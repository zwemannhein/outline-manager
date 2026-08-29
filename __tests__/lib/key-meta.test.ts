import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

import {
  buildInitialMeta,
  advanceCycle,
  extendCycles,
  computeQuotaUsage,
  describeQuota,
  cycleDueAt,
  expiryAt,
  isExpired,
  cyclesExhausted,
  readKeyMeta,
  writeKeyMeta,
  patchKeyMeta,
  migrateLegacyKeyMeta,
  metaField,
  KEY_META_HASH,
  CYCLE_MS,
  GIB,
} from "@/lib/key-meta";
import type { KeyMeta } from "@/lib/types";

const SERVER = "srv-1";
const KEY = "42";

describe("initial subscription metadata", () => {
  it("anchors expiry to cyclesTotal x 30 days from the start", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6, startedAt: start });

    expect(meta.periodStart).toBe(start.toISOString());
    expect(meta.cyclesTotal).toBe(6);
    expect(meta.cyclesUsed).toBe(1);
    expect(meta.carriedBytes).toBe(0);
    expect(Date.parse(meta.expiryDate!)).toBe(start.getTime() + 6 * CYCLE_MS);
  });

  it("treats a one-month plan as a single 30-day cycle", () => {
    const start = new Date("2026-03-10T00:00:00.000Z");
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 1, startedAt: start });
    expect(Date.parse(meta.expiryDate!)).toBe(start.getTime() + CYCLE_MS);
  });

  it("supports unlimited quota", () => {
    const meta = buildInitialMeta({ quotaBytes: null, cyclesTotal: 3 });
    expect(meta.quotaBytes).toBeNull();
  });

  it("clamps a nonsensical cycle count to at least one", () => {
    expect(buildInitialMeta({ quotaBytes: null, cyclesTotal: 0 }).cyclesTotal).toBe(1);
  });
});

describe("quota is per 30-day cycle, not a pool", () => {
  it("describes a multi-cycle plan as a monthly allowance", () => {
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6 });
    const text = describeQuota(meta);

    expect(text).toBe("100 GB every 30 days x 6 cycles");
    // Must never imply a single shared pool.
    expect(text).not.toContain("600");
  });

  it("describes a single cycle plainly", () => {
    expect(describeQuota(buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 1 }))).toBe(
      "100 GB every 30 days"
    );
  });

  it("describes unlimited plans", () => {
    expect(describeQuota(buildInitialMeta({ quotaBytes: null, cyclesTotal: 1 }))).toBe(
      "Unlimited for 30 days"
    );
    expect(describeQuota(buildInitialMeta({ quotaBytes: null, cyclesTotal: 6 }))).toBe(
      "Unlimited for 6 x 30 days"
    );
  });
});

describe("cycle rollover uses an anchored advance", () => {
  it("advances by exactly 30 days from the PREVIOUS start, not from now", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6, startedAt: start });

    const next = advanceCycle(meta);

    // Anchored: a late cron run cannot drift the billing date.
    expect(Date.parse(next.periodStart!)).toBe(start.getTime() + CYCLE_MS);
    expect(next.cyclesUsed).toBe(2);
  });

  it("clears migration debt so the new cycle starts with the full allowance", () => {
    const meta: KeyMeta = {
      ...buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6 }),
      carriedBytes: 80 * GIB,
    };
    expect(advanceCycle(meta).carriedBytes).toBe(0);
  });

  it("does not carry unused quota forward", () => {
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6 });
    const next = advanceCycle(meta);
    // Quota is a fixed monthly allowance; nothing accumulates.
    expect(next.quotaBytes).toBe(100 * GIB);
  });

  it("keeps anchors exact over six consecutive cycles", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    let meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 6, startedAt: start });

    for (let i = 1; i < 6; i += 1) {
      meta = advanceCycle(meta);
      expect(Date.parse(meta.periodStart!)).toBe(start.getTime() + i * CYCLE_MS);
      expect(meta.cyclesUsed).toBe(i + 1);
    }

    expect(cyclesExhausted(meta)).toBe(true);
  });

  it("reports the cycle boundary as periodStart + 30 days", () => {
    const start = new Date("2026-05-05T00:00:00.000Z");
    const meta = buildInitialMeta({ quotaBytes: null, cyclesTotal: 1, startedAt: start });
    expect(cycleDueAt(meta)).toBe(start.getTime() + CYCLE_MS);
  });
});

