/**
 * /api/store — Synced admin data store backed by Upstash Redis.
 *
 * GET  /api/store  → returns { servers, keyMeta }
 * POST /api/store  → saves   { servers, keyMeta }
 *
 * Authorization: Bearer <base64(username:password)>
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const KV_KEY = "outline_admin_data";

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(req: NextRequest): boolean {
  const expectedUser = process.env.ADMIN_USERNAME ?? "zmh";
  const expectedPass = process.env.ADMIN_PASSWORD ?? "admin123";

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;

  try {
    const decoded = Buffer.from(auth.slice(7), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    return user === expectedUser && pass === expectedPass;
  } catch {
    return false;
  }
}

// ── Redis client (lazy — only created when env vars are present) ──────────────

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    // No KV configured — return empty (client falls back to localStorage)
    return NextResponse.json({ servers: [], keyMeta: {} });
  }

  try {
    const data = await redis.get(KV_KEY);
    return NextResponse.json(data ?? { servers: [], keyMeta: {} });
  } catch (e) {
    console.error("[store] GET error:", e);
    return NextResponse.json({ servers: [], keyMeta: {} });
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ ok: true, note: "KV not configured, data not persisted" });
  }

  try {
    const body = await req.json();
    await redis.set(KV_KEY, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[store] POST error:", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
