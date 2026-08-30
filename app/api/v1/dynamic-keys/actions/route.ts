/**
 * POST /api/v1/dynamic-keys/actions — admin lifecycle operations.
 *
 * One authenticated endpoint with an explicit `action`, so every mutation shares
 * the same auth check, rate limit, validation shape and audit log line rather
 * than being spread over six near-identical routes.
 *
 * Actions:
 *   disable          close both gates (config delivery + Outline traffic)
 *   enable           reopen both, restoring the REMAINING current-cycle quota
 *   renew            extend cycles; same permanent URL
 *   updateQuota      change per-cycle quota; same permanent URL, zero KV writes
 *   migrate          move servers, preserving current-cycle consumption
 *   migrateCleanup   delete the superseded key, gated on edge sync
 *   revealRaw        return the raw ss:// URL for troubleshooting (audited)
 *   resync           force-push the edge projection
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
import {
  disableDynamicSchema,
  enableDynamicSchema,
  migrateDynamicSchema,
  migrateCleanupSchema,
  renewDynamicSchema,
  updateQuotaSchema,
  editSubscriptionSchema,
} from "@/lib/validation";
import { z } from "zod";
import {
  disableIdentity,
  enableIdentity,
  renewIdentity,
  updateQuota,
  editSubscription,
} from "@/lib/dynamic-lifecycle";
import { migrateToServer, cleanupMigration } from "@/lib/server-migration";
import { readDynamicRecord, buildDynamicUrl } from "@/lib/dynamic-keys";
import { syncDynamicToken as forceSync } from "@/lib/kv-sync";
import { createLogger, maskId } from "@/lib/logger";

const logger = createLogger("dynamic-keys-api");

const tokenOnlySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$/, "Invalid token"),
});

const actionSchema = z.object({
  action: z.enum([
    "disable",
    "enable",
    "renew",
    "updateQuota",
    "editSubscription",
    "migrate",
    "migrateCleanup",
    "revealRaw",
    "resync",
  ]),
});

/** Map service-layer failure codes onto HTTP statuses. */
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  REVOKED: 409,
  NOT_ACTIVE: 409,
  SAME_SERVER: 400,
  DEST_NOT_FOUND: 400,
  QUOTA_EXHAUSTED: 409,
  STATE_CONFLICT: 409,
  PROJECTION_STALE: 409,
  NOTHING_TO_CLEAN: 400,
  SUBSCRIPTION_ENDED: 409,
  NO_METADATA: 400,
  OUTLINE_FAILED: 502,
};

