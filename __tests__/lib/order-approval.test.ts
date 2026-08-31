import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";
import { fakeOutline } from "../helpers/fake-outline";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

// The Outline client is replaced wholesale so no real network call is possible.
vi.mock("@/lib/outline-admin", async () => {
  const { fakeOutline: fo } = await import("../helpers/fake-outline");

  class OutlineApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code: string
    ) {
      super(message);
    }
  }

  return {
    OutlineApiError,
    listRegisteredServers: async () => fo.servers,
    resolveServer: async (id: string) => {
      const s = fo.servers.find((x) => x.id === id);
      if (!s) throw new OutlineApiError("Server is not registered", 404, "NOT_FOUND");
      return s;
    },
    listAccessKeys: async (serverId: string) => fo.listKeys(serverId),
    getAccessKey: async (serverId: string, keyId: string) => fo.getKey(serverId, keyId) ?? null,
    accessKeyExists: async (serverId: string, keyId: string) =>
      fo.getKey(serverId, keyId) !== undefined,
    createAccessKey: async (serverId: string, name?: string) => {
      const key = (await fo.request(serverId, "POST", "/access-keys")) as {
        id: string;
        accessUrl: string;
        name: string;
      };
      if (name) {
        await fo.request(serverId, "PUT", `/access-keys/${key.id}/name`, { name });
        key.name = name;
      }
      return key;
    },
    renameAccessKey: async (serverId: string, keyId: string, name: string) => {
      await fo.request(serverId, "PUT", `/access-keys/${keyId}/name`, { name });
    },
    deleteAccessKey: async (serverId: string, keyId: string) => {
      await fo.request(serverId, "DELETE", `/access-keys/${keyId}`);
    },
    applyDataLimit: async (serverId: string, keyId: string, bytes: number | null) => {
      if (bytes === null) await fo.request(serverId, "DELETE", `/access-keys/${keyId}/data-limit`);
      else
        await fo.request(serverId, "PUT", `/access-keys/${keyId}/data-limit`, {
          limit: { bytes },
        });
    },
    getKeyLimitBytes: async (serverId: string, keyId: string) =>
      fo.getKey(serverId, keyId)?.dataLimit?.bytes ?? null,
    getKeyUsageBytes: async (serverId: string, keyId: string) => {
      const m = (await fo.request(serverId, "GET", "/metrics/transfer")) as {
        bytesTransferredByUserId: Record<string, number>;
      };
      return m.bytesTransferredByUserId[keyId] ?? 0;
    },
    getTransferMetrics: async (serverId: string) =>
      fo.request(serverId, "GET", "/metrics/transfer"),
  };
});

// KV is exercised separately; here it always succeeds so approval logic is isolated.
vi.mock("@/lib/kv-sync", () => ({
  putDynamicProjection: async () => ({ ok: true }),
  syncDynamicToken: async () => ({ ok: true }),
  deleteDynamicProjection: async () => ({ ok: true }),
  markDynamicDirty: async () => {},
  getWriteBudget: async () => ({ used: 0, limit: 1000, remaining: 1000, warn: false }),
  verifyProjectionCurrent: async () => ({ current: true, kvRev: 99 }),
  getSyncState: async () => "synced",
  countDirtyTokens: async () => 0,
  drainDirtyDynamicRecords: async () => ({
    attempted: 0,
    synced: 0,
    deleted: 0,
    failed: 0,
    remaining: 0,
  }),
}));

import { approveOrder, rejectOrder, resolvePlanTerms, pendingIntentKey } from "@/lib/order-approval";
import { getTokenByOrder, readDynamicRecord, buildDynamicUrl } from "@/lib/dynamic-keys";
import { readKeyMeta, GIB, CYCLE_MS } from "@/lib/key-meta";
import type { Order } from "@/lib/types";

const ORDERS_KEY = "outline_orders";
const ADMIN_DATA_KEY = "outline_admin_data";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1_abc",
    name: "Ko Aung",
    kpayRef: "123456",
    plan: "plan_b",
    customDataLimitGB: null,
    customMonths: 1,
    customDevices: null,
    status: "pending",
    serverId: "srv-a",
    keyId: null,
    accessUrl: null,
    createdAt: Date.now(),
    approvedAt: null,
    ...overrides,
  };
}

