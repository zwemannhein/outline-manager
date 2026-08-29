/**
 * Lifecycle operations on a permanent customer identity.
 *
 * Disable, enable, renew, and quota changes — all of which must leave the
 * customer's ssconf:// URL untouched.
 *
 * ── TWO GATES ───────────────────────────────────────────────────────────────
 * A customer has service only when BOTH gates are open:
 *
 *   1. config delivery  — the KV projection has status "active"
 *   2. Outline access   — the underlying key actually passes traffic
 *
 * Closing only gate 1 is NOT enough. A client that already fetched its ss://
 * config keeps connecting directly to the Outline server indefinitely, without
 * ever consulting the Worker again. So disable must act on Outline too.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * Outline first, then Upstash, then KV. Outline is the real enforcement point, so
 * every partial failure leaves access CLOSED rather than open:
 *
 *   disable: Outline blocked, KV write fails → config resolves but no traffic
 *   enable : Outline opened,  KV write fails → config 404s, so still no traffic
 *
 * ── HOW DISABLE BLOCKS OUTLINE ──────────────────────────────────────────────
 * Two strategies, selected by DISABLE_STRATEGY:
 *
 *   "limit"  set the data limit to DISABLE_BLOCK_BYTES (default 0). Reversible
 *            and cheap. Outline's setAccessKeyDataLimit calls
 *            enforceAccessKeyDataLimits synchronously, which drops the key from
 *            the live Shadowsocks config immediately — so new connections are
 *            refused at once. Whether an ESTABLISHED TCP session is torn down is
 *            not documented and must be measured; see scripts/outline-disable-probe.
 *
 *   "remove" delete the Outline key outright. Unambiguous, and the correct choice
 *            if the probe shows a 0-byte limit does not reliably block. Costs a
 *            key recreation on reactivation, which is why the permanent token
 *            indirection exists in the first place.
 *
 * Either way the permanent token, quota state and cycle anchors survive, and
 * reactivation restores the exact previous limit.
 */

import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";
import {
  readDynamicRecord,
  setDynamicStatus,
  repointDynamicIdentity,
  scheduleCycleDue,
  scheduleExpiryDue,
  clearCycleDue,
  clearExpiryDue,
} from "./dynamic-keys";
import {
  readKeyMeta,
  patchKeyMeta,
  copyKeyMeta,
  computeQuotaUsage,
  extendCycles,
  cycleDueAt,
  expiryAt,
  cyclesExhausted,
  isExpired,
  GIB,
} from "./key-meta";
import {
  applyDataLimit,
  getKeyLimitBytes,
  getKeyUsageBytes,
  createAccessKey,
  deleteAccessKey,
  accessKeyExists,
  resolveServer,
} from "./outline-admin";
import { putDynamicProjection, syncDynamicToken } from "./kv-sync";
import type { DynamicKeyRecord, KeyMeta, SuspendedState } from "./types";

const logger = createLogger("dynamic-lifecycle");

export type DisableStrategy = "limit" | "remove";

/**
 * Which mechanism disable uses. Defaults to "limit" because it is reversible and
 * preserves the key; switch to "remove" if the probe proves limits are unreliable.
 */
export function getDisableStrategy(): DisableStrategy {
  return process.env.DISABLE_STRATEGY === "remove" ? "remove" : "limit";
}

/**
 * Byte limit used to block a key under the "limit" strategy.
 *
 * 0 is preferred: `usageBytes >= 0` is true even for a key with no traffic yet,
 * so it blocks immediately. A value of 1 does NOT reliably block a brand-new key,
 * because 0 >= 1 is false — that is exactly the trap this variable exists to
 * avoid, and why the probe script tests 0 explicitly.
 */
