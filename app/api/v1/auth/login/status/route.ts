/**
 * POST /api/v1/auth/login/status — Step 2 of admin login.
 *
 * The waiting browser polls with { attemptId, browserSecret }. A JWT is issued
 * only when ALL of these hold:
 *   - the attempt exists and has not expired
 *   - the caller's browserSecret matches the stored SHA-256
 *   - Telegram approved the attempt
 *   - the attempt has not already been consumed
 *
 * The `approved -> consumed` transition is performed BEFORE the token is minted,
 * so the same attempt can never issue two sessions.
 *
 * Unknown, malformed and expired ids all return `expired`, so this endpoint
 * cannot be used to discover valid attempt ids.
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
  createToken,
} from "@/lib/api-utils";
import { loginAttemptSchema } from "@/lib/validation";
import {
  getAttemptStatusForBrowser,
  consumeApprovedAttempt,
} from "@/lib/login-attempts";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("auth");

export async function POST(req: NextRequest) {
  try {
    // Generous limit: the browser polls every ~2.5s for up to 5 minutes.
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "login-status", {
      requests: 200,
      window: "5m",
    });

    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const parsed = loginAttemptSchema.safeParse(body);

    // Malformed input is indistinguishable from an unknown attempt.
    if (!parsed.success) {
      return successResponse({ status: "expired" });
    }

    const { attemptId, browserSecret } = parsed.data;

    const status = await getAttemptStatusForBrowser(attemptId, browserSecret);

    if (status !== "approved") {
      return successResponse({ status });
    }

    // Consume first, then mint. A loser of this race gets no token.
    const consumed = await consumeApprovedAttempt(attemptId, browserSecret);
    if (!consumed.ok) {
      return successResponse({ status: consumed.status });
    }

    const token = await createToken(consumed.username);

    logger.info(
      { attempt: maskId(attemptId) },
      "Admin session issued after Telegram approval"
    );

    return successResponse({
      status: "approved",
      token,
      username: consumed.username,
      expiresIn: "24h",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