async function seed(orders: Order[]) {
  await fakeRedis.set(ORDERS_KEY, JSON.stringify(orders));
  await fakeRedis.set(
    ADMIN_DATA_KEY,
    JSON.stringify({ servers: fakeOutline.servers, keyMeta: {} })
  );
}

async function readOrders(): Promise<Order[]> {
  return ((await fakeRedis.get<Order[]>(ORDERS_KEY)) ?? []) as Order[];
}

beforeEach(async () => {
  fakeRedis.reset();
  fakeOutline.reset();
  fakeOutline.addServer("srv-a", "Server A");
  fakeOutline.addServer("srv-b", "Server B");
});

describe("plan terms are per 30-day cycle", () => {
  it("reads plan_b as 100 GB per cycle", () => {
    expect(resolvePlanTerms({ plan: "plan_b", customMonths: 1 })).toEqual({
      quotaBytes: 100 * GIB,
      cyclesTotal: 1,
    });
  });

  it("treats plan_a as unlimited", () => {
    expect(resolvePlanTerms({ plan: "plan_a", customMonths: 1 }).quotaBytes).toBeNull();
  });

  it("keeps a 6-month custom plan at the MONTHLY quota, not 6x", () => {
    const terms = resolvePlanTerms({
      plan: "custom",
      customDataLimitGB: 100,
      customMonths: 6,
    });
    // 100 GB every 30 days for 6 cycles, NOT a 600 GB pool.
    expect(terms.quotaBytes).toBe(100 * GIB);
    expect(terms.cyclesTotal).toBe(6);
  });

  it("treats a custom plan with null GB as unlimited", () => {
    expect(
      resolvePlanTerms({ plan: "custom", customDataLimitGB: null, customMonths: 3 }).quotaBytes
    ).toBeNull();
  });
});

