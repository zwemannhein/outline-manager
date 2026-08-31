/**
 * POST /api/v1/auth/login — Step 1 of admin login.
 *
 * Correct credentials do NOT produce a JWT here. They produce a pending login
 * attempt that must be approved from Telegram, after which the original browser
 * exchanges { attemptId, browserSecret } at /api/v1/auth/login/status for a
 * session. Telegram approval alone is not sufficient.
 *
 * Telegram notification targets (in priority order):
 *   1. All linked approvers from Redis (tg:approvers)
 *   2. Fallback: TELEGRAM_CHAT_ID env var (legacy / first-run)
 *
 * If ZERO Telegram targets are configured, the login is rejected with a clear
 * error rather than silently granting password-only access.
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
import { getApproverChatIds } from "@/lib/telegram-approvers";
import { writeLoginTelemetry } from "@/lib/monitoring";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("auth");

export async function POST(req: NextRequest) {
  try {
    // Rate limiting: 5 attempts per 15 minutes per IP.
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

    // Both halves evaluated inside verifyAdminCredentials — timing-safe.
    const valid = await verifyAdminCredentials(username, password);

    if (!valid) {
      logger.warn({ ip }, "Failed login attempt");
      throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    // Bound concurrent pending approvals to avoid Telegram spam.
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

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      logger.error("Telegram bot token not configured; cannot complete admin login approval");
      throw new AppError(
        "Login approval is unavailable because Telegram is not configured.",
        503,
        "APPROVAL_UNAVAILABLE"
      );
    }

    // Build notification target list.
    // ALWAYS include both:
    //   1. All linked approvers from Redis (tg:approvers)
    //   2. TELEGRAM_CHAT_ID env var (legacy / verified binding)
    // Deduplication ensures a chatId that appears in both is only messaged once.
    // The env var is NEVER skipped, even when Redis approvers exist — this is the
    // fix for the bug where a stale/unreachable Redis record caused the working
    // env-var channel to be bypassed entirely.
    const linkedChatIds = await getApproverChatIds().catch(() => [] as string[]);
    const staticIds = (process.env.TELEGRAM_CHAT_ID ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Merge and deduplicate — preserve order (linked first, then static).
    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const id of [...linkedChatIds, ...staticIds]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        chatIds.push(id);
      }
    }

    if (chatIds.length === 0) {
      logger.error("No Telegram approvers configured; cannot complete admin login approval");
      throw new AppError(
        "No Telegram approvers are configured. Add one in Settings → Telegram Approvers.",
        503,
        "APPROVAL_UNAVAILABLE"
      );
    }

    const browserSummary = describeUserAgent(rawUserAgent);
    let anyDelivered = false;
    let deliverSucceeded = 0;
    let deliverFailed = 0;
    let lastFailureCategory = "";

    for (const chatId of chatIds) {
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
      if (result.ok) {
        anyDelivered = true;
        deliverSucceeded++;
      } else {
        deliverFailed++;
        lastFailureCategory = result.error ?? "unknown";
        logger.warn("Failed to deliver login approval request to a configured recipient");
      }
    }

    // Persist delivery telemetry for System Monitoring — no secrets stored.
    await writeLoginTelemetry({
      challengeCreatedAt: new Date().toISOString(),
      recipientsAttempted: chatIds.length,
      deliverSucceeded,
      deliverFailed,
      lastFailureCategory: deliverFailed > 0 ? lastFailureCategory : "",
    }).catch(() => {});

    if (!anyDelivered) {
      throw new AppError(
        "Could not deliver the approval request to Telegram. Please try again.",
        502,
        "APPROVAL_DELIVERY_FAILED"
      );
    }

    logger.info(
      { ip, attempt: maskId(attempt.attemptId), targets: chatIds.length },
      "Credentials accepted, awaiting Telegram approval"
    );

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
