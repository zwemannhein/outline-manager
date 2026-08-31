/**
 * GET /api/v1/monitor
 *
 * Returns system health for: App, Redis, Telegram, Cron, Dynamic /k config,
 * login delivery telemetry, and Redis due-job counts.
 * All checks run in parallel with Promise.allSettled so one failure never
 * blocks the others.
 *
 * Cached in Redis for 30 s to avoid hammering external services.
 * Requires admin JWT.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  getRedis,
} from "@/lib/api-utils";
import {
  checkRedisHealth,
  checkTelegramHealth,
  checkDynamicConfigHealth,
  checkCronHealth,
  getAppHealth,
  readLoginTelemetry,
  getRedisDueJobCounts,
  type HealthStatus,
} from "@/lib/monitoring";
import { getWriteBudget } from "@/lib/kv-sync";

const CACHE_KEY = "monitor:system:cache";
const CACHE_TTL = 30; // seconds

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const force = req.nextUrl.searchParams.get("force") === "1";
    if (!force) {
      try {
        const cached = await getRedis().get<string>(CACHE_KEY);
        if (cached) {
          const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
          return successResponse({ ...parsed, cached: true });
        }
      } catch { /* cache miss — proceed */ }
    }

    const baseUrl = getBaseUrl(req);
    const startedAt = Date.now();

    // All checks in parallel — one failure never blocks the others.
    const [
      redisResult,
      telegramResult,
      dynResult,
      cronResult,
      budgetResult,
      loginTelemResult,
      dueJobsResult,
    ] = await Promise.allSettled([
      checkRedisHealth(),
      checkTelegramHealth(),
      checkDynamicConfigHealth(baseUrl),
      checkCronHealth(),
      getWriteBudget(),
      readLoginTelemetry(),
      getRedisDueJobCounts(),
    ]);

    const redis     = redisResult.status    === "fulfilled" ? redisResult.value    : { status: "critical" as HealthStatus, detail: "Check failed" };
    const telegram  = telegramResult.status === "fulfilled" ? telegramResult.value : { status: "warning"  as HealthStatus, detail: "Check failed", webhookConfigured: false, linkedApprovers: 0, pendingLinks: 0 };
    const dynConfig = dynResult.status      === "fulfilled" ? dynResult.value      : { status: "critical" as HealthStatus, detail: "Check failed", checkedAt: new Date().toISOString() };
    const cron      = cronResult.status     === "fulfilled" ? cronResult.value     : { status: "warning"  as HealthStatus, detail: "Check failed", summary: null };
    const budget    = budgetResult.status   === "fulfilled" ? budgetResult.value   : null;
    const loginTelemetry = loginTelemResult.status === "fulfilled" ? loginTelemResult.value : null;
    const dueJobs   = dueJobsResult.status  === "fulfilled" ? dueJobsResult.value  : { expiryDue: 0, cycleDue: 0, dirtyQueue: 0 };

    const app = getAppHealth();

    // Overall status: worst of all non-not_configured checks.
    // Telegram warning/offline alone never makes overall Critical.
    // not_configured (AWS metrics) never degrades overall status.
    const statuses: HealthStatus[] = [
      app.status,
      redis.status,
      dynConfig.status,
      cron.status,
      telegram.status === "critical" ? "warning" : telegram.status,
    ].filter((s) => s !== "not_configured");

    const overall: HealthStatus =
      statuses.includes("critical") ? "critical" :
      statuses.includes("warning")  ? "warning"  : "healthy";

    const payload = {
      checkedAt: new Date(startedAt).toISOString(),
      overall,
      app,
      redis: {
        ...redis,
        kvBudget: budget
          ? { used: budget.used, limit: budget.limit, remaining: budget.remaining, warn: budget.warn }
          : null,
        dirtyQueueSize: dueJobs.dirtyQueue,
        dueJobs: {
          expiryDue: dueJobs.expiryDue,
          cycleDue:  dueJobs.cycleDue,
        },
      },
      telegram: {
        ...telegram,
        // Login delivery telemetry — no secrets, only aggregate counts.
        loginTelemetry,
      },
      cron,
      dynamicConfig: dynConfig,
      // AWS/server resource metrics: not configured in this project.
      resourceMetrics: { status: "not_configured" as HealthStatus, detail: "AWS credentials not configured" },
    };

    try {
      await getRedis().set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL });
    } catch { /* non-fatal */ }

    return successResponse({ ...payload, cached: false });
  } catch (error) {
    return handleApiError(error);
  }
}

function getBaseUrl(req: NextRequest): string {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}
