/**
 * Server-authoritative Outline key metadata.
 *
 * WHY THIS EXISTS
 * Quota and expiry used to live inside `outline_admin_data.keyMeta`, a blob the
 * admin browser reads from localStorage, mutates wholesale, and pushes back. Two
 * mechanisms destroyed server-written values there: the full-blob overwrite, and
 * the store route's Zod schema silently stripping unknown keys. Those fields are
 * now enforcement inputs, so they live in a separate hash that only the server
 * writes.
 *
 *   outline_key_meta      hash, field = "<serverId>:<outlineKeyId>", value = JSON
 *
 * QUOTA MODEL (final product rule)
 * Quota is per 30-DAY CYCLE, not a pooled total.
 *
 *   100 GB x 6 months  =  100 GB every 30 days, for 6 cycles  (up to 600 GB)
 *
 * Unused quota never rolls over. This aligns with how Outline itself enforces
 * limits — `enforceAccessKeyDataLimits` compares usage over a rolling 30-day
 * window — so enforcement is native and we hold no cumulative counter.
 *
 * The load-bearing property: within any window of <= 30 days, Outline's rolling
 * window is arithmetically identical to "cumulative since cycle start", because
 * nothing has aged out yet. Cycle length is exactly 30 days, so that always holds.
 */

import { getRedis } from "./api-utils";
import { createLogger } from "./logger";
import type { KeyMeta } from "./types";

const logger = createLogger("key-meta");

export const KEY_META_HASH = "outline_key_meta";
export const LEGACY_ADMIN_DATA_KEY = "outline_admin_data";
const MIGRATION_FLAG = "migrations:keymeta_split_v1";

/** Exactly 30 days. Cycles are anchored, never "now + 30d". */
export const CYCLE_DAYS = 30;
export const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;

export const GIB = 1024 * 1024 * 1024;

export function metaField(serverId: string, outlineKeyId: string): string {
  return `${serverId}:${outlineKeyId}`;
}

function emptyMeta(): KeyMeta {
  return {
    expiryDate: null,
    quotaBytes: null,
    periodStart: null,
    carriedBytes: 0,
    cyclesTotal: 1,
    cyclesUsed: 1,
    updatedAt: new Date().toISOString(),
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function readKeyMeta(
  serverId: string,
  outlineKeyId: string
): Promise<KeyMeta | null> {
  const redis = getRedis();
  const raw = await redis.hget<string | KeyMeta>(
    KEY_META_HASH,
    metaField(serverId, outlineKeyId)
  );
  if (!raw) return null;

  if (typeof raw === "object") return raw as KeyMeta;
  try {
    return JSON.parse(raw) as KeyMeta;
  } catch {
    return null;
  }
}

/** All metadata, keyed `<serverId>:<keyId>`. */
export async function readAllKeyMeta(): Promise<Record<string, KeyMeta>> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string | KeyMeta>>(KEY_META_HASH);
  if (!raw) return {};

  const out: Record<string, KeyMeta> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!value) continue;
    if (typeof value === "object") {
      out[field] = value as KeyMeta;
      continue;
    }
    try {
      out[field] = JSON.parse(value) as KeyMeta;
    } catch {
      // Skip unparseable entries rather than failing the whole read.
    }
  }
  return out;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Replace the whole metadata record for one key. */
export async function writeKeyMeta(
  serverId: string,
  outlineKeyId: string,
  meta: KeyMeta
): Promise<KeyMeta> {
  const redis = getRedis();
  const next: KeyMeta = { ...meta, updatedAt: new Date().toISOString() };
  await redis.hset(KEY_META_HASH, {
    [metaField(serverId, outlineKeyId)]: JSON.stringify(next),
  });
  return next;
}

/**
 * Field-level merge, never a whole-object replace, so two admins editing
 * different fields cannot clobber each other.
 */
export async function patchKeyMeta(
  serverId: string,
  outlineKeyId: string,
  patch: Partial<KeyMeta>
): Promise<KeyMeta> {
  const existing = (await readKeyMeta(serverId, outlineKeyId)) ?? emptyMeta();
  return writeKeyMeta(serverId, outlineKeyId, { ...existing, ...patch });
}

