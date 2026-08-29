/**
 * Forgot Password via Telegram reset code.
 *
 * The admin may have forgotten BOTH their username and password, so this flow
 * never asks for a username. The server resolves the authoritative username
 * itself and sends it, with a 6-digit code, to the configured Telegram chat.
 * Possession of that chat is the authentication factor.
 *
 * ── STATE MODEL ─────────────────────────────────────────────────────────────
 * A single `state` field is the whole state machine:
 *
 *     pending ──correct code──► verified ──password written──► consumed
 *        │
 *        └──5th wrong code────► locked
 *
 * Only those three transitions exist. Every transition runs inside a Redis Lua
 * script, so it is a true compare-and-set: Redis executes Lua single-threaded,
 * which makes read-check-write indivisible. Independent marker fields could
 * previously interleave and leave a record both `verified` and `locked`; a
 * single `state` field cannot represent that, and CAS cannot produce it.
 *
 * The attempt counter is incremented inside the same script as the state check,
 * so a correct-code request and the 5th wrong-code request are serialised and
 * exactly one of them wins.
 *
 * ── SECRET HANDLING ─────────────────────────────────────────────────────────
 * The raw reset code is never stored. Only HMAC-SHA256(JWT_SECRET, resetId:code)
 * is persisted, so a Redis dump alone cannot be brute-forced offline against the
 * small 6-digit keyspace without also holding the server secret.
 *
 * The plaintext password is never written to Redis and never passed into Lua.
 * Only the already-derived scrypt hash and salt cross that boundary.
 */

import { randomBytes, randomInt, createHmac, timingSafeEqual } from "crypto";
import { getRedis } from "./api-utils";
import { getEnv } from "./validation";
import { createLogger, maskId } from "./logger";

const logger = createLogger("password-reset");

/** 5 minutes. */
export const RESET_TTL_SECONDS = 300;

/** Maximum incorrect code submissions before the request is locked. */
export const MAX_CODE_ATTEMPTS = 5;

/** Minimum seconds between reset code sends. */
export const RESEND_COOLDOWN_SECONDS = 60;

const RESEND_KEY = "adminreset:cooldown";

export type ResetState = "pending" | "verified" | "locked" | "consumed";
export type ResetStatus = ResetState | "expired";

export function resetKey(resetId: string): string {
  return `adminreset:${resetId}`;
}

/** resetId is 32 lowercase hex characters (128 bits). */
export function isValidResetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** The code is exactly 6 numeric digits. */
export function isValidCodeFormat(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{6}$/.test(value);
}

/**
 * Cryptographically secure 6-digit code.
 * randomInt is uniform over the range; Math.random is never used.
 */
