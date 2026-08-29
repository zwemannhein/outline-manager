/**
 * POST /api/v1/auth/login — Admin login with JWT
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
  AppError,
} from "@/lib/api-utils";
import { loginSchema } from "@/lib/validation";
import { getEnv } from "@/lib/validation";
import { createLogger } from "@/lib/logger";

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
      logger.warn({ ip, remaining: rateLimit.remaining }, "Login rate limit exceeded");
      return rateLimitResponse(rateLimit.reset);
    }

    // Parse and validate input
    const body = await parseJsonBody(req);
    const { username, password } = loginSchema.parse(body);

    // Verify credentials
    const env = getEnv();
    if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
      logger.warn({ username, ip }, "Failed login attempt");
      throw new AppError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    // Create JWT token
    const token = await createToken(username);

    logger.info({ username, ip }, "Successful login");

    return successResponse({
      token,
      expiresIn: "24h",
      username,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
