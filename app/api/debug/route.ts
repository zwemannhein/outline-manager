export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export async function GET(req: NextRequest) {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? null;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;
  const adminUser = process.env.ADMIN_USERNAME ?? null;
  const adminPass = process.env.ADMIN_PASSWORD ?? null;

  // Check auth header
  const authHeader = req.headers.get("authorization") ?? "none";
  let authDecoded = "none";
  if (authHeader.startsWith("Bearer ")) {
    try {
      authDecoded = Buffer.from(authHeader.slice(7), "base64").toString("utf-8");
    } catch { authDecoded = "decode error"; }
  }

  // Test Redis
  let kvStatus = "not configured";
  let kvData: unknown = null;
  if (url && token) {
    try {
      const redis = new Redis({ url, token });
      const pong = await redis.ping();
      kvStatus = `ok (${pong})`;
      // Also read current stored data
      kvData = await redis.get("outline_admin_data");
    } catch (e) {
      kvStatus = `error: ${String(e)}`;
    }
  }

  return NextResponse.json({
    env: {
      kvUrl: url ? url.slice(0, 50) + "…" : "MISSING",
      kvToken: token ? "set" : "MISSING",
      adminUser: adminUser ?? "MISSING",
      adminPass: adminPass ? "set" : "MISSING",
    },
    kvStatus,
    kvData,  // shows what's actually stored in Redis right now
    authHeader: authDecoded,
  });
}
