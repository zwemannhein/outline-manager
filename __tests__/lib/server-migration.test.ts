import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";
import { fakeOutline } from "../helpers/fake-outline";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

vi.mock("@/lib/outline-admin", async () => {
  const { buildOutlineAdminMock } = await import("../helpers/outline-mock");
  return buildOutlineAdminMock();
});

const kv = vi.hoisted(() => ({ instance: null as ReturnType<typeof import("../helpers/outline-mock").buildKvMock> | null }));

vi.mock("@/lib/kv-sync", async () => {
  const { buildKvMock } = await import("../helpers/outline-mock");
  const mock = buildKvMock();
  kv.instance = mock;
  return mock;
});

import { migrateToServer, cleanupMigration } from "@/lib/server-migration";
import {
  createDynamicIdentity,
  readDynamicRecord,
  buildDynamicUrl,
  getTokenByOutlineKey,
  pendingCleanupEntries,
  generateDynamicToken,
} from "@/lib/dynamic-keys";
import { writeKeyMeta, readKeyMeta, buildInitialMeta, GIB } from "@/lib/key-meta";

const SRC = "srv-a";
const DEST = "srv-b";

/** Create an active customer on SRC with the given quota and usage. */
async function seedCustomer(opts: {
  quotaGB: number | null;
  usedGB?: number;
  carriedGB?: number;
  cyclesTotal?: number;
}) {
  const token = generateDynamicToken();
  const key = fakeOutline.seedKey(SRC, { name: "Ko Aung" });

  if (opts.quotaGB !== null) {
    fakeOutline.getKey(SRC, key.id)!.dataLimit = { bytes: opts.quotaGB * GIB };
  }
  fakeOutline.setUsage(SRC, key.id, (opts.usedGB ?? 0) * GIB);

  await writeKeyMeta(SRC, key.id, {
    ...buildInitialMeta({
      quotaBytes: opts.quotaGB === null ? null : opts.quotaGB * GIB,
      cyclesTotal: opts.cyclesTotal ?? 1,
    }),
    carriedBytes: (opts.carriedGB ?? 0) * GIB,
  });

  await createDynamicIdentity({
    token,
    orderId: "ord_1",
    serverId: SRC,
    outlineKeyId: key.id,
    accessUrl: key.accessUrl,
    name: "Ko Aung",
    status: "active",
  });

  // Mark the edge as up to date so cleanup interlocks behave predictably.
  const record = await readDynamicRecord(token);
  kv.instance!.__state.kvRev.set(token, record!.rev);

  return { token, sourceKeyId: key.id };
}

beforeEach(() => {
  fakeRedis.reset();
  fakeOutline.reset();
  fakeOutline.addServer(SRC, "Server A");
  fakeOutline.addServer(DEST, "Server B");

  const state = kv.instance!.__state;
  state.writes = [];
  state.deletes = [];
  state.dirty.clear();
  state.failWrites = false;
  state.kvRev.clear();
});

