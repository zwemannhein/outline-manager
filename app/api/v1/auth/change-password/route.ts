/**
 * POST /api/v1/auth/change-password
 *
 * Authenticated password change from the dashboard. Verifies the current
 * password against whatever is authoritative right now (the `admin:auth` Redis
 * record if it exists, otherwise the bootstrap environment password), then
 * writes the new password to `admin:auth`.
 *
 * The first successful call migrates the deployment off the environment
 * password permanently: from then on ADMIN_PASSWORD is ignored.
 *
 * Never logs or returns the current password, the new password, the hash, or the salt.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  checkRateLimit,
  getClientIp,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { changePasswordSchema } from "@/lib/validation";
import {
  verifyAdminPassword,
  setAdminPassword,
  getCurrentAdminUsername,
  getCurrentAdminPasswordState,
} from "@/lib/admin-auth";
import { sendPasswordChangedNotice } from "@/lib/telegram";
import { createLogger } from "@/lib/logger";

const logger = createLogger("auth");

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "change-password", {
      requests: 5,
      window: "15m",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Change password rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const { currentPassword, newPassword } = changePasswordSchema.parse(body);

    const currentOk = await verifyAdminPassword(currentPassword);
    if (!currentOk) {
      logger.warn({ ip, user: auth.username }, "Change password rejected: wrong current password");
      throw new AppError("Current password is incorrect", 401, "INVALID_CURRENT_PASSWORD");
    }

    if (newPassword === currentPassword) {
      throw new AppError(
        "New password must be different from the current password",
        400,
        "PASSWORD_UNCHANGED"
      );
    }

    await setAdminPassword(newPassword);

    const state = await getCurrentAdminPasswordState();
    const username = await getCurrentAdminUsername();

    logger.info({ user: auth.username, source: state.source }, "Admin password changed");

    // Best-effort notification. Never contains the password.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatIds) {
      for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
        await sendPasswordChangedNotice({ botToken, chatId }, { username, via: "dashboard" });
      }
    }

    return successResponse({
      ok: true,
      message: "Password changed successfully.",
      // Confirms the environment password is no longer in use. No secret value.
      passwordSource: state.source,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
