/**
 * POST /api/v1/key-check — Check key status (public, rate-limited, with caching)
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
import { createLogger } from "@/lib/logger";
import https from "https";
import type { IncomingMessage } from "http";

const logger = createLogger("key-check");
const CACHE_TTL = 60; // 1 minute cache

interface StoredData {
  servers: Array<{
    id: string;
    name: string;
    apiUrl: string;
    certSha256: string;
  }>;
  keyMeta: Record<string, { expiryDate: string | null }>;
}

interface AccessKey {
  id: string;
  name: string;
  password: string;
  accessUrl: string;
  dataLimit?: { bytes: number };
  limit?: { bytes: number };
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────

function httpsRequest(
  url: string,
  options: https.RequestOptions
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function buildAgent(certSha256: string): https.Agent {
  const normalized = certSha256.replace(/:/g, "").toUpperCase();
  return new https.Agent({
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const actual = (cert.fingerprint256 ?? "")
        .replace(/:/g, "")
        .toUpperCase();
      if (actual !== normalized) {
        return new Error("Certificate fingerprint mismatch");
      }
      return undefined;
    },
  });
}

async function outlineFetch<T>(
  apiUrl: string,
  certSha256: string,
  path: string
): Promise<T> {
  const base = apiUrl.replace(/\/$/, "");
  const agent = buildAgent(certSha256);
  const { status, data } = await httpsRequest(`${base}${path}`, {
    method: "GET",
    agent,
    headers: { "Content-Type": "application/json" },
  });
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  return JSON.parse(data) as T;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // Rate limiting: 10 checks per minute per IP
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "key-check", {
      requests: 10,
      window: "1m",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Key check rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    // Parse and validate input
    const body = await parseJsonBody(req);
    const { ssHost, keyId, password } = keyCheckSchema.parse(body);

    const redis = getRedis();

    // Check cache first
    const cacheKey = `key-check:${ssHost}:${keyId || password}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      logger.debug({ ssHost, keyId }, "Cache hit for key check");
      return successResponse(cached);
    }

    // Load stored servers
    const stored = ((await redis.get("outline_admin_data")) as StoredData) ?? {
      servers: [],
      keyMeta: {},
    };

    // Find matching server by host
    const server = stored.servers.find((s) => {
      try {
        return new URL(s.apiUrl).hostname === ssHost;
      } catch {
        return false;
      }
    });

    if (!server) {
      throw new AppError(
        `Server ${ssHost} not found. Contact your administrator.`,
        404,
        "SERVER_NOT_FOUND"
      );
    }

    // Fetch keys + metrics from Outline API
    const [keysRes, metricsRes] = await Promise.all([
      outlineFetch<{ accessKeys: AccessKey[] }>(
        server.apiUrl,
        server.certSha256,
        "/access-keys"
      ),
      outlineFetch<{ bytesTransferredByUserId: Record<string, number> }>(
        server.apiUrl,
        server.certSha256,
        "/metrics/transfer"
      ),
    ]);

    // Match key by ID, password, or accessUrl
    const found = keysRes.accessKeys.find((k) => {
      if (keyId && k.id === keyId) return true;
      if (password && k.password === password) return true;
      if (password && k.accessUrl.includes(password)) return true;
      return false;
    });

    if (!found) {
      // Log server-side for troubleshooting, but return no details to the
      // caller: the number of keys on a server is information disclosure on a
      // public, unauthenticated endpoint.
      logger.warn(
        { ssHost, keyId, totalKeys: keysRes.accessKeys.length },
        "Key not found"
      );
      throw new AppError(
        "Key not found on this server. It may have been deleted.",
        404,
        "KEY_NOT_FOUND"
      );
    }

    const bytesUsed = metricsRes.bytesTransferredByUserId[found.id] ?? 0;
    const dataLimit = found.dataLimit?.bytes ?? found.limit?.bytes ?? null;
    const metaKey = `${server.id}:${found.id}`;
    const expiryDate = stored.keyMeta[metaKey]?.expiryDate ?? null;

    const response = {
      serverName: server.name,
      keyName: found.name || null,
      keyId: found.id,
      bytesUsed,
      dataLimit,
      expiryDate,
    };

    // Cache the result
    await redis.setex(cacheKey, CACHE_TTL, response);

    logger.info({ ssHost, keyId: found.id }, "Key check successful");

    return successResponse(response);
  } catch (error) {
    logger.error({ error }, "Key check failed");
    return handleApiError(error);
  }
}