describe("current-cycle quota is preserved", () => {
  it("the product example: 100 GB quota, 80 GB used, destination gets 20 GB", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The destination is limited to what actually remains, NOT a fresh 100 GB.
    expect(result.appliedLimitBytes).toBe(20 * GIB);
    expect(fakeOutline.getKey(DEST, result.destKeyId)!.dataLimit!.bytes).toBe(20 * GIB);
    expect(result.carriedBytes).toBe(80 * GIB);
  });

  it("records consumption as carriedBytes on the destination metadata", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 80 });
    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    const meta = await readKeyMeta(DEST, result.destKeyId);
    expect(meta?.carriedBytes).toBe(80 * GIB);
    // The purchased monthly quota is unchanged; only the applied limit is reduced.
    expect(meta?.quotaBytes).toBe(100 * GIB);
  });

  it("accumulates correctly across a second migration in the same cycle", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    const first = await migrateToServer({ token, destServerId: DEST });
    if (!first.ok) throw new Error("expected success");

    // The customer burns 15 GB more on the destination.
    fakeOutline.setUsage(DEST, first.destKeyId, 15 * GIB);
    fakeOutline.addServer("srv-c", "Server C");

    const second = await migrateToServer({ token, destServerId: "srv-c" });
    if (!second.ok) throw new Error("expected success");

    // 80 carried + 15 on the second key = 95 used, so 5 GB remains.
    expect(second.carriedBytes).toBe(95 * GIB);
    expect(second.appliedLimitBytes).toBe(5 * GIB);
  });

  it("carries an unlimited plan across with no limit applied", async () => {
    const { token } = await seedCustomer({ quotaGB: null, usedGB: 500 });

    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    expect(result.appliedLimitBytes).toBeNull();
    expect(fakeOutline.getKey(DEST, result.destKeyId)!.dataLimit).toBeUndefined();
  });

  it("includes pre-existing carriedBytes in the calculation", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10, carriedGB: 50 });

    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    // 50 carried + 10 live = 60 used → 40 remaining.
    expect(result.carriedBytes).toBe(60 * GIB);
    expect(result.appliedLimitBytes).toBe(40 * GIB);
  });
});

describe("exhausted quota", () => {
  it("refuses by default with QUOTA_EXHAUSTED", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 100 });

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("QUOTA_EXHAUSTED");
      expect(result.detail?.totalUsedBytes).toBe(100 * GIB);
    }

    // Nothing was created on the destination.
    expect(fakeOutline.keyCount(DEST)).toBe(0);
  });

  it("proceeds with the explicit admin override, applying a zero limit", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 120 });

    const result = await migrateToServer({
      token,
      destServerId: DEST,
      allowExhausted: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The key exists but passes no traffic until the next cycle restores quota.
    expect(result.appliedLimitBytes).toBe(0);
    expect(fakeOutline.passesTraffic(DEST, result.destKeyId)).toBe(false);
  });
});

describe("the permanent URL never changes", () => {
  it("keeps the same token and ssconf URL across migration", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const before = buildDynamicUrl(token, "Ko Aung");

    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    expect(result.token).toBe(token);
    expect(result.dynamicUrlChanged).toBe(false);

    const record = await readDynamicRecord(token);
    expect(buildDynamicUrl(record!.token, record!.name)).toBe(before);
  });

  it("moves the key index to the destination", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    await expect(getTokenByOutlineKey(DEST, result.destKeyId)).resolves.toBe(token);
    // The stale index is removed so the old key cannot be reconciled to it.
    await expect(getTokenByOutlineKey(SRC, sourceKeyId)).resolves.toBeNull();
  });

  it("increments rev so the edge projection is refreshed", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const before = (await readDynamicRecord(token))!.rev;

    await migrateToServer({ token, destServerId: DEST });

    expect((await readDynamicRecord(token))!.rev).toBeGreaterThan(before);
  });
});

describe("the source key stays alive", () => {
  it("does not delete the source key during migration", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });

    const result = await migrateToServer({ token, destServerId: DEST });
    if (!result.ok) throw new Error("expected success");

    expect(fakeOutline.getKey(SRC, sourceKeyId)).toBeDefined();
    expect(fakeOutline.deleteCalls).toHaveLength(0);
    expect(result.cleanupRequired).toBe(true);
  });

  it("records the source key as awaiting cleanup", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    await migrateToServer({ token, destServerId: DEST });

    const record = await readDynamicRecord(token);
    const pending = pendingCleanupEntries(record!);
    expect(pending).toHaveLength(1);
    expect(pending[0].outlineKeyId).toBe(sourceKeyId);
    expect(pending[0].reason).toBe("migrate");
  });
});

