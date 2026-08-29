/**
 * GET  /api/v1/store — Get admin data (auth required)
 * POST /api/v1/store — Save admin data (auth required)
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  getRedis,
  checkAuth,
  parseJsonBody,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";
import { z } from "zod";

const logger = createLogger("store");
const ADMIN_DATA_KEY = "outline_admin_data";

const adminDataSchema = z.object({
  servers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      apiUrl: z.string().url(),
      certSha256: z.string(),
      addedAt: z.number(),
    })
  ),
  keyMeta: z.record(
    z.object({
      expiryDate: z.string().nullable(),
    })
  ),
});

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const redis = getRedis();
    const data = (await redis.get(ADMIN_DATA_KEY)) ?? {
      servers: [],
      keyMeta: {},
    };

    logger.info({ user: auth.username }, "Admin data retrieved");

    return successResponse(data);
  } catch (error) {
    return handleApiError(error);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const body = await parseJsonBody(req);
    const data = adminDataSchema.parse(body);

    const redis = getRedis();
    await redis.set(ADMIN_DATA_KEY, data);

    logger.info(
      { user: auth.username, serverCount: data.servers.length },
      "Admin data saved"
    );

    return successResponse({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
