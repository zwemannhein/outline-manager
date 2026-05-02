/**
 * GET  /api/orders        — list all orders (admin only)
 * POST /api/orders        — submit a new order (public)
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import type { Order, Plan } from "@/lib/types";

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

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function loadOrders(redis: Redis): Promise<Order[]> {
  const data = await redis.get(ORDERS_KEY);
  return (data as Order[]) ?? [];
}

async function saveOrders(redis: Redis, orders: Order[]): Promise<void> {
  await redis.set(ORDERS_KEY, orders);
}

// ── GET — admin only ──────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const redis = getRedis();
  const orders = await loadOrders(redis);
  // Sort newest first
  orders.sort((a, b) => b.createdAt - a.createdAt);
  return NextResponse.json(orders);
}

// ── POST — public ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: { name?: string; kpayRef?: string; plan?: Plan };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { name, kpayRef, plan } = body;

  if (!name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!kpayRef || !/^\d{6}$/.test(kpayRef.trim())) {
    return NextResponse.json({ error: "KPay reference must be exactly 6 digits" }, { status: 400 });
  }
  if (plan !== "plan_a" && plan !== "plan_b") {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const order: Order = {
    id: uuid(),
    name: name.trim(),
    kpayRef: kpayRef.trim(),
    plan,
    status: "pending",
    serverId: null,
    keyId: null,
    accessUrl: null,
    createdAt: Date.now(),
    approvedAt: null,
  };

  const redis = getRedis();
  const orders = await loadOrders(redis);
  orders.push(order);
  await saveOrders(redis, orders);

  return NextResponse.json({ id: order.id }, { status: 201 });
}
