import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";
import { fakeOutline } from "../helpers/fake-outline";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

vi.mock("@/lib/outline-admin", async () => {
  const { buildOutlineAdminMock } = await import("../helpers/outline-mock");
  return buildOutlineAdminMock();
});

const kv = vi.hoisted(() => ({
  instance: null as ReturnType<typeof import("../helpers/outline-mock").buildKvMock> | null,
}));

vi.mock("@/lib/kv-sync", async () => {
  const { buildKvMock } = await import("../helpers/outline-mock");
  const mock = buildKvMock();
  kv.instance = mock;
  return mock;
});

import { runBackfill, deriveBackfillMeta, anchorFromExpiry } from "@/lib/backfill";
import {
  getTokenByOutlineKey,
  getTokenByOrder,
  readDynamicRecord,
  listDynamicTokens,
} from "@/lib/dynamic-keys";
import { readKeyMeta, writeKeyMeta, CYCLE_MS, GIB } from "@/lib/key-meta";
import type { Order } from "@/lib/types";

const SRV = "srv-a";
const ORDERS_KEY = "outline_orders";
const ADMIN_DATA_KEY = "outline_admin_data";

async function seedServerRegistry() {
  await fakeRedis.set(
    ADMIN_DATA_KEY,
    JSON.stringify({ servers: fakeOutline.servers, keyMeta: {} })
  );
}

beforeEach(async () => {
  fakeRedis.reset();
  fakeOutline.reset();
  fakeOutline.addServer(SRV, "Server A");
  await seedServerRegistry();

  const state = kv.instance!.__state;
  state.writes = [];
  state.dirty.clear();
  state.failWrites = false;
});

describe("metadata derivation", () => {
  it("adopts the existing Outline limit as the per-cycle quota", () => {
    const meta = deriveBackfillMeta(
      {
        id: "1",
        name: "Ko Aung",
        password: "p",
        port: 1234,
        method: "chacha20-ietf-poly1305",
        accessUrl: "ss://x",
        dataLimit: { bytes: 50 * GIB },
      },
      null
    );
    expect(meta.quotaBytes).toBe(50 * GIB);
    expect(meta.cyclesTotal).toBe(1);
    expect(meta.carriedBytes).toBe(0);
  });

  it("treats a key with no limit as unlimited", () => {
    const meta = deriveBackfillMeta(
      {
        id: "1",
        name: "x",
        password: "p",
        port: 1234,
        method: "chacha20-ietf-poly1305",
        accessUrl: "ss://x",
      },
      null
    );
    expect(meta.quotaBytes).toBeNull();
  });

  it("never regresses existing metadata", () => {
    const existing = {
      expiryDate: "2027-01-01T00:00:00.000Z",
      quotaBytes: 10 * GIB,
      cyclesTotal: 6,
      cyclesUsed: 3,
      periodStart: "2026-06-01T00:00:00.000Z",
      carriedBytes: 5 * GIB,
    };
    const meta = deriveBackfillMeta(
      {
        id: "1",
        name: "x",
        password: "p",
        port: 1234,
        method: "chacha20-ietf-poly1305",
        accessUrl: "ss://x",
        dataLimit: { bytes: 999 * GIB },
      },
      existing
    );
    // The stored values win; the live limit does not overwrite them.
    expect(meta.quotaBytes).toBe(10 * GIB);
    expect(meta.cyclesUsed).toBe(3);
    expect(meta.expiryDate).toBe("2027-01-01T00:00:00.000Z");
  });

  it("anchors backwards from a known expiry so the renewal date is preserved", () => {
    const expiry = "2026-12-01T00:00:00.000Z";
    const meta = anchorFromExpiry(expiry, 1);

    expect(meta.expiryDate).toBe(expiry);
    // The current cycle started one cycle before expiry.
    expect(Date.parse(meta.periodStart!)).toBe(Date.parse(expiry) - CYCLE_MS);
  });
});

