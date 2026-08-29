/**
 * POST /api/v1/auth/forgot-password/reset
 *
 * Final step of recovery. Requires a reset request that is already `verified`,
 * not expired, not locked and not consumed.
 *
 * The `verified -> consumed` transition happens BEFORE the password is written,
 * so a resetId can never change the password twice.
 *
 * Writes through the same admin-auth module used by login and by the dashboard
 * Change Password action, so there is only one password implementation.
 *
 * Does NOT log the admin in: no JWT is issued here. The admin returns to the
 * login form and still has to pass Telegram approval.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkRateLimit,
  getClientIp,
  parseJsonBody,
  handleApiError,
  successResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { resetPasswordSchema } from "@/lib/validation";
import {
  deriveNewPasswordMaterial,
  getCurrentAdminUsername,
  ADMIN_AUTH_KEY,
} from "@/lib/admin-auth";
import { consumeResetAndSetPassword } from "@/lib/password-reset";
import { sendPasswordChangedNotice } from "@/lib/telegram";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("password-reset");

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "forgot-password-reset", {
      requests: 10,
      window: "15m",
    });

    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const { resetId, newPassword } = resetPasswordSchema.parse(body);

    // 1. Derive the scrypt material FIRST. This is CPU-bound and must not run
    //    inside a Redis script. Only the derived hash and salt cross into Redis;
    //    the plaintext password never does.
    const material = await deriveNewPasswordMaterial(newPassword);

    // 2. Write the password AND consume the reset request in ONE atomic script.
    //    Either both happen or neither does, so a failure can no longer burn the
    //    reset credential without changing the password.
    const claim = await consumeResetAndSetPassword(resetId, material, ADMIN_AUTH_KEY);

    if (!claim.ok) {
      logger.warn(
        { reset: maskId(resetId), reason: claim.reason },
        "Password reset refused"
      );

      if (claim.reason === "not_verified") {
        throw new AppError(
          "This reset request has not been verified.",
          400,
          "RESET_NOT_VERIFIED"
        );
      }
      if (claim.reason === "consumed") {
        throw new AppError(
          "This reset request has already been used.",
          400,
          "RESET_ALREADY_USED"
        );
      }
      if (claim.reason === "locked") {
        throw new AppError("This reset request is locked.", 400, "RESET_LOCKED");
      }
      throw new AppError("This reset request is invalid or expired.", 400, "RESET_INVALID");
    }

    const username = claim.username || (await getCurrentAdminUsername());

    logger.info({ reset: maskId(resetId) }, "Admin password reset via Telegram code");

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatIds) {
      for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
        await sendPasswordChangedNotice({ botToken, chatId }, { username, via: "reset" });
      }
    }

    // Deliberately no token: the admin must log in and pass Telegram approval.
    return successResponse({
      ok: true,
      status: "password_reset",
      message: "Password reset successfully.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
