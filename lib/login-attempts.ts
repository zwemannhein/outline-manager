/**
 * Admin login approval attempts (Telegram second factor).
 *
 * Correct username + password does NOT produce a JWT. It produces a pending
 * attempt that must be approved from Telegram, and the JWT is only minted when
 * the ORIGINAL browser returns holding `browserSecret`. Telegram approval alone
 * is insufficient; possession of `browserSecret` alone is insufficient.
 *
 * ── STATE MODEL ─────────────────────────────────────────────────────────────
 * A single `state` field is the whole state machine:
 *
 *     pending ──► approved ──► consumed
 *        ├──► rejected
 *        └──► cancelled
 *
 * Transitions run inside a Redis Lua script, giving a true compare-and-set.
 * Redis executes Lua single-threaded, so read-check-write is indivisible and
 * Approve/Reject/Cancel are mutually exclusive by construction. `consumed` is
 * reachable only from `approved`, which is what makes JWT issuance one-time.
 *
 * Never stores the raw browserSecret, only its SHA-256. Never logs the secret,
 * and only ever logs a masked attempt id.
 */

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";

const logger = createLogger("login-attempts");

/** 5 minutes. */
export const ATTEMPT_TTL_SECONDS = 300;

/** Maximum simultaneous pending attempts, to bound Telegram notification spam. */
export const MAX_PENDING_ATTEMPTS = 3;

const PENDING_SET_KEY = "adminlogin:pending";

export type LoginAttemptState =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "consumed";

export type LoginAttemptStatus = LoginAttemptState | "expired";

export interface LoginAttemptView {
  status: LoginAttemptStatus;
  username: string;
  createdAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
}

export function attemptKey(attemptId: string): string {
  return `adminlogin:${attemptId}`;
}

/** attemptId is 32 lowercase hex characters (128 bits). */
export function isValidAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** browserSecret is 64 lowercase hex characters (256 bits). */
export function isValidBrowserSecret(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function hashBrowserSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Sanitize a User-Agent before it is embedded in a Telegram message.
 * Strips control characters and truncates, so a crafted header cannot inject
 * extra lines into the message body.
 */
export function sanitizeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  // eslint-disable-next-line no-control-regex
  const cleaned = ua.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Unknown device";
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}...` : cleaned;
}

/**
 * Short human-friendly browser/OS summary for the Telegram message.
 * Best-effort only.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  const s = sanitizeUserAgent(ua);
  if (s === "Unknown device") return s;

  let browser = "Unknown browser";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/Chrome\//.test(s) && !/Chromium/.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s) && !/Chrome\//.test(s)) browser = "Safari";
  else if (/Firefox\//.test(s)) browser = "Firefox";

  let os = "Unknown OS";
  if (/Windows NT/.test(s)) os = "Windows";
  else if (/iPhone|iPad|iOS/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";

  return `${browser} / ${os}`;
}

// ── Lua script ────────────────────────────────────────────────────────────────

/**
 * Compare-and-set a single state transition.
 *
 * KEYS[1] attempt record
 * ARGV[1] expected current state
 * ARGV[2] next state
 * ARGV[3] now (ms, as string)
 * ARGV[4] timestamp field name to record
 * ARGV[5] now (ISO)
 *
 * Returns: "ok" | "missing" | "expired" | <current state> on mismatch
 */
export const LUA_TRANSITION_ATTEMPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'missing' end
local expiresAtMs = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if (not expiresAtMs) or expiresAtMs <= tonumber(ARGV[3]) then return 'expired' end
if state ~= ARGV[1] then return state end
redis.call('HSET', KEYS[1], 'state', ARGV[2], ARGV[4], ARGV[5])
return 'ok'
`;

// ── Creation ──────────────────────────────────────────────────────────────────

export interface CreatedAttempt {
  attemptId: string;
  browserSecret: string;
  expiresAt: string;
}

/**
 * Count live pending attempts, pruning settled or vanished ids from the
 * tracking set. The set only bounds notification spam, so approximate accuracy
 * is acceptable.
 */
