/**
 * Monitoring helpers — lightweight, read-only, server-side only.
 *
 * Nothing here mutates customer data, Outline keys, or auth state.
 * All provider checks have short timeouts so one slow service never blocks
 * the whole dashboard.
 *
 * Redis schema (all new keys):
 *   monitor:cron:last     HASH  { lastStartedAt, lastCompletedAt, durationMs,
 *                                  processed, failed, expiryProcessed,
 *                                  quotaProcessed, dirtySyncProcessed }
 *                         TTL   25 h  (disappears if cron has not run in a day)
 */

import { getRedis } from "./api-utils";
import { createLogger } from "./logger";
import { listApprovers } from "./telegram-approvers";

const logger = createLogger("monitoring");

// ── Constants ─────────────────────────────────────────────────────────────────

export const MONITOR_CRON_KEY = "monitor:cron:last";
/** How many seconds before the cron summary expires from Redis. */
export const CRON_SUMMARY_TTL = 25 * 60 * 60; // 25 h
/** Expected max gap between cron runs (ms). Warn beyond this. */
export const CRON_WARN_GAP_MS = 90 * 60 * 1000;  // 90 min
export const CRON_CRITICAL_GAP_MS = 6 * 60 * 60 * 1000; // 6 h

/** Timeout for any single external check, in ms. */
export const CHECK_TIMEOUT_MS = 5000;

// ── Shared types ──────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "warning" | "critical" | "not_configured";

export interface CheckResult {
  status: HealthStatus;
  latencyMs?: number;
  detail?: string;
}

// ── Cron summary ──────────────────────────────────────────────────────────────

export interface CronSummary {
  lastStartedAt: string;
  lastCompletedAt: string;
  durationMs: number;
  processed: number;
  failed: number;
  expiryProcessed: number;
  quotaProcessed: number;
  dirtySyncProcessed: number;
}

/** Called at the END of each cron tick to persist a compact summary. */
export async function writeCronSummary(params: {
  startedAt: number;
  expiry: { processed: number; failed: number };
  rollover: { processed: number; failed: number };
  drain: { synced: number; failed: number };
}): Promise<void> {
  try {
    const redis = getRedis();
    const now = Date.now();
    const summary: Record<string, string> = {
      lastStartedAt:       new Date(params.startedAt).toISOString(),
      lastCompletedAt:     new Date(now).toISOString(),
      durationMs:          String(now - params.startedAt),
      processed:           String(
        (params.expiry.processed ?? 0) +
        (params.rollover.processed ?? 0) +
        (params.drain.synced ?? 0)
      ),
      failed:              String(
        (params.expiry.failed ?? 0) +
        (params.rollover.failed ?? 0) +
        (params.drain.failed ?? 0)
      ),
      expiryProcessed:     String(params.expiry.processed ?? 0),
      quotaProcessed:      String(params.rollover.processed ?? 0),
      dirtySyncProcessed:  String(params.drain.synced ?? 0),
    };
    await redis.hset(MONITOR_CRON_KEY, summary);
    await redis.expire(MONITOR_CRON_KEY, CRON_SUMMARY_TTL);
  } catch (err) {
    // Never let monitoring writes crash the cron.
    logger.warn({ err }, "Failed to write cron monitoring summary");
  }
}

/** Read the last cron summary from Redis. Returns null when never run. */
export async function readCronSummary(): Promise<CronSummary | null> {
  try {
    const redis = getRedis();
    const raw = await redis.hgetall<Record<string, string>>(MONITOR_CRON_KEY);
    if (!raw || !raw.lastCompletedAt) return null;
    return {
      lastStartedAt:      raw.lastStartedAt ?? "",
      lastCompletedAt:    raw.lastCompletedAt,
      durationMs:         Number(raw.durationMs ?? 0),
      processed:          Number(raw.processed ?? 0),
      failed:             Number(raw.failed ?? 0),
      expiryProcessed:    Number(raw.expiryProcessed ?? 0),
      quotaProcessed:     Number(raw.quotaProcessed ?? 0),
      dirtySyncProcessed: Number(raw.dirtySyncProcessed ?? 0),
    };
  } catch {
    return null;
  }
}

// ── Redis health check ────────────────────────────────────────────────────────

export async function checkRedisHealth(): Promise<CheckResult> {
  try {
    const redis = getRedis();
    const t0 = Date.now();
    await redis.set("monitor:ping", "1", { ex: 10 });
    const val = await redis.get("monitor:ping");
    const latencyMs = Date.now() - t0;
    if (val !== "1" && val !== 1) {
      return { status: "warning", latencyMs, detail: "Ping round-trip value mismatch" };
    }
    return { status: "healthy", latencyMs };
  } catch (err) {
    return { status: "critical", detail: "Redis unreachable" };
  }
}

// ── Telegram health check ─────────────────────────────────────────────────────