describe("dry run", () => {
  it("writes nothing and reports the plan", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung", dataLimit: { bytes: 100 * GIB } });
    fakeOutline.seedKey(SRV, { name: "Ma Hla" });

    const report = await runBackfill({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.keysScanned).toBe(2);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((i) => i.action === "create")).toBe(true);

    // Nothing persisted.
    await expect(listDynamicTokens()).resolves.toHaveLength(0);
    expect(kv.instance!.__state.writes).toHaveLength(0);
  });

  it("creates no Outline keys", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await runBackfill({ dryRun: true });
    expect(fakeOutline.createCalls).toHaveLength(0);
  });
});

describe("live run", () => {
  it("creates one identity per existing key and ZERO Outline keys", async () => {
    const a = fakeOutline.seedKey(SRV, { name: "Ko Aung", dataLimit: { bytes: 100 * GIB } });
    const b = fakeOutline.seedKey(SRV, { name: "Ma Hla" });

    const report = await runBackfill({ dryRun: false });

    expect(report.tokensCreated).toBe(2);
    // The hard guarantee: the job only reads from Outline.
    expect(fakeOutline.createCalls).toHaveLength(0);
    expect(fakeOutline.keyCount(SRV)).toBe(2);

    await expect(getTokenByOutlineKey(SRV, a.id)).resolves.toMatch(/^[0-9a-f]{32}$/);
    await expect(getTokenByOutlineKey(SRV, b.id)).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it("preserves the existing limit and accessUrl exactly", async () => {
    const key = fakeOutline.seedKey(SRV, {
      name: "Ko Aung",
      dataLimit: { bytes: 37 * GIB },
    });

    await runBackfill({ dryRun: false });

    // The live key is untouched.
    expect(fakeOutline.getKey(SRV, key.id)!.dataLimit!.bytes).toBe(37 * GIB);

    const token = (await getTokenByOutlineKey(SRV, key.id))!;
    const record = await readDynamicRecord(token);
    expect(record!.accessUrl).toBe(key.accessUrl);
    expect(record!.status).toBe("active");

    // The limit becomes the per-cycle quota.
    expect((await readKeyMeta(SRV, key.id))!.quotaBytes).toBe(37 * GIB);
  });

  it("preserves pre-existing expiry metadata", async () => {
    const key = fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await writeKeyMeta(SRV, key.id, {
      expiryDate: "2027-03-01T00:00:00.000Z",
      quotaBytes: 20 * GIB,
      cyclesTotal: 6,
      cyclesUsed: 2,
    });

    await runBackfill({ dryRun: false });

    const meta = await readKeyMeta(SRV, key.id);
    expect(meta!.expiryDate).toBe("2027-03-01T00:00:00.000Z");
    expect(meta!.cyclesUsed).toBe(2);
    expect(meta!.quotaBytes).toBe(20 * GIB);
  });

  it("names the identity after the Outline key, falling back for unnamed keys", async () => {
    const named = fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    const unnamed = fakeOutline.seedKey(SRV, { name: "" });

    await runBackfill({ dryRun: false });

    const t1 = (await getTokenByOutlineKey(SRV, named.id))!;
    const t2 = (await getTokenByOutlineKey(SRV, unnamed.id))!;
    expect((await readDynamicRecord(t1))!.name).toBe("Ko Aung");
    expect((await readDynamicRecord(t2))!.name).toBe("Unnamed");
  });

  it("projects each identity to the edge", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await runBackfill({ dryRun: false });
    expect(kv.instance!.__state.writes).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("a second run creates zero new tokens", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    fakeOutline.seedKey(SRV, { name: "Ma Hla" });

    const first = await runBackfill({ dryRun: false });
    expect(first.tokensCreated).toBe(2);

    const second = await runBackfill({ dryRun: false });

    expect(second.tokensCreated).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.items.every((i) => i.action === "skip")).toBe(true);
  });

  it("a second run issues no Cloudflare KV writes", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await runBackfill({ dryRun: false });

    kv.instance!.__state.writes = [];
    await runBackfill({ dryRun: false });

    // Skipping happens before a token is generated, so nothing is written.
    expect(kv.instance!.__state.writes).toHaveLength(0);
  });

  it("never issues two tokens for the same Outline key", async () => {
    const key = fakeOutline.seedKey(SRV, { name: "Ko Aung" });

    await runBackfill({ dryRun: false });
    const first = await getTokenByOutlineKey(SRV, key.id);

    await runBackfill({ dryRun: false });
    const second = await getTokenByOutlineKey(SRV, key.id);

    expect(second).toBe(first);
    await expect(listDynamicTokens()).resolves.toHaveLength(1);
  });

  it("picks up a newly added key on a later run", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await runBackfill({ dryRun: false });

    fakeOutline.seedKey(SRV, { name: "New Customer" });
    const second = await runBackfill({ dryRun: false });

    expect(second.tokensCreated).toBe(1);
    expect(second.skipped).toBe(1);
  });
});