export async function countPendingAttempts(): Promise<number> {
  const redis = getRedis();
  const ids = (await redis.smembers(PENDING_SET_KEY)) as string[] | null;
  if (!ids || ids.length === 0) return 0;

  let live = 0;
  const stale: string[] = [];

  for (const id of ids) {
    const state = await redis.hget<string>(attemptKey(id), "state");
    if (state === "pending") live += 1;
    else stale.push(id);
  }

  if (stale.length > 0) {
    await redis.srem(PENDING_SET_KEY, ...stale);
  }

  return live;
}

/**
 * Create a pending login attempt.
 * Returns the raw browserSecret exactly once; only its hash is persisted.
 */
export async function createLoginAttempt(params: {
  username: string;
  ip: string;
  userAgent: string;
}): Promise<CreatedAttempt> {
  const redis = getRedis();

  const attemptId = randomBytes(16).toString("hex");
  const browserSecret = randomBytes(32).toString("hex");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_SECONDS * 1000);

  await redis.hset(attemptKey(attemptId), {
    state: "pending",
    browserSecretHash: hashBrowserSecret(browserSecret),
    username: params.username,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Numeric mirror so Lua can compare without parsing ISO strings.
    expiresAtMs: String(expiresAt.getTime()),
    ip: params.ip,
    userAgent: sanitizeUserAgent(params.userAgent),
  });
  await redis.expire(attemptKey(attemptId), ATTEMPT_TTL_SECONDS);

  await redis.sadd(PENDING_SET_KEY, attemptId);
  await redis.expire(PENDING_SET_KEY, ATTEMPT_TTL_SECONDS * 4);

  logger.info({ attempt: maskId(attemptId) }, "Login attempt created, awaiting Telegram approval");

  return { attemptId, browserSecret, expiresAt: expiresAt.toISOString() };
}

// ── Reading ───────────────────────────────────────────────────────────────────

interface RawAttempt {
  [field: string]: unknown;
  state?: string;
  browserSecretHash?: string;
  username?: string;
  createdAt?: string;
  expiresAt?: string;
  expiresAtMs?: string;
  ip?: string;
  userAgent?: string;
}

function isExpiredMs(expiresAtMs: string | undefined): boolean {
  if (!expiresAtMs) return true;
  const t = Number(expiresAtMs);
  return !Number.isFinite(t) || t <= Date.now();
}

async function readAttempt(attemptId: string): Promise<RawAttempt | null> {
  const redis = getRedis();
  const raw = await redis.hgetall<RawAttempt>(attemptKey(attemptId));
  if (!raw || !raw.state) return null;
  return raw;
}

function deriveStatus(raw: RawAttempt): LoginAttemptStatus {
  const state = (raw.state ?? "pending") as LoginAttemptState;
  // Terminal states stay reportable after expiry so the UI can explain them.
  if (state === "rejected" || state === "cancelled" || state === "consumed") return state;
  if (isExpiredMs(raw.expiresAtMs)) return "expired";
  return state;
}

/** Look up an attempt for display purposes (Telegram handler). */
export async function getAttemptView(attemptId: string): Promise<LoginAttemptView | null> {
  if (!isValidAttemptId(attemptId)) return null;
  const raw = await readAttempt(attemptId);
  if (!raw) return null;

  return {
    status: deriveStatus(raw),
    username: (raw.username as string) ?? "",
    createdAt: (raw.createdAt as string) ?? "",
    expiresAt: (raw.expiresAt as string) ?? "",
    ip: (raw.ip as string) ?? "unknown",
    userAgent: (raw.userAgent as string) ?? "Unknown device",
  };
}

// ── Transitions ───────────────────────────────────────────────────────────────

export type DecisionResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "expired" | "already_decided";
      status: LoginAttemptStatus;
    };

