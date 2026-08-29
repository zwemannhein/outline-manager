/**
 * Server migration with current-cycle quota preservation.
 *
 * GOAL
 * Move a customer from Outline server A to server B without changing their
 * permanent ssconf:// URL, and without gifting them a fresh monthly allowance.
 *
 * THE QUOTA PROBLEM
 * Outline usage counters are per access key. A new key on the destination starts
 * at zero bytes, so naively re-applying the monthly quota would hand a customer
 * who had used 80 of 100 GB a further 100 GB.
 *
 * Fix: reduce the destination limit to what actually remains, and record the
 * consumed amount as `carriedBytes` so the arithmetic still works after a second
 * migration in the same cycle.
 *
 *   totalUsed  = carriedBytes + usageOnSourceKey
 *   remaining  = quotaBytes - totalUsed
 *   destination limit  = remaining
 *   destination carriedBytes = totalUsed
 *
 * At the next cycle rollover `carriedBytes` resets to 0 and the full monthly
 * quota is restored, so the reduction is temporary by construction.
 *
 * TWO PHASES
 * Phase A creates the destination key and re-points the identity, leaving the
 * SOURCE KEY ALIVE. Phase B deletes it later, and refuses to run until the
 * Cloudflare KV projection has caught up. That ordering is what makes the whole
 * operation zero-downtime and safe against a KV write failure:
 *
 *   destination live + Upstash switched + KV write failed
 *     → the edge still serves the OLD accessUrl
 *     → the old key still works
 *     → the customer never notices, and the cron repairs the projection
 *
 * Nothing here deletes an Outline key. That is Phase B's sole job.
 */

import { createLogger, maskId } from "./logger";
import {
  readDynamicRecord,
  repointDynamicIdentity,
  pendingCleanupEntries,
  markHistoryCleanedUp,
} from "./dynamic-keys";
import {
  readKeyMeta,
  writeKeyMeta,
  computeQuotaUsage,
  cycleDueAt,
  expiryAt,
} from "./key-meta";
import {
  createAccessKey,
  deleteAccessKey,
  applyDataLimit,
  getKeyUsageBytes,
  accessKeyExists,
  resolveServer,
  listRegisteredServers,
} from "./outline-admin";
import { syncDynamicToken, verifyProjectionCurrent } from "./kv-sync";
import { scheduleCycleDue, scheduleExpiryDue } from "./dynamic-keys";

const logger = createLogger("server-migration");

export interface MigrateOptions {
  token: string;
  destServerId: string;
  /**
   * Emergency override for decommissioning a server. Without it, a customer whose
   * cycle quota is exhausted cannot be migrated, because the destination limit
   * would be zero and the key would be born blocked.
   */
  allowExhausted?: boolean;
}

export type MigrateResult =
  | {
      ok: true;
      token: string;
      /** Unchanged — asserted by tests. */
      dynamicUrlChanged: false;
      sourceServerId: string;
      sourceKeyId: string;
      destServerId: string;
      destKeyId: string;
      quotaBytes: number | null;
      carriedBytes: number;
      appliedLimitBytes: number | null;
      cleanupRequired: true;
      syncPending: boolean;
    }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "NOT_ACTIVE"
        | "SAME_SERVER"
        | "DEST_NOT_FOUND"
        | "QUOTA_EXHAUSTED"
        | "OUTLINE_FAILED"
        | "STATE_CONFLICT";
      message: string;
      /** Present on QUOTA_EXHAUSTED so the admin can decide about the override. */
      detail?: { quotaBytes: number | null; totalUsedBytes: number };
    };

/**
 * Phase A: create the destination key, apply remaining quota, switch the pointer.
 * Leaves the source key alive.
 */
