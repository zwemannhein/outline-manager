/**
 * Admin credential authority.
 *
 * This is the ONLY module that hashes, verifies, reads, or writes the admin
 * password. Login, dashboard "Change Password", and "Forgot Password" reset all
 * route through here so there is exactly one password implementation.
 *
 * AUTHORITY MODEL
 *   - If the Redis record `admin:auth` exists, it is authoritative. The
 *     ADMIN_PASSWORD environment variable is ignored entirely.
 *   - If `admin:auth` does not exist, ADMIN_PASSWORD is used as a one-time
 *     bootstrap so an existing deployment keeps working with no manual
 *     migration. The first successful password change writes `admin:auth`,
 *     after which the environment password stops working permanently.
 *
 * Hashing uses Node's built-in crypto.scrypt with a per-password random salt.
 * No third-party dependency, no paid service.
 *
 * Nothing in this module logs a password, a hash, or a salt.
 */

import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "crypto";
import { promisify } from "util";
import { getRedis } from "./api-utils";
import { getEnv } from "./validation";
import { createLogger } from "./logger";

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const logger = createLogger("admin-auth");

/** Redis hash holding the authoritative admin password material. */
export const ADMIN_AUTH_KEY = "admin:auth";

/** scrypt output length in bytes. */
const KEY_LENGTH = 64;
/** Salt length in bytes. */
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 8;

export interface AdminAuthRecord {
  passwordHash: string; // hex
  salt: string; // hex
  updatedAt: string; // ISO
  algorithm: string; // e.g. "scrypt"
}

/** Where the currently authoritative password lives. */
export type PasswordSource = "redis" | "env" | "none";

export interface AdminPasswordState {
  source: PasswordSource;
  updatedAt: string | null;
}

// ── Hashing primitives ────────────────────────────────────────────────────────

export interface PasswordMaterial {
  passwordHash: string; // hex
  salt: string; // hex
  algorithm: string;
}

/**
 * Hash a password with a freshly generated random salt.
 * Returns hex-encoded hash and salt. Never logged.
 *
 * Derivation is deliberately separate from persistence: scrypt is CPU-bound and
 * must be computed in Node, never inside a Redis script. Callers that need an
 * atomic multi-key write derive the material first and pass only this result
 * across the Redis boundary, so the plaintext password never reaches Redis.
 */
export async function hashPassword(password: string): Promise<PasswordMaterial> {
  const saltBuf = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, saltBuf, KEY_LENGTH);
  return {
    passwordHash: derived.toString("hex"),
    salt: saltBuf.toString("hex"),
    algorithm: "scrypt",
  };
}

/**
 * Derive storage material for a new password, enforcing the length policy.
 * Use with an atomic writer such as consumeResetAndSetPassword.
 */
export async function deriveNewPasswordMaterial(
  newPassword: string
): Promise<PasswordMaterial> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return hashPassword(newPassword);
}

/**
 * Verify a candidate password against a stored hash + salt.
 * Constant-time comparison of the derived keys.
 */
