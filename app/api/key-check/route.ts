/**
 * /api/key-check  — Public endpoint for users to check their key status.
 *
 * POST { ssHost, keyId, password }
 *   → Looks up the matching server from Redis (server-side, no creds exposed)
 *   → Fetches key data + metrics from the Outline API via the proxy
 *   → Returns safe public info: name, dataUsed, dataLimit, expiryDate
 *
 * No auth required from the user — server credentials stay server-side.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import https from "https";
import type { IncomingMessage } from "http";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Redis ─────────────────────────────────────────────────────────────────────

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ── HTTPS helper (same as outline proxy) ─────────────────────────────────────

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
      const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();
      if (actual !== normalized) {
        return new Error(`Cert mismatch: expected ${normalized}, got ${actual}`);
      }
      return undefined;
    },
  });
}

async function outlineFetch<T>(apiUrl: string, certSha256: string, path: string): Promise<T> {
  const base = apiUrl.replace(/\/$/, "");
  const agent = buildAgent(certSha256);
  const { status, data } = await httpsRequest(`${base}${path}`, {
    method: "GET",
    agent,
    headers: { "Content-Type": "application/json" },
  });
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(data) as T;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { ssHost?: string; keyId?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ssHost, keyId, password } = body;
  if (!ssHost) {
    return NextResponse.json({ error: "ssHost is required" }, { status: 400 });
  }

  // Load stored servers from Redis
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "Server not configured. Ask your admin to set up the app." },
      { status: 503 }
    );
  }

  let stored: StoredData;
  try {
    stored = ((await redis.get("outline_admin_data")) as StoredData) ?? { servers: [], keyMeta: {} };
  } catch {
    return NextResponse.json({ error: "Could not load server list" }, { status: 500 });
  }

  // Find matching server by host
  const server = stored.servers.find((s) => {
    try { return new URL(s.apiUrl).hostname === ssHost; }
    catch { return false; }
  });

  if (!server) {
    return NextResponse.json(
      { error: `Server ${ssHost} not found. Ask your admin to add this server to the app.` },
      { status: 404 }
    );
  }

  // Fetch keys + metrics from Outline API
  try {
    const [keysRes, metricsRes] = await Promise.all([
      outlineFetch<{ accessKeys: AccessKey[] }>(server.apiUrl, server.certSha256, "/access-keys"),
      outlineFetch<{ bytesTransferredByUserId: Record<string, number> }>(
        server.apiUrl, server.certSha256, "/metrics/transfer"
      ),
    ]);

    // Match key by ID or password
    const found = keysRes.accessKeys.find(
      (k) => (keyId && k.id === keyId) || (password && k.accessUrl.includes(password))
    );

    if (!found) {
      return NextResponse.json(
        { error: "Key not found on this server. It may have been deleted." },
        { status: 404 }
      );
    }

    const bytesUsed = metricsRes.bytesTransferredByUserId[found.id] ?? 0;
    const dataLimit = found.dataLimit?.bytes ?? found.limit?.bytes ?? null;
    const metaKey = `${server.id}:${found.id}`;
    const expiryDate = stored.keyMeta[metaKey]?.expiryDate ?? null;

    return NextResponse.json({
      serverName: server.name,
      keyName: found.name || null,
      keyId: found.id,
      bytesUsed,
      dataLimit,
      expiryDate,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach server: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
