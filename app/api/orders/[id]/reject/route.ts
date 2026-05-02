export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import type { Order } from "@/lib/types";

const ORDERS_KEY = "outline_orders";

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  return new Redis({ url, token });
}

function checkAuth(req: NextRequest): boolean {
  const expectedUser = process.env.ADMIN_USERNAME ?? "zmh";
  const expectedPass = process.env.ADMIN_PASSWORD ?? "admin123";
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  try {
    const decoded = Buffer.from(auth.slice(7), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    return decoded.slice(0, colonIdx) === expectedUser &&
           decoded.slice(colonIdx + 1) === expectedPass;
  } catch { return false; }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const redis = getRedis();
  const orders = ((await redis.get(ORDERS_KEY)) as Order[]) ?? [];
  const idx = orders.findIndex((o) => o.id === params.id);
  if (idx === -1) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (orders[idx].status !== "pending") {
    return NextResponse.json({ error: "Order already processed" }, { status: 400 });
  }
  orders[idx] = { ...orders[idx], status: "rejected", approvedAt: Date.now() };
  await redis.set(ORDERS_KEY, orders);
  return NextResponse.json({ ok: true });
}
