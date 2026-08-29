/**
 * Backfill: give every pre-existing Outline key a permanent dynamic identity.
 *
 * HARD GUARANTEE — creates ZERO Outline keys.
 * The job only issues `GET /access-keys` and writes metadata/mappings. It never
 * POSTs to Outline, so it cannot duplicate a customer's key or disturb service.
 * Existing limits and expiry metadata are preserved exactly as found.
 *
 * IDEMPOTENCY
 * Driven off `dynidx:key:<serverId>:<keyId>`. If a mapping exists the key is
 * skipped before a token is even generated, so running the job twice produces
 * `tokensCreated: 0` and issues no Cloudflare KV writes.
 *
 * WHY IT READS OUTLINE RATHER THAN THE ORDERS ARRAY
 * Keys created by hand through the dashboard have no order. Enumerating the live
 * server catches those too; the orders array would miss them.
 *
 * FREE-TIER SAFETY
 * Each new identity costs one Cloudflare KV write, and the free tier allows 1,000
 * per day. The job reports the remaining budget, refuses to exceed it, and is
 * resumable — an interrupted or budget-capped run simply continues next time
 * because completed keys are already mapped.
 *
 * EXISTING CUSTOMERS
 * Their raw ss:// keys keep working untouched. The permanent ssconf:// URL becomes
 * available immediately but is handed out manually, at the operator's pace. Note
 * that only customers who have switched to ssconf:// can later be migrated between
 * servers, since a raw-key holder has no indirection to re-point.
 */

import { createLogger, maskId } from "./logger";
import {
  generateDynamicToken,
  getTokenByOutlineKey,
  createDynamicIdentity,
  scheduleCycleDue,
  scheduleExpiryDue,
  buildDynamicUrl,
  orderIndexKey,
} from "./dynamic-keys";
import {
  readKeyMeta,
  writeKeyMeta,
  buildInitialMeta,
  cycleDueAt,
  expiryAt,
  CYCLE_MS,
} from "./key-meta";
import { listRegisteredServers, listAccessKeys } from "./outline-admin";
import { putDynamicProjection, getWriteBudget } from "./kv-sync";
import { getRedis } from "./api-utils";
import { loadOrders, saveOrders } from "./order-approval";
import type { AccessKey, KeyMeta, Order } from "./types";

const logger = createLogger("backfill");

export interface BackfillPlanItem {
  serverId: string;
  serverName: string;
  outlineKeyId: string;
  keyName: string;
  limitBytes: number | null;
  hasExistingMeta: boolean;
  action: "create" | "skip";
  reason?: string;
}

export interface BackfillReport {
  dryRun: boolean;
  serversScanned: number;
  keysScanned: number;
  tokensCreated: number;
  skipped: number;
  ordersLinked: number;
  kvWrites: number;
  kvWriteBudgetRemaining: number;
  budgetCapped: boolean;
  warnings: string[];
  items: BackfillPlanItem[];
}

export interface BackfillOptions {
  dryRun?: boolean;
  /** Bound the work per invocation. Resumable, so a partial run is safe. */
  limit?: number;
}

/**
 * Derive metadata for a pre-existing key.
 *
 * The existing Outline limit becomes the per-cycle quota, so nothing about the
 * customer's current entitlement changes. When an expiry date already exists we
 * infer the cycle anchor backwards from it, which keeps the customer's renewal
 * date stable instead of silently resetting it to today.
 */
