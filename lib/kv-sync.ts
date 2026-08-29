/**
 * Cloudflare KV projection sync — server-side only.
 *
 * ROLE SPLIT
 *   Upstash  = source of truth. Full identity, quota state, history.
 *   CF KV    = public projection. Only what the edge Worker needs to answer
 *              `GET /k/<token>`: accessUrl, status, rev, updatedAt.
 *
 * Moving the high-frequency public read path to KV is what keeps Upstash inside
 * its 500k commands/month free tier: customer config fetches never touch Redis.
 *
 * WRITE ORDERING DOCTRINE
 *   Outline enforcement  →  Upstash commit  →  Cloudflare KV projection
 *
 * Outline is the real gate, so it moves first and every partial failure leaves
 * access CLOSED rather than open:
 *
 *   grant  : Outline opened, KV write fails  → Worker 404s        → no access
 *   revoke : Outline closed, KV write fails  → config resolves    → no access
 *
 * A failed KV write is never fatal. The token is added to `dyn:kv_dirty` and the
 * hourly cron drains it. `rev` lets us detect drift: KV rev < Upstash rev means
 * the projection is stale.
 *
 * KV WRITE BUDGET
 * The free tier allows 1,000 writes/day, which is the tightest limit in the whole
 * system. Writes therefore happen ONLY when the public projection actually
 * changes. Cycle rollover changes neither accessUrl nor status, so it costs zero
 * KV writes — that property is load-bearing for staying on the free tier.
 * `putDynamicProjection` also skips a write when the payload is unchanged.
 */

import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";
import {
  DYN_DIRTY_SET,
  readDynamicRecord,
  toProjection,
  isValidDynamicToken,
} from "./dynamic-keys";
import type { DynamicKeyProjection, DynamicKeyRecord } from "./types";

const logger = createLogger("kv-sync");

/** Daily counter so an accidental bulk re-sync cannot exhaust the free tier. */
const WRITE_BUDGET_LIMIT = 1000;
const WRITE_BUDGET_WARN = 800;
const WRITE_BUDGET_REFUSE = 950;

export interface KvConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

export type KvResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: "not_configured" | "budget_exhausted" | "http_error"; detail?: string };

/** KV key for a token's projection. */
export function projectionKey(token: string): string {
  return `dyn:${token}`;
}

/**
 * Read Cloudflare credentials from server env.
 *
 * Named CF_* to avoid confusion with KV_REST_API_* which in this project refers
 * to Upstash. Returns null when unconfigured so the app degrades to
 * "queue everything dirty" rather than crashing.
 */
export function getKvConfig(): KvConfig | null {
  const accountId = process.env.CF_ACCOUNT_ID?.trim();
  const namespaceId = process.env.CF_KV_NAMESPACE_ID?.trim();
  const apiToken = process.env.CF_KV_API_TOKEN?.trim();
  if (!accountId || !namespaceId || !apiToken) return null;
  return { accountId, namespaceId, apiToken };
}

export function isKvConfigured(): boolean {
  return getKvConfig() !== null;
}

function budgetKey(): string {
  return `kvwrites:${new Date().toISOString().slice(0, 10)}`;
}

export interface WriteBudget {
  used: number;
  limit: number;
  remaining: number;
  warn: boolean;
}

export async function getWriteBudget(): Promise<WriteBudget> {
  const redis = getRedis();
  const used = Number((await redis.get<string | number>(budgetKey())) ?? 0) || 0;
  return {
    used,
    limit: WRITE_BUDGET_LIMIT,
    remaining: Math.max(0, WRITE_BUDGET_LIMIT - used),
    warn: used >= WRITE_BUDGET_WARN,
  };
}

async function consumeWriteBudget(): Promise<number> {
  const redis = getRedis();
  const key = budgetKey();
  const used = await redis.incr(key);
  // Expire a little over a day so the counter self-cleans.
  if (used === 1) await redis.expire(key, 60 * 60 * 26);
  return used;
}

