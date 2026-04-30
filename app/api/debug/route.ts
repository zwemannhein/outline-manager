export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export async function GET() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? null;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  const adminUser = process.env.ADMIN_USERNAME ?? null;
  const adminPass = process.env.ADMIN_PASSWORD ? "set" : null;

  let kvStatus = "not configured";
  if (url && token) {
    try {
      const redis = new Redis({ url, token });
      const pong = await redis.ping();
      kvStatus = `ok (${pong})`;
    } catch (e) {
      kvStatus = `error: ${String(e)}`;
    }
  }

  return NextResponse.json({
    kvUrl: url ? url.slice(0, 50) + "…" : "MISSING",
    kvToken: token ? "set (" + token.slice(0, 8) + "…)" : "MISSING",
    adminUser: adminUser ?? "MISSING",
    adminPass: adminPass ?? "MISSING",
    kvStatus,
  });
}
