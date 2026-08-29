/**
 * POST /api/v1/orders/[id]/approve
 * Admin approves an order → auto-creates an Outline access key
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkAuth,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
} from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";
import https from "https";
import type { IncomingMessage } from "http";
import type { Order } from "@/lib/types";
import { z } from "zod";

const logger = createLogger("orders");
const ORDERS_KEY = "outline_orders";
const ADMIN_DATA_KEY = "outline_admin_data";

const approveSchema = z.object({
  serverId: z.string().optional(),
});

interface OutlineServer {
  id: string;
  name: string;
  apiUrl: string;
  certSha256: string;
}

interface AdminData {
  servers: OutlineServer[];
  keyMeta: Record<string, { expiryDate: string | null }>;
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
      if (actual !== normalized) {
        return new Error("Certificate fingerprint mismatch");
      }
      return undefined;
    },
  });
}

async function outlineRequest<T>(
  apiUrl: string,
  certSha256: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const base = apiUrl.replace(/\/$/, "");
  const agent = buildAgent(certSha256);
  const serialized = body ? JSON.stringify(body) : undefined;

  const { status, data } = await httpsRequest(
    `${base}${path}`,
    {
      method,
      agent,
      headers: { "Content-Type": "application/json" },
    },
    serialized
  );

  if (status < 200 || status >= 300) {
    throw new Error(`Outline API error: HTTP ${status}`);
  }

  return data ? (JSON.parse(data) as T) : ({} as T);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const body = await parseJsonBody(req);
    const { serverId } = approveSchema.parse(body);

    const redis = getRedis();

    // Load orders
    const orders = ((await redis.get(ORDERS_KEY)) as Order[]) ?? [];
    const orderIdx = orders.findIndex((o) => o.id === params.id);

    if (orderIdx === -1) {
      throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    }

    const order = orders[orderIdx];

    if (order.status !== "pending") {
      throw new AppError(
        "Order already processed",
        400,
        "ORDER_ALREADY_PROCESSED"
      );
    }

    // Load admin data
    const adminData = ((await redis.get(ADMIN_DATA_KEY)) as AdminData) ?? {
      servers: [],
      keyMeta: {},
    };

    if (adminData.servers.length === 0) {
      throw new AppError("No servers configured", 400, "NO_SERVERS");
    }

    // Select server
    const server = serverId
      ? adminData.servers.find((s) => s.id === serverId)
      : adminData.servers[0];

    if (!server) {
      throw new AppError("Server not found", 404, "SERVER_NOT_FOUND");
    }

    logger.info(
      { orderId: order.id, serverId: server.id, user: auth.username },
      "Approving order"
    );

    // Create access key
    const keyResponse = await outlineRequest<{ id: string; accessUrl: string }>(
      server.apiUrl,
      server.certSha256,
      "POST",
      "/access-keys",
      {}
    );

    const keyId = keyResponse.id;
    const accessUrl = keyResponse.accessUrl;

    // Set key name
    await outlineRequest(
      server.apiUrl,
      server.certSha256,
      "PUT",
      `/access-keys/${keyId}/name`,
      { name: order.name }
    );

    // Set data limit based on plan
    let dataLimitBytes: number | null = null;

    if (order.plan === "plan_a") {
      dataLimitBytes = null; // unlimited
    } else if (order.plan === "plan_b") {
      dataLimitBytes = 100 * 1024 ** 3; // 100 GB
    } else if (order.plan === "custom" && order.customDataLimitGB) {
      dataLimitBytes = order.customDataLimitGB * 1024 ** 3;
    }

    if (dataLimitBytes !== null) {
      await outlineRequest(
        server.apiUrl,
        server.certSha256,
        "PUT",
        `/access-keys/${keyId}/data-limit`,
        { limit: { bytes: dataLimitBytes } }
      );
    }

    // Calculate expiry date
    const months = order.customMonths ?? 1;
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + months);

    // Store expiry in keyMeta
    const metaKey = `${server.id}:${keyId}`;
    adminData.keyMeta[metaKey] = { expiryDate: expiryDate.toISOString() };
    await redis.set(ADMIN_DATA_KEY, adminData);

    // Update order
    orders[orderIdx] = {
      ...order,
      status: "approved",
      serverId: server.id,
      keyId,
      accessUrl,
      approvedAt: Date.now(),
    };

    await redis.set(ORDERS_KEY, orders);

    logger.info(
      { orderId: order.id, keyId, serverId: server.id },
      "Order approved successfully"
    );

    return successResponse({ ok: true, accessUrl });
  } catch (error) {
    logger.error({ error, orderId: params.id }, "Order approval failed");
    return handleApiError(error);
  }
}