export function generateResetCode(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Peppered hash of a reset code, bound to its resetId.
 *
 * HMAC keyed with JWT_SECRET (an existing server secret — no new environment
 * variable) rather than a bare digest. A 6-digit code has only 900k
 * possibilities, so a plain SHA-256 of `resetId:code` in a leaked Redis dump
 * would be trivially brute-forced offline. Keying with a secret the dump does
 * not contain removes that.
 *
 * Including resetId means the same code issued for a different request produces
 * a different value, so a hash cannot be replayed across requests.
 */
export function hashResetCode(resetId: string, code: string): string {
  const pepper = getEnv().JWT_SECRET;
  return createHmac("sha256", pepper).update(`${resetId}:${code}`, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
function hexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// ── Lua scripts ───────────────────────────────────────────────────────────────

/**
 * Verify a submitted code.
 *
 * Handles the wrong-code increment, the lock transition, and the verify
 * transition in ONE atomic script, so `pending -> verified` and
 * `pending -> locked` can never both take effect.
 *
 * KEYS[1] reset record
 * ARGV[1] submitted code hash
 * ARGV[2] now (ms, as string)
 * ARGV[3] now (ISO)
 * ARGV[4] max attempts
 *
 * Return contract — "ok" means THIS call performed the verify transition.
 * A bare state name means the call did nothing because the record was already in
 * that state. These must stay distinct: returning 'verified' for both would make
 * a second verification of an already-verified record look like a fresh success.
 *
 * Returns: "ok" | "missing" | "expired" | "locked"
 *          | "wrong:<attempts>" | <current state> when not pending
 */
export const LUA_VERIFY_RESET_CODE = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'missing' end
local expiresAtMs = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if (not expiresAtMs) or expiresAtMs <= tonumber(ARGV[2]) then return 'expired' end
if state ~= 'pending' then return state end
local stored = redis.call('HGET', KEYS[1], 'codeHash')
if stored ~= ARGV[1] then
  local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  if attempts >= tonumber(ARGV[4]) then
    redis.call('HSET', KEYS[1], 'state', 'locked', 'lockedAt', ARGV[3])
    return 'locked'
  end
  return 'wrong:' .. attempts
end
redis.call('HSET', KEYS[1], 'state', 'verified', 'verifiedAt', ARGV[3])
return 'ok'
`;

/**
 * Write the new admin password AND consume the reset request together.
 *
 * This is the fix for a burned-but-unused reset: previously the request was
 * consumed first and the password written afterwards, so a failure in between
 * destroyed the reset credential without changing the password. Both writes now
 * happen in one script — they succeed together or neither happens.
 *
 * Only derived key material is passed in. The plaintext password never enters Lua.
 *
 * KEYS[1] reset record
 * KEYS[2] admin:auth
 * ARGV[1] now (ms, as string)
 * ARGV[2] now (ISO)
 * ARGV[3] passwordHash (hex)
 * ARGV[4] salt (hex)
 * ARGV[5] algorithm
 *
 * Returns: "ok" | "missing" | "expired" | <current state> when not verified
 */
export const LUA_CONSUME_RESET_AND_SET_PASSWORD = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'missing' end
local expiresAtMs = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if (not expiresAtMs) or expiresAtMs <= tonumber(ARGV[1]) then return 'expired' end
if state ~= 'verified' then return state end
redis.call('HSET', KEYS[2], 'passwordHash', ARGV[3], 'salt', ARGV[4], 'algorithm', ARGV[5], 'updatedAt', ARGV[2])
redis.call('HSET', KEYS[1], 'state', 'consumed', 'consumedAt', ARGV[2])
return 'ok'
`;

// ── Cooldown ──────────────────────────────────────────────────────────────────

/** Seconds remaining before another code may be sent; 0 when ready. */
export async function getResendCooldownRemaining(): Promise<number> {
  const redis = getRedis();
  const ttl = await redis.ttl(RESEND_KEY);
  return typeof ttl === "number" && ttl > 0 ? ttl : 0;
}

/**
 * Begin the cooldown window.
 *
 * Called only AFTER a code has been successfully delivered, so a failed
 * Telegram send does not lock the admin out of retrying.
 */
export async function startResendCooldown(): Promise<void> {
  const redis = getRedis();
  await redis.set(RESEND_KEY, "1", { ex: RESEND_COOLDOWN_SECONDS });
}

// ── Creation ──────────────────────────────────────────────────────────────────

export interface CreatedReset {
  resetId: string;
  /** Returned so it can be sent via Telegram. Never persisted, never sent to the browser. */
  code: string;
  expiresAt: string;
}

/**
 * Create a reset request.
 *
 * Deliberately does NOT touch any previous request. Invalidating the old one is
 * a separate, explicit step the caller performs only after the replacement code
 * has actually been delivered, so a failed send never leaves the admin with no
 * usable code.
 */
export async function createResetRequest(params: {
  username: string;
  ip: string;
}): Promise<CreatedReset> {
  const redis = getRedis();

  const resetId = randomBytes(16).toString("hex");
  const code = generateResetCode();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_SECONDS * 1000);

  await redis.hset(resetKey(resetId), {
    state: "pending",
    username: params.username,
    // Only the peppered hash is stored. The raw code lives solely in Telegram.
    codeHash: hashResetCode(resetId, code),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Numeric mirror so Lua can compare without parsing ISO strings.
    expiresAtMs: String(expiresAt.getTime()),
    ip: params.ip,
    attempts: "0",
  });
  await redis.expire(resetKey(resetId), RESET_TTL_SECONDS);

  // The code itself is never logged.
  logger.info({ reset: maskId(resetId) }, "Password reset code created");

  return { resetId, code, expiresAt: expiresAt.toISOString() };
}

/**
 * Invalidate a reset request outright.
 *
 * Used after a successful resend so the superseded code stops working
 * immediately.
 */
export async function invalidateResetRequest(resetId: string): Promise<void> {
  if (!isValidResetId(resetId)) return;
  const redis = getRedis();
  await redis.del(resetKey(resetId));
  logger.info({ reset: maskId(resetId) }, "Previous reset request invalidated");
}

export type IssueResetOutcome =
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "sent"; resetId: string; expiresAt: string }
  | { status: "delivery_failed" };

/**
 * The send / resend transaction, in one place so its ordering is testable.
 *
 *   1. cooldown check  → return early, leaving any existing request UNTOUCHED
 *   2. create the replacement request (the previous one is still usable)
 *   3. deliver the new code
 *   4. delivery failed → discard the undeliverable replacement, keep the
 *      previous request valid, do NOT start the cooldown so a retry is possible
 *   5. delivery succeeded → retire the previous request, start the cooldown
 *
 * The ordering exists so that neither a cooldown rejection nor a delivery
 * failure can ever leave the admin holding no usable code.
 */
export async function issueResetCode(params: {
  username: string;
  ip: string;
  previousResetId?: string | null;
  /** Returns true when the code reached at least one destination. */
  deliver: (code: string, username: string) => Promise<boolean>;
}): Promise<IssueResetOutcome> {
  // 1. Cooldown — nothing is created or destroyed.
  const cooldown = await getResendCooldownRemaining();
  if (cooldown > 0) {
    return { status: "cooldown", retryAfterSeconds: cooldown };
  }

  // 2. Create the replacement.
  const created = await createResetRequest({
    username: params.username,
    ip: params.ip,
  });

  // 3. Deliver.
  let delivered = false;
  try {
    delivered = await params.deliver(created.code, params.username);
  } catch {
    delivered = false;
  }

  // 4. Failure: discard the new one, keep the old one usable, no cooldown.
  if (!delivered) {
    await invalidateResetRequest(created.resetId);
    logger.warn(
      { reset: maskId(created.resetId), keptPrevious: Boolean(params.previousResetId) },
      "Reset code delivery failed; previous request left intact"
    );
    return { status: "delivery_failed" };
  }

  // 5. Success: now it is safe to retire the superseded code.
  if (params.previousResetId) {
    await invalidateResetRequest(params.previousResetId);
  }
  await startResendCooldown();

  return { status: "sent", resetId: created.resetId, expiresAt: created.expiresAt };
}

// ── Reading ───────────────────────────────────────────────────────────────────

interface RawReset {
  [field: string]: unknown;
  state?: string;
  username?: string;
  codeHash?: string;
  createdAt?: string;
  expiresAt?: string;
  expiresAtMs?: string;
  ip?: string;
  attempts?: string;
}

function isExpiredMs(expiresAtMs: string | undefined): boolean {
  if (!expiresAtMs) return true;
  const t = Number(expiresAtMs);
  return !Number.isFinite(t) || t <= Date.now();
}

async function readReset(resetId: string): Promise<RawReset | null> {
  const redis = getRedis();
  const raw = await redis.hgetall<RawReset>(resetKey(resetId));
  if (!raw || !raw.state) return null;
  return raw;
}

/** Current status, or "expired" for anything unknown, malformed, or timed out. */
export async function getResetStatus(resetId: string): Promise<ResetStatus> {
  if (!isValidResetId(resetId)) return "expired";
  const raw = await readReset(resetId);
  if (!raw) return "expired";

  const state = (raw.state ?? "pending") as ResetState;
  // Terminal states remain reportable after expiry so the UI can explain them.
  if (state === "locked" || state === "consumed") return state;
  if (isExpiredMs(raw.expiresAtMs)) return "expired";
  return state;
}

/** The username captured when the request was created. */
export async function getResetUsername(resetId: string): Promise<string | null> {
  if (!isValidResetId(resetId)) return null;
  const raw = await readReset(resetId);
  return (raw?.username as string) ?? null;
}

// ── Verification ──────────────────────────────────────────────────────────────

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid" | "expired" | "locked" | "wrong_code" | "not_pending";
      attemptsRemaining?: number;
      status: ResetStatus;
    };

