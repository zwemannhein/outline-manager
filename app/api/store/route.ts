/**
 * /api/store — Synced admin data store backed by Vercel KV.
 *
 * GET  /api/store          → returns { servers, keyMeta }
 * POST /api/store          → saves   { servers, keyMeta }
 *
 * Both require the Authorization header:
 *   Authorization: Bearer <base64(username:password)>
 *
 * Falls back gracefully when KV is not configured (local dev without KV).
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

// ── Auth ──────────────────────────────────────────────────────────────────────

function checkAuth(req: NextRequest): boolean {
  const expectedUser = process.env.ADMIN_USERNAME ?? "zmh";
  const expectedPass = process.env.ADMIN_PASSWORD ?? "admin123";

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;

  try {
    const decoded = Buffer.from(auth.slice(7), "base64").toString("utf-8");
    const [user, ...passParts] = decoded.split(":");
    const pass = passParts.join(":");
    return user === expectedUser && pass === expectedPass;
  } catch {
    return false;
  }
}

// ── KV helpers ────────────────────────────────────────────────────────────────

const KV_KEY = "outline_admin_data";

async function kvGet(): Promise<unknown> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/get/${KV_KEY}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json() as { result?: string };
  if (!json.result) return null;
  return JSON.parse(json.result);
}

async function kvSet(data: unknown): Promise<void> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  await fetch(`${url}/set/${KV_KEY}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: JSON.stringify(data) }),
  });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await kvGet();
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

  try {
    const body = await req.json();
    await kvSet(body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[store] POST error:", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