// ── Cloudflare REST ───────────────────────────────────────────────────────────

function kvUrl(cfg: KvConfig, token: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}/values/${encodeURIComponent(projectionKey(token))}`;
}

async function kvPut(
  cfg: KvConfig,
  token: string,
  projection: DynamicKeyProjection
): Promise<void> {
  const res = await fetch(kvUrl(cfg, token), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(projection),
  });

  if (!res.ok) {
    // Status only — the response can echo request context.
    throw new Error(`KV PUT failed with status ${res.status}`);
  }
}

async function kvDelete(cfg: KvConfig, token: string): Promise<void> {
  const res = await fetch(kvUrl(cfg, token), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
  });
  // 404 means already absent, which satisfies the intent.
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV DELETE failed with status ${res.status}`);
  }
}

/** Read a projection back, used by cleanup gating and the drift audit. */
export async function kvGetProjection(
  token: string
): Promise<DynamicKeyProjection | null> {
  const cfg = getKvConfig();
  if (!cfg || !isValidDynamicToken(token)) return null;

  const res = await fetch(kvUrl(cfg, token), {
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET failed with status ${res.status}`);

  try {
    return (await res.json()) as DynamicKeyProjection;
  } catch {
    return null;
  }
}

// ── Dirty queue ───────────────────────────────────────────────────────────────

export async function markDynamicDirty(token: string): Promise<void> {
  if (!isValidDynamicToken(token)) return;
  const redis = getRedis();
  await redis.sadd(DYN_DIRTY_SET, token);
  logger.warn({ dyn: maskId(token) }, "Dynamic projection marked dirty");
}

async function clearDynamicDirty(token: string): Promise<void> {
  const redis = getRedis();
  await redis.srem(DYN_DIRTY_SET, token);
}

export async function listDirtyTokens(limit = 50): Promise<string[]> {
  const redis = getRedis();
  const members = (await redis.smembers(DYN_DIRTY_SET)) as string[] | null;
  return (members ?? []).filter(isValidDynamicToken).slice(0, limit);
}

export async function countDirtyTokens(): Promise<number> {
  const redis = getRedis();
  const members = (await redis.smembers(DYN_DIRTY_SET)) as string[] | null;
  return (members ?? []).length;
}

/** Last projection we believe reached KV, so unchanged writes can be skipped. */
function syncedRevKey(token: string): string {
  return `dyn:synced:${token}`;
}

async function readSyncedRev(token: string): Promise<number | null> {
  const redis = getRedis();
  const v = await redis.get<string | number>(syncedRevKey(token));
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function writeSyncedRev(token: string, rev: number): Promise<void> {
  const redis = getRedis();
  await redis.set(syncedRevKey(token), String(rev));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Push a record's projection to KV.
 *
 * Skips the write when the projection revision is already synced, which is what
 * makes cycle rollover free. Marks dirty and resolves (never throws) on failure,
 * so callers can continue with the authoritative state already committed.
 */
export async function putDynamicProjection(
  record: DynamicKeyRecord,
  options: { force?: boolean } = {}
): Promise<KvResult> {
  const cfg = getKvConfig();
  if (!cfg) {
    await markDynamicDirty(record.token);
    return { ok: false, reason: "not_configured" };
  }

  if (!options.force) {
    const synced = await readSyncedRev(record.token);
    if (synced !== null && synced >= record.rev) {
      // Public data unchanged since the last successful sync.
      return { ok: true, skipped: true };
    }
  }

  const budget = await getWriteBudget();
  if (budget.used >= WRITE_BUDGET_REFUSE) {
    await markDynamicDirty(record.token);
    logger.error({ used: budget.used }, "KV daily write budget nearly exhausted; queued instead");
    return { ok: false, reason: "budget_exhausted" };
  }

  try {
    await kvPut(cfg, record.token, toProjection(record));
    await consumeWriteBudget();
    await writeSyncedRev(record.token, record.rev);
    await clearDynamicDirty(record.token);
    return { ok: true };
  } catch (err) {
    await markDynamicDirty(record.token);
    logger.error(
      { dyn: maskId(record.token), reason: err instanceof Error ? err.message : "unknown" },
      "KV projection write failed"
    );
    return {
      ok: false,
      reason: "http_error",
      detail: err instanceof Error ? err.message : undefined,
    };
  }
}

/** Convenience: read the authoritative record, then project it. */
export async function syncDynamicToken(
  token: string,
  options: { force?: boolean } = {}
): Promise<KvResult> {
  const record = await readDynamicRecord(token);
  if (!record) {
    return deleteDynamicProjection(token);
  }
  return putDynamicProjection(record, options);
}

/** Remove a projection so the Worker stops resolving the token entirely. */
export async function deleteDynamicProjection(token: string): Promise<KvResult> {
  const cfg = getKvConfig();
  if (!cfg) {
    await markDynamicDirty(token);
    return { ok: false, reason: "not_configured" };
  }

  try {
    await kvDelete(cfg, token);
    await consumeWriteBudget();
    const redis = getRedis();
    await redis.del(syncedRevKey(token));
    await clearDynamicDirty(token);
    return { ok: true };
  } catch (err) {
    await markDynamicDirty(token);
    logger.error({ dyn: maskId(token) }, "KV projection delete failed");
    return {
      ok: false,
      reason: "http_error",
      detail: err instanceof Error ? err.message : undefined,
    };
  }
}

export interface DrainReport {
  attempted: number;
  synced: number;
  deleted: number;
  failed: number;
  remaining: number;
}

/**
 * Retry queued projections. Called by the hourly cron.
 * Bounded per invocation so one run cannot blow the KV write budget.
 */
export async function drainDirtyDynamicRecords(limit = 25): Promise<DrainReport> {
  const tokens = await listDirtyTokens(limit);

  let synced = 0;
  let deleted = 0;
  let failed = 0;

  for (const token of tokens) {
    const record = await readDynamicRecord(token);

    // Revoked or vanished identities should not resolve at all.
    if (!record || record.status === "revoked") {
      const result = await deleteDynamicProjection(token);
      if (result.ok) deleted += 1;
      else failed += 1;
      continue;
    }

    const result = await putDynamicProjection(record, { force: true });
    if (result.ok) synced += 1;
    else failed += 1;
  }

  const remaining = await countDirtyTokens();

  if (tokens.length > 0) {
    logger.info({ attempted: tokens.length, synced, deleted, failed, remaining }, "Dirty KV drain");
  }

  return { attempted: tokens.length, synced, deleted, failed, remaining };
}

export type SyncState = "synced" | "pending" | "unknown" | "not_configured";

/**
 * Sync status for the admin UI, derived from the locally recorded synced rev.
 * Deliberately avoids a KV read so rendering a table costs no Cloudflare quota.
 */
export async function getSyncState(record: DynamicKeyRecord): Promise<SyncState> {
  if (!isKvConfigured()) return "not_configured";
  const synced = await readSyncedRev(record.token);
  if (synced === null) return "unknown";
  return synced >= record.rev ? "synced" : "pending";
}

/**
 * Confirm KV genuinely matches the authoritative revision.
 *
 * Costs one KV read, so it is used only where correctness demands it — notably
 * migration cleanup, which must not delete the old Outline key while the edge
 * still points at it.
 */
export async function verifyProjectionCurrent(
  record: DynamicKeyRecord
): Promise<{ current: boolean; kvRev: number | null }> {
  if (!isKvConfigured()) return { current: false, kvRev: null };

  try {
    const projection = await kvGetProjection(record.token);
    if (!projection) return { current: false, kvRev: null };
    return { current: projection.rev >= record.rev, kvRev: projection.rev };
  } catch {
    return { current: false, kvRev: null };
  }
}
