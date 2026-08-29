/**
 * POST /api/v1/auth/login — Step 1 of admin login.
 *
 * Correct credentials do NOT produce a JWT here. They produce a pending login
 * attempt that must be approved from Telegram, after which the original browser
 * exchanges { attemptId, browserSecret } at /api/v1/auth/login/status for a
 * session. Telegram approval alone is not sufficient.
 *
 * Wrong credentials never create an attempt and never send a Telegram message.
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
import { loginSchema } from "@/lib/validation";
import { verifyAdminCredentials, getCurrentAdminUsername } from "@/lib/admin-auth";
import {
  createLoginAttempt,
  countPendingAttempts,
  describeUserAgent,
  MAX_PENDING_ATTEMPTS,
} from "@/lib/login-attempts";
import { sendLoginApprovalRequest } from "@/lib/telegram";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("auth");

export async function POST(req: NextRequest) {
  try {
    // Rate limiting: 5 attempts per 15 minutes per IP
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "login", {
      requests: 5,
      window: "15m",
    });

    if (!rateLimit.success) {
      logger.warn({ ip }, "Login rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const { username, password } = loginSchema.parse(body);

    // Both halves are always evaluated inside verifyAdminCredentials so the
    // response does not reveal which one was wrong. Never log either value.
    const valid = await verifyAdminCredentials(username, password);

    if (!valid) {
      logger.warn({ ip }, "Failed login attempt");
      throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    // Bound concurrent pending approvals so a repeated login cannot flood Telegram.
    const pending = await countPendingAttempts();
    if (pending >= MAX_PENDING_ATTEMPTS) {
      logger.warn({ ip, pending }, "Too many pending login approvals");
      throw new AppError(
        "Too many pending login requests. Please wait for them to expire and try again.",
        429,
        "TOO_MANY_PENDING"
      );
    }

    const adminUsername = await getCurrentAdminUsername();
    const rawUserAgent = req.headers.get("user-agent");

    const attempt = await createLoginAttempt({
      username: adminUsername,
      ip,
      userAgent: rawUserAgent ?? "",
    });

    // Notify every configured admin chat.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatIds) {
      // Fail closed: without Telegram there is no second factor, so refuse
      // rather than silently downgrading to password-only login.
      logger.error("Telegram is not configured; cannot complete admin login approval");
      throw new AppError(
        "Login approval is unavailable because Telegram is not configured.",
        503,
        "APPROVAL_UNAVAILABLE"
      );
    }

    const browserSummary = describeUserAgent(rawUserAgent);
    let anyDelivered = false;

    for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
      const result = await sendLoginApprovalRequest(
        { botToken, chatId },
        {
          attemptId: attempt.attemptId,
          username: adminUsername,
          browserSummary,
          ip,
          requestedAt: Date.now(),
        }
      );
      if (result.ok) anyDelivered = true;
      else logger.warn({ chatId, error: result.error }, "Failed to send login approval request");
    }

    if (!anyDelivered) {
      throw new AppError(
        "Could not deliver the approval request to Telegram. Please try again.",
        502,
        "APPROVAL_DELIVERY_FAILED"
      );
    }

    logger.info(
      { ip, attempt: maskId(attempt.attemptId) },
      "Credentials accepted, awaiting Telegram approval"
    );

    // browserSecret is returned exactly once, only to this browser.
    return successResponse({
      status: "approval_required",
      attemptId: attempt.attemptId,
      browserSecret: attempt.browserSecret,
      expiresAt: attempt.expiresAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