describe("expiry", () => {
  it("detects an expired subscription", () => {
    const past = new Date(Date.now() - 2 * CYCLE_MS);
    const meta = buildInitialMeta({ quotaBytes: null, cyclesTotal: 1, startedAt: past });
    expect(isExpired(meta)).toBe(true);
  });

  it("does not treat an active subscription as expired", () => {
    const meta = buildInitialMeta({ quotaBytes: null, cyclesTotal: 6 });
    expect(isExpired(meta)).toBe(false);
  });

  it("reports exhaustion only once every cycle is used", () => {
    const meta = buildInitialMeta({ quotaBytes: null, cyclesTotal: 3 });
    expect(cyclesExhausted(meta)).toBe(false);
    expect(cyclesExhausted({ ...meta, cyclesUsed: 3 })).toBe(true);
  });
});

describe("renewal extends without moving the anchor", () => {
  it("adds cycles and pushes expiry out", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const meta = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 1, startedAt: start });

    const renewed = extendCycles(meta, 3);

    expect(renewed.cyclesTotal).toBe(4);
    expect(Date.parse(renewed.expiryDate!)).toBeGreaterThan(Date.parse(meta.expiryDate!));
    // The cycle anchor is untouched, so the billing day does not move.
    expect(renewed.periodStart).toBe(meta.periodStart);
  });

  it("counts remaining cycles from the current period", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const meta: KeyMeta = {
      ...buildInitialMeta({ quotaBytes: null, cyclesTotal: 6, startedAt: start }),
      cyclesUsed: 3,
    };

    const renewed = extendCycles(meta, 2);
    // total 8, used 3 → 6 remaining counted from periodStart.
    expect(renewed.cyclesTotal).toBe(8);
    expect(Date.parse(renewed.expiryDate!)).toBe(start.getTime() + 6 * CYCLE_MS);
  });
});

describe("quota usage combines migration debt with live usage", () => {
  const base = buildInitialMeta({ quotaBytes: 100 * GIB, cyclesTotal: 1 });

  it("adds carriedBytes to the current key's usage", () => {
    const usage = computeQuotaUsage({ ...base, carriedBytes: 80 * GIB }, 5 * GIB);

    expect(usage.carriedBytes).toBe(80 * GIB);
    expect(usage.currentKeyBytes).toBe(5 * GIB);
    expect(usage.totalUsedBytes).toBe(85 * GIB);
    expect(usage.remainingBytes).toBe(15 * GIB);
    expect(usage.exhausted).toBe(false);
  });

  it("computes the migration case from the product spec", () => {
    // 100 GB quota, 80 GB already used → 20 GB should remain.
    const usage = computeQuotaUsage(base, 80 * GIB);
    expect(usage.remainingBytes).toBe(20 * GIB);
  });

  it("never reports negative remaining", () => {
    const usage = computeQuotaUsage(base, 150 * GIB);
    expect(usage.remainingBytes).toBe(0);
    expect(usage.exhausted).toBe(true);
  });

  it("marks exactly-at-quota as exhausted", () => {
    expect(computeQuotaUsage(base, 100 * GIB).exhausted).toBe(true);
  });

  it("treats unlimited as never exhausted", () => {
    const unlimited = buildInitialMeta({ quotaBytes: null, cyclesTotal: 1 });
    const usage = computeQuotaUsage(unlimited, 900 * GIB);
    expect(usage.remainingBytes).toBeNull();
    expect(usage.exhausted).toBe(false);
  });

  it("ignores negative or missing inputs", () => {
    const usage = computeQuotaUsage({ ...base, carriedBytes: -5 }, -10);
    expect(usage.totalUsedBytes).toBe(0);
  });
});

