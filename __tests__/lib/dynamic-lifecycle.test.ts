import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import {
  disableIdentity,
  enableIdentity,
  renewIdentity,
  updateQuota,
  getDisableStrategy,
  getDisableBlockBytes,
} from "@/lib/dynamic-lifecycle";
import {
  createDynamicIdentity,
  readDynamicRecord,
  buildDynamicUrl,
  generateDynamicToken,
  getTokenByOutlineKey,
} from "@/lib/dynamic-keys";
import { writeKeyMeta, readKeyMeta, buildInitialMeta, CYCLE_MS, GIB } from "@/lib/key-meta";

const SRV = "srv-a";

async function seedCustomer(opts: {
  quotaGB: number | null;
  usedGB?: number;
  cyclesTotal?: number;
  startedCyclesAgo?: number;
}) {
  const token = generateDynamicToken();
  const key = fakeOutline.seedKey(SRV, { name: "Ko Aung" });

  if (opts.quotaGB !== null) {
    fakeOutline.getKey(SRV, key.id)!.dataLimit = { bytes: opts.quotaGB * GIB };
  }
  fakeOutline.setUsage(SRV, key.id, (opts.usedGB ?? 0) * GIB);

  await writeKeyMeta(
    SRV,
    key.id,
    buildInitialMeta({
      quotaBytes: opts.quotaGB === null ? null : opts.quotaGB * GIB,
      cyclesTotal: opts.cyclesTotal ?? 6,
      startedAt: new Date(Date.now() - (opts.startedCyclesAgo ?? 0) * CYCLE_MS),
    })
  );

  await createDynamicIdentity({
    token,
    orderId: "ord_1",
    serverId: SRV,
    outlineKeyId: key.id,
    accessUrl: key.accessUrl,
    name: "Ko Aung",
    status: "active",
  });

  return { token, keyId: key.id };
}

beforeEach(() => {
  fakeRedis.reset();
  fakeOutline.reset();
  fakeOutline.addServer(SRV, "Server A");
  fakeOutline.addServer("srv-b", "Server B");

  const state = kv.instance!.__state;
  state.writes = [];
  state.dirty.clear();
  state.failWrites = false;
  state.kvRev.clear();

  delete process.env.DISABLE_STRATEGY;
  delete process.env.DISABLE_BLOCK_BYTES;
});

afterEach(() => {
  delete process.env.DISABLE_STRATEGY;
  delete process.env.DISABLE_BLOCK_BYTES;
});

describe("disable configuration", () => {
  it("defaults to the reversible limit strategy", () => {
    expect(getDisableStrategy()).toBe("limit");
  });

  it("defaults the block limit to 0 bytes", () => {
    // 0 is required: `usage >= 0` is true even for a brand-new key, whereas a
    // 1-byte limit would NOT block a key with no traffic yet.
    expect(getDisableBlockBytes()).toBe(0);
  });

  it("honours an explicit remove strategy", () => {
    process.env.DISABLE_STRATEGY = "remove";
    expect(getDisableStrategy()).toBe("remove");
  });
});

describe("disable closes both gates", () => {
  it("blocks Outline traffic and marks the identity disabled", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });

    const result = await disableIdentity({ token });
    expect(result.ok).toBe(true);

    // Gate 1: authoritative status, which the edge projects.
    expect((await readDynamicRecord(token))!.status).toBe("disabled");
    // Gate 2: real enforcement, because a cached client never re-checks the edge.
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(false);
  });

  it("blocks a brand-new key with no traffic yet", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 0 });

    await disableIdentity({ token });

    // The 0-byte limit is what makes this work; 1 byte would not.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(0);
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(false);
  });

  it("preserves the previous limit for restoration", async () => {
    const { token } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    await disableIdentity({ token });

    const record = await readDynamicRecord(token);
    expect(record!.suspendedState?.previousLimitBytes).toBe(100 * GIB);
    expect(record!.suspendedState?.keyRemoved).toBe(false);
  });

  it("records null previousLimitBytes for an unlimited customer", async () => {
    const { token } = await seedCustomer({ quotaGB: null });
    await disableIdentity({ token });

    const record = await readDynamicRecord(token);
    expect(record!.suspendedState?.previousLimitBytes).toBeNull();
  });

  it("bumps rev so the edge stops resolving the key", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    const before = (await readDynamicRecord(token))!.rev;

    await disableIdentity({ token });

    expect((await readDynamicRecord(token))!.rev).toBeGreaterThan(before);
  });

  it("is idempotent", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    await disableIdentity({ token });
    const second = await disableIdentity({ token });
    expect(second.ok).toBe(true);
  });

  it("removes the underlying key under the remove strategy", async () => {
    process.env.DISABLE_STRATEGY = "remove";
    const { token, keyId } = await seedCustomer({ quotaGB: 100 });

    const result = await disableIdentity({ token });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.strategy).toBe("remove");

    expect(fakeOutline.getKey(SRV, keyId)).toBeUndefined();
    const record = await readDynamicRecord(token);
    expect(record!.suspendedState?.keyRemoved).toBe(true);
  });

  it("still blocks at Outline when the KV write fails", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    kv.instance!.__state.failWrites = true;

    const result = await disableIdentity({ token });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.syncPending).toBe(true);

    // The safe direction: enforcement happened even though the edge is stale.
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(false);
  });
});

