/**
 * GET /api/v1/orders/[id]/status — Check order status (public, rate-limited)
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkRateLimit,
  getClientIp,
  handleApiError,
  successResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";
import type { Order } from "@/lib/types";

const logger = createLogger("orders");
const ORDERS_KEY = "outline_orders";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Rate limiting: 20 checks per minute per IP
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "order-status", {
      requests: 20,
      window: "1m",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Order status rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    const redis = getRedis();
    const orders = ((await redis.get(ORDERS_KEY)) as Order[]) ?? [];
    const order = orders.find((o) => o.id === params.id);

    if (!order) {
      throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    }

    // Return safe public info
    const response = {
      id: order.id,
      status: order.status,
      plan: order.plan,
      name: order.name,
      createdAt: order.createdAt,
      accessUrl: order.status === "approved" ? order.accessUrl : null,
    };

    return successResponse(response);
  } catch (error) {
    return handleApiError(error);
  }
}