export async function migrateToServer(options: MigrateOptions): Promise<MigrateResult> {
  const record = await readDynamicRecord(options.token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }
  if (record.status !== "active") {
    return {
      ok: false,
      code: "NOT_ACTIVE",
      message: "Only an active customer can be migrated. Enable them first.",
    };
  }
  if (record.serverId === options.destServerId) {
    return {
      ok: false,
      code: "SAME_SERVER",
      message: "The customer is already on that server.",
    };
  }

  const servers = await listRegisteredServers();
  const dest = servers.find((s) => s.id === options.destServerId);
  if (!dest) {
    return { ok: false, code: "DEST_NOT_FOUND", message: "Destination server is not registered." };
  }
  await resolveServer(dest.id);

  // ── Quota arithmetic ──────────────────────────────────────────────────────
  const meta = await readKeyMeta(record.serverId, record.outlineKeyId);

  // Usage on the source key. If the source is unreachable we cannot compute
  // remaining quota honestly, so treat it as zero and log — the alternative
  // (blocking migration off a dead server) is worse operationally.
  let sourceUsage = 0;
  try {
    sourceUsage = await getKeyUsageBytes(record.serverId, record.outlineKeyId);
  } catch {
    logger.warn(
      { dyn: maskId(record.token), serverId: record.serverId },
      "Source usage unreadable; migrating with sourceUsage=0"
    );
  }

  const quotaBytes = meta?.quotaBytes ?? null;
  const carriedBefore = Math.max(0, meta?.carriedBytes ?? 0);
  const totalUsed = carriedBefore + Math.max(0, sourceUsage);

  let appliedLimit: number | null = null;
  if (quotaBytes !== null) {
    const usage = computeQuotaUsage(meta ?? { expiryDate: null, quotaBytes }, sourceUsage);
    const remaining = usage.remainingBytes ?? 0;

    if (remaining <= 0 && !options.allowExhausted) {
      return {
        ok: false,
        code: "QUOTA_EXHAUSTED",
        message:
          "This customer has used their full quota for the current cycle. Migrating now would give them no usable data. Use the admin override if you are decommissioning the server.",
        detail: { quotaBytes, totalUsedBytes: totalUsed },
      };
    }

    // With the override, a floor of 0 means the key exists but passes no traffic
    // until the next cycle restores the allowance.
    appliedLimit = Math.max(0, remaining);
  }

  // ── Create and configure the destination key ──────────────────────────────
  let destKeyId: string;
  let destAccessUrl: string;
  try {
    const created = await createAccessKey(dest.id, record.name);
    destKeyId = created.id;
    destAccessUrl = created.accessUrl;
    await applyDataLimit(dest.id, destKeyId, appliedLimit);
  } catch (err) {
    // Nothing has been switched: the customer is untouched on the source server.
    logger.error(
      { dyn: maskId(record.token), destServerId: dest.id },
      "Destination key creation failed; migration aborted with no changes"
    );
    return {
      ok: false,
      code: "OUTLINE_FAILED",
      message: "Could not create the key on the destination server. Nothing was changed.",
    };
  }

  // ── Carry metadata, recording consumed bytes as debt ──────────────────────
  const nextMeta = {
    ...(meta ?? {
      expiryDate: null,
      quotaBytes,
      periodStart: new Date().toISOString(),
      cyclesTotal: 1,
      cyclesUsed: 1,
    }),
    // Accumulates across multiple migrations inside one cycle.
    carriedBytes: totalUsed,
  };
  await writeKeyMeta(dest.id, destKeyId, nextMeta);

  // ── Atomic switchover ─────────────────────────────────────────────────────
  const repoint = await repointDynamicIdentity({
    token: record.token,
    destServerId: dest.id,
    destOutlineKeyId: destKeyId,
    destAccessUrl,
    reason: "migrate",
    status: "active",
    // Records the source key in history with cleanedUp: false.
    trackPreviousForCleanup: true,
  });

  if (!repoint.ok) {
    logger.error(
      { dyn: maskId(record.token) },
      "Repoint failed after destination key creation; destination key is orphaned"
    );
    return {
      ok: false,
      code: "STATE_CONFLICT",
      message:
        "The identity changed while migrating. The destination key was created but not attached; reconcile manually.",
    };
  }

  // Re-anchor cron schedules against the new key's metadata.
  const cycleDue = cycleDueAt(nextMeta);
  if (cycleDue) await scheduleCycleDue(record.token, cycleDue);
  const expiry = expiryAt(nextMeta);
  if (expiry) await scheduleExpiryDue(record.token, expiry);

  // ── Project to the edge. Failure here is SAFE: the old key is still alive. ─
  const sync = await syncDynamicToken(record.token, { force: true });

  logger.info(
    {
      dyn: maskId(record.token),
      from: record.serverId,
      to: dest.id,
      carriedBytes: totalUsed,
      syncPending: !sync.ok,
    },
    "Migration phase A complete; source key left alive"
  );

  return {
    ok: true,
    token: record.token,
    dynamicUrlChanged: false,
    sourceServerId: record.serverId,
    sourceKeyId: record.outlineKeyId,
    destServerId: dest.id,
    destKeyId,
    quotaBytes,
    carriedBytes: totalUsed,
    appliedLimitBytes: appliedLimit,
    cleanupRequired: true,
    syncPending: !sync.ok,
  };
}