export async function deleteKeyMeta(serverId: string, outlineKeyId: string): Promise<void> {
  const redis = getRedis();
  await redis.hdel(KEY_META_HASH, metaField(serverId, outlineKeyId));
}

/** Move metadata to a different key, used when migration replaces the key. */
export async function copyKeyMeta(
  from: { serverId: string; outlineKeyId: string },
  to: { serverId: string; outlineKeyId: string },
  patch: Partial<KeyMeta> = {}
): Promise<KeyMeta> {
  const existing = (await readKeyMeta(from.serverId, from.outlineKeyId)) ?? emptyMeta();
  return writeKeyMeta(to.serverId, to.outlineKeyId, { ...existing, ...patch });
}

// ── Cycle helpers ─────────────────────────────────────────────────────────────

/**
 * Build the metadata for a newly approved subscription.
 *
 * `expiryDate` is anchored to periodStart + cyclesTotal * 30 days, computed once
 * so later cron delays cannot shift it.
 */
export function buildInitialMeta(params: {
  quotaBytes: number | null;
  cyclesTotal: number;
  startedAt?: Date;
}): KeyMeta {
  const start = params.startedAt ?? new Date();
  const cycles = Math.max(1, Math.floor(params.cyclesTotal || 1));

  return {
    quotaBytes: params.quotaBytes,
    periodStart: start.toISOString(),
    carriedBytes: 0,
    cyclesTotal: cycles,
    cyclesUsed: 1,
    expiryDate: new Date(start.getTime() + cycles * CYCLE_MS).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** When the current cycle ends: periodStart + exactly 30 days. */
export function cycleDueAt(meta: KeyMeta): number | null {
  if (!meta.periodStart) return null;
  const start = Date.parse(meta.periodStart);
  if (Number.isNaN(start)) return null;
  return start + CYCLE_MS;
}

export function expiryAt(meta: KeyMeta): number | null {
  if (!meta.expiryDate) return null;
  const t = Date.parse(meta.expiryDate);
  return Number.isNaN(t) ? null : t;
}

export function isExpired(meta: KeyMeta, nowMs = Date.now()): boolean {
  const t = expiryAt(meta);
  return t !== null && t <= nowMs;
}

/** True when every purchased cycle has been consumed. */
export function cyclesExhausted(meta: KeyMeta): boolean {
  const total = meta.cyclesTotal ?? 1;
  const used = meta.cyclesUsed ?? 1;
  return used >= total;
}

/**
 * Advance one cycle, anchored to the previous periodStart.
 *
 * Deliberately NOT `periodStart = now`: the cron runs hourly and may be late, and
 * using `now` would let the cycle boundary drift forward on every rollover.
 */
export function advanceCycle(meta: KeyMeta): KeyMeta {
  const prevStart = meta.periodStart ? Date.parse(meta.periodStart) : Date.now();
  const base = Number.isNaN(prevStart) ? Date.now() : prevStart;

  return {
    ...meta,
    periodStart: new Date(base + CYCLE_MS).toISOString(),
    // Migration debt is cleared: the new cycle starts with the full allowance.
    carriedBytes: 0,
    cyclesUsed: (meta.cyclesUsed ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Extend a subscription by additional cycles, preserving the existing anchor.
 * Used by renewal, which must not change the customer's permanent URL.
 */
export function extendCycles(meta: KeyMeta, additionalCycles: number): KeyMeta {
  const add = Math.max(1, Math.floor(additionalCycles));
  const total = (meta.cyclesTotal ?? 1) + add;

  const anchor = meta.periodStart ? Date.parse(meta.periodStart) : Date.now();
  const base = Number.isNaN(anchor) ? Date.now() : anchor;

  // Expiry counts remaining cycles from the CURRENT period start, so a renewal
  // during cycle 3 of 6 yields 3 remaining + the added cycles.
  const remaining = total - (meta.cyclesUsed ?? 1) + 1;

  return {
    ...meta,
    cyclesTotal: total,
    expiryDate: new Date(base + remaining * CYCLE_MS).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface QuotaUsage {
  /** Quota for the current cycle. null = unlimited. */
  quotaBytes: number | null;
  /** Usage on previous keys during this cycle. */
  carriedBytes: number;
  /** Usage reported by the current Outline key. */
  currentKeyBytes: number;
  /** carriedBytes + currentKeyBytes. */
  totalUsedBytes: number;
  /** Remaining allowance, or null when unlimited. Never negative. */
  remainingBytes: number | null;
  exhausted: boolean;
}

/**
 * Combine stored migration debt with live Outline usage.
 *
 * `currentKeyBytes` comes from Outline's `/metrics/transfer`, which reports a
 * rolling 30-day window. Within a 30-day cycle that equals cumulative usage for
 * the current key, so adding `carriedBytes` gives cycle-to-date consumption.
 */
export function computeQuotaUsage(meta: KeyMeta, currentKeyBytes: number): QuotaUsage {
  const carried = Math.max(0, meta.carriedBytes ?? 0);
  const current = Math.max(0, currentKeyBytes || 0);
  const total = carried + current;
  const quota = meta.quotaBytes ?? null;

  return {
    quotaBytes: quota,
    carriedBytes: carried,
    currentKeyBytes: current,
    totalUsedBytes: total,
    remainingBytes: quota === null ? null : Math.max(0, quota - total),
    exhausted: quota !== null && total >= quota,
  };
}

/** Human-readable plan wording. Never describes a multi-cycle plan as one pool. */
export function describeQuota(meta: KeyMeta): string {
  const cycles = meta.cyclesTotal ?? 1;
  if (meta.quotaBytes === null || meta.quotaBytes === undefined) {
    return cycles > 1 ? `Unlimited for ${cycles} x 30 days` : "Unlimited for 30 days";
  }
  const gb = Math.round((meta.quotaBytes / GIB) * 100) / 100;
  return cycles > 1
    ? `${gb} GB every 30 days x ${cycles} cycles`
    : `${gb} GB every 30 days`;
}

// ── Forward migration ─────────────────────────────────────────────────────────

interface LegacyAdminData {
  servers?: unknown[];
  keyMeta?: Record<string, KeyMeta>;
}

/**
 * One-time, idempotent copy of legacy `outline_admin_data.keyMeta` into the
 * server-authoritative hash.
 *
 * Existing entries in the new hash win, so re-running never regresses newer
 * values. The legacy copy is intentionally left in place as a rollback source;
 * it simply stops being read.
 */
export async function migrateLegacyKeyMeta(): Promise<{
  migrated: number;
  skipped: number;
  alreadyDone: boolean;
}> {
  const redis = getRedis();

  const done = await redis.get<string>(MIGRATION_FLAG);
  if (done) return { migrated: 0, skipped: 0, alreadyDone: true };

  const rawAdmin = await redis.get<LegacyAdminData | string>(LEGACY_ADMIN_DATA_KEY);
  let adminData: LegacyAdminData | null = null;
  if (typeof rawAdmin === "string") {
    try {
      adminData = JSON.parse(rawAdmin) as LegacyAdminData;
    } catch {
      adminData = null;
    }
  } else {
    adminData = rawAdmin ?? null;
  }

  const legacy = adminData?.keyMeta ?? {};
  const target = await readAllKeyMeta();

  let migrated = 0;
  let skipped = 0;

  for (const [field, meta] of Object.entries(legacy)) {
    if (target[field]) {
      skipped += 1;
      continue;
    }
    await redis.hset(KEY_META_HASH, {
      [field]: JSON.stringify({
        ...emptyMeta(),
        ...meta,
        updatedAt: new Date().toISOString(),
      }),
    });
    migrated += 1;
  }

  await redis.set(MIGRATION_FLAG, new Date().toISOString());

  logger.info({ migrated, skipped }, "Legacy keyMeta migration complete");
  return { migrated, skipped, alreadyDone: false };
}
