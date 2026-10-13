/**
 * POST /api/v1/auth/login — verify the single admin's credentials and issue a
 * short-lived session. Telegram approval is not part of dashboard login.
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
  createToken,
} from "@/lib/api-utils";
import { loginSchema } from "@/lib/validation";
import { verifyAdminCredentials, getCurrentAdminUsername } from "@/lib/admin-auth";
import { createLogger } from "@/lib/logger";

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

    const adminUsername = await getCurrentAdminUsername();
    const token = await createToken(adminUsername);

    logger.info({ ip }, "Admin session issued after credential verification");

    return successResponse({
      status: "authenticated",
      token,
      username: adminUsername,
      expiresIn: "24h",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
