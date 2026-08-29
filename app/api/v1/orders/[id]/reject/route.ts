/**
 * POST /api/v1/orders/[id]/reject — Reject an order (admin only)
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
} from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";
import type { Order } from "@/lib/types";

const logger = createLogger("orders");
const ORDERS_KEY = "outline_orders";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const redis = getRedis();
    const orders = ((await redis.get(ORDERS_KEY)) as Order[]) ?? [];
    const idx = orders.findIndex((o) => o.id === params.id);

    if (idx === -1) {
      throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    }

    if (orders[idx].status !== "pending") {
      throw new AppError(
        "Order already processed",
        400,
        "ORDER_ALREADY_PROCESSED"
      );
    }

    orders[idx] = {
      ...orders[idx],
      status: "rejected",
      approvedAt: Date.now(),
    };

    await redis.set(ORDERS_KEY, orders);

    logger.info(
      { orderId: params.id, user: auth.username },
      "Order rejected"
    );

    return successResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