export function getDisableBlockBytes(): number {
  const raw = Number(process.env.DISABLE_BLOCK_BYTES ?? "0");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

export type LifecycleResult<T = Record<string, unknown>> =
  | ({ ok: true; syncPending: boolean } & T)
  | { ok: false; code: string; message: string };

// ── Disable ───────────────────────────────────────────────────────────────────

export interface DisableOptions {
  token: string;
  reason?: "manual" | "expiry";
}

/**
 * Close both gates.
 *
 * `suspendedState` is written BEFORE Outline is touched, so a crash cannot lose
 * the previous limit and leave the customer unrestorable.
 */
export async function disableIdentity(
  options: DisableOptions
): Promise<LifecycleResult<{ strategy: DisableStrategy; status: string }>> {
  const record = await readDynamicRecord(options.token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }
  if (record.status === "revoked") {
    return { ok: false, code: "REVOKED", message: "This identity has been revoked." };
  }
  if (record.status === "disabled" || record.status === "expired") {
    // Idempotent: re-run the projection in case a previous KV write failed.
    const sync = await syncDynamicToken(options.token, { force: true });
    return { ok: true, syncPending: !sync.ok, strategy: getDisableStrategy(), status: record.status };
  }

  const reason = options.reason ?? "manual";
  const strategy = getDisableStrategy();

  // 1. Capture the live limit from Outline — the authoritative current value.
  let previousLimitBytes: number | null = null;
  try {
    previousLimitBytes = await getKeyLimitBytes(record.serverId, record.outlineKeyId);
  } catch {
    // Fall back to stored metadata if the server is unreachable.
    const meta = await readKeyMeta(record.serverId, record.outlineKeyId);
    previousLimitBytes = meta?.quotaBytes ?? null;
  }

  const suspendedState: SuspendedState = {
    previousLimitBytes,
    suspendedAt: new Date().toISOString(),
    reason,
    keyRemoved: strategy === "remove",
  };

  // 2. Persist suspendedState first so the restore value cannot be lost.
  const redis = getRedis();
  await redis.hset(`dynamic:${record.token}`, {
    suspendedState: JSON.stringify(suspendedState),
    updatedAt: new Date().toISOString(),
  });

  // 3. Close the Outline gate.
  try {
    if (strategy === "remove") {
      await deleteAccessKey(record.serverId, record.outlineKeyId);
    } else {
      await applyDataLimit(record.serverId, record.outlineKeyId, getDisableBlockBytes());
    }
  } catch (err) {
    logger.error(
      { dyn: maskId(record.token), strategy },
      "Failed to close the Outline gate during disable"
    );
    return {
      ok: false,
      code: "OUTLINE_FAILED",
      message: "Could not block access on the Outline server. Nothing was changed.",
    };
  }

  // 4. Authoritative status.
  const statusResult = await setDynamicStatus(
    record.token,
    reason === "expiry" ? "expired" : "disabled",
    { suspendedState }
  );
  if (!statusResult.ok) {
    return { ok: false, code: "STATE_CONFLICT", message: "Identity state changed concurrently." };
  }

  // 5. Close the config gate. A failure here is safe: Outline already blocks.
  const sync = await syncDynamicToken(record.token, { force: true });

  // Expired identities receive no further cycles.
  if (reason === "expiry") {
    await clearCycleDue(record.token);
  }

  logger.info(
    { dyn: maskId(record.token), reason, strategy },
    "Identity disabled on both gates"
  );

  return {
    ok: true,
    syncPending: !sync.ok,
    strategy,
    status: reason === "expiry" ? "expired" : "disabled",
  };
}

// ── Enable ────────────────────────────────────────────────────────────────────

export interface EnableOptions {
  token: string;
  /** Destination when the underlying key must be recreated. */
  serverId?: string | null;
}

/**
 * Reopen both gates, restoring the correct REMAINING quota for the current cycle
 * rather than a fresh full allowance.
 *
 * If the key was removed (or has since vanished), a replacement is created and
 * the SAME permanent token is repointed at it — the customer's ssconf:// URL does
 * not change.
 */
export async function enableIdentity(
  options: EnableOptions
): Promise<LifecycleResult<{ recreatedKey: boolean; outlineKeyId: string }>> {
  const record = await readDynamicRecord(options.token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }
  if (record.status === "revoked") {
    return { ok: false, code: "REVOKED", message: "This identity has been revoked." };
  }
  if (record.status === "active") {
    const sync = await syncDynamicToken(options.token, { force: true });
    return {
      ok: true,
      syncPending: !sync.ok,
      recreatedKey: false,
      outlineKeyId: record.outlineKeyId,
    };
  }

  const meta = await readKeyMeta(record.serverId, record.outlineKeyId);

  // Refuse to reactivate a subscription that is genuinely over: that is what
  // renewal is for, and silently granting another cycle would be a billing bug.
  if (meta && isExpired(meta) && cyclesExhausted(meta)) {
    return {
      ok: false,
      code: "SUBSCRIPTION_ENDED",
      message: "This subscription has ended. Renew it to restore access.",
    };
  }

  // Restore the REMAINING allowance for the current cycle, not the full quota.
  const restoreLimit = await computeRestoreLimit(record, meta);

  let outlineKeyId = record.outlineKeyId;
  let recreatedKey = false;

  const keyStillExists = record.outlineKeyId
    ? await accessKeyExists(record.serverId, record.outlineKeyId).catch(() => false)
    : false;

  if (keyStillExists) {
    // 1. Reopen the Outline gate by restoring the limit.
    try {
      await applyDataLimit(record.serverId, record.outlineKeyId, restoreLimit);
    } catch {
      return {
        ok: false,
        code: "OUTLINE_FAILED",
        message: "Could not restore access on the Outline server.",
      };
    }
  } else {
    // 2. The key is gone: create a replacement and repoint the same token.
    const destServerId = options.serverId ?? record.serverId;
    try {
      await resolveServer(destServerId);
      const created = await createAccessKey(destServerId, record.name);
      await applyDataLimit(destServerId, created.id, restoreLimit);

      // Carry metadata across to the new key, preserving cycle state.
      await copyKeyMeta(
        { serverId: record.serverId, outlineKeyId: record.outlineKeyId },
        { serverId: destServerId, outlineKeyId: created.id }
      );

      const repoint = await repointDynamicIdentity({
        token: record.token,
        destServerId,
        destOutlineKeyId: created.id,
        destAccessUrl: created.accessUrl,
        reason: "reactivate",
        status: "active",
        // The old key no longer exists, so there is nothing to clean up.
        trackPreviousForCleanup: false,
      });
      if (!repoint.ok) {
        return { ok: false, code: "STATE_CONFLICT", message: "Identity changed concurrently." };
      }

      outlineKeyId = created.id;
      recreatedKey = true;
    } catch (err) {
      logger.error({ dyn: maskId(record.token) }, "Failed to recreate the Outline key on enable");
      return {
        ok: false,
        code: "OUTLINE_FAILED",
        message: "Could not create a replacement key on the Outline server.",
      };
    }
  }

  // 3. Authoritative status → active, clearing suspendedState.
  const statusResult = await setDynamicStatus(record.token, "active", { suspendedState: null });
  if (!statusResult.ok) {
    return { ok: false, code: "STATE_CONFLICT", message: "Identity state changed concurrently." };
  }

  // 4. Reschedule the cron entries that disable removed.
  const finalMeta = await readKeyMeta(
    recreatedKey ? (options.serverId ?? record.serverId) : record.serverId,
    outlineKeyId
  );
  if (finalMeta) {
    const cycleDue = cycleDueAt(finalMeta);
    if (cycleDue) await scheduleCycleDue(record.token, cycleDue);
    const expiry = expiryAt(finalMeta);
    if (expiry) await scheduleExpiryDue(record.token, expiry);
  }

  // 5. Reopen the config gate.
  const sync = await syncDynamicToken(record.token, { force: true });

  logger.info(
    { dyn: maskId(record.token), recreatedKey },
    "Identity enabled on both gates"
  );

  return { ok: true, syncPending: !sync.ok, recreatedKey, outlineKeyId };
}

/**
 * The limit to restore on reactivation.
 *
 * Prefers the remaining allowance for the current cycle so a suspended customer
 * cannot regain a full month's data by being toggled off and on. Falls back to the
 * captured `previousLimitBytes` when metadata is unavailable.
 */
async function computeRestoreLimit(
  record: DynamicKeyRecord,
  meta: KeyMeta | null
): Promise<number | null> {
  if (meta) {
    if (meta.quotaBytes === null || meta.quotaBytes === undefined) return null; // unlimited

    // Usage on the current key may be unreadable if it was removed.
    const currentBytes = await getKeyUsageBytes(record.serverId, record.outlineKeyId).catch(
      () => 0
    );
    const usage = computeQuotaUsage(meta, currentBytes);
    return usage.remainingBytes ?? 0;
  }

  const previous = record.suspendedState?.previousLimitBytes;
  return previous === undefined ? null : previous;
}

// ── Renewal ───────────────────────────────────────────────────────────────────

/**
 * Extend a subscription. The permanent token and URL are untouched — that is the
 * whole point of the indirection.
 */
export async function renewIdentity(
  token: string,
  additionalCycles: number
): Promise<LifecycleResult<{ expiryDate: string | null; cyclesTotal: number }>> {
  const record = await readDynamicRecord(token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }
  if (record.status === "revoked") {
    return { ok: false, code: "REVOKED", message: "This identity has been revoked." };
  }

  const meta = await readKeyMeta(record.serverId, record.outlineKeyId);
  if (!meta) {
    return { ok: false, code: "NO_METADATA", message: "No subscription metadata for this key." };
  }

  const extended = extendCycles(meta, additionalCycles);
  await patchKeyMeta(record.serverId, record.outlineKeyId, extended);

  // Reschedule expiry, and the cycle boundary if it had been cleared.
  const expiry = expiryAt(extended);
  if (expiry) await scheduleExpiryDue(token, expiry);
  const cycleDue = cycleDueAt(extended);
  if (cycleDue) await scheduleCycleDue(token, cycleDue);

  // A renewal reactivates an expired customer, reusing the same URL.
  let syncPending = false;
  if (record.status === "expired" || record.status === "disabled") {
    const enabled = await enableIdentity({ token });
    if (!enabled.ok) {
      return {
        ok: false,
        code: enabled.code,
        message: `Subscription extended, but access could not be restored: ${enabled.message}`,
      };
    }
    syncPending = enabled.syncPending;
  }

  logger.info(
    { dyn: maskId(token), additionalCycles, cyclesTotal: extended.cyclesTotal },
    "Subscription renewed"
  );

  return {
    ok: true,
    syncPending,
    expiryDate: extended.expiryDate ?? null,
    cyclesTotal: extended.cyclesTotal ?? 1,
  };
}

// ── Quota change ──────────────────────────────────────────────────────────────

/**
 * Change the per-cycle quota.
 *
 * Touches only the Outline limit and the metadata. It does NOT change the token,
 * the projection, or `rev`, so it costs zero Cloudflare KV writes and the
 * customer's URL is provably unaffected.
 */
export async function updateQuota(
  token: string,
  quotaGB: number | null
): Promise<LifecycleResult<{ quotaBytes: number | null; appliedBytes: number | null }>> {
  const record = await readDynamicRecord(token);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }

  const quotaBytes = quotaGB === null ? null : Math.floor(quotaGB * GIB);

  const meta = (await readKeyMeta(record.serverId, record.outlineKeyId)) ?? null;

  // Apply the remaining allowance under the new quota, so raising a limit
  // mid-cycle credits the customer and lowering it accounts for usage so far.
  let appliedBytes: number | null = quotaBytes;
  if (quotaBytes !== null && meta) {
    const currentBytes = await getKeyUsageBytes(record.serverId, record.outlineKeyId).catch(() => 0);
    const usage = computeQuotaUsage({ ...meta, quotaBytes }, currentBytes);
    appliedBytes = usage.remainingBytes ?? 0;
  }

  // Only touch Outline while the customer is active; a suspended key must stay
  // blocked until it is explicitly enabled.
  if (record.status === "active") {
    try {
      await applyDataLimit(record.serverId, record.outlineKeyId, appliedBytes);
    } catch {
      return {
        ok: false,
        code: "OUTLINE_FAILED",
        message: "Could not update the limit on the Outline server.",
      };
    }
  }

  await patchKeyMeta(record.serverId, record.outlineKeyId, { quotaBytes });

  logger.info({ dyn: maskId(token) }, "Quota updated without changing the permanent URL");

  // No projection write: accessUrl and status are unchanged.
  return { ok: true, syncPending: false, quotaBytes, appliedBytes };
}
