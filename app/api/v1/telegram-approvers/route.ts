/**
 * /api/v1/telegram-approvers
 *
 * GET  — list all linked Telegram approvers
 * DELETE — remove a linked approver (body: { userId })
 *
 * Requires admin JWT. Does NOT create/modify dashboard accounts.
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
import { removeApproverSchema } from "@/lib/validation";
import { listApprovers, removeApprover } from "@/lib/telegram-approvers";
import { createLogger } from "@/lib/logger";

const logger = createLogger("telegram-approvers");

/** GET /api/v1/telegram-approvers — list linked approvers */
export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const approvers = await listApprovers();

    return successResponse({
      approvers: approvers.map((a) => ({
        userId: a.userId,
        username: a.username,
        linkedAt: a.linkedAt,
        status: a.status,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** DELETE /api/v1/telegram-approvers — remove a linked approver */
export async function DELETE(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const body = await req.json().catch(() => ({}));
    const input = removeApproverSchema.safeParse(body);
    if (!input.success) {
      throw new AppError("userId is required", 400, "VALIDATION_ERROR");
    }

    await removeApprover(input.data.userId);

    logger.info({ user: auth.username, targetUserId: input.data.userId }, "Telegram approver removed");

    return successResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
