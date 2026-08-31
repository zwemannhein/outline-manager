/**
 * GET /api/v1/monitor/outline
 *
 * Per-server Outline health: API reachability, key counts, managed/unmanaged
 * detection, basic consistency checks, and VPN port TCP reachability.
 *
 * READ-ONLY. Never modifies keys, quotas, or customer records.
 * Requires admin JWT.
 * Cached 30 s in Redis.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import net from "net";
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
import type { ServerInfo } from "@/lib/types";

const CACHE_KEY = "monitor:outline:cache";
const CACHE_TTL = 30;
const PORT_CHECK_TIMEOUT_MS = 4000;

// ── VPN port TCP reachability ─────────────────────────────────────────────────

export type PortStatus = "open" | "timeout" | "refused" | "unknown";

/**
 * TCP-connect check for the VPN access port.
 * Reports OPEN / TIMEOUT / REFUSED — never claims UDP health.
 * Vercel runs in a Node.js environment so net.connect works server-side.
 */
function checkPortReachable(host: string, port: number): Promise<{ status: PortStatus; latencyMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = new net.Socket();
    let settled = false;

    function done(status: PortStatus) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, latencyMs: Date.now() - t0 });
    }

    socket.setTimeout(PORT_CHECK_TIMEOUT_MS);
    socket.on("connect", () => done("open"));
    socket.on("timeout", () => done("timeout"));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      done(err.code === "ECONNREFUSED" ? "refused" : "timeout");
    });

    try {
      socket.connect(port, host);
    } catch {
      done("unknown");
    }
  });
}

// ── Per-server check ──────────────────────────────────────────────────────────

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
  missingKeys: number;
  duplicateMappings: number;
  vpnEndpoint?: {
    host: string;
    port: number;
    portStatus: PortStatus;
    portLatencyMs: number;
    note: string;
  };
  checkedAt: string;
}

async function checkServer(
  serverId: string,
  name: string,
  dynamicRecords: Awaited<ReturnType<typeof listDynamicRecords>>
): Promise<OutlineServerHealth> {
  const checkedAt = new Date().toISOString();

  try {
    const t0 = Date.now();

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

    const serverRecords = dynamicRecords.filter(
      (r) => r.serverId === serverId && r.status !== "revoked"
    );

    const activeCustomers   = serverRecords.filter((r) => r.status === "active").length;
    const disabledCustomers = serverRecords.filter(
      (r) => r.status === "disabled" || r.status === "expired"
    ).length;

    const missingKeys = serverRecords.filter(
      (r) => !outlineKeyIds.has(r.outlineKeyId)
    ).length;

    let unmanagedCount = 0;
    for (const key of outlineKeys) {
      const token = await getTokenByOutlineKey(serverId, key.id).catch(() => null);
      if (!token) unmanagedCount++;
    }

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

    // VPN endpoint TCP reachability — use hostnameForAccessKeys + portForNewAccessKeys
    // from server info when available. Falls back to graceful unknown.
    let vpnEndpoint: OutlineServerHealth["vpnEndpoint"];
    if (infoResult.status === "fulfilled") {
      const info = infoResult.value as ServerInfo;
      const host = info.hostnameForAccessKeys;
      const port = info.portForNewAccessKeys;
      if (host && port) {
        const portCheck = await checkPortReachable(host, port).catch(
          () => ({ status: "unknown" as PortStatus, latencyMs: 0 })
        );
        vpnEndpoint = {
          host,
          port,
          portStatus: portCheck.status,
          portLatencyMs: portCheck.latencyMs,
          // Be honest: TCP open does NOT confirm UDP Shadowsocks works.
          note: "TCP-only — does not confirm Shadowsocks/UDP connectivity",
        };
        if (portCheck.status === "timeout") {
          issues.push(`VPN port ${port} TCP timeout — may be firewalled`);
          if (status === "healthy") status = "warning";
        } else if (portCheck.status === "refused") {
          issues.push(`VPN port ${port} TCP refused`);
          if (status === "healthy") status = "warning";
        }
      }
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
      vpnEndpoint,
    };
  } catch {
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

// ── Route handler ─────────────────────────────────────────────────────────────

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
      resourceMetrics: { status: "not_configured" as HealthStatus, detail: "AWS credentials not configured — CPU/RAM/Disk not available" },
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