describe("a fresh approval creates exactly one key and one identity", () => {
  it("creates one Outline key and one permanent token", async () => {
    await seed([makeOrder()]);

    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fakeOutline.createCalls).toHaveLength(1);
    expect(fakeOutline.totalKeyCount()).toBe(1);
    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
    expect(result.reconciled).toBe(false);
  });

  it("returns the permanent ssconf URL, never a raw ss:// key", async () => {
    await seed([makeOrder()]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");

    expect(result.dynamicUrl.startsWith("ssconf://")).toBe(true);
    expect(result.dynamicUrl).not.toContain("ss://c");
    expect(JSON.stringify(result)).not.toContain("ss://created");
  });

  it("returns the canonical Vercel URL without a customer-name fragment", async () => {
    await seed([makeOrder({ name: "Ko Aung" })]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");
    expect(result.dynamicUrl).toMatch(
      /^ssconf:\/\/outline-manager\.vercel\.app\/k\/[0-9a-f]{32}$/
    );
    expect(result.dynamicUrl).not.toContain("#");
  });

  it("names the Outline key after the customer and applies the plan quota", async () => {
    await seed([makeOrder()]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");

    const key = fakeOutline.getKey(result.serverId, result.outlineKeyId)!;
    expect(key.name).toBe("Ko Aung");
    expect(key.dataLimit?.bytes).toBe(100 * GIB);
  });

  it("removes the limit entirely for an unlimited plan", async () => {
    await seed([makeOrder({ plan: "plan_a" })]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");

    expect(fakeOutline.getKey(result.serverId, result.outlineKeyId)!.dataLimit).toBeUndefined();
  });

  it("writes anchored cycle metadata", async () => {
    await seed([makeOrder({ plan: "custom", customDataLimitGB: 100, customMonths: 6 })]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");

    const meta = await readKeyMeta(result.serverId, result.outlineKeyId);
    expect(meta?.quotaBytes).toBe(100 * GIB);
    expect(meta?.cyclesTotal).toBe(6);
    expect(meta?.cyclesUsed).toBe(1);
    expect(meta?.carriedBytes).toBe(0);

    const start = Date.parse(meta!.periodStart!);
    expect(Date.parse(meta!.expiryDate!)).toBe(start + 6 * CYCLE_MS);
  });

  it("indexes the identity by order and marks the order approved last", async () => {
    await seed([makeOrder()]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!result.ok) throw new Error("expected success");

    await expect(getTokenByOrder("ord_1_abc")).resolves.toBe(result.token);

    const orders = await readOrders();
    expect(orders[0].status).toBe("approved");
    expect(orders[0].dynamicToken).toBe(result.token);
    expect(orders[0].approvedAt).toBeTruthy();
  });

  it("clears the pending intent marker on success", async () => {
    await seed([makeOrder()]);
    await approveOrder({ orderId: "ord_1_abc", source: "web" });
    await expect(fakeRedis.exists(pendingIntentKey("ord_1_abc"))).resolves.toBe(0);
  });

  it("honours an explicit server override", async () => {
    await seed([makeOrder({ serverId: "srv-a" })]);
    const result = await approveOrder({
      orderId: "ord_1_abc",
      serverId: "srv-b",
      source: "web",
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.serverId).toBe("srv-b");
  });
});

describe("idempotency", () => {
  it("a second approval creates no second key and reuses the token", async () => {
    await seed([makeOrder()]);

    const first = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    const second = await approveOrder({ orderId: "ord_1_abc", source: "web" });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(fakeOutline.createCalls).toHaveLength(1);
    expect(fakeOutline.totalKeyCount()).toBe(1);
    expect(second.token).toBe(first.token);
    expect(second.reconciled).toBe(true);
    expect(second.dynamicUrl).toBe(first.dynamicUrl);
  });

  it("dashboard and Telegram approving concurrently create ONE key", async () => {
    await seed([makeOrder()]);

    const [a, b] = await Promise.all([
      approveOrder({ orderId: "ord_1_abc", source: "web" }),
      approveOrder({ orderId: "ord_1_abc", source: "telegram" }),
    ]);

    // Exactly one Outline key regardless of which call won the lock.
    expect(fakeOutline.createCalls).toHaveLength(1);
    expect(fakeOutline.totalKeyCount()).toBe(1);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);

    // Whoever lost must have been told the approval was already running.
    const losers = [a, b].filter((r) => !r.ok);
    for (const loser of losers) {
      if (!loser.ok) expect(loser.code).toBe("APPROVAL_IN_PROGRESS");
    }
  });

  it("three simultaneous approvals still create ONE key", async () => {
    await seed([makeOrder()]);

    await Promise.all([
      approveOrder({ orderId: "ord_1_abc", source: "web" }),
      approveOrder({ orderId: "ord_1_abc", source: "telegram" }),
      approveOrder({ orderId: "ord_1_abc", source: "web" }),
    ]);

    expect(fakeOutline.createCalls).toHaveLength(1);
  });

  it("refuses to approve a rejected order", async () => {
    await seed([makeOrder({ status: "rejected" })]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ALREADY_PROCESSED");
    expect(fakeOutline.totalKeyCount()).toBe(0);
  });

  it("reports a missing order", async () => {
    await seed([]);
    const result = await approveOrder({ orderId: "nope", source: "web" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ORDER_NOT_FOUND");
  });

  it("reports when no server is registered", async () => {
    fakeOutline.reset();
    await seed([makeOrder()]);
    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_SERVERS");
  });
});

describe("crash recovery and orphan adoption", () => {
  it("adopts the single orphan a crashed attempt left behind", async () => {
    await seed([makeOrder()]);

    // Simulate: token reserved, key created, then a crash before the record was
    // written. The intent marker is what makes this recoverable.
    const reservedToken = "a".repeat(32);
    const orphan = fakeOutline.seedKey("srv-a", { name: "Ko Aung" });
    await fakeRedis.set(
      pendingIntentKey("ord_1_abc"),
      JSON.stringify({
        token: reservedToken,
        serverId: "srv-a",
        requestId: "req-1",
        createdAt: new Date().toISOString(),
        customerName: "Ko Aung",
      })
    );

    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No NEW key was created; the orphan was adopted under the reserved token.
    expect(fakeOutline.createCalls).toHaveLength(0);
    expect(fakeOutline.totalKeyCount()).toBe(1);
    expect(result.token).toBe(reservedToken);
    expect(result.outlineKeyId).toBe(orphan.id);
  });

  it("reuses the reserved token when the crash left no key at all", async () => {
    await seed([makeOrder()]);

    const reservedToken = "b".repeat(32);
    await fakeRedis.set(
      pendingIntentKey("ord_1_abc"),
      JSON.stringify({
        token: reservedToken,
        serverId: "srv-a",
        requestId: "req-1",
        createdAt: new Date().toISOString(),
        customerName: "Ko Aung",
      })
    );

    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fakeOutline.createCalls).toHaveLength(1);
    // The customer's permanent URL is the one the interrupted attempt reserved.
    expect(result.token).toBe(reservedToken);
  });

  it("escalates instead of guessing when several orphans match", async () => {
    await seed([makeOrder()]);

    // Two unmapped keys with the same customer name: choosing wrongly could hand
    // one customer another's key, so this must NOT be resolved automatically.
    fakeOutline.seedKey("srv-a", { name: "Ko Aung" });
    fakeOutline.seedKey("srv-a", { name: "Ko Aung" });

    await fakeRedis.set(
      pendingIntentKey("ord_1_abc"),
      JSON.stringify({
        token: "c".repeat(32),
        serverId: "srv-a",
        requestId: "req-1",
        createdAt: new Date().toISOString(),
        customerName: "Ko Aung",
      })
    );

    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NEEDS_RECONCILIATION");

    // Nothing new created, and the order is flagged for a human.
    expect(fakeOutline.createCalls).toHaveLength(0);
    const orders = await readOrders();
    expect(orders[0].needsReconciliation).toBe(true);
    expect(orders[0].status).toBe("pending");
  });

  it("does not adopt a key that already belongs to another identity", async () => {
    await seed([makeOrder()]);

    // First approval maps a key to an identity.
    const first = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!first.ok) throw new Error("setup failed");

    // A second order for the same customer name must not steal that key.
    await seed([
      { ...makeOrder({ id: "ord_1_abc", status: "approved", dynamicToken: first.token }) },
      makeOrder({ id: "ord_2_def", name: "Ko Aung" }),
    ]);
    await fakeRedis.set(
      pendingIntentKey("ord_2_def"),
      JSON.stringify({
        token: "d".repeat(32),
        serverId: "srv-a",
        requestId: "req-2",
        createdAt: new Date().toISOString(),
        customerName: "Ko Aung",
      })
    );

    const second = await approveOrder({ orderId: "ord_2_def", source: "web" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // A brand-new key was created rather than the mapped one being reused.
    expect(second.outlineKeyId).not.toBe(first.outlineKeyId);
    expect(second.token).not.toBe(first.token);
  });

  it("recreates under the SAME token when the key vanished out of band", async () => {
    await seed([makeOrder()]);
    const first = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    if (!first.ok) throw new Error("setup failed");

    // Someone deleted the key in the official Outline Manager.
    await fakeOutline.request("srv-a", "DELETE", `/access-keys/${first.outlineKeyId}`);

    const second = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // New underlying key, SAME permanent URL.
    expect(second.outlineKeyId).not.toBe(first.outlineKeyId);
    expect(second.token).toBe(first.token);
    expect(second.dynamicUrl).toBe(first.dynamicUrl);
  });

  it("leaves the order pending when Outline key creation fails", async () => {
    await seed([makeOrder()]);
    fakeOutline.failCreateOn.add("srv-a");

    const result = await approveOrder({ orderId: "ord_1_abc", source: "web" });
    expect(result.ok).toBe(false);

    const orders = await readOrders();
    expect(orders[0].status).toBe("pending");
    expect(fakeOutline.totalKeyCount()).toBe(0);
  });
});

describe("rejection", () => {
  it("marks the order rejected and creates nothing", async () => {
    await seed([makeOrder()]);

    const result = await rejectOrder("ord_1_abc");
    expect(result.ok).toBe(true);

    const orders = await readOrders();
    expect(orders[0].status).toBe("rejected");
    expect(fakeOutline.totalKeyCount()).toBe(0);
  });

  it("cannot reject twice", async () => {
    await seed([makeOrder()]);
    await rejectOrder("ord_1_abc");
    const second = await rejectOrder("ord_1_abc");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("ALREADY_PROCESSED");
  });

  it("cannot reject an approved order", async () => {
    await seed([makeOrder()]);
    await approveOrder({ orderId: "ord_1_abc", source: "web" });

    const result = await rejectOrder("ord_1_abc");
    expect(result.ok).toBe(false);
  });

  it("approve and reject racing yields exactly one outcome", async () => {
    await seed([makeOrder()]);

    await Promise.all([
      approveOrder({ orderId: "ord_1_abc", source: "web" }),
      rejectOrder("ord_1_abc"),
    ]);

    const orders = await readOrders();
    expect(["approved", "rejected"]).toContain(orders[0].status);
    // At most one key, never one per caller.
    expect(fakeOutline.totalKeyCount()).toBeLessThanOrEqual(1);
  });
});
