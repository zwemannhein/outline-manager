/**
 * POST /api/v1/key-check — public "check my key" endpoint.
 *
 * Accepts EITHER form a customer might hold:
 *
 *   1. a permanent key            ssconf://host/k/<token>#Name  (or a bare token)
 *   2. a legacy raw Shadowsocks   ss://...
 *
 * Path 1 is the reason this route was rewritten. `decodeSsUrl` resolves an
 * ssconf:// URL to the WORKER's hostname, which is not an Outline server, so the
 * old host-matching logic returned SERVER_NOT_FOUND for every customer holding a
 * permanent key. Resolving the token through the dynamic identity fixes that.
 *
 * Path 2 keeps working for customers who have not yet been switched over.
 *
 * Never returns the raw ss:// URL, the server's apiUrl, or a key count.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkRateLimit,
  getClientIp,
  parseJsonBody,
  handleApiError,
  successResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { keyCheckSchema } from "@/lib/validation";
import { createLogger, maskId } from "@/lib/logger";
import { parseDynamicUrl, readDynamicRecord, isValidDynamicToken } from "@/lib/dynamic-keys";
import { readKeyMeta, computeQuotaUsage, describeQuota } from "@/lib/key-meta";
import {
  listRegisteredServers,
  listAccessKeys,
  getTransferMetrics,
  getKeyUsageBytes,
} from "@/lib/outline-admin";
import type { AccessKey } from "@/lib/types";

const logger = createLogger("key-check");

/** Short cache so repeated taps do not hammer the Outline servers. */
const CACHE_TTL = 60;

interface KeyStatusResponse {
  serverName: string;
  keyName: string | null;
  keyId: string;
  bytesUsed: number;
  dataLimit: number | null;
  expiryDate: string | null;
  /** Present for permanent keys. */
  status?: string;
  planDescription?: string | null;
  cyclesTotal?: number | null;
  cyclesUsed?: number | null;
  remainingBytes?: number | null;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "key-check", { requests: 20, window: "5m" });
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody<Record<string, unknown>>(req);
    const redis = getRedis();

    // ── Path 1: a permanent dynamic key ──────────────────────────────────────
    // The client may send the whole ssconf:// URL, a bare token, or the legacy
    // { ssHost, keyId, password } shape whose host is the Worker.
    const rawInput =
      typeof body.key === "string"
        ? body.key
        : typeof body.ssUrl === "string"
          ? body.ssUrl
          : typeof body.token === "string"
            ? body.token
            : null;

    const parsedDynamic = rawInput ? parseDynamicUrl(rawInput) : null;
    const dynamicToken =
      parsedDynamic?.token ??
      (typeof body.token === "string" && isValidDynamicToken(body.token) ? body.token : null);

    if (dynamicToken) {
      return successResponse(await checkDynamicKey(dynamicToken, redis));
    }

    // ── Path 2: a legacy raw ss:// key ───────────────────────────────────────
    const validated = keyCheckSchema.parse(body);
    return successResponse(await checkLegacyKey(validated, redis));
  } catch (error) {
    return handleApiError(error);
  }
}

// ── Permanent key ─────────────────────────────────────────────────────────────

async function checkDynamicKey(
  token: string,
  redis: ReturnType<typeof getRedis>
): Promise<KeyStatusResponse> {
  const cacheKey = `keycheck:dyn:${token}`;
  const cached = await redis.get<KeyStatusResponse>(cacheKey);
  if (cached) return cached;

  const record = await readDynamicRecord(token);
  if (!record || record.status === "revoked") {
    // Same message as a wrong key: do not confirm that a token exists.
    throw new AppError("Key not found. It may have been removed.", 404, "KEY_NOT_FOUND");
  }

  const servers = await listRegisteredServers();
  const server = servers.find((s) => s.id === record.serverId);

  const meta = await readKeyMeta(record.serverId, record.outlineKeyId);

  let liveBytes = 0;
  try {
    liveBytes = await getKeyUsageBytes(record.serverId, record.outlineKeyId);
  } catch {
    logger.warn({ dyn: maskId(token) }, "Could not read usage for a dynamic key");
  }

  const usage = meta ? computeQuotaUsage(meta, liveBytes) : null;

  const response: KeyStatusResponse = {
    serverName: server?.name ?? "VPN server",
    keyName: record.name || null,
    keyId: record.outlineKeyId,
    bytesUsed: usage?.totalUsedBytes ?? liveBytes,
    dataLimit: usage?.quotaBytes ?? meta?.quotaBytes ?? null,
    expiryDate: meta?.expiryDate ?? null,
    status: record.status,
    planDescription: meta ? describeQuota(meta) : null,
    cyclesTotal: meta?.cyclesTotal ?? null,
    cyclesUsed: meta?.cyclesUsed ?? null,
    remainingBytes: usage?.remainingBytes ?? null,
  };

  await redis.setex(cacheKey, CACHE_TTL, response);
  return response;
}

// ── Legacy raw key ────────────────────────────────────────────────────────────

async function checkLegacyKey(
  input: { ssHost: string; keyId?: string; password?: string },
  redis: ReturnType<typeof getRedis>
): Promise<KeyStatusResponse> {
  const cacheKey = `keycheck:ss:${input.ssHost}:${input.keyId ?? ""}:${(input.password ?? "").slice(0, 8)}`;
  const cached = await redis.get<KeyStatusResponse>(cacheKey);
  if (cached) return cached;

  const servers = await listRegisteredServers();

  // Match the server by the host embedded in the customer's ss:// URL.
  const server = servers.find((s) => {
    try {
      return new URL(s.apiUrl).hostname === input.ssHost;
    } catch {
      return false;
    }
  });

  if (!server) {
    throw new AppError("Server not recognised for this key.", 404, "SERVER_NOT_FOUND");
  }

  const [keys, metrics] = await Promise.all([
    listAccessKeys(server.id),
    getTransferMetrics(server.id),
  ]);

  const found = keys.find((k: AccessKey) => {
    if (input.keyId && k.id === input.keyId) return true;
    if (input.password && k.password === input.password) return true;
    if (input.password && k.accessUrl?.includes(input.password)) return true;
    return false;
  });

  if (!found) {
    // Key count is logged server-side only; returning it would be information
    // disclosure on a public endpoint.
    logger.warn(
      { ssHost: input.ssHost, totalKeys: keys.length },
      "Legacy key not found on the matched server"
    );
    throw new AppError("Key not found on this server. It may have been deleted.", 404, "KEY_NOT_FOUND");
  }

  const meta = await readKeyMeta(server.id, found.id);
  const liveBytes = metrics.bytesTransferredByUserId?.[found.id] ?? 0;
  const usage = meta ? computeQuotaUsage(meta, liveBytes) : null;

  const response: KeyStatusResponse = {
    serverName: server.name,
    keyName: found.name || null,
    keyId: found.id,
    bytesUsed: usage?.totalUsedBytes ?? liveBytes,
    dataLimit:
      usage?.quotaBytes ?? found.dataLimit?.bytes ?? found.limit?.bytes ?? null,
    expiryDate: meta?.expiryDate ?? null,
    planDescription: meta ? describeQuota(meta) : null,
    cyclesTotal: meta?.cyclesTotal ?? null,
    cyclesUsed: meta?.cyclesUsed ?? null,
    remainingBytes: usage?.remainingBytes ?? null,
  };

  await redis.setex(cacheKey, CACHE_TTL, response);
  return response;
}
