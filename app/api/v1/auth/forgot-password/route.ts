/**
 * POST /api/v1/auth/forgot-password
 *
 * Starts password recovery. Takes NO username: the admin may have forgotten it,
 * so the server resolves the authoritative username itself and delivers BOTH the
 * username and a 6-digit code to the configured Telegram chat. Possession of
 * that chat is the authentication factor.
 *
 * Body: {} or { previousResetId } — the latter only for "Resend", which
 * invalidates the previously issued code.
 *
 * The username is never returned to the browser, and the code is never stored
 * in raw form.
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
import { forgotPasswordSchema } from "@/lib/validation";
import { getCurrentAdminUsername } from "@/lib/admin-auth";
import {
  issueResetCode,
  RESET_TTL_SECONDS,
  RESEND_COOLDOWN_SECONDS,
} from "@/lib/password-reset";
import { sendPasswordResetCode } from "@/lib/telegram";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("password-reset");

export async function POST(req: NextRequest) {
  try {
    // 3 reset requests per 15 minutes per IP.
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "forgot-password", {
      requests: 3,
      window: "15m",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Forgot password rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    // Body is optional; treat a missing or unparsable body as {}.
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const { previousResetId } = forgotPasswordSchema.parse(raw ?? {});

    // Telegram is the only delivery channel, so without it recovery is impossible.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatIds) {
      logger.error("Telegram is not configured; password recovery unavailable");
      throw new AppError(
        "Password recovery is unavailable because Telegram is not configured.",
        503,
        "RECOVERY_UNAVAILABLE"
      );
    }

    const username = await getCurrentAdminUsername();

    // The send/resend ordering lives in issueResetCode so it is covered by
    // tests: cooldown returns early without touching the existing request, and a
    // delivery failure discards the replacement rather than the old code.
    const outcome = await issueResetCode({
      username,
      ip,
      previousResetId: previousResetId ?? null,
      deliver: async (code, forUsername) => {
        let delivered = false;
        for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
          const result = await sendPasswordResetCode(
            { botToken, chatId },
            {
              username: forUsername,
              code,
              expiresInMinutes: Math.round(RESET_TTL_SECONDS / 60),
            }
          );
          if (result.ok) delivered = true;
          else logger.warn({ chatId, error: result.error }, "Failed to deliver reset code");
        }
        return delivered;
      },
    });

    if (outcome.status === "cooldown") {
      return successResponse({
        status: "cooldown",
        retryAfterSeconds: outcome.retryAfterSeconds,
        resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
      });
    }

    if (outcome.status === "delivery_failed") {
      throw new AppError(
        "Could not deliver the reset code to Telegram. Please try again.",
        502,
        "RESET_DELIVERY_FAILED"
      );
    }

    // Neither the code nor the username is logged or returned to the browser.
    logger.info({ ip, reset: maskId(outcome.resetId) }, "Password reset code sent via Telegram");

    return successResponse({
      status: "code_sent",
      resetId: outcome.resetId,
      expiresAt: outcome.expiresAt,
      resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
