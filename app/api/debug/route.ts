export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET() {
  const kvUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? null;
  const kvToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? null;
  const adminUser = process.env.ADMIN_USERNAME ?? null;
  const adminPass = process.env.ADMIN_PASSWORD ? "set" : null;

  // Try a real KV ping
  let kvStatus = "not configured";
  if (kvUrl && kvToken) {
    try {
      const res = await fetch(`${kvUrl}/ping`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const text = await res.text();
      kvStatus = res.ok ? `ok (${text.trim()})` : `error ${res.status}: ${text}`;
    } catch (e) {
      kvStatus = `fetch error: ${String(e)}`;
    }
  }

  return NextResponse.json({
    kvUrl: kvUrl ? kvUrl.slice(0, 40) + "…" : "MISSING",
    kvToken: kvToken ? "set (" + kvToken.slice(0, 8) + "…)" : "MISSING",
    adminUser: adminUser ?? "MISSING",
    adminPass: adminPass ?? "MISSING",
    kvStatus,
  });
}
