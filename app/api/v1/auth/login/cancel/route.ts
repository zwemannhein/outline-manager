/**
 * POST /api/v1/auth/login/cancel
 *
 * Browser-initiated cancellation of a pending login approval, so the admin can
 * back out without waiting for the 5-minute expiry.
 *
 * Requires browserSecret, so a third party who somehow learned an attemptId
 * cannot cancel someone else's pending login.
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
} from "@/lib/api-utils";
import { loginAttemptSchema } from "@/lib/validation";
import { cancelLoginAttempt } from "@/lib/login-attempts";

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "login-cancel", {
      requests: 20,
      window: "5m",
    });

    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody(req);
    const parsed = loginAttemptSchema.safeParse(body);

    // Always report success: cancelling is idempotent from the browser's point
    // of view, and a distinct error would leak whether the attempt existed.
    if (!parsed.success) {
      return successResponse({ status: "cancelled" });
    }

    await cancelLoginAttempt(parsed.data.attemptId, parsed.data.browserSecret);

    return successResponse({ status: "cancelled" });
  } catch (error) {
    return handleApiError(error);
  }
}
