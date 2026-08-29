/**
 * The single server-side Outline Management API client.
 *
 * Replaces five near-identical cert-pinned https.Agent implementations that were
 * scattered across route files. All server-side Outline access goes through here.
 *
 * SECURITY
 *  - Callers pass a `serverId`; credentials are resolved from the server registry
 *    in Redis. The browser never supplies an apiUrl to this module.
 *  - Nothing here logs the management URL, the cert fingerprint, an access URL,
 *    or a response body. Error messages are scrubbed of the target URL, because
 *    Node puts the full URL into connection errors and that URL contains the
 *    management secret path.
 *  - The cert-mismatch error deliberately omits both fingerprints.
 *
 * Cloudflare Workers cannot do cert-pinned TLS to a self-signed Outline server,
 * which is why every Outline call must originate from this Node runtime and never
 * from the edge.
 */

import https from "https";
import type { IncomingMessage } from "http";
import { getRedis } from "./api-utils";
import { createLogger } from "./logger";
import type { AccessKey, OutlineServer, ServerInfo, TransferMetrics } from "./types";

const logger = createLogger("outline-admin");

const ADMIN_DATA_KEY = "outline_admin_data";

export class OutlineApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code:
      | "NOT_FOUND"
      | "UNAUTHORIZED"
      | "BAD_REQUEST"
      | "UNREACHABLE"
      | "CERT_MISMATCH"
      | "SERVER_ERROR"
  ) {
    super(message);
    this.name = "OutlineApiError";
  }
}

// ── Server registry ───────────────────────────────────────────────────────────

interface AdminData {
  servers?: OutlineServer[];
}

/** All registered Outline servers. This is the proxy/API allow-list. */
export async function listRegisteredServers(): Promise<OutlineServer[]> {
  const redis = getRedis();
  const raw = await redis.get<AdminData | string>(ADMIN_DATA_KEY);
  if (!raw) return [];

  let parsed: AdminData | null = null;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as AdminData;
    } catch {
      return [];
    }
  } else {
    parsed = raw;
  }

  return Array.isArray(parsed?.servers) ? parsed!.servers! : [];
}

/** Resolve one server's credentials, or throw if it is not registered. */
export async function resolveServer(serverId: string): Promise<OutlineServer> {
  const servers = await listRegisteredServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    throw new OutlineApiError("Server is not registered", 404, "NOT_FOUND");
  }
  if (!server.apiUrl || !server.certSha256) {
    throw new OutlineApiError("Server registration is incomplete", 400, "BAD_REQUEST");
  }
  return server;
}

// ── Transport ─────────────────────────────────────────────────────────────────

function buildAgent(certSha256: string): https.Agent {
  const expected = certSha256.replace(/:/g, "").toUpperCase();

  return new https.Agent({
    // Self-signed by design; authenticity comes from the fingerprint check below.
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();
      if (actual !== expected) {
        // Neither fingerprint is included: the expected one is a stored secret.
        return new Error("Certificate fingerprint mismatch");
      }
      return undefined;
    },
  });
}

/**
 * Remove anything URL-shaped from an error message.
 * Connection errors from Node embed the full management URL, which is secret.
 */
function scrubError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/https?:\/\/\S+/gi, "[redacted-url]");
}

function rawRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("Outline request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Low-level call against explicit credentials.
 *
 * Prefer the serverId-based helpers below. This is exported only for the
 * backfill and health paths that already hold a validated server record.
 */
export async function outlineRequest<T>(
  server: Pick<OutlineServer, "id" | "apiUrl" | "certSha256">,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const base = server.apiUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const serialized = body !== undefined ? JSON.stringify(body) : undefined;

  let status = 0;
  let data = "";

  try {
    const res = await rawRequest(
      `${base}${normalizedPath}`,
      {
        method,
        agent: buildAgent(server.certSha256),
        headers: {
          "Content-Type": "application/json",
          ...(serialized
            ? { "Content-Length": Buffer.byteLength(serialized).toString() }
            : {}),
        },
      },
      serialized
    );
    status = res.status;
    data = res.data;
  } catch (err) {
    const scrubbed = scrubError(err);
    logger.error({ serverId: server.id, method, reason: scrubbed }, "Outline request failed");
    if (/fingerprint mismatch/i.test(scrubbed)) {
      throw new OutlineApiError("Certificate fingerprint mismatch", 502, "CERT_MISMATCH");
    }
    throw new OutlineApiError("Outline server is unreachable", 502, "UNREACHABLE");
  }

  // 204/205 carry no body.
  if (status === 204 || status === 205) return undefined as T;

  let parsed: unknown = {};
  if (data.trim()) {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = {};
    }
  }

  if (status < 200 || status >= 300) {
    // Never surface the upstream body: /access-keys responses contain secrets.
    logger.warn({ serverId: server.id, method, status }, "Outline returned an error status");
    if (status === 404) throw new OutlineApiError("Not found on Outline server", 404, "NOT_FOUND");
    if (status === 401 || status === 403) {
      throw new OutlineApiError("Outline rejected the credentials", 502, "UNAUTHORIZED");
    }
    if (status >= 400 && status < 500) {
      throw new OutlineApiError("Outline rejected the request", 400, "BAD_REQUEST");
    }
    throw new OutlineApiError("Outline server error", 502, "SERVER_ERROR");
  }

  return parsed as T;
}

