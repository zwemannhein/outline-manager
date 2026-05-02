/**
 * POST /api/orders/[id]/approve
 * Admin approves an order → auto-creates an Outline access key on the first server.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import https from "https";
import type { IncomingMessage } from "http";
import type { Order, Plan } from "@/lib/types";

const ORDERS_KEY = "outline_orders";
const ADMIN_DATA_KEY = "outline_admin_data";

const PLAN_LIMITS: Record<Plan, number | null> = {
  plan_a: null,           // unlimited
  plan_b: 100 * 1024 ** 3, // 100 GB
};

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

// ── HTTPS helpers ─────────────────────────────────────────────────────────────

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildAgent(certSha256: string): https.Agent {
  const normalized = certSha256.replace(/:/g, "").toUpperCase();
  return new https.Agent({
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toUpperCase();
      if (actual !== normalized) return new Error("Cert mismatch");
      return undefined;
    },
  });
}

async function outlinePost<T>(
  apiUrl: string, certSha256: string, path: string, body?: unknown
): Promise<T> {
  const base = apiUrl.replace(/\/$/, "");
  const agent = buildAgent(certSha256);
  const serialized = body ? JSON.stringify(body) : undefined;
  const { status, data } = await httpsRequest(
    `${base}${path}`,
    {
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        ...(serialized ? { "Content-Length": Buffer.byteLength(serialized).toString() } : {}),
      },
    },
    serialized
  );
  if (status === 204) return undefined as T;
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}: ${data}`);
  return data ? JSON.parse(data) as T : undefined as T;
}

async function outlinePut(
  apiUrl: string, certSha256: string, path: string, body: unknown
): Promise<void> {
  const base = apiUrl.replace(/\/$/, "");
  const agent = buildAgent(certSha256);
  const serialized = JSON.stringify(body);
  const { status } = await httpsRequest(
    `${base}${path}`,
    {
      method: "PUT",
      agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serialized).toString(),
      },
    },
    serialized
  );
  if (status !== 204 && (status < 200 || status >= 300)) {
    throw new Error(`HTTP ${status}`);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = getRedis();

  // Load orders
  const orders = ((await redis.get(ORDERS_KEY)) as Order[]) ?? [];
  const orderIdx = orders.findIndex((o) => o.id === params.id);
  if (orderIdx === -1) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  const order = orders[orderIdx];
  if (order.status !== "pending") {
    return NextResponse.json({ error: "Order already processed" }, { status: 400 });
  }

  // Load admin data to get servers
  const adminData = (await redis.get(ADMIN_DATA_KEY)) as {
    servers: Array<{ id: string; name: string; apiUrl: string; certSha256: string }>;
  } | null;

  if (!adminData?.servers?.length) {
    return NextResponse.json({ error: "No servers configured" }, { status: 503 });
  }

  // Use the body to optionally pick a server, otherwise use first
  let serverId: string | undefined;
  try {
    const body = await req.json() as { serverId?: string };
    serverId = body.serverId;
  } catch { /* no body */ }

  const server = serverId
    ? adminData.servers.find((s) => s.id === serverId) ?? adminData.servers[0]
    : adminData.servers[0];

  try {
    // 1. Create access key
    const key = await outlinePost<{
      id: string; name: string; accessUrl: string;
    }>(server.apiUrl, server.certSha256, "/access-keys");

    // 2. Set name to customer name
    await outlinePut(server.apiUrl, server.certSha256, `/access-keys/${key.id}/name`, {
      name: order.name,
    });

    // 3. Set data limit if plan requires it
    const limitBytes = PLAN_LIMITS[order.plan];
    if (limitBytes !== null) {
      await outlinePut(server.apiUrl, server.certSha256, `/access-keys/${key.id}/data-limit`, {
        limit: { bytes: limitBytes },
      });
    }

    // 4. Update order in Redis
    orders[orderIdx] = {
      ...order,
      status: "approved",
      serverId: server.id,
      keyId: key.id,
      accessUrl: key.accessUrl,
      approvedAt: Date.now(),
    };
    await redis.set(ORDERS_KEY, orders);

    return NextResponse.json({ ok: true, accessUrl: key.accessUrl });
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to create key: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
