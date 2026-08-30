/**
 * POST /api/v1/telegram-approvers/link-token
 *
 * Creates a cryptographically random one-time linking token.
 * Returns a deep link to OutlineTeleBot that the admin can share with
 * the prospective approver.
 *
 * - Token is 32 hex chars (128 bits), TTL 15 minutes, single-use.
 * - Optionally bound to an expected Telegram username.
 * - The bot /start handler verifies token + username + user_id, then marks
 *   the approver as Linked.
 *
 * Requires admin JWT. Does NOT create a dashboard account.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  checkRateLimit,
  getClientIp,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { createLinkTokenSchema } from "@/lib/validation";
import { createLinkToken } from "@/lib/telegram-approvers";
import { createLogger } from "@/lib/logger";

const logger = createLogger("telegram-approvers");

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const ip = getClientIp(req);
    const rl = await checkRateLimit(ip, "tg-link-token", { requests: 10, window: "15m" });
    if (!rl.success) return rateLimitResponse(rl.reset);

    const body = await req.json().catch(() => ({}));
    const input = createLinkTokenSchema.safeParse(body);
    if (!input.success) {
      throw new AppError("Validation failed", 400, "VALIDATION_ERROR");
    }

    const pending = await createLinkToken(input.data.username);

    // Build the Telegram deep link using the configured bot username.
    const botUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!botUsername) {
      throw new AppError(
        "TELEGRAM_BOT_USERNAME is not configured. Add it to your environment variables.",
        503,
        "BOT_NOT_CONFIGURED"
      );
    }

    const deepLink = `https://t.me/${botUsername}?start=${pending.token}`;

    logger.info(
      { user: auth.username, expectedUsername: pending.expectedUsername || "(any)" },
      "Telegram link token issued"
    );

    return successResponse({
      token: pending.token,
      deepLink,
      expectedUsername: pending.expectedUsername,
      expiresAt: pending.expiresAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
