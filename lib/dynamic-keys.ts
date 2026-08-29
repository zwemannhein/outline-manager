/**
 * Permanent dynamic access key identities — the canonical implementation.
 *
 * PRODUCT RULE
 * A customer receives exactly ONE permanent URL and adds it to Outline once:
 *
 *     ssconf://<host>/k/<TOKEN>#<URL-encoded name>
 *
 * That URL must survive every backend change: quota updates, cycle rollover,
 * renewal, disable/enable, underlying Outline key replacement, and server
 * migration. Everything mutable lives behind the token.
 *
 * STORAGE
 * Upstash is the source of truth. Records are Redis hashes so individual fields
 * can be updated atomically; the two structured fields (`suspendedState`,
 * `history`) are JSON-encoded strings.
 *
 *   dynamic:<token>                      authoritative record
 *   dynidx:order:<orderId>               → token
 *   dynidx:key:<serverId>:<keyId>        → token
 *   dynidx:all                           set of all tokens
 *   dyn:kv_dirty                         set of tokens whose KV projection is stale
 *   dyn:cycle_due / dyn:expiry_due       sorted sets scored by due epoch
 *
 * `rev` is monotonic and increments only when the PUBLIC projection changes
 * (accessUrl or status). That lets cycle rollover run without any Cloudflare KV
 * write, which is what keeps us inside the 1,000 writes/day free tier.
 *
 * This module never builds an ssconf URL anywhere else in the codebase — one
 * builder, one parser.
 */

import { randomBytes } from "crypto";
import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";
import type {
  DynamicKeyRecord,
  DynamicKeyStatus,
  DynamicKeyProjection,
  DynamicHistoryEntry,
  SuspendedState,
} from "./types";

const logger = createLogger("dynamic-keys");

/** Cap history so a long-lived identity cannot grow without bound. */
const MAX_HISTORY_ENTRIES = 20;

// ── Keys ──────────────────────────────────────────────────────────────────────

export const DYN_ALL_SET = "dynidx:all";
export const DYN_DIRTY_SET = "dyn:kv_dirty";
export const DYN_CYCLE_DUE = "dyn:cycle_due";
export const DYN_EXPIRY_DUE = "dyn:expiry_due";

export function dynamicKey(token: string): string {
  return `dynamic:${token}`;
}
export function orderIndexKey(orderId: string): string {
  return `dynidx:order:${orderId}`;
}
export function outlineKeyIndexKey(serverId: string, outlineKeyId: string): string {
  return `dynidx:key:${serverId}:${outlineKeyId}`;
}

// ── Token ─────────────────────────────────────────────────────────────────────

/** 128 bits of cryptographic randomness as 32 lowercase hex characters. */
export function generateDynamicToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * URL building and parsing live in lib/dynamic-url.ts so the browser can use the
 * same implementation without pulling in server-only modules. Re-exported here
 * so server code has one obvious import site.
 */
export {
  isValidDynamicToken,
  getDynamicBaseUrl,
  getDynamicBaseHost,
  buildDynamicUrl,
  buildDynamicHttpsUrl,
  encodeDisplayName,
  parseDynamicUrl,
  type ParsedDynamicUrl,
} from "./dynamic-url";

import { isValidDynamicToken } from "./dynamic-url";

// ── Record serialisation ──────────────────────────────────────────────────────

type RawRecord = Record<string, string>;

function serialise(record: DynamicKeyRecord): RawRecord {
  return {
    token: record.token,
    orderId: record.orderId ?? "",
    serverId: record.serverId,
    outlineKeyId: record.outlineKeyId,
    accessUrl: record.accessUrl,
    name: record.name,
    status: record.status,
    rev: String(record.rev),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    suspendedState: record.suspendedState ? JSON.stringify(record.suspendedState) : "",
    history: JSON.stringify(record.history ?? []),
  };
}

function deserialise(raw: RawRecord | null): DynamicKeyRecord | null {
  if (!raw || !raw.token || !raw.status) return null;

  let suspendedState: SuspendedState | null = null;
  if (raw.suspendedState) {
    try {
      suspendedState = JSON.parse(raw.suspendedState) as SuspendedState;
    } catch {
      suspendedState = null;
    }
  }

  let history: DynamicHistoryEntry[] = [];
  if (raw.history) {
    try {
      const parsed = JSON.parse(raw.history);
      if (Array.isArray(parsed)) history = parsed as DynamicHistoryEntry[];
    } catch {
      history = [];
    }
  }

  return {
    token: raw.token,
    orderId: raw.orderId ? raw.orderId : null,
    serverId: raw.serverId ?? "",
    outlineKeyId: raw.outlineKeyId ?? "",
    accessUrl: raw.accessUrl ?? "",
    name: raw.name ?? "",
    status: raw.status as DynamicKeyStatus,
    rev: Number(raw.rev ?? "1") || 1,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
    suspendedState,
    history,
  };
}