async function transition(
  attemptId: string,
  from: LoginAttemptState,
  to: LoginAttemptState,
  timestampField: string
): Promise<string> {
  const redis = getRedis();
  const now = Date.now();

  return (await redis.eval(
    LUA_TRANSITION_ATTEMPT,
    [attemptKey(attemptId)],
    [from, to, String(now), timestampField, new Date(now).toISOString()]
  )) as string;
}

async function decide(
  attemptId: string,
  decision: "approved" | "rejected" | "cancelled"
): Promise<DecisionResult> {
  if (!isValidAttemptId(attemptId)) {
    return { ok: false, reason: "not_found", status: "expired" };
  }

  const result = await transition(attemptId, "pending", decision, "decidedAt");

  if (result === "ok") {
    logger.info({ attempt: maskId(attemptId), decision }, "Login attempt decided");
    return { ok: true };
  }
  if (result === "missing") return { ok: false, reason: "not_found", status: "expired" };
  if (result === "expired") return { ok: false, reason: "expired", status: "expired" };

  return { ok: false, reason: "already_decided", status: result as LoginAttemptStatus };
}

export function approveLoginAttempt(attemptId: string): Promise<DecisionResult> {
  return decide(attemptId, "approved");
}

export function rejectLoginAttempt(attemptId: string): Promise<DecisionResult> {
  return decide(attemptId, "rejected");
}

/**
 * Browser-initiated cancellation. Requires browserSecret so a third party who
 * somehow learned an attemptId cannot cancel someone else's pending login.
 */
export async function cancelLoginAttempt(
  attemptId: string,
  browserSecret: string
): Promise<DecisionResult> {
  const verified = await verifyAttemptSecret(attemptId, browserSecret);
  if (!verified) return { ok: false, reason: "not_found", status: "expired" };
  return decide(attemptId, "cancelled");
}

/** Constant-time check that the caller holds this attempt's browserSecret. */
export async function verifyAttemptSecret(
  attemptId: string,
  browserSecret: string
): Promise<boolean> {
  if (!isValidAttemptId(attemptId) || !isValidBrowserSecret(browserSecret)) return false;

  const raw = await readAttempt(attemptId);
  const stored = raw?.browserSecretHash as string | undefined;
  if (!stored) return false;

  try {
    const a = Buffer.from(hashBrowserSecret(browserSecret), "hex");
    const b = Buffer.from(stored, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type ConsumeResult =
  | { ok: true; username: string }
  | { ok: false; status: LoginAttemptStatus };

/**
 * Atomically consume an approved attempt so a JWT can be issued exactly once.
 *
 * `approved -> consumed` is a CAS performed BEFORE the caller mints a token, so
 * a second caller loses the race, observes `consumed`, and receives no token.
 */
export async function consumeApprovedAttempt(
  attemptId: string,
  browserSecret: string
): Promise<ConsumeResult> {
  if (!(await verifyAttemptSecret(attemptId, browserSecret))) {
    return { ok: false, status: "expired" };
  }

  const raw = await readAttempt(attemptId);
  if (!raw) return { ok: false, status: "expired" };
  const username = (raw.username as string) ?? "";

  const result = await transition(attemptId, "approved", "consumed", "consumedAt");

  if (result === "ok") {
    const redis = getRedis();
    await redis.srem(PENDING_SET_KEY, attemptId);
    logger.info({ attempt: maskId(attemptId) }, "Login attempt consumed, issuing session");
    return { ok: true, username };
  }

  if (result === "missing" || result === "expired") {
    return { ok: false, status: "expired" };
  }

  return { ok: false, status: result as LoginAttemptStatus };
}

/**
 * Status for the polling browser. Requires browserSecret, and returns an
 * indistinguishable "expired" for unknown, malformed and genuinely expired ids
 * so the endpoint cannot be used to probe for valid attempt ids.
 */
export async function getAttemptStatusForBrowser(
  attemptId: string,
  browserSecret: string
): Promise<LoginAttemptStatus> {
  if (!(await verifyAttemptSecret(attemptId, browserSecret))) return "expired";
  const raw = await readAttempt(attemptId);
  if (!raw) return "expired";
  return deriveStatus(raw);
}
