/**
 * POST /api/v1/auth/bootstrap-password
 *
 * First-run password setup. Retires the bootstrap ADMIN_PASSWORD environment
 * variable without any Vercel configuration change.
 *
 * Deliberately does NOT ask for the current password, because the caller has
 * already proven possession of it twice over:
 *   1. the JWT was only issued after the bootstrap password validated, and
 *   2. that login additionally required a Telegram approval tap.
 *
 * Two guards keep this from becoming a password-reset bypass:
 *   - a valid admin JWT is required, and
 *   - it only works while `admin:auth` does not yet exist. Once a runtime
 *     password has been set, this endpoint returns 409 forever and the normal
 *     change-password flow (which requires the current password) is the only way
 *     to change it.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  checkRateLimit,
  getClientIp,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { bootstrapPasswordSchema } from "@/lib/validation";
import {
  isBootstrapPasswordInUse,
  setAdminPassword,
  getCurrentAdminPasswordState,
  getCurrentAdminUsername,
} from "@/lib/admin-auth";
import { sendPasswordChangedNotice } from "@/lib/telegram";
import { createLogger } from "@/lib/logger";

const logger = createLogger("auth");

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "bootstrap-password", {
      requests: 5,
      window: "15m",
    });
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    // Only valid during first run. After that this route is permanently closed.
    if (!(await isBootstrapPasswordInUse())) {
      throw new AppError(
        "A password has already been set. Use Change Password instead.",
        409,
        "ALREADY_INITIALISED"
      );
    }

    const body = await parseJsonBody(req);
    const { newPassword } = bootstrapPasswordSchema.parse(body);

    await setAdminPassword(newPassword);

    const state = await getCurrentAdminPasswordState();
    const username = await getCurrentAdminUsername();

    logger.info(
      { user: auth.username, source: state.source },
      "First-run admin password set; environment password retired"
    );

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatIds) {
      for (const chatId of chatIds.split(",").map((c) => c.trim()).filter(Boolean)) {
        await sendPasswordChangedNotice({ botToken, chatId }, { username, via: "dashboard" });
      }
    }

    return successResponse({
      ok: true,
      message: "Password set successfully.",
      passwordSource: state.source,
      passwordChangeRequired: false,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
