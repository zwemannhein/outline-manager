/**
 * The single order-approval implementation.
 *
 * Both the admin dashboard (`POST /api/v1/orders/[id]/approve`) and the Telegram
 * webhook call `approveOrder()`. Previously these were two divergent code paths —
 * the Telegram one never wrote expiry metadata at all — and either could race the
 * other into creating duplicate Outline keys for one customer.
 *
 * ── GUARANTEES ──────────────────────────────────────────────────────────────
 * 1. At most one Outline key per order, even under concurrent approval, retry
 *    after a crash, or a duplicate Telegram tap.
 * 2. Exactly one permanent dynamic token per order, reused on every retry so the
 *    customer's ssconf:// URL never changes.
 * 3. An interrupted approval never leaves an unmapped-but-live Outline key
 *    granting free access.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * A short Redis lock serialises approvals. Then, BEFORE any Outline write, we
 * reconcile: if a dynamic identity already exists for this order we adopt it; if
 * a pending-intent marker exists we look for the key that intent may have
 * created. The permanent token is generated BEFORE the Outline call and recorded
 * in the intent marker, so a crash mid-approval can be tied back to the same
 * identity rather than producing a second one.
 *
 * Order status is written LAST, so a crash never marks an order approved without
 * a resolvable key.
 *
 * The genuinely ambiguous case — several unmapped keys with the customer's name
 * on the target server — escalates to a human instead of guessing, because
 * guessing could hand one customer another customer's key.
 */

import { randomUUID } from "crypto";
import { getRedis } from "./api-utils";
import { createLogger, maskId } from "./logger";
import {
  generateDynamicToken,
  isValidDynamicToken,
  createDynamicIdentity,
  readDynamicRecord,
  getTokenByOrder,
  getTokenByOutlineKey,
  buildDynamicUrl,
  scheduleCycleDue,
  scheduleExpiryDue,
  orderIndexKey,
} from "./dynamic-keys";
import {
  buildInitialMeta,
  writeKeyMeta,
  readKeyMeta,
  cycleDueAt,
  expiryAt,
  GIB,
} from "./key-meta";
import {
  listAccessKeys,
  createAccessKey,
  renameAccessKey,
  applyDataLimit,
  accessKeyExists,
  resolveServer,
  listRegisteredServers,
  OutlineApiError,
} from "./outline-admin";
import { putDynamicProjection } from "./kv-sync";
import type { AccessKey, DynamicKeyRecord, Order } from "./types";

const logger = createLogger("order-approval");

const ORDERS_KEY = "outline_orders";

/** Lock lifetime. Long enough for several Outline round trips, short enough to self-heal. */
const LOCK_TTL_SECONDS = 60;
/** Intent marker lifetime; outlives the lock so reconciliation can still see it. */
const PENDING_TTL_SECONDS = 900;

export function orderLockKey(orderId: string): string {
  return `lock:order:${orderId}`;
}
export function pendingIntentKey(orderId: string): string {
  return `dynpending:${orderId}`;
}

// ── Plan interpretation ───────────────────────────────────────────────────────

export interface PlanTerms {
  /** Quota per 30-day cycle in bytes. null = unlimited. */
  quotaBytes: number | null;
  /** Number of 30-day cycles purchased. */
  cyclesTotal: number;
}

/**
 * Resolve an order's plan into quota-per-cycle and a cycle count.
 *
 * Quota is PER CYCLE, never a pooled total: "100 GB x 6 months" means 100 GB
 * every 30 days for six cycles, up to 600 GB, with no rollover of unused data.
 */
export function resolvePlanTerms(order: Pick<Order, "plan" | "customDataLimitGB" | "customMonths">): PlanTerms {
  const cyclesTotal = Math.max(1, Math.floor(order.customMonths ?? 1));

  if (order.plan === "custom") {
    // null / undefined customDataLimitGB on a custom plan means unlimited.
    const gb = order.customDataLimitGB;
    return {
      quotaBytes: gb === null || gb === undefined ? null : Math.floor(gb * GIB),
      cyclesTotal,
    };
  }

  const perCycleGb: Record<string, number | null> = {
    plan_a: null, // unlimited
    plan_b: 100,
    "10gb": 10,
    "20gb": 20,
    "50gb": 50,
    "100gb": 100,
  };

  const gb = perCycleGb[order.plan];
  return {
    quotaBytes: gb === null || gb === undefined ? null : Math.floor(gb * GIB),
    cyclesTotal,
  };
}

