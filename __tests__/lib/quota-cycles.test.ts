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

import { processExpiries, processCycleRollovers } from "@/lib/quota-cycles";
import {
  createDynamicIdentity,
  readDynamicRecord,
  scheduleCycleDue,
  scheduleExpiryDue,
  generateDynamicToken,
  DYN_CYCLE_DUE,
  DYN_EXPIRY_DUE,
} from "@/lib/dynamic-keys";
import {
  writeKeyMeta,
  readKeyMeta,
  buildInitialMeta,
  cycleDueAt,
  expiryAt,
  CYCLE_MS,
  GIB,
} from "@/lib/key-meta";

const SRV = "srv-a";

/** Seed an active customer whose cycle started `cyclesAgo` cycles in the past. */
async function seedCustomer(opts: {
  quotaGB: number | null;
  cyclesTotal: number;
  cyclesUsed?: number;
  startedCyclesAgo?: number;
  usedGB?: number;
}) {
  const token = generateDynamicToken();
  const key = fakeOutline.seedKey(SRV, { name: "Ko Aung" });

  const start = new Date(Date.now() - (opts.startedCyclesAgo ?? 0) * CYCLE_MS);
  const meta = {
    ...buildInitialMeta({
      quotaBytes: opts.quotaGB === null ? null : opts.quotaGB * GIB,
      cyclesTotal: opts.cyclesTotal,
      startedAt: start,
    }),
    cyclesUsed: opts.cyclesUsed ?? 1,
  };

  await writeKeyMeta(SRV, key.id, meta);

  if (opts.quotaGB !== null) {
    fakeOutline.getKey(SRV, key.id)!.dataLimit = { bytes: opts.quotaGB * GIB };
  }
  fakeOutline.setUsage(SRV, key.id, (opts.usedGB ?? 0) * GIB);

  await createDynamicIdentity({
    token,
    orderId: "ord_1",
    serverId: SRV,
    outlineKeyId: key.id,
    accessUrl: key.accessUrl,
    name: "Ko Aung",
    status: "active",
  });

  const due = cycleDueAt(meta);
  if (due) await scheduleCycleDue(token, due);
  const exp = expiryAt(meta);
  if (exp) await scheduleExpiryDue(token, exp);

  return { token, keyId: key.id, meta };
}

beforeEach(() => {
  fakeRedis.reset();
  fakeOutline.reset();
  fakeOutline.addServer(SRV, "Server A");

  const state = kv.instance!.__state;
  state.writes = [];
  state.deletes = [];
  state.dirty.clear();
  state.failWrites = false;
  state.kvRev.clear();
});

