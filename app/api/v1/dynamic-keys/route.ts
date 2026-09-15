/**
 * GET /api/v1/dynamic-keys — admin listing of permanent customer identities.
 *
 * One call returns everything the admin table needs: identity, quota/cycle state,
 * live usage, expiry, and edge sync status.
 *
 * The raw ss:// access URL is deliberately excluded so the value does not sit in
 * every table render, browser cache, or devtools network log. Revealing it is an
 * explicit, audited action through `revealRaw` only.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-utils";
import {
  listDynamicRecords,
  buildDynamicUrl,
  pendingCleanupEntries,
} from "@/lib/dynamic-keys";
import { readAllKeyMeta, metaField, computeQuotaUsage, describeQuota } from "@/lib/key-meta";
import { getSyncState, getWriteBudget, countDirtyTokens } from "@/lib/kv-sync";
import { listRegisteredServers, getTransferMetrics, listAccessKeys } from "@/lib/outline-admin";
import { createLogger } from "@/lib/logger";

const logger = createLogger("dynamic-keys-api");

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) {
      return unauthorizedResponse();
    }

    const [records, allMeta, servers] = await Promise.all([
      listDynamicRecords(),
      readAllKeyMeta(),
      listRegisteredServers(),
    ]);

    const serverNames = new Map(servers.map((s) => [s.id, s.name]));

    // Fetch each server's metrics and key inventory ONCE rather than per key.
    // A null key set means the inventory was unreadable, not that every key is
    // missing; only a successful inventory can authoritatively mark an orphan.
    const usageByServer = new Map<string, Record<string, number>>();
    const keyIdsByServer = new Map<string, Set<string> | null>();
    const snapshots = await Promise.all(
      servers.map(async (server) => {
        const [metrics, keys] = await Promise.allSettled([
          getTransferMetrics(server.id),
          listAccessKeys(server.id),
        ]);
        return { server, metrics, keys };
      })
    );
    for (const { server, metrics, keys } of snapshots) {
      usageByServer.set(
        server.id,
        metrics.status === "fulfilled" ? metrics.value.bytesTransferredByUserId ?? {} : {}
      );
      keyIdsByServer.set(
        server.id,
        // Outline 1.12.x can serialize numeric-looking IDs as numbers even
        // though our persisted identity schema stores them as strings.
        keys.status === "fulfilled" ? new Set(keys.value.map((key) => String(key.id))) : null
      );
    }

    const rows = await Promise.all(
      records
        .filter((r) => r.status !== "revoked")
        .map(async (record) => {
          const meta = allMeta[metaField(record.serverId, record.outlineKeyId)] ?? null;
          const liveBytes = usageByServer.get(record.serverId)?.[record.outlineKeyId] ?? 0;
          const usage = meta ? computeQuotaUsage(meta, liveBytes) : null;
          const syncState = await getSyncState(record);
          const serverKeyIds = keyIdsByServer.get(record.serverId) ?? null;

          return {
            token: record.token,
            name: record.name,
            orderId: record.orderId,
            serverId: record.serverId,
            serverName: serverNames.get(record.serverId) ?? "Unknown server",
            outlineKeyId: record.outlineKeyId,
            status: record.status,
            rev: record.rev,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,

            // The customer's permanent key — the primary thing to copy.
            dynamicUrl: buildDynamicUrl(record.token, record.name),

            // configuredQuotaBytes is always the admin-set allowance, never
            // the decreasing "remaining" value.  Used by the UI to show the
            // plan quota without confusion.
            configuredQuotaBytes: meta?.quotaBytes ?? null,
            quotaBytes: usage?.quotaBytes ?? meta?.quotaBytes ?? null,
            usedBytes: usage?.totalUsedBytes ?? liveBytes,
            carriedBytes: usage?.carriedBytes ?? 0,
            remainingBytes: usage?.remainingBytes ?? null,
            quotaExhausted: usage?.exhausted ?? false,
            planDescription: meta ? describeQuota(meta) : null,

            periodStart: meta?.periodStart ?? null,
            expiryDate: meta?.expiryDate ?? null,
            cyclesTotal: meta?.cyclesTotal ?? null,
            cyclesUsed: meta?.cyclesUsed ?? null,

            syncState,
            suspendedState: record.suspendedState,
            cleanupPending: pendingCleanupEntries(record).length > 0,
            // Surfaces keys deleted out of band in the official Outline app.
            orphaned: serverKeyIds !== null && !serverKeyIds.has(String(record.outlineKeyId)),
          };
        })
    );

    rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const [budget, dirtyCount] = await Promise.all([getWriteBudget(), countDirtyTokens()]);

    logger.info({ user: auth.username, count: rows.length }, "Dynamic key list retrieved");

    return successResponse({
      customers: rows,
      health: {
        kvWritesUsedToday: budget.used,
        kvWriteLimit: budget.limit,
        kvWritesRemaining: budget.remaining,
        kvBudgetWarning: budget.warn,
        pendingEdgeSyncs: dirtyCount,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
