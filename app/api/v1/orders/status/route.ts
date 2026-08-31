/**
 * POST /api/v1/orders/status — customer order status by claim token.
 *
 * Replaces `GET /api/v1/orders/[id]/status`, which keyed on a semi-predictable
 * order id and returned the raw ss:// key to anyone who guessed one.
 *
 * POST with a body rather than GET with a path/query param, so the claim token
 * stays out of access logs, `Referer` headers and browser history.
 *
 * Malformed, unknown and expired claim tokens all produce the SAME 404, so the
 * endpoint cannot be used to probe for valid tokens.
 *
 * After approval this returns the permanent ssconf:// URL. It NEVER returns the
 * raw ss:// access URL — that is admin-only.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkRateLimit,
  getClientIp,
  handleApiError,
  successResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { orderStatusSchema } from "@/lib/validation";
import { resolveClaimToken } from "@/lib/order-claim";
import { findOrder } from "@/lib/order-approval";
import { readDynamicRecord, buildDynamicUrl } from "@/lib/dynamic-keys";
import { readKeyMeta, computeQuotaUsage, describeQuota } from "@/lib/key-meta";
import { getKeyUsageBytes } from "@/lib/outline-admin";
import { createLogger } from "@/lib/logger";

const logger = createLogger("orders");

export async function POST(req: NextRequest) {
  try {
    // Generous: the order form polls this while waiting for approval.
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "order-status", {
      requests: 120,
      window: "5m",
    });
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const parsed = orderStatusSchema.safeParse(body);
    if (!parsed.success) {
      // Same response as an unknown token.
      throw new AppError("Order not found", 404, "NOT_FOUND");
    }

    const orderId = await resolveClaimToken(parsed.data.claimToken);
    if (!orderId) {
      throw new AppError("Order not found", 404, "NOT_FOUND");
    }

    const order = await findOrder(orderId);
    if (!order) {
      throw new AppError("Order not found", 404, "NOT_FOUND");
    }

    // Before approval: status only, no key material of any kind.
    if (order.status !== "approved") {
      return successResponse({
        status: order.status,
        name: order.name,
        plan: order.plan,
        createdAt: order.createdAt,
        dynamicUrl: null,
      });
    }

    // Approved: return the permanent URL, plus usage if we can read it cheaply.
    const token = order.dynamicToken ?? null;
    if (!token) {
      // Approved before dynamic keys existed, or awaiting backfill.
      logger.warn({ orderId }, "Approved order has no dynamic token yet");
      return successResponse({
        status: "approved",
        name: order.name,
        plan: order.plan,
        createdAt: order.createdAt,
        dynamicUrl: null,
        pendingSetup: true,
      });
    }

    const record = await readDynamicRecord(token);
    if (!record) {
      return successResponse({
        status: "approved",
        name: order.name,
        plan: order.plan,
        createdAt: order.createdAt,
        dynamicUrl: null,
        pendingSetup: true,
      });
    }

    const meta = await readKeyMeta(record.serverId, record.outlineKeyId);

    let usage: ReturnType<typeof computeQuotaUsage> | null = null;
    if (meta) {
      // Usage is best-effort: a slow or unreachable server must not break the
      // customer's ability to copy their key.
      const bytes = await getKeyUsageBytes(record.serverId, record.outlineKeyId).catch(() => 0);
      usage = computeQuotaUsage(meta, bytes);
    }

    return successResponse({
      status: "approved",
      name: order.name,
      plan: order.plan,
      createdAt: order.createdAt,
      // The permanent customer key. Never the raw ss:// URL.
      dynamicUrl: buildDynamicUrl(record.token, record.name),
      keyStatus: record.status,
      planDescription: meta ? describeQuota(meta) : null,
      expiryDate: meta?.expiryDate ?? null,
      cyclesTotal: meta?.cyclesTotal ?? null,
      cyclesUsed: meta?.cyclesUsed ?? null,
      usage: usage
        ? {
            totalUsedBytes: usage.totalUsedBytes,
            quotaBytes: usage.quotaBytes,
            remainingBytes: usage.remainingBytes,
          }
        : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
