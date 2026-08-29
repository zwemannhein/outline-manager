/**
 * 30-day quota cycles and subscription expiry.
 *
 * BUSINESS RULE
 * Quota is per 30-day cycle, never a pooled total:
 *
 *   100 GB x 6 months  =  100 GB every 30 days, for 6 cycles  (up to 600 GB)
 *
 * Unused quota does not roll over. Each valid new cycle restores the purchased
 * monthly allowance and clears migration debt. An expired subscription receives
 * no further cycle.
 *
 * WHY THIS MATCHES OUTLINE
 * Outline's `enforceAccessKeyDataLimits` compares usage over a rolling 30-day
 * window. Because a cycle is exactly 30 days, "usage in the rolling window"
 * equals "usage since cycle start" for the current key — nothing has aged out
 * yet. So enforcement is native and we keep no cumulative counter.
 *
 * ANCHORING
 * Rollover sets `periodStart = previousPeriodStart + 30 days`, never `now`. The
 * cron runs hourly and may be late; using `now` would let cycle boundaries drift
 * forward on every rollover and slowly desynchronise from the billing date.
 *
 * ORDER OF OPERATIONS
 * Expiry is processed BEFORE rollover. Otherwise a subscription that ended could
 * be handed one extra cycle by a rollover that ran first.
 *
 * COST
 * Both passes are driven by sorted-set due indexes, so the cron is O(due) rather
 * than O(customers). Scanning every identity hourly would cost roughly 864k
 * Upstash commands/month at 300 customers, which exceeds the 500k free tier.
 * Rollover also performs ZERO Cloudflare KV writes, because neither accessUrl nor
 * status changes — only the Outline limit and Redis metadata.
 */

import { createLogger, maskId } from "./logger";
import {
  DYN_CYCLE_DUE,
  DYN_EXPIRY_DUE,
  getDueTokens,
  readDynamicRecord,
  scheduleCycleDue,
  clearCycleDue,
  clearExpiryDue,
} from "./dynamic-keys";
import {
  readKeyMeta,
  writeKeyMeta,
  advanceCycle,
  cycleDueAt,
  expiryAt,
  cyclesExhausted,
  isExpired,
} from "./key-meta";
import { applyDataLimit } from "./outline-admin";
import { disableIdentity } from "./dynamic-lifecycle";

const logger = createLogger("quota-cycles");

export interface ExpiryPassReport {
  due: number;
  expired: number;
  skipped: number;
  failed: number;
}

export interface RolloverPassReport {
  due: number;
  rolled: number;
  skippedExpired: number;
  skippedExhausted: number;
  failed: number;
}

/**
 * Disable subscriptions whose expiry has arrived.
 *
 * Uses DISABLE, not revocation, so a renewal restores service under the SAME
 * permanent ssconf:// URL. That is the whole point of the token indirection.
 */
export async function processExpiries(
  nowMs = Date.now(),
  limit = 50
): Promise<ExpiryPassReport> {
  const tokens = await getDueTokens(DYN_EXPIRY_DUE, nowMs, limit);

  let expired = 0;
  let skipped = 0;
  let failed = 0;

  for (const token of tokens) {
    const record = await readDynamicRecord(token);

    if (!record || record.status === "revoked") {
      await clearExpiryDue(token);
      skipped += 1;
      continue;
    }

    // Already blocked: just drop the due entry.
    if (record.status === "expired" || record.status === "disabled") {
      await clearExpiryDue(token);
      // An expired customer must never receive another cycle.
      await clearCycleDue(token);
      skipped += 1;
      continue;
    }

    const meta = await readKeyMeta(record.serverId, record.outlineKeyId);
    if (!meta || !isExpired(meta, nowMs)) {
      // Expiry was extended (renewal) after the entry was scheduled.
      if (meta) {
        const next = expiryAt(meta);
        if (next && next > nowMs) {
          await clearExpiryDue(token);
          skipped += 1;
          continue;
        }
      }
      await clearExpiryDue(token);
      skipped += 1;
      continue;
    }

    const result = await disableIdentity({ token, reason: "expiry" });
    if (result.ok) {
      await clearExpiryDue(token);
      await clearCycleDue(token);
      expired += 1;
      logger.info({ dyn: maskId(token) }, "Subscription expired and access disabled");
    } else {
      // Leave the due entry so the next tick retries.
      failed += 1;
      logger.error({ dyn: maskId(token), code: result.code }, "Expiry disable failed");
    }
  }

  return { due: tokens.length, expired, skipped, failed };
}

/**
 * Advance cycles that have come due, restoring the monthly quota.
 *
 * Deliberately performs no Cloudflare KV write: the public projection is
 * unchanged, which is what keeps the free tier viable.
 */
export async function processCycleRollovers(
  nowMs = Date.now(),
  limit = 50
): Promise<RolloverPassReport> {
  const tokens = await getDueTokens(DYN_CYCLE_DUE, nowMs, limit);

  let rolled = 0;
  let skippedExpired = 0;
  let skippedExhausted = 0;
  let failed = 0;

  for (const token of tokens) {
    const record = await readDynamicRecord(token);

    if (!record || record.status === "revoked") {
      await clearCycleDue(token);
      skippedExhausted += 1;
      continue;
    }

    // Expired or disabled identities get no new cycle. The expiry pass ran first,
    // so this is the authoritative check.
    if (record.status !== "active") {
      await clearCycleDue(token);
      skippedExpired += 1;
      continue;
    }

    const meta = await readKeyMeta(record.serverId, record.outlineKeyId);
    if (!meta) {
      await clearCycleDue(token);
      failed += 1;
      continue;
    }

    if (isExpired(meta, nowMs)) {
      // Belt and braces: never roll a subscription that has ended.
      await clearCycleDue(token);
      skippedExpired += 1;
      continue;
    }

    if (cyclesExhausted(meta)) {
      await clearCycleDue(token);
      skippedExhausted += 1;
      continue;
    }

    // Anchored advance: previousPeriodStart + 30 days, never `now`.
    const next = advanceCycle(meta);

    try {
      // Restore the full monthly allowance. This also undoes any reduction a
      // mid-cycle migration applied to the destination key.
      await applyDataLimit(record.serverId, record.outlineKeyId, next.quotaBytes ?? null);
    } catch {
      failed += 1;
      logger.error({ dyn: maskId(token) }, "Failed to restore quota at cycle rollover");
      // Leave the due entry so the next tick retries.
      continue;
    }

    await writeKeyMeta(record.serverId, record.outlineKeyId, next);

    // Schedule the following boundary from the NEW anchor.
    const nextDue = cycleDueAt(next);
    if (nextDue) {
      await scheduleCycleDue(token, nextDue);
    } else {
      await clearCycleDue(token);
    }

    rolled += 1;
    logger.info(
      { dyn: maskId(token), cyclesUsed: next.cyclesUsed, cyclesTotal: next.cyclesTotal },
      "Cycle rolled over; monthly quota restored"
    );
  }

  return {
    due: tokens.length,
    rolled,
    skippedExpired,
    skippedExhausted,
    failed,
  };
}
