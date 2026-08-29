/**
 * Customer order claim tokens.
 *
 * THE PROBLEM THIS SOLVES
 * The order status endpoint used to be `GET /api/v1/orders/<id>/status`, keyed on
 * an order id of the form `ord_<timestamp>_<random>`. The timestamp component is
 * highly predictable, so the id was a weak credential — and after this feature it
 * would return the customer's PERMANENT ssconf:// URL, which is far more valuable
 * than the single raw key it used to leak. Swapping one bearer credential for a
 * stronger one would have made the hole worse, not better.
 *
 * So order ids stop being credentials entirely. A separate 128-bit claim token is
 * issued once and is the only way to retrieve an order result.
 *
 * TWO INDEPENDENT CREDENTIALS
 *
 *                    claim token              dynamic VPN token
 *   purpose          retrieve my order        fetch VPN config
 *   lifetime         30 days                  permanent
 *   scope            one order                one customer identity
 *   holder           customer's browser       customer's Outline app
 *   stored in Redis  SHA-256 hash only        plaintext (the Worker looks it up)
 *   revocable        independently            independently
 *
 * The asymmetry is deliberate. The claim token is stored hashed, so a Redis dump
 * yields no usable claim tokens. The dynamic token cannot be hashed because the
 * edge Worker must look up by it; its protection is 128 bits of entropy plus the
 * fact that the record is useless without the Worker.
 */

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";

const logger = createLogger("order-claim");

/** 30 days. Long enough to cover approval plus a customer coming back later. */
export const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

export function claimIndexKey(claimHash: string): string {
  return `orderclaim:${claimHash}`;
}

/** 128 bits as 32 lowercase hex characters. */
export function generateClaimToken(): string {
  return randomBytes(16).toString("hex");
}

export function isValidClaimToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function claimHashEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export interface IssuedClaim {
  /** Returned to the browser exactly once. Never persisted in raw form. */
  claimToken: string;
  /** Stored on the order so it can be matched later. */
  claimHash: string;
}

/**
 * Mint a claim token for an order and index it for lookup.
 *
 * The index maps hash → orderId, so the raw token is never recoverable from
 * Redis. Lookups hash the submitted token and read the index.
 */
export async function issueClaimToken(orderId: string): Promise<IssuedClaim> {
  const claimToken = generateClaimToken();
  const claimHash = hashClaimToken(claimToken);

  const redis = getRedis();
  await redis.set(claimIndexKey(claimHash), orderId, { ex: CLAIM_TTL_SECONDS });

  // Never log the raw token.
  logger.info({ orderId, claim: maskId(claimHash) }, "Order claim token issued");

  return { claimToken, claimHash };
}

/**
 * Resolve a claim token to its order id.
 * Returns null for malformed, unknown and expired tokens alike, so callers cannot
 * distinguish them and the endpoint cannot be used as an existence oracle.
 */
export async function resolveClaimToken(claimToken: string): Promise<string | null> {
  if (!isValidClaimToken(claimToken)) return null;

  const redis = getRedis();
  const orderId = await redis.get<string>(claimIndexKey(hashClaimToken(claimToken)));
  return typeof orderId === "string" && orderId.length > 0 ? orderId : null;
}

/** Invalidate a claim link, e.g. if the customer reports it leaked. */
export async function revokeClaimToken(claimHash: string): Promise<void> {
  if (!claimHash) return;
  const redis = getRedis();
  await redis.del(claimIndexKey(claimHash));
  logger.info({ claim: maskId(claimHash) }, "Order claim token revoked");
}