describe("order linking", () => {
  it("attaches identities to approved orders", async () => {
    const key = fakeOutline.seedKey(SRV, { name: "Ko Aung" });

    const order: Order = {
      id: "ord_old_1",
      name: "Ko Aung",
      kpayRef: "111111",
      plan: "plan_b",
      status: "approved",
      serverId: SRV,
      keyId: key.id,
      accessUrl: key.accessUrl,
      createdAt: Date.now(),
      approvedAt: Date.now(),
    };
    await fakeRedis.set(ORDERS_KEY, JSON.stringify([order]));

    const report = await runBackfill({ dryRun: false });
    expect(report.ordersLinked).toBe(1);

    const token = (await getTokenByOutlineKey(SRV, key.id))!;
    await expect(getTokenByOrder("ord_old_1")).resolves.toBe(token);

    const orders = (await fakeRedis.get<Order[]>(ORDERS_KEY))!;
    expect(orders[0].dynamicToken).toBe(token);
  });

  it("ignores pending orders and orders without a key", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await fakeRedis.set(
      ORDERS_KEY,
      JSON.stringify([
        {
          id: "ord_pending",
          name: "x",
          kpayRef: "1",
          plan: "plan_b",
          status: "pending",
          serverId: SRV,
          keyId: null,
          accessUrl: null,
          createdAt: Date.now(),
          approvedAt: null,
        },
      ])
    );

    const report = await runBackfill({ dryRun: false });
    expect(report.ordersLinked).toBe(0);
  });
});

describe("safety and resumability", () => {
  it("bounds work per run and reports being capped", async () => {
    for (let i = 0; i < 5; i += 1) fakeOutline.seedKey(SRV, { name: `C${i}` });

    const report = await runBackfill({ dryRun: false, limit: 2 });

    expect(report.tokensCreated).toBeLessThanOrEqual(2);
    expect(report.budgetCapped).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/limit/i);
  });

  it("resumes cleanly, eventually covering every key", async () => {
    for (let i = 0; i < 5; i += 1) fakeOutline.seedKey(SRV, { name: `C${i}` });

    await runBackfill({ dryRun: false, limit: 2 });
    await runBackfill({ dryRun: false, limit: 2 });
    await runBackfill({ dryRun: false, limit: 2 });
    await runBackfill({ dryRun: false, limit: 10 });

    await expect(listDynamicTokens()).resolves.toHaveLength(5);
    expect(fakeOutline.createCalls).toHaveLength(0);
  });

  it("warns when no server is registered", async () => {
    fakeOutline.reset();
    await seedServerRegistry();

    const report = await runBackfill({ dryRun: true });
    expect(report.serversScanned).toBe(0);
    expect(report.warnings.join(" ")).toMatch(/no outline servers/i);
  });

  it("continues past a server it cannot reach", async () => {
    fakeOutline.addServer("srv-dead", "Dead");
    // Removing it from the fake's key map makes listAccessKeys throw.
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    await seedServerRegistry();

    const report = await runBackfill({ dryRun: false });
    // The healthy server was still processed.
    expect(report.tokensCreated).toBeGreaterThanOrEqual(1);
  });

  it("queues the projection when the edge write fails", async () => {
    fakeOutline.seedKey(SRV, { name: "Ko Aung" });
    kv.instance!.__state.failWrites = true;

    const report = await runBackfill({ dryRun: false });

    expect(report.tokensCreated).toBe(1);
    expect(report.warnings.join(" ")).toMatch(/queued/i);
    expect(kv.instance!.__state.dirty.size).toBe(1);
  });
});