/**
 * Verify a submitted code, atomically.
 *
 * One Lua script performs: existence check, expiry check, state check, code
 * comparison, attempt increment, and either the lock or the verify transition.
 * Nothing can interleave, so a correct code and the 5th wrong code cannot both
 * succeed.
 */
export async function verifyResetCode(
  resetId: string,
  code: string
): Promise<VerifyResult> {
  if (!isValidResetId(resetId) || !isValidCodeFormat(code)) {
    return { ok: false, reason: "invalid", status: "expired" };
  }

  const redis = getRedis();
  const now = Date.now();

  const submittedHash = hashResetCode(resetId, code);

  const result = (await redis.eval(
    LUA_VERIFY_RESET_CODE,
    [resetKey(resetId)],
    [submittedHash, String(now), new Date(now).toISOString(), String(MAX_CODE_ATTEMPTS)]
  )) as string;

  // "ok" means THIS call performed pending -> verified. A bare "verified" means
  // the record was already verified, which is not a success for this caller.
  if (result === "ok") {
    logger.info({ reset: maskId(resetId) }, "Password reset code verified");
    return { ok: true };
  }

  if (result === "locked") {
    logger.warn({ reset: maskId(resetId) }, "Password reset locked after too many wrong codes");
    return { ok: false, reason: "locked", attemptsRemaining: 0, status: "locked" };
  }

  if (typeof result === "string" && result.startsWith("wrong:")) {
    const attempts = Number(result.slice("wrong:".length)) || 0;
    logger.warn({ reset: maskId(resetId), attempts }, "Incorrect password reset code");
    return {
      ok: false,
      reason: "wrong_code",
      attemptsRemaining: Math.max(0, MAX_CODE_ATTEMPTS - attempts),
      status: "pending",
    };
  }

  if (result === "missing") return { ok: false, reason: "invalid", status: "expired" };
  if (result === "expired") return { ok: false, reason: "expired", status: "expired" };

  // Any other value is the current state, i.e. it was not pending.
  return { ok: false, reason: "not_pending", status: result as ResetStatus };
}

