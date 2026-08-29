/**
 * POST /api/v1/orders/[id]/reject — Reject an order (admin only).
 *
 * Delegates to lib/order-approval.ts so rejection takes the SAME per-order lock
 * as approval. Previously the two paths were independent, so a dashboard reject
 * racing a Telegram approve could interleave and leave the order in an
 * inconsistent state.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
} from "@/lib/api-utils";
import { rejectOrder } from "@/lib/order-approval";
import { createLogger } from "@/lib/logger";

const logger = createLogger("orders");

const STATUS_BY_CODE: Record<string, number> = {
  ORDER_NOT_FOUND: 404,
  ALREADY_PROCESSED: 400,
  APPROVAL_IN_PROGRESS: 409,
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const result = await rejectOrder(params.id);
    if (!result.ok) {
      throw new AppError(result.message, STATUS_BY_CODE[result.code] ?? 400, result.code);
    }

    logger.info({ orderId: params.id, user: auth.username }, "Order rejected");

    return successResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