describe("failure safety", () => {
  it("changes nothing when the destination key cannot be created", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    fakeOutline.failCreateOn.add(DEST);

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUTLINE_FAILED");

    // The customer is untouched on the source server.
    const record = await readDynamicRecord(token);
    expect(record!.serverId).toBe(SRC);
    expect(record!.outlineKeyId).toBe(sourceKeyId);
    expect(fakeOutline.getKey(SRC, sourceKeyId)).toBeDefined();
  });

  it("keeps the customer working when the KV write fails", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    kv.instance!.__state.failWrites = true;

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Authoritative state switched, the edge did not, and the OLD key is alive —
    // so the customer keeps working off the stale projection.
    expect(result.syncPending).toBe(true);
    expect(fakeOutline.getKey(SRC, sourceKeyId)).toBeDefined();
    expect(kv.instance!.__state.dirty.has(token)).toBe(true);
  });

  it("rejects migrating to the same server", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const result = await migrateToServer({ token, destServerId: SRC });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SAME_SERVER");
  });

  it("rejects an unregistered destination", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const result = await migrateToServer({ token, destServerId: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DEST_NOT_FOUND");
  });

  it("refuses to migrate a disabled customer", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    await fakeRedis.hset(`dynamic:${token}`, { status: "disabled" });

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_ACTIVE");
  });

  it("migrates with usage treated as zero when the source is unreachable", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 40 });
    fakeOutline.failMetricsOn.add(SRC);

    const result = await migrateToServer({ token, destServerId: DEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cannot read usage, so the full quota is granted rather than blocking the
    // operator from evacuating a dead server.
    expect(result.appliedLimitBytes).toBe(100 * GIB);
  });
});

describe("cleanup is gated on the edge catching up", () => {
  it("refuses while the projection is stale, keeping the old key alive", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    kv.instance!.__state.failWrites = true;

    await migrateToServer({ token, destServerId: DEST });

    const result = await cleanupMigration(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PROJECTION_STALE");

    // The interlock is what prevents a KV failure becoming an outage.
    expect(fakeOutline.getKey(SRC, sourceKeyId)).toBeDefined();
    expect(fakeOutline.deleteCalls).toHaveLength(0);
  });

  it("deletes the old key once the projection is current", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });

    const migrated = await migrateToServer({ token, destServerId: DEST });
    if (!migrated.ok) throw new Error("expected success");

    // Simulate the edge having caught up.
    const record = await readDynamicRecord(token);
    kv.instance!.__state.kvRev.set(token, record!.rev);

    const result = await cleanupMigration(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.deleted).toEqual([{ serverId: SRC, outlineKeyId: sourceKeyId }]);
    expect(fakeOutline.getKey(SRC, sourceKeyId)).toBeUndefined();

    // History is closed out, so cleanup is not offered again.
    const after = await readDynamicRecord(token);
    expect(pendingCleanupEntries(after!)).toHaveLength(0);
  });

  it("never deletes the key the identity currently points at", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const migrated = await migrateToServer({ token, destServerId: DEST });
    if (!migrated.ok) throw new Error("expected success");

    const record = await readDynamicRecord(token);
    kv.instance!.__state.kvRev.set(token, record!.rev);

    await cleanupMigration(token);

    // The live destination key survives.
    expect(fakeOutline.getKey(DEST, migrated.destKeyId)).toBeDefined();
  });

  it("reports nothing to clean when there is no history", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const result = await cleanupMigration(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOTHING_TO_CLEAN");
  });

  it("closes the history entry when the old key was already deleted elsewhere", async () => {
    const { token, sourceKeyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    const migrated = await migrateToServer({ token, destServerId: DEST });
    if (!migrated.ok) throw new Error("expected success");

    // Someone removed it manually in the official Outline app.
    await fakeOutline.request(SRC, "DELETE", `/access-keys/${sourceKeyId}`);
    fakeOutline.deleteCalls = [];

    const record = await readDynamicRecord(token);
    kv.instance!.__state.kvRev.set(token, record!.rev);

    const result = await cleanupMigration(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(1);
    expect(result.deleted).toHaveLength(0);
  });
});