export interface TelegramHealth extends CheckResult {
  botUsername?: string;
  webhookConfigured: boolean;
  linkedApprovers: number;
  pendingLinks: number;
}

export async function checkTelegramHealth(): Promise<TelegramHealth> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { status: "not_configured", webhookConfigured: false, linkedApprovers: 0, pendingLinks: 0 };
  }

  try {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);

    let getMeOk = false;
    let botUsername: string | undefined;
    let webhookConfigured = false;

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json() as { ok: boolean; result?: { username?: string } };
        getMeOk = data.ok === true;
        botUsername = data.result?.username;
      }
    } catch {
      clearTimeout(timer);
    }

    // Check webhook info (best-effort, separate call)
    try {
      const wRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
        signal: new AbortController().signal,
      });
      if (wRes.ok) {
        const wData = await wRes.json() as { ok: boolean; result?: { url?: string } };
        webhookConfigured = !!(wData.result?.url);
      }
    } catch { /* non-fatal */ }

    const latencyMs = Date.now() - t0;

    // Count approvers from Redis
    let linkedApprovers = 0;
    let pendingLinks = 0;
    try {
      const approvers = await listApprovers();
      linkedApprovers = approvers.length;
      const redis = getRedis();
      const pending = await redis.smembers("tg:links:pending") as string[] | null;
      pendingLinks = pending?.length ?? 0;
    } catch { /* non-fatal */ }

    if (!getMeOk) {
      return {
        status: "warning",
        latencyMs,
        detail: "Bot API unreachable or token invalid",
        webhookConfigured,
        linkedApprovers,
        pendingLinks,
      };
    }

    return {
      status: "healthy",
      latencyMs,
      botUsername,
      webhookConfigured,
      linkedApprovers,
      pendingLinks,
    };
  } catch (err) {
    return {
      status: "warning",
      detail: "Telegram check failed",
      webhookConfigured: false,
      linkedApprovers: 0,
      pendingLinks: 0,
    };
  }
}

// ── Dynamic /k config health check ───────────────────────────────────────────

export interface DynamicConfigHealth extends CheckResult {
  /** ISO timestamp of the last check. */
  checkedAt: string;
  httpStatus?: number;
}

/**
 * Check the /k/ route health using a deliberately invalid 32-hex token.
 * An unknown token MUST return 404 with no body — that proves the route is
 * operational without exposing any customer credential.
 */
export async function checkDynamicConfigHealth(baseUrl: string): Promise<DynamicConfigHealth> {
  const checkedAt = new Date().toISOString();
  // All-zeros is a valid 32-hex string but will never map to a real customer.
  const probeToken = "0".repeat(32);
  const url = `${baseUrl}/k/${probeToken}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    const t0 = Date.now();
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    // Expect 404 for an unknown token — that proves route + Redis lookup work.
    if (res.status === 404) {
      return { status: "healthy", latencyMs, httpStatus: 404, checkedAt };
    }
    if (res.status === 503) {
      return { status: "critical", latencyMs, httpStatus: 503, checkedAt, detail: "Redis unavailable on /k/ route" };
    }
    return { status: "warning", latencyMs, httpStatus: res.status, checkedAt, detail: `Unexpected status ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "critical", detail: `Fetch failed: ${msg}`, checkedAt };
  }
}

// ── Cron health from summary ──────────────────────────────────────────────────

export interface CronHealth extends CheckResult {
  summary: CronSummary | null;
  overdueMs?: number;
}

export async function checkCronHealth(): Promise<CronHealth> {
  const summary = await readCronSummary();
  if (!summary) {
    return { status: "warning", summary: null, detail: "No cron run recorded yet" };
  }

  const lastMs = Date.parse(summary.lastCompletedAt);
  if (Number.isNaN(lastMs)) {
    return { status: "warning", summary, detail: "Invalid cron timestamp" };
  }

  const gapMs = Date.now() - lastMs;
  if (gapMs > CRON_CRITICAL_GAP_MS) {
    return { status: "critical", summary, overdueMs: gapMs, detail: "Cron has not run in over 6 hours" };
  }
  if (gapMs > CRON_WARN_GAP_MS) {
    return { status: "warning", summary, overdueMs: gapMs, detail: "Cron is overdue" };
  }
  if (summary.failed > 0) {
    return { status: "warning", summary, detail: `${summary.failed} failures in last run` };
  }
  return { status: "healthy", summary };
}

// ── Application self-check ────────────────────────────────────────────────────

export interface AppHealth extends CheckResult {
  environment: string;
  region: string;
  commitSha?: string;
}

export function getAppHealth(): AppHealth {
  return {
    status: "healthy",
    environment: process.env.NODE_ENV ?? "unknown",
    region: process.env.VERCEL_REGION ?? process.env.AWS_REGION ?? "unknown",
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  };
}