export type CleanupResult =
  | { ok: true; deleted: Array<{ serverId: string; outlineKeyId: string }>; skipped: number }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOTHING_TO_CLEAN" | "PROJECTION_STALE" | "OUTLINE_FAILED";
      message: string;
      detail?: { authoritativeRev: number; kvRev: number | null };
    };

/**
 * Phase B: delete superseded Outline keys.
 *
 * REFUSES to run while the Cloudflare KV projection is behind the authoritative
 * revision. If the edge still serves the old accessUrl and we deleted that key,
 * the customer would lose service immediately — this check is the interlock that
 * makes a KV write failure harmless rather than an outage.
 */
export async function cleanupMigration(token: string): Promise<CleanupResult> {
  const record = await readDynamicRecord(token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }

  const pending = pendingCleanupEntries(record);
  if (pending.length === 0) {
    return { ok: false, code: "NOTHING_TO_CLEAN", message: "No superseded keys awaiting cleanup." };
  }

  // Interlock: the edge must already point at the new key.
  const projection = await verifyProjectionCurrent(record);
  if (!projection.current) {
    logger.warn(
      { dyn: maskId(token), authoritativeRev: record.rev, kvRev: projection.kvRev },
      "Cleanup refused: edge projection is stale"
    );
    return {
      ok: false,
      code: "PROJECTION_STALE",
      message:
        "The edge configuration has not caught up yet. Cleanup is blocked until it syncs, so the customer keeps working.",
      detail: { authoritativeRev: record.rev, kvRev: projection.kvRev },
    };
  }

  const deleted: Array<{ serverId: string; outlineKeyId: string }> = [];
  let skipped = 0;

  for (const entry of pending) {
    // Never delete the key the identity currently points at.
    if (entry.serverId === record.serverId && entry.outlineKeyId === record.outlineKeyId) {
      await markHistoryCleanedUp(token, entry.serverId, entry.outlineKeyId);
      skipped += 1;
      continue;
    }

    const exists = await accessKeyExists(entry.serverId, entry.outlineKeyId).catch(() => false);
    if (!exists) {
      // Already gone; just close the history entry.
      await markHistoryCleanedUp(token, entry.serverId, entry.outlineKeyId);
      skipped += 1;
      continue;
    }

    try {
      await deleteAccessKey(entry.serverId, entry.outlineKeyId);
      await markHistoryCleanedUp(token, entry.serverId, entry.outlineKeyId);
      deleted.push({ serverId: entry.serverId, outlineKeyId: entry.outlineKeyId });
    } catch {
      logger.error(
        { dyn: maskId(token), serverId: entry.serverId },
        "Failed to delete a superseded Outline key"
      );
      return {
        ok: false,
        code: "OUTLINE_FAILED",
        message: "Could not delete the old key. It remains in place; retry later.",
      };
    }
  }

  logger.info({ dyn: maskId(token), deleted: deleted.length, skipped }, "Migration cleanup complete");

  return { ok: true, deleted, skipped };
}
