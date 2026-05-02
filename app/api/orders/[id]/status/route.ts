/**
 * GET /api/orders/[id]/status — public, returns order status + accessUrl if approved
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import type { Order } from "@/lib/types";

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  return new Redis({ url, token });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const redis = getRedis();
  const orders = ((await redis.get("outline_orders")) as Order[]) ?? [];
  const order = orders.find((o) => o.id === params.id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // Only expose safe fields to the public
  return NextResponse.json({
    id: order.id,
    status: order.status,
    plan: order.plan,
    name: order.name,
    createdAt: order.createdAt,
    // Only reveal accessUrl after approval
    accessUrl: order.status === "approved" ? order.accessUrl : null,
  });
}