describe("enable reopens both gates with the REMAINING quota", () => {
  it("restores remaining quota rather than a fresh allowance", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    await disableIdentity({ token });
    const result = await enableIdentity({ token });
    expect(result.ok).toBe(true);

    // 20 GB remains, so toggling disable/enable cannot mint a new month of data.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(20 * GIB);
    expect((await readDynamicRecord(token))!.status).toBe("active");
  });

  it("restores unlimited by removing the limit", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: null, usedGB: 500 });

    await disableIdentity({ token });
    await enableIdentity({ token });

    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit).toBeUndefined();
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(true);
  });

  it("clears suspendedState", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    await disableIdentity({ token });
    await enableIdentity({ token });

    expect((await readDynamicRecord(token))!.suspendedState).toBeNull();
  });

  it("keeps the SAME permanent URL", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    const before = buildDynamicUrl(token, "Ko Aung");

    await disableIdentity({ token });
    await enableIdentity({ token });

    const record = await readDynamicRecord(token);
    expect(buildDynamicUrl(record!.token, record!.name)).toBe(before);
  });

  it("recreates the key under the same token when it was removed", async () => {
    process.env.DISABLE_STRATEGY = "remove";
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 30 });
    const urlBefore = buildDynamicUrl(token, "Ko Aung");

    await disableIdentity({ token });
    expect(fakeOutline.getKey(SRV, keyId)).toBeUndefined();

    const result = await enableIdentity({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.recreatedKey).toBe(true);
    expect(result.outlineKeyId).not.toBe(keyId);

    // Same permanent URL despite a brand-new underlying key.
    const record = await readDynamicRecord(token);
    expect(buildDynamicUrl(record!.token, record!.name)).toBe(urlBefore);
    // And the index follows the new key.
    await expect(getTokenByOutlineKey(SRV, result.outlineKeyId)).resolves.toBe(token);
  });

  it("refuses to reactivate a fully ended subscription", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2,
    });
    await disableIdentity({ token, reason: "expiry" });

    const result = await enableIdentity({ token });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SUBSCRIPTION_ENDED");
  });

  it("is idempotent for an already-active identity", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    const result = await enableIdentity({ token });
    expect(result.ok).toBe(true);
  });
});

describe("renewal keeps the same URL and restores access", () => {
  it("extends cycles without changing the token", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, cyclesTotal: 1 });
    const urlBefore = buildDynamicUrl(token, "Ko Aung");

    const result = await renewIdentity(token, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cyclesTotal).toBe(4);
    const record = await readDynamicRecord(token);
    expect(buildDynamicUrl(record!.token, record!.name)).toBe(urlBefore);
  });

  it("reactivates an expired customer under the same URL", async () => {
    const { token } = await seedCustomer({
      quotaGB: 100,
      cyclesTotal: 1,
      startedCyclesAgo: 2,
    });
    const urlBefore = buildDynamicUrl(token, "Ko Aung");

    await disableIdentity({ token, reason: "expiry" });
    expect((await readDynamicRecord(token))!.status).toBe("expired");

    const result = await renewIdentity(token, 6);
    expect(result.ok).toBe(true);

    const record = await readDynamicRecord(token);
    expect(record!.status).toBe("active");
    expect(buildDynamicUrl(record!.token, record!.name)).toBe(urlBefore);
  });

  it("pushes expiry further out", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, cyclesTotal: 1 });
    const before = (await readKeyMeta(SRV, keyId))!.expiryDate!;

    await renewIdentity(token, 2);

    const after = (await readKeyMeta(SRV, keyId))!.expiryDate!;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });
});

describe("quota change never touches the permanent URL", () => {
  it("updates the limit and metadata without changing the token or rev", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 20 });
    const record = await readDynamicRecord(token);
    const revBefore = record!.rev;
    const urlBefore = buildDynamicUrl(token, "Ko Aung");

    const result = await updateQuota(token, 200);
    expect(result.ok).toBe(true);

    expect((await readKeyMeta(SRV, keyId))!.quotaBytes).toBe(200 * GIB);
    // rev is unchanged, so this costs no Cloudflare KV write.
    expect((await readDynamicRecord(token))!.rev).toBe(revBefore);
    expect(buildDynamicUrl(token, "Ko Aung")).toBe(urlBefore);
  });

  it("credits the customer when the quota is raised mid-cycle", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    await updateQuota(token, 200);

    // 200 purchased minus 80 used = 120 applied.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(120 * GIB);
  });

  it("accounts for usage when the quota is lowered", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    await updateQuota(token, 90);

    // 90 purchased minus 80 used = 10 applied.
    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit!.bytes).toBe(10 * GIB);
  });

  it("switches a customer to unlimited", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 80 });

    await updateQuota(token, null);

    expect(fakeOutline.getKey(SRV, keyId)!.dataLimit).toBeUndefined();
    expect((await readKeyMeta(SRV, keyId))!.quotaBytes).toBeNull();
  });

  it("does not reopen the Outline gate for a disabled customer", async () => {
    const { token, keyId } = await seedCustomer({ quotaGB: 100, usedGB: 10 });
    await disableIdentity({ token });

    await updateQuota(token, 500);

    // Metadata updated, but the customer stays blocked until explicitly enabled.
    expect((await readKeyMeta(SRV, keyId))!.quotaBytes).toBe(500 * GIB);
    expect(fakeOutline.passesTraffic(SRV, keyId)).toBe(false);
  });

  it("costs zero KV writes", async () => {
    const { token } = await seedCustomer({ quotaGB: 100 });
    kv.instance!.__state.writes = [];

    await updateQuota(token, 250);

    expect(kv.instance!.__state.writes).toHaveLength(0);
  });
});