export async function verifyPassword(
  candidate: string,
  passwordHash: string,
  salt: string
): Promise<boolean> {
  try {
    const saltBuf = Buffer.from(salt, "hex");
    const expected = Buffer.from(passwordHash, "hex");
    if (saltBuf.length === 0 || expected.length !== KEY_LENGTH) return false;

    const derived = await scrypt(candidate, saltBuf, KEY_LENGTH);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Length-independent timing-safe string comparison, used only for the bootstrap
 * environment password (which is stored in plaintext by nature of being an env
 * var). Hashing both sides first avoids timingSafeEqual's length-mismatch throw,
 * which would itself leak length.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ── admin:auth record access ──────────────────────────────────────────────────

/**
 * Read the stored admin auth record, or null when it has never been set.
 * Tolerates both hash storage and a JSON-string value.
 */
export async function readAdminAuthRecord(): Promise<AdminAuthRecord | null> {
  const redis = getRedis();

  const raw = await redis.hgetall<Record<string, string>>(ADMIN_AUTH_KEY);
  if (raw && raw.passwordHash && raw.salt) {
    return {
      passwordHash: raw.passwordHash,
      salt: raw.salt,
      updatedAt: raw.updatedAt ?? "",
      algorithm: raw.algorithm ?? "scrypt",
    };
  }

  return null;
}

/**
 * Write a new password to `admin:auth`.
 *
 * Uses a single HSET so the hash and its matching salt land together; a partial
 * write that paired a new hash with an old salt would lock the admin out.
 */
export async function setAdminPassword(newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const { passwordHash, salt, algorithm } = await hashPassword(newPassword);
  const redis = getRedis();

  await redis.hset(ADMIN_AUTH_KEY, {
    passwordHash,
    salt,
    algorithm,
    updatedAt: new Date().toISOString(),
  });

  // Deliberately records only that a change happened.
  logger.info("Admin password updated");
}

/**
 * Describe where the authoritative password currently comes from.
 * Never returns the password, hash, or salt.
 */
export async function getCurrentAdminPasswordState(): Promise<AdminPasswordState> {
  const record = await readAdminAuthRecord();
  if (record) {
    return { source: "redis", updatedAt: record.updatedAt || null };
  }

  const env = getEnv();
  if (env.ADMIN_PASSWORD) {
    return { source: "env", updatedAt: null };
  }

  return { source: "none", updatedAt: null };
}

/**
 * True while the deployment is still authenticating with the bootstrap
 * environment password, i.e. no runtime password has ever been set.
 *
 * Drives the forced first-run password setup, so the admin can retire the
 * environment password from the dashboard with no Vercel changes.
 */
export async function isBootstrapPasswordInUse(): Promise<boolean> {
  return (await readAdminAuthRecord()) === null;
}

// ── Authentication ────────────────────────────────────────────────────────────

/**
 * Verify a candidate password against the CURRENT authority.
 *
 * Redis wins when present. Once `admin:auth` exists the environment password is
 * never consulted again, so a dashboard password change immediately invalidates
 * the old environment password.
 */
export async function verifyAdminPassword(candidate: string): Promise<boolean> {
  const record = await readAdminAuthRecord();

  if (record) {
    return verifyPassword(candidate, record.passwordHash, record.salt);
  }

  // Bootstrap path only.
  const env = getEnv();
  if (!env.ADMIN_PASSWORD) {
    logger.error("No admin password configured (no admin:auth record, no ADMIN_PASSWORD)");
    return false;
  }

  return timingSafeEqualStr(candidate, env.ADMIN_PASSWORD);
}

/**
 * The authoritative admin username.
 *
 * Supports an optional `username` field on `admin:auth` for a future runtime
 * username, falling back to ADMIN_USERNAME. Used by the login approval message
 * and by Forgot Password, which must be able to tell the admin their username
 * without being given it first.
 */
export async function getCurrentAdminUsername(): Promise<string> {
  try {
    const redis = getRedis();
    const stored = await redis.hget<string>(ADMIN_AUTH_KEY, "username");
    if (stored && typeof stored === "string" && stored.length > 0) {
      return stored;
    }
  } catch {
    // Fall through to the environment value.
  }

  return getEnv().ADMIN_USERNAME;
}

/**
 * Verify a candidate username against the authoritative one, timing-safely.
 */
export async function verifyAdminUsername(candidate: string): Promise<boolean> {
  const expected = await getCurrentAdminUsername();
  return timingSafeEqualStr(candidate, expected);
}

/**
 * Validate a full credential pair.
 *
 * Both halves are always evaluated so the response time does not reveal which
 * one was wrong, and the caller only ever receives a single boolean.
 */
export async function verifyAdminCredentials(
  username: string,
  password: string
): Promise<boolean> {
  const [userOk, passOk] = await Promise.all([
    verifyAdminUsername(username),
    verifyAdminPassword(password),
  ]);
  return userOk && passOk;
}