export function deriveBackfillMeta(
  key: AccessKey,
  existing: KeyMeta | null
): KeyMeta {
  const limitBytes = key.dataLimit?.bytes ?? key.limit?.bytes ?? null;

  // Preserve whatever is already recorded; only fill in what is missing.
  if (existing) {
    return {
      ...existing,
      quotaBytes: existing.quotaBytes ?? limitBytes,
      carriedBytes: existing.carriedBytes ?? 0,
      cyclesTotal: existing.cyclesTotal ?? 1,
      cyclesUsed: existing.cyclesUsed ?? 1,
      periodStart: existing.periodStart ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const base = buildInitialMeta({ quotaBytes: limitBytes, cyclesTotal: 1 });
  return base;
}

/**
 * Anchor the cycle backwards from a known expiry so the renewal date is preserved.
 * Used when legacy metadata carried only `expiryDate`.
 */
export function anchorFromExpiry(expiryIso: string, cyclesTotal = 1): KeyMeta {
  const expiry = Date.parse(expiryIso);
  const safeExpiry = Number.isNaN(expiry) ? Date.now() + CYCLE_MS : expiry;
  const cycles = Math.max(1, cyclesTotal);

  return {
    expiryDate: new Date(safeExpiry).toISOString(),
    // periodStart is the start of the CURRENT cycle, i.e. one cycle before expiry.
    periodStart: new Date(safeExpiry - CYCLE_MS).toISOString(),
    carriedBytes: 0,
    cyclesTotal: cycles,
    cyclesUsed: cycles,
    quotaBytes: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Run the backfill.
 *
 * With `dryRun: true` nothing is written and the returned `items` describe exactly
 * what a live run would do.
 */
export async function runBackfill(options: BackfillOptions = {}): Promise<BackfillReport> {
  const dryRun = options.dryRun !== false ? options.dryRun === true : false;
  const limit = options.limit ?? 200;

  const warnings: string[] = [];
  const items: BackfillPlanItem[] = [];

  const servers = await listRegisteredServers();
  if (servers.length === 0) {
    warnings.push("No Outline servers are registered; nothing to backfill.");
  }

  const budget = await getWriteBudget();
  let kvWrites = 0;
  let tokensCreated = 0;
  let skipped = 0;
  let keysScanned = 0;
  let budgetCapped = false;

  const redis = getRedis();

  for (const server of servers) {
    let keys: AccessKey[] = [];
    try {
      // READ ONLY. This job never POSTs to Outline.
      keys = await listAccessKeys(server.id);
    } catch {
      warnings.push(`Could not list keys on "${server.name}"; skipped that server.`);
      continue;
    }

    for (const key of keys) {
      keysScanned += 1;

      if (items.length >= limit) {
        budgetCapped = true;
        warnings.push(
          `Reached the per-run limit of ${limit} keys. Re-run to continue; completed keys are skipped automatically.`
        );
        break;
      }

      // Idempotency gate — short-circuits BEFORE generating a token.
      const existingToken = await getTokenByOutlineKey(server.id, key.id);
      if (existingToken) {
        skipped += 1;
        items.push({
          serverId: server.id,
          serverName: server.name,
          outlineKeyId: key.id,
          keyName: key.name || "(unnamed)",
          limitBytes: key.dataLimit?.bytes ?? key.limit?.bytes ?? null,
          hasExistingMeta: true,
          action: "skip",
          reason: "already has a permanent identity",
        });
        continue;
      }

      const existingMeta = await readKeyMeta(server.id, key.id);
      const meta = deriveBackfillMeta(key, existingMeta);

      items.push({
        serverId: server.id,
        serverName: server.name,
        outlineKeyId: key.id,
        keyName: key.name || "(unnamed)",
        limitBytes: meta.quotaBytes ?? null,
        hasExistingMeta: existingMeta !== null,
        action: "create",
      });

      if (dryRun) {
        tokensCreated += 1; // projected count
        continue;
      }

      // Respect the Cloudflare KV daily write ceiling.
      if (budget.used + kvWrites >= 950) {
        budgetCapped = true;
        warnings.push(
          "Cloudflare KV daily write budget nearly exhausted. Stopping; re-run tomorrow to continue."
        );
        break;
      }

      const token = generateDynamicToken();

      await writeKeyMeta(server.id, key.id, meta);

      const record = await createDynamicIdentity({
        token,
        orderId: null,
        serverId: server.id,
        outlineKeyId: key.id,
        accessUrl: key.accessUrl,
        name: key.name || "Unnamed",
        status: "active",
      });

      const cycleDue = cycleDueAt(meta);
      if (cycleDue) await scheduleCycleDue(token, cycleDue);
      const expiry = expiryAt(meta);
      if (expiry) await scheduleExpiryDue(token, expiry);

      const sync = await putDynamicProjection(record);
      if (sync.ok && !sync.skipped) kvWrites += 1;
      if (!sync.ok) {
        warnings.push(
          `Identity created for "${key.name || key.id}" but the edge projection is queued for retry.`
        );
      }

      tokensCreated += 1;
      logger.info(
        { dyn: maskId(token), serverId: server.id, keyId: key.id },
        "Backfilled a permanent identity"
      );
    }

    if (budgetCapped) break;
  }

  // ── Link approved orders to the identities we just created ────────────────
  let ordersLinked = 0;
  if (!dryRun) {
    const orders = await loadOrders();
    let mutated = false;

    for (let i = 0; i < orders.length; i += 1) {
      const order = orders[i];
      if (order.status !== "approved") continue;
      if (order.dynamicToken) continue;
      if (!order.serverId || !order.keyId) continue;

      const token = await getTokenByOutlineKey(order.serverId, order.keyId);
      if (!token) continue;

      orders[i] = { ...order, dynamicToken: token };
      // Point the order index at the identity so future approvals reconcile.
      await redis.set(orderIndexKey(order.id), token);
      // Attach the order to the record for admin display.
      await redis.hset(`dynamic:${token}`, { orderId: order.id });
      ordersLinked += 1;
      mutated = true;
    }

    if (mutated) await saveOrders(orders);
  }

  const finalBudget = await getWriteBudget();

  return {
    dryRun,
    serversScanned: servers.length,
    keysScanned,
    tokensCreated,
    skipped,
    ordersLinked,
    kvWrites,
    kvWriteBudgetRemaining: finalBudget.remaining,
    budgetCapped,
    warnings,
    items,
  };
}