// ── Results ───────────────────────────────────────────────────────────────────

export type ApprovalResult =
  | {
      ok: true;
      /** True when an existing identity was adopted instead of creating a key. */
      reconciled: boolean;
      token: string;
      dynamicUrl: string;
      serverId: string;
      outlineKeyId: string;
      /** Set when the authoritative state committed but the KV push did not. */
      syncPending: boolean;
    }
  | {
      ok: false;
      code:
        | "ORDER_NOT_FOUND"
        | "ALREADY_PROCESSED"
        | "APPROVAL_IN_PROGRESS"
        | "NO_SERVERS"
        | "SERVER_NOT_FOUND"
        | "NEEDS_RECONCILIATION"
        | "OUTLINE_FAILED"
        | "INCONSISTENT_STATE";
      message: string;
    };

interface PendingIntent {
  token: string;
  serverId: string;
  requestId: string;
  createdAt: string;
  customerName: string;
}

// ── Orders persistence ────────────────────────────────────────────────────────

async function loadOrders(): Promise<Order[]> {
  const redis = getRedis();
  const data = await redis.get<Order[]>(ORDERS_KEY);
  return Array.isArray(data) ? data : [];
}

async function saveOrders(orders: Order[]): Promise<void> {
  const redis = getRedis();
  await redis.set(ORDERS_KEY, orders);
}

// ── Locking ───────────────────────────────────────────────────────────────────

/**
 * `SET NX EX` is atomic on Upstash, so exactly one caller acquires the lock.
 * Release is value-checked so a slow holder cannot delete a later holder's lock.
 */
async function acquireLock(orderId: string, requestId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(orderLockKey(orderId), requestId, {
    nx: true,
    ex: LOCK_TTL_SECONDS,
  });
  return result === "OK";
}

