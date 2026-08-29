/**
 * POST /api/v1/orders/[id]/approve — admin approval.
 *
 * Thin wrapper: all logic lives in lib/order-approval.ts, which the Telegram
 * webhook also calls. One implementation means the two paths cannot diverge and
 * cannot race each other into creating duplicate Outline keys.
 *
 * Returns the permanent ssconf:// URL. The raw ss:// key is never in the
 * response body — admins retrieve it separately via the dynamic-keys endpoint.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
} from "@/lib/api-utils";
import { approveOrderSchema } from "@/lib/validation";
import { approveOrder } from "@/lib/order-approval";
import { sendApprovalConfirmation } from "@/lib/telegram";
import { createLogger } from "@/lib/logger";

const logger = createLogger("orders");

/** Map the engine's failure codes onto HTTP statuses. */
const STATUS_BY_CODE: Record<string, number> = {
  ORDER_NOT_FOUND: 404,
  ALREADY_PROCESSED: 409,
  APPROVAL_IN_PROGRESS: 409,
  NEEDS_RECONCILIATION: 409,
  INCONSISTENT_STATE: 409,
  NO_SERVERS: 400,
  SERVER_NOT_FOUND: 400,
  OUTLINE_FAILED: 502,
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

    // Body is optional: an explicit serverId overrides the customer's choice.
    let body: unknown = {};
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const parsed = approveOrderSchema.safeParse(body ?? {});
    const serverId = parsed.success ? (parsed.data.serverId ?? null) : null;

    const result = await approveOrder({
      orderId: params.id,
      serverId,
      source: "web",
    });

    if (!result.ok) {
      throw new AppError(result.message, STATUS_BY_CODE[result.code] ?? 400, result.code);
    }

    // Notify the admin chat with the PERMANENT key, not the raw ss:// URL.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatIds && !result.reconciled) {
      for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
        await sendApprovalConfirmation(
          { botToken, chatId },
          { id: params.id, name: auth.username ?? "customer", dynamicUrl: result.dynamicUrl }
        ).catch(() => {});
      }
    }

    logger.info(
      { orderId: params.id, user: auth.username, reconciled: result.reconciled },
      "Order approved via dashboard"
    );

    return successResponse({
      ok: true,
      reconciled: result.reconciled,
      dynamicUrl: result.dynamicUrl,
      serverId: result.serverId,
      keyId: result.outlineKeyId,
      syncPending: result.syncPending,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
