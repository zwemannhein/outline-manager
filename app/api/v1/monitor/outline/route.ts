/**
 * GET /api/v1/monitor/outline
 *
 * Per-server Outline health: API reachability, key counts, managed/unmanaged
 * detection, and basic consistency checks.
 *
 * READ-ONLY. Never modifies keys, quotas, or customer records.
 * Requires admin JWT.
 * Cached for 30 s in Redis.
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
  listRegisteredServers,
  getServerInfo,
  listAccessKeys,
} from "@/lib/outline-admin";
import {
  listDynamicRecords,
  getTokenByOutlineKey,
} from "@/lib/dynamic-keys";
import { CHECK_TIMEOUT_MS, type HealthStatus } from "@/lib/monitoring";

const CACHE_KEY = "monitor:outline:cache";
const CACHE_TTL = 30;

export interface OutlineServerHealth {
  serverId: string;
  name: string;
  status: HealthStatus;
  latencyMs?: number;
  detail?: string;
  totalKeys: number;
  managedKeys: number;
  unmanagedKeys: number;
  activeCustomers: number;
  disabledCustomers: number;
  missingKeys: number;       // managed records whose Outline key was not found
  duplicateMappings: number; // >1 managed record pointing to the same Outline key
  checkedAt: string;
}

async function checkServer(
  serverId: string,
  name: string,
  dynamicRecords: Awaited<ReturnType<typeof listDynamicRecords>>
): Promise<OutlineServerHealth> {
  const checkedAt = new Date().toISOString();

  // Wrap entire check so one server never throws for the caller.
  try {
    const t0 = Date.now();

    // Parallel: server info + key list.
    const [infoResult, keysResult] = await Promise.allSettled([
      withTimeout(getServerInfo(serverId), CHECK_TIMEOUT_MS),
      withTimeout(listAccessKeys(serverId), CHECK_TIMEOUT_MS),
    ]);

    const latencyMs = Date.now() - t0;

    if (keysResult.status === "rejected") {
      return {
        serverId, name, checkedAt, latencyMs,
        status: "critical",
        detail: "Management API unreachable",
        totalKeys: 0, managedKeys: 0, unmanagedKeys: 0,
        activeCustomers: 0, disabledCustomers: 0,
        missingKeys: 0, duplicateMappings: 0,
      };
    }

    const outlineKeys = keysResult.value;
    const outlineKeyIds = new Set(outlineKeys.map((k) => k.id));

    // Records for THIS server only.
    const serverRecords = dynamicRecords.filter(
      (r) => r.serverId === serverId && r.status !== "revoked"
    );

    // Count per-status.
    const activeCustomers   = serverRecords.filter((r) => r.status === "active").length;
    const disabledCustomers = serverRecords.filter(
      (r) => r.status === "disabled" || r.status === "expired"
    ).length;

    // Missing keys: managed record whose outlineKeyId is not on the server.
    const missingKeys = serverRecords.filter(
      (r) => !outlineKeyIds.has(r.outlineKeyId)
    ).length;

    // Unmanaged: Outline keys with no matching managed record.
    let unmanagedCount = 0;
    for (const key of outlineKeys) {
      const token = await getTokenByOutlineKey(serverId, key.id).catch(() => null);
      if (!token) unmanagedCount++;
    }

    // Duplicate mappings: multiple records pointing to the same Outline key ID.
    const keyIdCounts = new Map<string, number>();
    for (const r of serverRecords) {
      keyIdCounts.set(r.outlineKeyId, (keyIdCounts.get(r.outlineKeyId) ?? 0) + 1);
    }
    const duplicateMappings = Array.from(keyIdCounts.values()).filter((c) => c > 1).length;

    const managedKeys = serverRecords.length;
    const totalKeys   = outlineKeys.length;

    let status: HealthStatus = "healthy";
    const issues: string[] = [];

    if (infoResult.status === "rejected") {
      issues.push("Server info unavailable (keys still loaded)");
      status = "warning";
    }
    if (missingKeys > 0) {
      issues.push(`${missingKeys} managed record(s) missing Outline key`);
      status = "warning";
    }
    if (duplicateMappings > 0) {
      issues.push(`${duplicateMappings} duplicate key mapping(s)`);
      status = "warning";
    }

    return {
      serverId, name, checkedAt, latencyMs,
      status,
      detail: issues.length ? issues.join("; ") : undefined,
      totalKeys,
      managedKeys,
      unmanagedKeys: unmanagedCount,
      activeCustomers,
      disabledCustomers,
      missingKeys,
      duplicateMappings,
    };
  } catch (err) {
    return {
      serverId, name, checkedAt,
      status: "critical",
      detail: "Unexpected error during check",
      totalKeys: 0, managedKeys: 0, unmanagedKeys: 0,
      activeCustomers: 0, disabledCustomers: 0,
      missingKeys: 0, duplicateMappings: 0,
    };
  }
}

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
      } catch { /* miss */ }
    }

    const [servers, dynamicRecords] = await Promise.all([
      listRegisteredServers(),
      listDynamicRecords().catch(() => []),
    ]);

    // Check all servers in parallel.
    const results = await Promise.all(
      servers.map((s) => checkServer(s.id, s.name, dynamicRecords))
    );

    const overall: HealthStatus =
      results.some((r) => r.status === "critical") ? "critical" :
      results.some((r) => r.status === "warning")  ? "warning"  :
      results.length === 0                          ? "not_configured" : "healthy";

    const payload = {
      checkedAt: new Date().toISOString(),
      overall,
      servers: results,
      // Resource metrics require AWS credentials — not configured.
      resourceMetrics: { status: "not_configured" as HealthStatus },
    };

    try {
      await getRedis().set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL });
    } catch { /* non-fatal */ }

    return successResponse({ ...payload, cached: false });
  } catch (error) {
    return handleApiError(error);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}