async function releaseLock(orderId: string, requestId: string): Promise<void> {
  const redis = getRedis();
  const current = await redis.get<string>(orderLockKey(orderId));
  if (current === requestId) {
    await redis.del(orderLockKey(orderId));
  }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/**
 * Find Outline keys that a crashed approval may have created.
 *
 * A candidate is a key on the target server bearing the customer's exact name
 * that no dynamic identity maps to. Outline offers no client-supplied idempotency
 * key, so name plus absence-of-mapping is the only available correlation.
 */
async function findOrphanCandidates(
  serverId: string,
  customerName: string
): Promise<AccessKey[]> {
  const keys = await listAccessKeys(serverId);
  const candidates: AccessKey[] = [];

  for (const key of keys) {
    if ((key.name ?? "") !== customerName) continue;
    const mapped = await getTokenByOutlineKey(serverId, key.id);
    if (!mapped) candidates.push(key);
  }

  return candidates;
}

/**
 * Finish an approval around an identity that already exists.
 * Writes metadata if missing, schedules due entries, projects to KV, and marks
 * the order approved. Creates no Outline key.
 */
async function finaliseWithExistingIdentity(
  order: Order,
  record: DynamicKeyRecord,
  orders: Order[],
  terms: PlanTerms
): Promise<ApprovalResult> {
  let meta = await readKeyMeta(record.serverId, record.outlineKeyId);
  if (!meta) {
    meta = buildInitialMeta({
      quotaBytes: terms.quotaBytes,
      cyclesTotal: terms.cyclesTotal,
      startedAt: order.approvedAt ? new Date(order.approvedAt) : new Date(),
    });
    await writeKeyMeta(record.serverId, record.outlineKeyId, meta);
  }

  const cycleDue = cycleDueAt(meta);
  if (cycleDue) await scheduleCycleDue(record.token, cycleDue);
  const expiry = expiryAt(meta);
  if (expiry) await scheduleExpiryDue(record.token, expiry);

  const sync = await putDynamicProjection(record);

  const idx = orders.findIndex((o) => o.id === order.id);
  if (idx !== -1) {
    orders[idx] = {
      ...orders[idx],
      status: "approved",
      serverId: record.serverId,
      keyId: record.outlineKeyId,
      accessUrl: record.accessUrl,
      dynamicToken: record.token,
      needsReconciliation: false,
      approvedAt: orders[idx].approvedAt ?? Date.now(),
    };
    await saveOrders(orders);
  }

  const redis = getRedis();
  await redis.del(pendingIntentKey(order.id));

  return {
    ok: true,
    reconciled: true,
    token: record.token,
    dynamicUrl: buildDynamicUrl(record.token, record.name),
    serverId: record.serverId,
    outlineKeyId: record.outlineKeyId,
    syncPending: !sync.ok,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface ApproveOptions {
  orderId: string;
  /** Optional override; defaults to the server chosen at order time. */
  serverId?: string | null;
  /** For audit logging: "web" or "telegram". */
  source: "web" | "telegram";
}

/**
 * Approve an order: create and configure the Outline key, mint the permanent
 * identity, and commit authoritative state.
 *
 * Safe to call twice. Safe to call from two places at once. Safe to retry after
 * a crash at any point.
 */
export async function approveOrder(options: ApproveOptions): Promise<ApprovalResult> {
  const { orderId, source } = options;
  const requestId = randomUUID();
  const redis = getRedis();

  // ── 1. Serialise approvals for this order ─────────────────────────────────
  const locked = await acquireLock(orderId, requestId);
  if (!locked) {
    logger.warn({ orderId, source }, "Approval already in progress");
    return {
      ok: false,
      code: "APPROVAL_IN_PROGRESS",
      message: "This order is already being approved. Please wait a moment.",
    };
  }

  try {
    const orders = await loadOrders();
    const order = orders.find((o) => o.id === orderId);
    if (!order) {
      return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found." };
    }
    if (order.status === "rejected") {
      return { ok: false, code: "ALREADY_PROCESSED", message: "This order was rejected." };
    }

    const terms = resolvePlanTerms(order);

    // ── 2a. An identity already exists for this order: adopt it ─────────────
    const existingToken = await getTokenByOrder(orderId);
    if (existingToken) {
      const record = await readDynamicRecord(existingToken);
      if (record) {
        const stillThere = await accessKeyExists(record.serverId, record.outlineKeyId).catch(
          () => false
        );

        if (stillThere) {
          logger.info(
            { orderId, dyn: maskId(existingToken), source },
            "Approval reconciled against existing identity"
          );
          return await finaliseWithExistingIdentity(order, record, orders, terms);
        }

        // The key was deleted out of band. Recreate it but REUSE the token so the
        // customer's permanent URL survives.
        logger.warn(
          { orderId, dyn: maskId(existingToken) },
          "Existing identity points at a missing Outline key; recreating under the same token"
        );
        return await createKeyAndCommit({
          order,
          orders,
          terms,
          token: existingToken,
          serverIdOverride: options.serverId ?? record.serverId,
          requestId,
          source,
          reusingIdentity: true,
        });
      }
    }

    // ── 2b. A pending intent exists: a previous attempt may have created a key ─
    const rawIntent = await redis.get<PendingIntent | string>(pendingIntentKey(orderId));
    let intent: PendingIntent | null = null;
    if (rawIntent) {
      intent =
        typeof rawIntent === "string"
          ? (() => {
              try {
                return JSON.parse(rawIntent) as PendingIntent;
              } catch {
                return null;
              }
            })()
          : rawIntent;
    }

    if (intent && isValidDynamicToken(intent.token)) {
      const candidates = await findOrphanCandidates(intent.serverId, intent.customerName).catch(
        () => [] as AccessKey[]
      );

      if (candidates.length === 1) {
        // Adopt the orphan under the token the previous attempt had reserved.
        const adopted = candidates[0];
        logger.warn(
          { orderId, dyn: maskId(intent.token), keyId: adopted.id },
          "Adopting orphaned Outline key from an interrupted approval"
        );
        return await adoptExistingKey({
          order,
          orders,
          terms,
          token: intent.token,
          serverId: intent.serverId,
          key: adopted,
        });
      }

      if (candidates.length > 1) {
        // Never guess between customers. Escalate.
        const idx = orders.findIndex((o) => o.id === orderId);
        if (idx !== -1) {
          orders[idx] = { ...orders[idx], needsReconciliation: true };
          await saveOrders(orders);
        }
        logger.error(
          { orderId, candidateCount: candidates.length, keyIds: candidates.map((c) => c.id) },
          "Multiple orphan candidates; manual reconciliation required"
        );
        return {
          ok: false,
          code: "NEEDS_RECONCILIATION",
          message:
            "Multiple unmapped keys match this customer on the target server. Resolve manually before approving.",
        };
      }

      // Zero candidates: nothing was created. Reuse the reserved token.
      return await createKeyAndCommit({
        order,
        orders,
        terms,
        token: intent.token,
        serverIdOverride: options.serverId ?? intent.serverId,
        requestId,
        source,
        reusingIdentity: true,
      });
    }

    // ── 2c. Approved but with no identity: inconsistent, needs a human ───────
    if (order.status === "approved") {
      logger.error({ orderId }, "Order is approved but has no dynamic identity");
      return {
        ok: false,
        code: "INCONSISTENT_STATE",
        message:
          "This order is marked approved but has no permanent key. Resolve manually.",
      };
    }

    // ── 3. Fresh approval ───────────────────────────────────────────────────
    return await createKeyAndCommit({
      order,
      orders,
      terms,
      token: generateDynamicToken(),
      serverIdOverride: options.serverId ?? order.serverId,
      requestId,
      source,
      reusingIdentity: false,
    });
  } catch (err) {
    logger.error(
      { orderId, source, reason: err instanceof Error ? err.message : "unknown" },
      "Approval failed unexpectedly"
    );
    if (err instanceof OutlineApiError) {
      return { ok: false, code: "OUTLINE_FAILED", message: "Outline server rejected the request." };
    }
    return { ok: false, code: "OUTLINE_FAILED", message: "Approval failed. Please retry." };
  } finally {
    await releaseLock(orderId, requestId);
  }
}

// ── Commit paths ──────────────────────────────────────────────────────────────

interface CreateAndCommitInput {
  order: Order;
  orders: Order[];
  terms: PlanTerms;
  token: string;
  serverIdOverride: string | null;
  requestId: string;
  source: "web" | "telegram";
  reusingIdentity: boolean;
}

/**
 * Create the Outline key, configure it, then commit authoritative state.
 *
 * Ordering matters: the intent marker is written BEFORE the Outline POST so a
 * crash between the two is recoverable, and the order status is written LAST.
 */
async function createKeyAndCommit(input: CreateAndCommitInput): Promise<ApprovalResult> {
  const { order, orders, terms, token, requestId, source } = input;
  const redis = getRedis();

  // Resolve the destination server.
  const servers = await listRegisteredServers();
  if (servers.length === 0) {
    return { ok: false, code: "NO_SERVERS", message: "No Outline servers are configured." };
  }

  const targetServer =
    (input.serverIdOverride ? servers.find((s) => s.id === input.serverIdOverride) : undefined) ??
    servers[0];

  if (!targetServer) {
    return { ok: false, code: "SERVER_NOT_FOUND", message: "Selected server is not registered." };
  }

  await resolveServer(targetServer.id);

  // 1. Intent marker BEFORE the Outline write, carrying the reserved token.
  const intent: PendingIntent = {
    token,
    serverId: targetServer.id,
    requestId,
    createdAt: new Date().toISOString(),
    customerName: order.name,
  };
  await redis.set(pendingIntentKey(order.id), JSON.stringify(intent), {
    ex: PENDING_TTL_SECONDS,
  });

  // 2. Create and configure the Outline key.
  let key: AccessKey;
  try {
    key = await createAccessKey(targetServer.id, order.name);
  } catch (err) {
    logger.error({ orderId: order.id, serverId: targetServer.id }, "Outline key creation failed");
    // Intent marker is intentionally left in place: if the key was in fact
    // created before the error surfaced, the next attempt will adopt it.
    throw err;
  }

  try {
    await applyDataLimit(targetServer.id, key.id, terms.quotaBytes);
  } catch (err) {
    logger.error(
      { orderId: order.id, serverId: targetServer.id, keyId: key.id },
      "Failed to apply data limit after key creation"
    );
    throw err;
  }

  return commitIdentity({
    order,
    orders,
    terms,
    token,
    serverId: targetServer.id,
    key,
    source,
  });
}

interface AdoptInput {
  order: Order;
  orders: Order[];
  terms: PlanTerms;
  token: string;
  serverId: string;
  key: AccessKey;
}

/** Adopt an orphaned key: reapply configuration, then commit as normal. */
async function adoptExistingKey(input: AdoptInput): Promise<ApprovalResult> {
  // Reassert name and limit; the interrupted attempt may not have got that far.
  await renameAccessKey(input.serverId, input.key.id, input.order.name).catch(() => {});
  await applyDataLimit(input.serverId, input.key.id, input.terms.quotaBytes);

  return commitIdentity({
    order: input.order,
    orders: input.orders,
    terms: input.terms,
    token: input.token,
    serverId: input.serverId,
    key: input.key,
    source: "web",
  });
}

interface CommitInput {
  order: Order;
  orders: Order[];
  terms: PlanTerms;
  token: string;
  serverId: string;
  key: AccessKey;
  source: "web" | "telegram";
}

/**
 * Write authoritative state, then project to KV, then mark the order approved.
 *
 * A KV failure here is non-fatal: the identity is committed and queued dirty, so
 * the customer's key starts working once the cron drains the queue.
 */
async function commitIdentity(input: CommitInput): Promise<ApprovalResult> {
  const { order, orders, terms, token, serverId, key } = input;
  const redis = getRedis();

  // 1. Key metadata: quota per cycle, anchored period, derived expiry.
  const meta = buildInitialMeta({
    quotaBytes: terms.quotaBytes,
    cyclesTotal: terms.cyclesTotal,
  });
  await writeKeyMeta(serverId, key.id, meta);

  // 2. Authoritative identity + indexes.
  const record = await createDynamicIdentity({
    token,
    orderId: order.id,
    serverId,
    outlineKeyId: key.id,
    accessUrl: key.accessUrl,
    name: order.name,
    status: "active",
  });

  // 3. Cycle and expiry schedules for the cron.
  const cycleDue = cycleDueAt(meta);
  if (cycleDue) await scheduleCycleDue(token, cycleDue);
  const expiry = expiryAt(meta);
  if (expiry) await scheduleExpiryDue(token, expiry);

  // 4. Public projection.
  const sync = await putDynamicProjection(record);

  // 5. Intent satisfied.
  await redis.del(pendingIntentKey(order.id));

  // 6. Order status LAST.
  const idx = orders.findIndex((o) => o.id === order.id);
  if (idx !== -1) {
    orders[idx] = {
      ...orders[idx],
      status: "approved",
      serverId,
      keyId: key.id,
      accessUrl: key.accessUrl,
      dynamicToken: token,
      needsReconciliation: false,
      approvedAt: Date.now(),
    };
    await saveOrders(orders);
  }

  logger.info(
    {
      orderId: order.id,
      dyn: maskId(token),
      serverId,
      keyId: key.id,
      source: input.source,
      syncPending: !sync.ok,
    },
    "Order approved and permanent identity committed"
  );

  return {
    ok: true,
    reconciled: false,
    token,
    dynamicUrl: buildDynamicUrl(token, order.name),
    serverId,
    outlineKeyId: key.id,
    syncPending: !sync.ok,
  };
}

// ── Rejection ─────────────────────────────────────────────────────────────────

export type RejectResult =
  | { ok: true }
  | { ok: false; code: "ORDER_NOT_FOUND" | "ALREADY_PROCESSED" | "APPROVAL_IN_PROGRESS"; message: string };

/**
 * Reject an order. Uses the same lock as approval so the two cannot race, which
 * was previously possible between the web UI and Telegram.
 */
export async function rejectOrder(orderId: string): Promise<RejectResult> {
  const requestId = randomUUID();

  const locked = await acquireLock(orderId, requestId);
  if (!locked) {
    return {
      ok: false,
      code: "APPROVAL_IN_PROGRESS",
      message: "This order is currently being processed.",
    };
  }

  try {
    const orders = await loadOrders();
    const idx = orders.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found." };
    }
    if (orders[idx].status !== "pending") {
      return {
        ok: false,
        code: "ALREADY_PROCESSED",
        message: "This order has already been processed.",
      };
    }

    orders[idx] = { ...orders[idx], status: "rejected" };
    await saveOrders(orders);

    logger.info({ orderId }, "Order rejected");
    return { ok: true };
  } finally {
    await releaseLock(orderId, requestId);
  }
}

/** Read one order. Exposed so routes do not each re-implement blob loading. */
export async function findOrder(orderId: string): Promise<Order | null> {
  const orders = await loadOrders();
  return orders.find((o) => o.id === orderId) ?? null;
}

export { loadOrders, saveOrders };