/** The slim public view stored in Cloudflare KV. Never includes the name. */
export function toProjection(record: DynamicKeyRecord): DynamicKeyProjection {
  return {
    accessUrl: record.accessUrl,
    status: record.status,
    rev: record.rev,
    updatedAt: record.updatedAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function readDynamicRecord(token: string): Promise<DynamicKeyRecord | null> {
  if (!isValidDynamicToken(token)) return null;
  const redis = getRedis();
  const raw = await redis.hgetall<RawRecord>(dynamicKey(token));
  return deserialise(raw);
}

export async function getTokenByOrder(orderId: string): Promise<string | null> {
  if (!orderId) return null;
  const redis = getRedis();
  const token = await redis.get<string>(orderIndexKey(orderId));
  return isValidDynamicToken(token) ? token : null;
}

export async function getTokenByOutlineKey(
  serverId: string,
  outlineKeyId: string
): Promise<string | null> {
  if (!serverId || !outlineKeyId) return null;
  const redis = getRedis();
  const token = await redis.get<string>(outlineKeyIndexKey(serverId, outlineKeyId));
  return isValidDynamicToken(token) ? token : null;
}

export async function listDynamicTokens(): Promise<string[]> {
  const redis = getRedis();
  const members = (await redis.smembers(DYN_ALL_SET)) as string[] | null;
  return (members ?? []).filter(isValidDynamicToken);
}

export async function listDynamicRecords(): Promise<DynamicKeyRecord[]> {
  const tokens = await listDynamicTokens();
  const records: DynamicKeyRecord[] = [];
  for (const token of tokens) {
    const record = await readDynamicRecord(token);
    if (record) records.push(record);
  }
  return records;
}

// ── Creation ──────────────────────────────────────────────────────────────────

export interface CreateDynamicIdentityInput {
  token: string;
  orderId: string | null;
  serverId: string;
  outlineKeyId: string;
  accessUrl: string;
  name: string;
  status?: DynamicKeyStatus;
}

/**
 * Write a brand-new identity and all of its indexes.
 *
 * The token is supplied rather than generated here: the approval flow mints it
 * BEFORE creating the Outline key so a crash mid-approval can be reconciled
 * against the same identity instead of producing a second one.
 */
export async function createDynamicIdentity(
  input: CreateDynamicIdentityInput
): Promise<DynamicKeyRecord> {
  if (!isValidDynamicToken(input.token)) {
    throw new Error("createDynamicIdentity: invalid token");
  }

  const redis = getRedis();
  const now = new Date().toISOString();

  const record: DynamicKeyRecord = {
    token: input.token,
    orderId: input.orderId,
    serverId: input.serverId,
    outlineKeyId: input.outlineKeyId,
    accessUrl: input.accessUrl,
    name: input.name,
    status: input.status ?? "active",
    rev: 1,
    createdAt: now,
    updatedAt: now,
    suspendedState: null,
    history: [],
  };

  await redis.hset(dynamicKey(input.token), serialise(record));
  await redis.set(outlineKeyIndexKey(input.serverId, input.outlineKeyId), input.token);
  if (input.orderId) {
    await redis.set(orderIndexKey(input.orderId), input.token);
  }
  await redis.sadd(DYN_ALL_SET, input.token);

  logger.info(
    { dyn: maskId(input.token), serverId: input.serverId },
    "Dynamic identity created"
  );

  return record;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Atomically set status and bump rev.
 *
 * KEYS[1] record
 * ARGV[1] expected current status ("" to accept any)
 * ARGV[2] new status
 * ARGV[3] now ISO
 * ARGV[4] suspendedState JSON ("" clears, "-" leaves unchanged)
 *
 * Returns "ok:<newRev>" | "missing" | <current status> on mismatch.
 */
export const LUA_SET_STATUS = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 'missing' end
if ARGV[1] ~= '' and status ~= ARGV[1] then return status end
local rev = tonumber(redis.call('HGET', KEYS[1], 'rev')) or 1
if status ~= ARGV[2] then rev = rev + 1 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'rev', tostring(rev), 'updatedAt', ARGV[3])
if ARGV[4] ~= '-' then
  redis.call('HSET', KEYS[1], 'suspendedState', ARGV[4])
end
return 'ok:' .. rev
`;

export type StatusChangeResult =
  | { ok: true; rev: number }
  | { ok: false; reason: "missing" | "unexpected_status"; status?: DynamicKeyStatus };

/**
 * Change status, optionally guarded on the current value so concurrent
 * disable/enable requests cannot interleave into the wrong end state.
 */
export async function setDynamicStatus(
  token: string,
  next: DynamicKeyStatus,
  options: {
    expected?: DynamicKeyStatus;
    suspendedState?: SuspendedState | null | "unchanged";
  } = {}
): Promise<StatusChangeResult> {
  if (!isValidDynamicToken(token)) {
    return { ok: false, reason: "missing" };
  }

  const redis = getRedis();
  const suspendedArg =
    options.suspendedState === "unchanged"
      ? "-"
      : options.suspendedState
        ? JSON.stringify(options.suspendedState)
        : "";

  const result = (await redis.eval(
    LUA_SET_STATUS,
    [dynamicKey(token)],
    [options.expected ?? "", next, new Date().toISOString(), suspendedArg]
  )) as string;

  if (typeof result === "string" && result.startsWith("ok:")) {
    const rev = Number(result.slice(3)) || 1;
    logger.info({ dyn: maskId(token), status: next, rev }, "Dynamic status updated");
    return { ok: true, rev };
  }
  if (result === "missing") return { ok: false, reason: "missing" };

  return { ok: false, reason: "unexpected_status", status: result as DynamicKeyStatus };
}

/**
 * Atomically re-point an identity at a different Outline key, moving the index
 * and bumping rev — the core of server migration and of reactivation after a
 * key removal.
 *
 * KEYS[1] record
 * KEYS[2] NEW  dynidx:key:<destServer>:<destKey>
 * KEYS[3] OLD  dynidx:key:<srcServer>:<srcKey>
 * ARGV[1] destServerId
 * ARGV[2] destKeyId
 * ARGV[3] destAccessUrl
 * ARGV[4] now ISO
 * ARGV[5] token
 * ARGV[6] history JSON (full replacement array)
 * ARGV[7] new status
 *
 * Returns "ok:<newRev>" | "missing".
 */
export const LUA_REPOINT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 'missing' end
local rev = (tonumber(redis.call('HGET', KEYS[1], 'rev')) or 1) + 1
redis.call('HSET', KEYS[1],
  'serverId', ARGV[1],
  'outlineKeyId', ARGV[2],
  'accessUrl', ARGV[3],
  'updatedAt', ARGV[4],
  'rev', tostring(rev),
  'history', ARGV[6],
  'status', ARGV[7])
redis.call('SET', KEYS[2], ARGV[5])
if KEYS[3] ~= KEYS[2] then
  redis.call('DEL', KEYS[3])
end
return 'ok:' .. rev
`;

export interface RepointInput {
  token: string;
  destServerId: string;
  destOutlineKeyId: string;
  destAccessUrl: string;
  reason: DynamicHistoryEntry["reason"];
  /** Status to set alongside the repoint; defaults to keeping it active. */
  status?: DynamicKeyStatus;
  /** When false the superseded key is treated as already gone (no cleanup row). */
  trackPreviousForCleanup?: boolean;
}

export type RepointResult =
  | { ok: true; rev: number; previous: { serverId: string; outlineKeyId: string } | null }
  | { ok: false; reason: "missing" };

/**
 * Move the identity to a new underlying Outline key.
 *
 * The previous key is recorded in `history` with `cleanedUp: false` so a separate,
 * explicitly gated cleanup step can delete it later. Nothing here deletes an
 * Outline key.
 */
export async function repointDynamicIdentity(
  input: RepointInput
): Promise<RepointResult> {
  const current = await readDynamicRecord(input.token);
  if (!current) return { ok: false, reason: "missing" };

  const previous =
    current.serverId && current.outlineKeyId
      ? { serverId: current.serverId, outlineKeyId: current.outlineKeyId }
      : null;

  const history = [...(current.history ?? [])];
  if (previous && input.trackPreviousForCleanup !== false) {
    history.push({
      serverId: previous.serverId,
      outlineKeyId: previous.outlineKeyId,
      at: new Date().toISOString(),
      reason: input.reason,
      cleanedUp: false,
    });
  }
  while (history.length > MAX_HISTORY_ENTRIES) history.shift();

  const redis = getRedis();
  const oldIndex = previous
    ? outlineKeyIndexKey(previous.serverId, previous.outlineKeyId)
    : outlineKeyIndexKey(input.destServerId, input.destOutlineKeyId);

  const result = (await redis.eval(
    LUA_REPOINT,
    [
      dynamicKey(input.token),
      outlineKeyIndexKey(input.destServerId, input.destOutlineKeyId),
      oldIndex,
    ],
    [
      input.destServerId,
      input.destOutlineKeyId,
      input.destAccessUrl,
      new Date().toISOString(),
      input.token,
      JSON.stringify(history),
      input.status ?? current.status,
    ]
  )) as string;

  if (typeof result === "string" && result.startsWith("ok:")) {
    logger.info(
      { dyn: maskId(input.token), destServerId: input.destServerId, reason: input.reason },
      "Dynamic identity repointed"
    );
    return { ok: true, rev: Number(result.slice(3)) || 1, previous };
  }

  return { ok: false, reason: "missing" };
}

/** Update the display name. Does NOT bump rev: the name is not in the projection. */
export async function setDynamicName(token: string, name: string): Promise<void> {
  if (!isValidDynamicToken(token)) return;
  const redis = getRedis();
  await redis.hset(dynamicKey(token), {
    name,
    updatedAt: new Date().toISOString(),
  });
}

/** Mark a history entry for the given key as cleaned up. */
export async function markHistoryCleanedUp(
  token: string,
  serverId: string,
  outlineKeyId: string
): Promise<void> {
  const record = await readDynamicRecord(token);
  if (!record) return;

  const history = (record.history ?? []).map((entry) =>
    entry.serverId === serverId && entry.outlineKeyId === outlineKeyId
      ? { ...entry, cleanedUp: true }
      : entry
  );

  const redis = getRedis();
  await redis.hset(dynamicKey(token), {
    history: JSON.stringify(history),
    updatedAt: new Date().toISOString(),
  });
}

/** Entries whose Outline key still exists and is awaiting deletion. */
export function pendingCleanupEntries(record: DynamicKeyRecord): DynamicHistoryEntry[] {
  return (record.history ?? []).filter((e) => !e.cleanedUp);
}

/**
 * Permanently retire an identity. Drops the accessUrl and name (the PII) but
 * keeps the token in the tombstone set so it can never be reissued.
 */
export async function revokeDynamicIdentity(token: string): Promise<void> {
  const record = await readDynamicRecord(token);
  if (!record) return;

  const redis = getRedis();
  await redis.hset(dynamicKey(token), {
    status: "revoked",
    accessUrl: "",
    name: "",
    rev: String(record.rev + 1),
    updatedAt: new Date().toISOString(),
  });
  await redis.del(outlineKeyIndexKey(record.serverId, record.outlineKeyId));
  await redis.zrem(DYN_CYCLE_DUE, token);
  await redis.zrem(DYN_EXPIRY_DUE, token);

  logger.info({ dyn: maskId(token) }, "Dynamic identity revoked");
}

// ── Due indexes ───────────────────────────────────────────────────────────────

/**
 * Schedule the next cycle rollover and the subscription expiry.
 *
 * Sorted sets keep the cron O(due) rather than O(customers). Scanning every
 * identity hourly would cost roughly 864k Upstash commands/month at 300
 * customers, which exceeds the 500k free tier; the due index costs a few
 * thousand.
 */
export async function scheduleCycleDue(token: string, dueEpochMs: number): Promise<void> {
  const redis = getRedis();
  await redis.zadd(DYN_CYCLE_DUE, { score: dueEpochMs, member: token });
}

export async function scheduleExpiryDue(token: string, dueEpochMs: number): Promise<void> {
  const redis = getRedis();
  await redis.zadd(DYN_EXPIRY_DUE, { score: dueEpochMs, member: token });
}

export async function clearCycleDue(token: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(DYN_CYCLE_DUE, token);
}

export async function clearExpiryDue(token: string): Promise<void> {
  const redis = getRedis();
  await redis.zrem(DYN_EXPIRY_DUE, token);
}

/** Tokens due at or before `nowMs`, bounded. */
export async function getDueTokens(
  setKey: string,
  nowMs: number,
  limit = 50
): Promise<string[]> {
  const redis = getRedis();
  const members = (await redis.zrange(setKey, 0, nowMs, {
    byScore: true,
    offset: 0,
    count: limit,
  })) as string[] | null;
  return (members ?? []).filter(isValidDynamicToken);
}
