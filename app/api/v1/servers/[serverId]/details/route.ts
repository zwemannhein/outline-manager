/**
 * GET /api/v1/servers/<serverId>/details — READ-ONLY server overview.
 *
 * Returns only safe operational information for the Server Details view.
 * NEVER returns: management API URL, cert fingerprint, raw ss:// URLs,
 * passwords, tokens, or any credential.
 *
 * All numbers are derived from existing helpers:
 *   - getServerInfo / listAccessKeys / getTransferMetrics (Outline API)
 *   - listDynamicRecords (customer identities)
 *   - getTokenByOutlineKey (managed/unmanaged classification)
 *
 * This endpoint performs NO mutations.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
} from "@/lib/api-utils";
import {
  resolveServer,
  getServerInfo,
  listAccessKeys,
  getTransferMetrics,
} from "@/lib/outline-admin";
import { listDynamicRecords, getTokenByOutlineKey } from "@/lib/dynamic-keys";
import { normalizeOutlineKeyId, outlineKeyIdSet } from "@/lib/outline-key-id";
import type { HealthStatus } from "@/lib/monitoring";

export interface ServerDetails {
  serverId: string;
  name: string;                 // Outline-reported name, falling back to registry name
  online: boolean;
  status: HealthStatus;
  version: string | null;
  metricsEnabled: boolean | null;
  totalKeys: number;
  totalDataUsedBytes: number;
  managedCustomers: number;
  activeCustomers: number;
  disabledCustomers: number;
  expiredCustomers: number;
  unmanagedKeys: number;
  missingKeys: number;
  customerDataAvailable: boolean;
  detail?: string;
  checkedAt: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { serverId: string } }
) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const { serverId } = params;

    // Registry name fallback; resolveServer throws if the server is unknown.
    const registered = await resolveServer(serverId).catch(() => {
      throw new AppError("Server not found.", 404, "SERVER_NOT_FOUND");
    });

    const checkedAt = new Date().toISOString();

    // Outline API calls + customer records, isolated so one failure degrades
    // gracefully rather than throwing the whole response.
    const [infoResult, keysResult, metricsResult, recordsResult] =
      await Promise.allSettled([
        getServerInfo(serverId),
        listAccessKeys(serverId),
        getTransferMetrics(serverId),
        listDynamicRecords(),
      ]);

    // Management API is considered reachable if the key list loaded.
    if (keysResult.status === "rejected") {
      return successResponse<ServerDetails>({
        serverId,
        name: registered.name,
        online: false,
        status: "critical",
        version: null,
        metricsEnabled: null,
        totalKeys: 0,
        totalDataUsedBytes: 0,
        managedCustomers: 0,
        activeCustomers: 0,
        disabledCustomers: 0,
        expiredCustomers: 0,
        unmanagedKeys: 0,
        missingKeys: 0,
        customerDataAvailable: recordsResult.status === "fulfilled",
        detail: "Management API unreachable",
        checkedAt,
      });
    }

    const outlineKeys = keysResult.value;
    const outlineKeyIds = outlineKeyIdSet(outlineKeys);

    const info = infoResult.status === "fulfilled" ? infoResult.value : null;
    const metrics =
      metricsResult.status === "fulfilled"
        ? metricsResult.value.bytesTransferredByUserId ?? {}
        : {};
    const totalDataUsedBytes = Object.values(metrics).reduce((a, b) => a + b, 0);

    const customerDataAvailable = recordsResult.status === "fulfilled";
    const allRecords = customerDataAvailable ? recordsResult.value : [];
    const serverRecords = allRecords.filter(
      (r) => r.serverId === serverId && r.status !== "revoked"
    );

    const activeCustomers = serverRecords.filter((r) => r.status === "active").length;
    const disabledCustomers = serverRecords.filter((r) => r.status === "disabled").length;
    const expiredCustomers = serverRecords.filter((r) => r.status === "expired").length;
    const managedCustomers = serverRecords.length;

    const missingKeys = customerDataAvailable
      ? serverRecords.filter(
          (r) => !outlineKeyIds.has(normalizeOutlineKeyId(r.outlineKeyId))
        ).length
      : 0;

    // Unmanaged: Outline keys with no matching managed identity.
    let unmanagedKeys = 0;
    if (customerDataAvailable) {
      for (const key of outlineKeys) {
        const token = await getTokenByOutlineKey(
          serverId,
          normalizeOutlineKeyId(key.id)
        ).catch(() => null);
        if (!token) unmanagedKeys++;
      }
    }

    const issues: string[] = [];
    let status: HealthStatus = "healthy";
    if (infoResult.status === "rejected") {
      issues.push("Server info unavailable (keys still loaded)");
      status = "warning";
    }
    if (!customerDataAvailable) {
      issues.push("Customer records unavailable");
      status = "warning";
    }
    if (missingKeys > 0) {
      issues.push(`${missingKeys} managed record(s) missing Outline key`);
      status = "warning";
    }

    return successResponse<ServerDetails>({
      serverId,
      name: info?.name || registered.name,
      online: true,
      status,
      version: info?.version ?? null,
      metricsEnabled: info?.metricsEnabled ?? null,
      totalKeys: outlineKeys.length,
      totalDataUsedBytes,
      managedCustomers,
      activeCustomers,
      disabledCustomers,
      expiredCustomers,
      unmanagedKeys,
      missingKeys,
      customerDataAvailable,
      detail: issues.length ? issues.join("; ") : undefined,
      checkedAt,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
