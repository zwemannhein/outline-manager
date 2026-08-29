/**
 * /api/outline  — Serverless proxy for the Outline Management API
 *
 * Accepts POST with JSON body:
 *   { apiUrl, certSha256, method, path, body? }
 *
 * SECURITY MODEL
 *  - Requires a valid admin JWT (Authorization: Bearer <token>).
 *  - The supplied (apiUrl, certSha256) pair MUST match a server already
 *    registered in the server-side admin data store. Arbitrary values from the
 *    browser are rejected, which closes the SSRF hole and prevents this route
 *    being used as a generic Outline management client.
 *  - Nothing about the target URL or the upstream response body is ever logged.
 *
 * Node.js runtime is required (not Edge) because we use the `https` module.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import type { IncomingMessage } from "http";
import { checkAuth, getRedis, unauthorizedResponse } from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";
import type { OutlineServer } from "@/lib/types";

const logger = createLogger("outline-proxy");
const ADMIN_DATA_KEY = "outline_admin_data";

interface ProxyRequestBody {
  apiUrl: string;
  certSha256: string;
  method: string;
  path: string;
  body?: unknown;
}

interface AdminData {
  servers: OutlineServer[];
}

/** Only these Outline management paths may be proxied. */
const ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^\/server$/,
  /^\/server\/(hostname-for-access-keys|port-for-new-access-keys|access-key-data-limit)$/,
  /^\/access-keys$/,
  /^\/access-keys\/[A-Za-z0-9_-]+$/,
  /^\/access-keys\/[A-Za-z0-9_-]+\/(name|data-limit)$/,
  /^\/metrics\/transfer$/,
  /^\/metrics\/enabled$/,
];

/** Perform an HTTPS request and return { status, data } */
function httpsRequest(
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
    if (body) req.write(body);
    req.end();
  });
}

/** Build a custom https.Agent that pins the cert by SHA-256 fingerprint */
function buildAgent(expectedSha256: string): https.Agent {
  const normalized = expectedSha256.replace(/:/g, "").toUpperCase();

  return new https.Agent({
    rejectUnauthorized: false, // we do manual fingerprint check below
    checkServerIdentity: (_host, cert) => {
      const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();

      if (actual !== normalized) {
        // Deliberately does not include either fingerprint in the message.
        return new Error("Certificate fingerprint mismatch");
      }
      return undefined; // OK
    },
  });
}

/** Load the registered servers that act as the proxy allow-list. */
async function loadRegisteredServers(): Promise<OutlineServer[]> {
  const redis = getRedis();
  const raw = await redis.get<AdminData | string>(ADMIN_DATA_KEY);
  if (!raw) return [];

  const parsed: AdminData | null =
    typeof raw === "string" ? (JSON.parse(raw) as AdminData) : raw;

  return Array.isArray(parsed?.servers) ? parsed.servers : [];
}

export async function POST(req: NextRequest) {
  // ── 1. Require an authenticated admin ───────────────────────────────────────
  const auth = await checkAuth(req);
  if (!auth.authenticated) {
    return unauthorizedResponse();
  }

  let body: ProxyRequestBody;
  try {
    body = (await req.json()) as ProxyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiUrl, certSha256, method, path, body: requestBody } = body;

  if (!apiUrl || !certSha256 || !method || !path) {
    return NextResponse.json(
      { error: "Missing required fields: apiUrl, certSha256, method, path" },
      { status: 400 }
    );
  }

  // ── 2. Validate the HTTP method ─────────────────────────────────────────────
  const allowedMethods = ["GET", "POST", "PUT", "DELETE"];
  const upperMethod = method.toUpperCase();
  if (!allowedMethods.includes(upperMethod)) {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  // ── 3. Validate the requested path against the allow-list ───────────────────
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (normalizedPath.includes("..") || !ALLOWED_PATH_PATTERNS.some((re) => re.test(normalizedPath))) {
    logger.warn({ username: auth.username }, "Rejected disallowed Outline path");
    return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
  }

  // ── 4. Allow-list the target server (blocks SSRF / arbitrary apiUrl) ────────
  let registered: OutlineServer[];
  try {
    registered = await loadRegisteredServers();
  } catch {
    logger.error({ username: auth.username }, "Failed to load server allow-list");
    return NextResponse.json({ error: "Server registry unavailable" }, { status: 503 });
  }

  const suppliedUrl = apiUrl.replace(/\/+$/, "");
  const suppliedFp = certSha256.replace(/:/g, "").toUpperCase();

  const match = registered.find(
    (s) =>
      s.apiUrl?.replace(/\/+$/, "") === suppliedUrl &&
      s.certSha256?.replace(/:/g, "").toUpperCase() === suppliedFp
  );

  if (!match) {
    // Never echo the rejected apiUrl back to the caller or into logs.
    logger.warn(
      { username: auth.username, registeredCount: registered.length },
      "Rejected Outline proxy request for an unregistered server"
    );
    return NextResponse.json(
      { error: "Target server is not registered" },
      { status: 403 }
    );
  }

  const targetUrl = `${suppliedUrl}${normalizedPath}`;

  let agent: https.Agent;
  try {
    agent = buildAgent(certSha256);
  } catch {
    return NextResponse.json({ error: "Failed to build TLS agent" }, { status: 500 });
  }

  const serializedBody =
    requestBody !== undefined ? JSON.stringify(requestBody) : undefined;

  const options: https.RequestOptions = {
    method: upperMethod,
    agent,
    headers: {
      "Content-Type": "application/json",
      ...(serializedBody
        ? { "Content-Length": Buffer.byteLength(serializedBody).toString() }
        : {}),
    },
  };

  try {
    const { status, data } = await httpsRequest(targetUrl, options, serializedBody);

    // Log the operation WITHOUT the target URL, request body, or response body.
    logger.info(
      { username: auth.username, serverId: match.id, method: upperMethod, status },
      "Outline proxy request completed"
    );

    // 204 No Content and other no-body success codes — return empty response
    const NO_BODY_STATUSES = [204, 205, 304];
    if (NO_BODY_STATUSES.includes(status)) {
      return new Response(null, { status });
    }

    let parsed: unknown;
    try {
      parsed = data.trim() ? JSON.parse(data) : {};
    } catch {
      parsed = data;
    }

    return NextResponse.json(parsed, { status });
  } catch {
    // The underlying error can contain the target URL — do not log or return it.
    logger.error(
      { username: auth.username, serverId: match.id, method: upperMethod },
      "Outline proxy request failed"
    );
    return NextResponse.json({ error: "Proxy request failed" }, { status: 502 });
  }
}