/** Resolve credentials by serverId, then call. The preferred entry point. */
export async function callServer<T>(
  serverId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const server = await resolveServer(serverId);
  return outlineRequest<T>(server, method, path, body);
}

// ── Operations ────────────────────────────────────────────────────────────────

export async function getServerInfo(serverId: string): Promise<ServerInfo> {
  return callServer<ServerInfo>(serverId, "GET", "/server");
}

export async function listAccessKeys(serverId: string): Promise<AccessKey[]> {
  const res = await callServer<{ accessKeys: AccessKey[] }>(serverId, "GET", "/access-keys");
  return res?.accessKeys ?? [];
}

export async function getAccessKey(
  serverId: string,
  keyId: string
): Promise<AccessKey | null> {
  try {
    return await callServer<AccessKey>(serverId, "GET", `/access-keys/${keyId}`);
  } catch (err) {
    if (err instanceof OutlineApiError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

/** True when the key still exists. Used by approval reconciliation. */
export async function accessKeyExists(serverId: string, keyId: string): Promise<boolean> {
  return (await getAccessKey(serverId, keyId)) !== null;
}

export async function createAccessKey(
  serverId: string,
  name?: string
): Promise<AccessKey> {
  const key = await callServer<AccessKey>(serverId, "POST", "/access-keys");
  if (name) {
    await renameAccessKey(serverId, key.id, name);
    key.name = name;
  }
  return key;
}

export async function renameAccessKey(
  serverId: string,
  keyId: string,
  name: string
): Promise<void> {
  await callServer(serverId, "PUT", `/access-keys/${keyId}/name`, { name });
}

export async function deleteAccessKey(serverId: string, keyId: string): Promise<void> {
  await callServer(serverId, "DELETE", `/access-keys/${keyId}`);
}

export async function setDataLimit(
  serverId: string,
  keyId: string,
  bytes: number
): Promise<void> {
  await callServer(serverId, "PUT", `/access-keys/${keyId}/data-limit`, {
    limit: { bytes },
  });
}

export async function removeDataLimit(serverId: string, keyId: string): Promise<void> {
  await callServer(serverId, "DELETE", `/access-keys/${keyId}/data-limit`);
}

/**
 * Apply a quota, or remove the limit entirely for unlimited.
 * One helper so no caller has to remember which call means "unlimited".
 */
export async function applyDataLimit(
  serverId: string,
  keyId: string,
  bytes: number | null
): Promise<void> {
  if (bytes === null) {
    await removeDataLimit(serverId, keyId);
  } else {
    await setDataLimit(serverId, keyId, Math.max(0, Math.floor(bytes)));
  }
}

export async function getTransferMetrics(serverId: string): Promise<TransferMetrics> {
  const res = await callServer<TransferMetrics>(serverId, "GET", "/metrics/transfer");
  return res ?? { bytesTransferredByUserId: {} };
}

/** Bytes used by one key, per Outline's rolling 30-day window. */
export async function getKeyUsageBytes(serverId: string, keyId: string): Promise<number> {
  const metrics = await getTransferMetrics(serverId);
  return metrics.bytesTransferredByUserId?.[keyId] ?? 0;
}

/** The limit currently set on a key, or null when unlimited. */
export async function getKeyLimitBytes(
  serverId: string,
  keyId: string
): Promise<number | null> {
  const key = await getAccessKey(serverId, keyId);
  if (!key) return null;
  return key.dataLimit?.bytes ?? key.limit?.bytes ?? null;
}
