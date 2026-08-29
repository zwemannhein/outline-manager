/**
 * POST /api/v1/admin/backfill — give pre-existing Outline keys a permanent identity.
 *
 * Creates ZERO Outline keys: the job only reads `/access-keys` and writes
 * metadata/mappings, so it cannot disturb a live customer.
 *
 * Recommended sequence:
 *   1. POST { "dryRun": true }   review the plan
 *   2. POST { "dryRun": false }  write identities
 *   3. POST { "dryRun": false }  confirm tokensCreated === 0 (idempotent)
 *
 * Defaults to a dry run, so an accidental empty POST cannot write anything.
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
} from "@/lib/api-utils";
import { backfillSchema } from "@/lib/validation";
import { runBackfill } from "@/lib/backfill";
import { migrateLegacyKeyMeta } from "@/lib/key-meta";
import { createLogger } from "@/lib/logger";

const logger = createLogger("backfill-api");

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "backfill", { requests: 10, window: "15m" });
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = backfillSchema.safeParse(body ?? {});
    const options = parsed.success ? parsed.data : {};

    // Default to dry run: an empty POST must never mutate anything.
    const dryRun = options.dryRun !== false;

    // Move any legacy browser-written keyMeta into the server-authoritative hash
    // first, so the backfill sees existing expiry dates and preserves them.
    const metaMigration = await migrateLegacyKeyMeta();

    const report = await runBackfill({ dryRun, limit: options.limit });

    logger.info(
      {
        user: auth.username,
        dryRun,
        tokensCreated: report.tokensCreated,
        skipped: report.skipped,
      },
      "Backfill run complete"
    );

    return successResponse({
      ok: true,
      metaMigration,
      ...report,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
