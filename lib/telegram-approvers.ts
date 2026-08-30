/**
 * Telegram approver management.
 *
 * A single dashboard admin account may have ANY NUMBER of linked Telegram
 * approvers. Each approver is a Telegram user who can approve/reject admin
 * login requests. They are NOT dashboard accounts and have no password.
 *
 * ── SECURITY MODEL ──────────────────────────────────────────────────────────
 * - Linking is done via a one-time cryptographic token (15-minute TTL, single use)
 *   sent as a deep link to the Telegram bot.
 * - The token is bound to the expected Telegram username (if provided).
 * - The permanent security identity is the Telegram numeric user_id, never the
 *   username (usernames can change).
 * - Token replay is prevented by atomically consuming the token on first use.
 *
 * ── REDIS SCHEMA ────────────────────────────────────────────────────────────
 *   tg:approvers            SET  of approver numeric IDs (strings)
 *   tg:approver:<userId>    HASH { username, chatId, linkedAt, status }
 *   tg:link:<token>         HASH { expectedUsername, createdAt, expiresAtMs }
 *                                TTL = LINK_TTL_SECONDS
 */

import { randomBytes } from "crypto";
import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";

const logger = createLogger("telegram-approvers");

export const LINK_TTL_SECONDS = 15 * 60; // 15 minutes

export interface TelegramApprover {
  userId: string;       // numeric Telegram user_id (permanent identity)
  chatId: string;       // numeric chat_id for sending messages
  username: string;     // current Telegram username (may change — display only)
  linkedAt: string;     // ISO timestamp
  status: "linked";
}

export interface PendingLink {
  token: string;        // 32 hex chars
  expectedUsername: string; // normalized (without @), may be ""
  createdAt: string;
  expiresAt: string;
}

// ── Key helpers ───────────────────────────────────────────────────────────────

export function approverKey(userId: string): string {
  return `tg:approver:${userId}`;
}

export function linkKey(token: string): string {
  return `tg:link:${token}`;
}

const APPROVERS_SET = "tg:approvers";
const PENDING_LINKS_SET = "tg:links:pending";

// ── Pending link tokens ───────────────────────────────────────────────────────

/**
 * Create a one-time linking token bound to an optional expected username.
 * Returns the raw token (32 hex chars). Only the token itself is stored; it is
 * never hashed because it is already 128 bits of entropy and is consumed once.
 */
export async function createLinkToken(expectedUsername: string): Promise<PendingLink> {
  const redis = getRedis();

  // Normalize: strip leading @, lowercase.
  const normalized = expectedUsername.replace(/^@/, "").toLowerCase().trim();

  const token = randomBytes(16).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TTL_SECONDS * 1000);

  await redis.hset(linkKey(token), {
    expectedUsername: normalized,
    createdAt: now.toISOString(),
    expiresAtMs: String(expiresAt.getTime()),
  });
  await redis.expire(linkKey(token), LINK_TTL_SECONDS);

  // Track for cleanup. Best-effort.
  await redis.sadd(PENDING_LINKS_SET, token).catch(() => {});
  await redis.expire(PENDING_LINKS_SET, LINK_TTL_SECONDS * 2).catch(() => {});

  logger.info(
    { token: maskId(token), expectedUsername: normalized || "(any)" },
    "Telegram link token created"
  );

  return {
    token,
    expectedUsername: normalized,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Read and atomically consume a link token.
 *
 * Returns null when the token is missing, expired, or already consumed.
 * On success deletes the token key so replay is impossible.
 */
export interface ConsumedLink {
  expectedUsername: string;
}

export async function consumeLinkToken(token: string): Promise<ConsumedLink | null> {
  if (!isValidLinkToken(token)) return null;

  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string>>(linkKey(token));
  if (!raw || !raw.expiresAtMs) return null;

  const expiresAtMs = Number(raw.expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    // Expired — clean up
    await redis.del(linkKey(token)).catch(() => {});
    return null;
  }

  // Atomically delete so a second caller gets nothing.
  const deleted = await redis.del(linkKey(token));
  if (!deleted) return null; // already consumed by a concurrent request

  await redis.srem(PENDING_LINKS_SET, token).catch(() => {});

  logger.info({ token: maskId(token) }, "Telegram link token consumed");
  return { expectedUsername: raw.expectedUsername ?? "" };
}

export function isValidLinkToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

// ── Approver CRUD ─────────────────────────────────────────────────────────────

/**
 * Register a verified Telegram user as a linked approver.
 * If the userId is already linked, updates username and chatId.
 */
export async function linkApprover(params: {
  userId: string;
  chatId: string;
  username: string;
}): Promise<TelegramApprover> {
  const redis = getRedis();

  const now = new Date().toISOString();
  const existing = await redis.hgetall<Record<string, string>>(approverKey(params.userId));
  const linkedAt = existing?.linkedAt ?? now;

  const approver: TelegramApprover = {
    userId: params.userId,
    chatId: params.chatId,
    username: params.username,
    linkedAt,
    status: "linked",
  };

  await redis.hset(approverKey(params.userId), {
    userId: approver.userId,
    chatId: approver.chatId,
    username: approver.username,
    linkedAt: approver.linkedAt,
    status: "linked",
  });

  await redis.sadd(APPROVERS_SET, params.userId);

  logger.info({ userId: params.userId, username: params.username }, "Telegram approver linked");
  return approver;
}

/** Remove a linked approver. Idempotent. */
export async function removeApprover(userId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(approverKey(userId));
  await redis.srem(APPROVERS_SET, userId);
  logger.info({ userId }, "Telegram approver removed");
}

/** List all linked approvers. */
export async function listApprovers(): Promise<TelegramApprover[]> {
  const redis = getRedis();
  const ids = (await redis.smembers(APPROVERS_SET)) as string[] | null;
  if (!ids || ids.length === 0) return [];

  const approvers: TelegramApprover[] = [];
  const stale: string[] = [];

  for (const id of ids) {
    const raw = await redis.hgetall<Record<string, string>>(approverKey(id));
    if (!raw || !raw.userId) {
      stale.push(id);
      continue;
    }
    approvers.push({
      userId: raw.userId,
      chatId: raw.chatId ?? raw.userId,
      username: raw.username ?? "",
      linkedAt: raw.linkedAt ?? "",
      status: "linked",
    });
  }

  if (stale.length > 0) {
    await redis.srem(APPROVERS_SET, ...stale).catch(() => {});
  }

  return approvers.sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
}

/** Get a single approver by userId. */
export async function getApprover(userId: string): Promise<TelegramApprover | null> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string>>(approverKey(userId));
  if (!raw || !raw.userId) return null;
  return {
    userId: raw.userId,
    chatId: raw.chatId ?? raw.userId,
    username: raw.username ?? "",
    linkedAt: raw.linkedAt ?? "",
    status: "linked",
  };
}

/**
 * Return the chatIds of all active linked approvers.
 * Used by the login route to know where to send approval requests.
 */
export async function getApproverChatIds(): Promise<string[]> {
  const approvers = await listApprovers();
  return approvers.map((a) => a.chatId);
}

/**
 * Check whether a Telegram chatId belongs to a linked approver.
 * Used by the webhook to authorize callbacks.
 */
export async function isLinkedApprover(chatId: string): Promise<boolean> {
  const approvers = await listApprovers();
  return approvers.some((a) => a.chatId === chatId);
}
