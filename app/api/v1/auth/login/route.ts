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
import { createHash, timingSafeEqual } from "crypto";

const logger = createLogger("auth");

/**
 * Length-independent, timing-safe string comparison.
 *
 * timingSafeEqual throws when the two buffers differ in length, which would
 * itself leak length information. Hashing both sides to a fixed 32 bytes first
 * makes the comparison constant-time regardless of input length.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

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

    // Verify credentials.
    // FAIL CLOSED: if either credential env var is missing, no login is possible.
    // There are deliberately no default/fallback credentials.
    const env = getEnv();
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
      logger.error({ ip }, "Admin credentials are not configured; refusing all logins");
      throw new AppError("Server not configured", 503, "NOT_CONFIGURED");
    }

    // Timing-safe comparison of both fields. Both are always compared so the
    // response time does not reveal which field was wrong.
    const userOk = timingSafeEqualStr(username, env.ADMIN_USERNAME);
    const passOk = timingSafeEqualStr(password, env.ADMIN_PASSWORD);

    if (!userOk || !passOk) {
      // Never log the attempted username or password.
      logger.warn({ ip }, "Failed login attempt");
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
