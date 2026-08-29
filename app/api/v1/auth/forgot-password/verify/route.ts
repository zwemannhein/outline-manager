/**
 * POST /api/v1/auth/forgot-password/verify
 *
 * Verifies the 6-digit code and moves the reset request pending -> verified.
 * The password is NOT changed here.
 *
 * Wrong codes increment an atomic counter; the fifth wrong code locks the request
 * permanently. The submitted code is never logged.
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
import { verifyResetCodeSchema } from "@/lib/validation";
import { verifyResetCode, MAX_CODE_ATTEMPTS } from "@/lib/password-reset";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "forgot-password-verify", {
      requests: 20,
      window: "15m",
    });

    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const parsed = verifyResetCodeSchema.safeParse(body);

    // Malformed input is treated as a generic failure, with no detail about
    // which field was wrong or whether the request exists.
    if (!parsed.success) {
      throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
    }

    const result = await verifyResetCode(parsed.data.resetId, parsed.data.code);

    if (result.ok) {
      return successResponse({ status: "verified" });
    }

    if (result.reason === "locked") {
      throw new AppError(
        "Too many incorrect codes. Please start the reset again.",
        429,
        "RESET_LOCKED"
      );
    }

    if (result.reason === "wrong_code") {
      throw new AppError("Invalid or expired code", 400, "INVALID_CODE", {
        attemptsRemaining: result.attemptsRemaining ?? 0,
        maxAttempts: MAX_CODE_ATTEMPTS,
      });
    }

    // invalid / expired / not_pending all collapse to one public message.
    throw new AppError("Invalid or expired code", 400, "INVALID_CODE");
  } catch (error) {
    return handleApiError(error);
  }
}