function fail(code: string, message: string, detail?: unknown): never {
  throw new AppError(message, STATUS_BY_CODE[code] ?? 400, code, detail);
}

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const ip = getClientIp(req);
    const rateLimit = await checkRateLimit(ip, "dynamic-actions", {
      requests: 60,
      window: "5m",
    });
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit.reset);
    }

    const body = await parseJsonBody<Record<string, unknown>>(req);
    const { action } = actionSchema.parse(body);

    switch (action) {
      // ── Disable ────────────────────────────────────────────────────────────
      case "disable": {
        const input = disableDynamicSchema.parse(body);
        const result = await disableIdentity({ token: input.token, reason: input.reason });
        if (!result.ok) fail(result.code, result.message);

        logger.info(
          { user: auth.username, dyn: maskId(input.token), strategy: result.strategy },
          "Customer disabled"
        );
        return successResponse({
          ok: true,
          status: result.status,
          strategy: result.strategy,
          syncPending: result.syncPending,
        });
      }

      // ── Enable ─────────────────────────────────────────────────────────────
      case "enable": {
        const input = enableDynamicSchema.parse(body);
        const result = await enableIdentity({ token: input.token, serverId: input.serverId });
        if (!result.ok) fail(result.code, result.message);

        const record = await readDynamicRecord(input.token);
        logger.info(
          { user: auth.username, dyn: maskId(input.token), recreated: result.recreatedKey },
          "Customer enabled"
        );
        return successResponse({
          ok: true,
          recreatedKey: result.recreatedKey,
          outlineKeyId: result.outlineKeyId,
          // Proof for the operator that the URL did not change.
          dynamicUrl: record ? buildDynamicUrl(record.token, record.name) : null,
          syncPending: result.syncPending,
        });
      }

      // ── Renew ──────────────────────────────────────────────────────────────
      case "renew": {
        const input = renewDynamicSchema.parse(body);
        const result = await renewIdentity(input.token, input.additionalCycles);
        if (!result.ok) fail(result.code, result.message);

        logger.info(
          { user: auth.username, dyn: maskId(input.token), cycles: input.additionalCycles },
          "Subscription renewed"
        );
        return successResponse({
          ok: true,
          expiryDate: result.expiryDate,
          cyclesTotal: result.cyclesTotal,
          syncPending: result.syncPending,
        });
      }

      // ── Quota change ───────────────────────────────────────────────────────
      case "updateQuota": {
        const input = updateQuotaSchema.parse(body);
        const result = await updateQuota(input.token, input.quotaGB);
        if (!result.ok) fail(result.code, result.message);

        logger.info({ user: auth.username, dyn: maskId(input.token) }, "Quota updated");
        return successResponse({
          ok: true,
          quotaBytes: result.quotaBytes,
          appliedBytes: result.appliedBytes,
          // Unchanged by construction: no token or projection change.
          urlChanged: false,
        });
      }

      // ── Edit subscription (quota + expiry together) ────────────────────────
      case "editSubscription": {
        const input = editSubscriptionSchema.parse(body);
        const result = await editSubscription(input.token, {
          quotaGB: input.quotaGB,
          expiryDate: input.expiryDate ?? null,
        });
        if (!result.ok) fail(result.code, result.message);

        logger.info({ user: auth.username, dyn: maskId(input.token) }, "Subscription edited");
        return successResponse({
          ok: true,
          quotaBytes: result.quotaBytes,
          expiryDate: result.expiryDate,
          disabledImmediately: result.disabledImmediately,
          syncPending: result.syncPending,
          urlChanged: false,
        });
      }

      // ── Migrate ────────────────────────────────────────────────────────────
      case "migrate": {
        const input = migrateDynamicSchema.parse(body);
        const result = await migrateToServer({
          token: input.token,
          destServerId: input.destServerId,
          allowExhausted: input.allowExhausted,
        });
        if (!result.ok) fail(result.code, result.message, result.detail);

        logger.info(
          {
            user: auth.username,
            dyn: maskId(input.token),
            from: result.sourceServerId,
            to: result.destServerId,
          },
          "Customer migrated; source key left alive"
        );
        return successResponse({
          ok: true,
          sourceServerId: result.sourceServerId,
          sourceKeyId: result.sourceKeyId,
          destServerId: result.destServerId,
          destKeyId: result.destKeyId,
          carriedBytes: result.carriedBytes,
          appliedLimitBytes: result.appliedLimitBytes,
          urlChanged: false,
          cleanupRequired: true,
          syncPending: result.syncPending,
        });
      }

      // ── Migration cleanup ──────────────────────────────────────────────────
      case "migrateCleanup": {
        const input = migrateCleanupSchema.parse(body);
        const result = await cleanupMigration(input.token);
        if (!result.ok) fail(result.code, result.message, result.detail);

        logger.info(
          { user: auth.username, dyn: maskId(input.token), deleted: result.deleted.length },
          "Migration cleanup completed"
        );
        return successResponse({
          ok: true,
          deleted: result.deleted,
          skipped: result.skipped,
        });
      }

      // ── Reveal raw key (audited) ────────────────────────────────────────────
      case "revealRaw": {
        const input = tokenOnlySchema.parse(body);
        const record = await readDynamicRecord(input.token);
        if (!record) fail("NOT_FOUND", "Customer identity not found.");

        // Audited deliberately: this is the one path that exposes key material.
        logger.warn(
          { user: auth.username, dyn: maskId(input.token) },
          "Raw access key revealed to an administrator"
        );
        return successResponse({
          ok: true,
          accessUrl: record!.accessUrl,
          serverId: record!.serverId,
          outlineKeyId: record!.outlineKeyId,
        });
      }

      // ── Force edge resync ──────────────────────────────────────────────────
      case "resync": {
        const input = tokenOnlySchema.parse(body);
        const result = await forceSync(input.token, { force: true });
        logger.info(
          { user: auth.username, dyn: maskId(input.token), ok: result.ok },
          "Edge projection resync requested"
        );
        return successResponse({
          ok: result.ok,
          reason: result.ok ? undefined : result.reason,
        });
      }
    }
  } catch (error) {
    return handleApiError(error);
  }
}