describe("cycle rollover restores the monthly quota", () => {
  it("does nothing when no cycle is due", async () => {
    await seedCustomer({ quotaGB: 100, cyclesTotal: 6 });
    const report = await processCycleRollovers(Date.now());
    expect(report.due).toBe(0);
    expect(report.rolled).toBe(0);
  });

  it("rolls a due cycle and restores the full monthly allowance", async () => {
    // One cycle has elapsed and the customer used 90 of 100 GB.
    const { token, keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
      usedGB: 90,
    });

    const report = await processCycleRollovers(Date.now());
    expect(report.rolled).toBe(1);

    // The Outline limit is back to the full monthly quota.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(100 * GIB);

    const meta = await readKeyMeta(SRV, keyId);
    expect(meta?.cyclesUsed).toBe(2);
    expect(meta?.carriedBytes).toBe(0);
  });

  it("advances the anchor by exactly 30 days from the PREVIOUS start", async () => {
    const { token, keyId, meta } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });
    const originalStart = Date.parse(meta.periodStart!);

    // Run the cron "late" to prove lateness does not drift the cycle.
    await processCycleRollovers(Date.now() + 5 * 60 * 60 * 1000);

    const after = await readKeyMeta(SRV, keyId);
    expect(Date.parse(after!.periodStart!)).toBe(originalStart + CYCLE_MS);
  });

  it("clears migration debt so the new cycle starts clean", async () => {
    const { keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });
    await writeKeyMeta(SRV, keyId, {
      ...(await readKeyMeta(SRV, keyId))!,
      carriedBytes: 80 * GIB,
    });

    await processCycleRollovers(Date.now());

    expect((await readKeyMeta(SRV, keyId))!.carriedBytes).toBe(0);
  });

  it("does NOT carry unused quota into the next cycle", async () => {
    const { keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
      usedGB: 5, // 95 GB unused
    });

    await processCycleRollovers(Date.now());

    // Still 100, never 195.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(100 * GIB);
    expect((await readKeyMeta(SRV, keyId))!.quotaBytes).toBe(100 * GIB);
  });

  it("costs ZERO Cloudflare KV writes", async () => {
    await seedCustomer({ quotaGB: 100, cyclesTotal: 6, startedCyclesAgo: 1 });
    kv.instance!.__state.writes = [];

    await processCycleRollovers(Date.now());

    // The public projection is unchanged, which is what keeps us on the free tier.
    expect(kv.instance!.__state.writes).toHaveLength(0);
  });

  it("does not bump rev, because the projection is unchanged", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });
    const before = (await readDynamicRecord(token))!.rev;

    await processCycleRollovers(Date.now());

    expect((await readDynamicRecord(token))!.rev).toBe(before);
  });

  it("reschedules the next boundary from the new anchor", async () => {
    const { token, meta } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });
    const originalStart = Date.parse(meta.periodStart!);

    await processCycleRollovers(Date.now());

    const score = await fakeRedis.zscore(DYN_CYCLE_DUE, token);
    expect(score).toBe(originalStart + 2 * CYCLE_MS);
  });

  it("runs a 6-cycle plan as six separate monthly allowances", async () => {
    const { token, keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });

    // Simulate the customer exhausting each cycle and the cron rolling it.
    for (let cycle = 2; cycle <= 6; cycle += 1) {
      fakeOutline.setUsage(SRV, keyId, 100 * GIB);
      const meta = await readKeyMeta(SRV, keyId);
      const due = cycleDueAt(meta!)!;

      const report = await processCycleRollovers(due);
      if (cycle <= 6) expect(report.rolled).toBe(1);

      const after = await readKeyMeta(SRV, keyId);
      expect(after!.cyclesUsed).toBe(cycle);
      // Every cycle restores the SAME monthly quota.
      expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(100 * GIB);
    }

    // After the 6th cycle no further rollover is granted.
    const meta = await readKeyMeta(SRV, keyId);
    const report = await processCycleRollovers(cycleDueAt(meta!)! + CYCLE_MS);
    expect(report.rolled).toBe(0);
    expect(report.skippedExhausted + report.skippedExpired).toBeGreaterThan(0);
  });

  it("does not roll a subscription whose cycles are exhausted", async () => {
    await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      cyclesUsed: 1,
      startedCyclesAgo: 1,
    });

    const report = await processCycleRollovers(Date.now());
    expect(report.rolled).toBe(0);
  });

  it("does not roll a disabled customer", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });
    await fakeRedis.hset(`dynamic:${token}`, { status: "disabled" });

    const report = await processCycleRollovers(Date.now());
    expect(report.rolled).toBe(0);
    expect(report.skippedExpired).toBe(1);
  });

  it("leaves unlimited plans without a limit", async () => {
    const { keyId } = await seedCustomer({
      quotaGB: null,
      cyclesTotal: 6,
      startedCyclesAgo: 1,
    });

    await processCycleRollovers(Date.now());

    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit).toBeUndefined();
  });

  it("is bounded per invocation", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedCustomer({ quotaGB: 10, cyclesTotal: 6, startedCyclesAgo: 1 });
    }
    const report = await processCycleRollovers(Date.now(), 2);
    expect(report.due).toBe(2);
    expect(report.rolled).toBe(2);
  });
});

describe("expiry disables rather than revoking", () => {
  it("disables an expired subscription", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2, // expired one cycle ago
    });

    const report = await processExpiries(Date.now());
    expect(report.expired).toBe(1);

    const record = await readDynamicRecord(token);
    // Disabled, NOT revoked, so a renewal reuses the same permanent URL.
    expect(record!.status).toBe("expired");
    expect(record!.status).not.toBe("revoked");
  });

  it("blocks Outline traffic, not just the config", async () => {
    const { keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2,
      usedGB: 1,
    });

    await processExpiries(Date.now());

    // A client that already cached its config must also stop passing traffic.
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(false);
  });

  it("preserves the previous limit for restoration", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2,
    });

    await processExpiries(Date.now());

    const record = await readDynamicRecord(token);
    expect(record!.suspendedState?.previousLimitBytes).toBe(100 * GIB);
    expect(record!.suspendedState?.reason).toBe("expiry");
  });

  it("removes the cycle schedule so no further cycle is granted", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2,
    });

    await processExpiries(Date.now());

    await expect(fakeRedis.zscore(DYN_CYCLE_DUE, token)).resolves.toBeNull();
  });

  it("leaves an unexpired subscription alone", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, cyclesTotal: 6 });
    const report = await processExpiries(Date.now());
    expect(report.expired).toBe(0);
    expect((await readDynamicRecord(token))!.status).toBe("active");
  });

  it("is idempotent for an already-expired identity", async () => {
    await seedCustomer({ quotaGB: 100, cyclesTotal: 1, startedCyclesAgo: 2 });

    await processExpiries(Date.now());
    const second = await processExpiries(Date.now());

    expect(second.expired).toBe(0);
  });
});

describe("expiry is processed before rollover", () => {
  it("an expired customer never receives another cycle", async () => {
    // Both the cycle boundary and expiry are due at the same moment.
    const { token, keyId } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 1,
    });

    const now = Date.now();
    // The cron runs expiry first, exactly as the endpoint does.
    await processExpiries(now);
    const rollover = await processCycleRollovers(now);

    expect(rollover.rolled).toBe(0);

    const record = await readDynamicRecord(token);
    expect(record!.status).toBe("expired");

    const meta = await readKeyMeta(SRV, keyId);
    // Still cycle 1: no extra cycle was granted.
    expect(meta!.cyclesUsed).toBe(1);
  });
});