/**
 * Constant-time check of a code against the stored hash, without mutating state.
 * Exposed for tests; the authoritative comparison happens inside Lua.
 */
export async function codeMatchesStoredHash(resetId: string, code: string): Promise<boolean> {
  const raw = await readReset(resetId);
  if (!raw?.codeHash) return false;
  return hexEqual(hashResetCode(resetId, code), raw.codeHash as string);
}

// ── Consumption + password write ──────────────────────────────────────────────

export type ConsumeResetResult =
  | { ok: true; username: string }
  | {
      ok: false;
      reason: "invalid" | "not_verified" | "expired" | "locked" | "consumed";
      status: ResetStatus;
    };

/**
 * Atomically write the new admin password AND consume the reset request.
 *
 * The caller derives the scrypt material first (a CPU-bound operation that must
 * not sit inside a Redis script) and passes only the derived hash and salt here.
 *
 * Either both the password update and the state transition happen, or neither
 * does. A second caller finds the state already `consumed` and changes nothing,
 * so two simultaneous resets produce exactly one password update.
 */
export async function consumeResetAndSetPassword(
  resetId: string,
  material: { passwordHash: string; salt: string; algorithm: string },
  adminAuthKey: string
): Promise<ConsumeResetResult> {
  if (!isValidResetId(resetId)) {
    return { ok: false, reason: "invalid", status: "expired" };
  }

  const redis = getRedis();

  // Read the username before the transition so it can be returned on success.
  const before = await readReset(resetId);
  const username = (before?.username as string) ?? "";

  const now = Date.now();

  const result = (await redis.eval(
    LUA_CONSUME_RESET_AND_SET_PASSWORD,
    [resetKey(resetId), adminAuthKey],
    [
      String(now),
      new Date(now).toISOString(),
      material.passwordHash,
      material.salt,
      material.algorithm,
    ]
  )) as string;

  if (result === "ok") {
    logger.info({ reset: maskId(resetId) }, "Admin password written and reset consumed");
    return { ok: true, username };
  }

  logger.warn({ reset: maskId(resetId), result }, "Password reset refused");

  if (result === "missing") return { ok: false, reason: "invalid", status: "expired" };
  if (result === "expired") return { ok: false, reason: "expired", status: "expired" };
  if (result === "consumed") return { ok: false, reason: "consumed", status: "consumed" };
  if (result === "locked") return { ok: false, reason: "locked", status: "locked" };

  return { ok: false, reason: "not_verified", status: result as ResetStatus };
}