describe("server-authoritative storage", () => {
  beforeEach(() => fakeRedis.reset());

  it("round-trips metadata", async () => {
    const meta = buildInitialMeta({ quotaBytes: 50 * GIB, cyclesTotal: 2 });
    await writeKeyMeta(SERVER, KEY, meta);

    const read = await readKeyMeta(SERVER, KEY);
    expect(read?.quotaBytes).toBe(50 * GIB);
    expect(read?.cyclesTotal).toBe(2);
  });

  it("stores under a serverId:keyId field in the server-owned hash", async () => {
    await writeKeyMeta(SERVER, KEY, buildInitialMeta({ quotaBytes: null, cyclesTotal: 1 }));
    const hash = fakeRedis.peekHash(KEY_META_HASH);
    expect(hash).toBeDefined();
    expect(Object.keys(hash!)).toContain(metaField(SERVER, KEY));
  });

  it("merges on patch rather than replacing the record", async () => {
    await writeKeyMeta(SERVER, KEY, buildInitialMeta({ quotaBytes: 10 * GIB, cyclesTotal: 4 }));
    await patchKeyMeta(SERVER, KEY, { carriedBytes: 3 * GIB });

    const read = await readKeyMeta(SERVER, KEY);
    // The patched field changed and the others survived.
    expect(read?.carriedBytes).toBe(3 * GIB);
    expect(read?.quotaBytes).toBe(10 * GIB);
    expect(read?.cyclesTotal).toBe(4);
  });

  it("returns null for an unknown key", async () => {
    await expect(readKeyMeta("nope", "nope")).resolves.toBeNull();
  });
});

describe("legacy keyMeta migration", () => {
  beforeEach(() => fakeRedis.reset());

  it("copies entries out of the browser-writable blob", async () => {
    await fakeRedis.set(
      "outline_admin_data",
      JSON.stringify({
        servers: [],
        keyMeta: { "srv-1:7": { expiryDate: "2026-12-01T00:00:00.000Z" } },
      })
    );

    const result = await migrateLegacyKeyMeta();
    expect(result.migrated).toBe(1);
    expect(result.alreadyDone).toBe(false);

    const read = await readKeyMeta("srv-1", "7");
    expect(read?.expiryDate).toBe("2026-12-01T00:00:00.000Z");
  });

  it("is idempotent", async () => {
    await fakeRedis.set(
      "outline_admin_data",
      JSON.stringify({ keyMeta: { "srv-1:7": { expiryDate: null } } })
    );

    await migrateLegacyKeyMeta();
    const second = await migrateLegacyKeyMeta();

    expect(second.alreadyDone).toBe(true);
    expect(second.migrated).toBe(0);
  });

  it("never regresses a newer server-authoritative value", async () => {
    await writeKeyMeta("srv-1", "7", {
      expiryDate: "2027-01-01T00:00:00.000Z",
      quotaBytes: 5 * GIB,
    });
    await fakeRedis.set(
      "outline_admin_data",
      JSON.stringify({ keyMeta: { "srv-1:7": { expiryDate: "2020-01-01T00:00:00.000Z" } } })
    );

    const result = await migrateLegacyKeyMeta();
    expect(result.skipped).toBe(1);

    const read = await readKeyMeta("srv-1", "7");
    expect(read?.expiryDate).toBe("2027-01-01T00:00:00.000Z");
    expect(read?.quotaBytes).toBe(5 * GIB);
  });

  it("handles a missing legacy blob", async () => {
    const result = await migrateLegacyKeyMeta();
    expect(result.migrated).toBe(0);
  });
});
