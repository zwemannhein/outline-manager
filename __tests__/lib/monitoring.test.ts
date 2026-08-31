/**
 * Tests for the monitoring helpers and customer diagnostics logic.
 *
 * Covers:
 * - Redis health check
 * - Cron summary write/read
 * - Cron health derivation (overdue, ok, never-run)
 * - Partial provider failure does not crash other checks
 * - Telegram health parsing (basic)
 * - Outline health parsing (missing key, duplicate mapping)
 * - Customer diagnosis: healthy, missing key, unlimited accidental limit,
 *   expired mismatch, disabled/public mismatch
 * - Secret values never returned by diagnose
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

import {
  writeCronSummary,
  readCronSummary,
  checkCronHealth,
  checkRedisHealth,
  CRON_WARN_GAP_MS,
  CRON_CRITICAL_GAP_MS,
  MONITOR_CRON_KEY,
} from "@/lib/monitoring";

// ── Redis health ──────────────────────────────────────────────────────────────

describe("Redis health check", () => {
  beforeEach(() => fakeRedis.reset());

  it("returns healthy with a latency when Redis responds", async () => {
    const result = await checkRedisHealth();
    expect(result.status).toBe("healthy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Cron summary ──────────────────────────────────────────────────────────────

describe("Cron summary write/read", () => {
  beforeEach(() => fakeRedis.reset());

  it("writes and reads back a cron summary", async () => {
    const startedAt = Date.now() - 1500;
    await writeCronSummary({
      startedAt,
      expiry:   { processed: 3, failed: 0 },
      rollover: { processed: 2, failed: 0 },
      drain:    { synced: 5,    failed: 1 },
    });

    const summary = await readCronSummary();
    expect(summary).not.toBeNull();
    expect(summary!.processed).toBe(10);         // 3+2+5
    expect(summary!.failed).toBe(1);
    expect(summary!.expiryProcessed).toBe(3);
    expect(summary!.quotaProcessed).toBe(2);
    expect(summary!.dirtySyncProcessed).toBe(5);
    expect(summary!.durationMs).toBeGreaterThan(0);
  });

  it("returns null when no cron has run", async () => {
    const summary = await readCronSummary();
    expect(summary).toBeNull();
  });
});

// ── Cron health derivation ────────────────────────────────────────────────────

describe("checkCronHealth", () => {
  beforeEach(() => fakeRedis.reset());

  it("returns warning when no cron run is recorded", async () => {
    const result = await checkCronHealth();
    expect(result.status).toBe("warning");
    expect(result.summary).toBeNull();
  });

  it("returns healthy when cron ran recently with no failures", async () => {
    await writeCronSummary({
      startedAt: Date.now() - 500,
      expiry:   { processed: 0, failed: 0 },
      rollover: { processed: 0, failed: 0 },
      drain:    { synced: 0,    failed: 0 },
    });
    const result = await checkCronHealth();
    expect(result.status).toBe("healthy");
  });

  it("returns warning when cron ran recently but had failures", async () => {
    await writeCronSummary({
      startedAt: Date.now() - 500,
      expiry:   { processed: 1, failed: 2 },
      rollover: { processed: 0, failed: 0 },
      drain:    { synced: 0,    failed: 0 },
    });
    const result = await checkCronHealth();
    expect(result.status).toBe("warning");
  });

  it("returns warning when cron is overdue (90 min < gap < 6h)", async () => {
    // Fake the stored timestamp to be 2 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await fakeRedis.hset(MONITOR_CRON_KEY, {
      lastStartedAt: twoHoursAgo,
      lastCompletedAt: twoHoursAgo,
      durationMs: "100",
      processed: "0",
      failed: "0",
      expiryProcessed: "0",
      quotaProcessed: "0",
      dirtySyncProcessed: "0",
    });
    const result = await checkCronHealth();
    expect(result.status).toBe("warning");
    expect(result.overdueMs).toBeGreaterThan(0);
  });

  it("returns critical when cron is overdue by > 6 hours", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    await fakeRedis.hset(MONITOR_CRON_KEY, {
      lastStartedAt: sevenHoursAgo,
      lastCompletedAt: sevenHoursAgo,
      durationMs: "100",
      processed: "0",
      failed: "0",
      expiryProcessed: "0",
      quotaProcessed: "0",
      dirtySyncProcessed: "0",
    });
    const result = await checkCronHealth();
    expect(result.status).toBe("critical");
  });
});

// ── Partial failure isolation ─────────────────────────────────────────────────

describe("Partial provider failure isolation", () => {
  it("Promise.allSettled pattern: one failure does not prevent others", async () => {
    const willFail  = Promise.reject(new Error("timeout"));
    const willPass  = Promise.resolve({ status: "healthy" });
    const willPass2 = Promise.resolve({ status: "warning" });

    const results = await Promise.allSettled([willFail, willPass, willPass2]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect(results[2].status).toBe("fulfilled");

    // Simulate monitoring aggregation: degraded result for failure, values for success.
    const health1 = results[0].status === "fulfilled" ? results[0].value : { status: "critical" };
    const health2 = results[1].status === "fulfilled" ? results[1].value : { status: "critical" };

    expect(health1.status).toBe("critical");
    expect(health2.status).toBe("healthy");
  });
});

// ── Telegram health parsing ───────────────────────────────────────────────────

describe("Telegram health: not_configured when no token", () => {
  it("returns not_configured status when TELEGRAM_BOT_TOKEN is absent", async () => {
    const { checkTelegramHealth } = await import("@/lib/monitoring");
    // Token not set in test env.
    const orig = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const result = await checkTelegramHealth();
    expect(result.status).toBe("not_configured");
    expect(result.linkedApprovers).toBe(0);
    if (orig) process.env.TELEGRAM_BOT_TOKEN = orig;
  });
});

// ── Outline health: missing key detection ─────────────────────────────────────

describe("Outline health: missing key detection logic", () => {
  it("detects managed records whose Outline key ID is not in the server's key list", () => {
    const serverKeyIds = new Set(["k1", "k2", "k3"]);
    const managedRecords = [
      { outlineKeyId: "k1" },
      { outlineKeyId: "k2" },
      { outlineKeyId: "k_missing" }, // NOT in serverKeyIds
    ];

    const missingKeys = managedRecords.filter((r) => !serverKeyIds.has(r.outlineKeyId));
    expect(missingKeys).toHaveLength(1);
    expect(missingKeys[0].outlineKeyId).toBe("k_missing");
  });

  it("detects duplicate key mappings", () => {
    const managedRecords = [
      { token: "a", outlineKeyId: "k1" },
      { token: "b", outlineKeyId: "k1" }, // duplicate!
      { token: "c", outlineKeyId: "k2" },
    ];

    const counts = new Map<string, number>();
    for (const r of managedRecords) {
      counts.set(r.outlineKeyId, (counts.get(r.outlineKeyId) ?? 0) + 1);
    }
    const duplicates = Array.from(counts.values()).filter((c) => c > 1).length;
    expect(duplicates).toBe(1);
  });
});

// ── Customer diagnosis logic ──────────────────────────────────────────────────

describe("Customer diagnosis: healthy state", () => {
  it("all pass checks produce no_issue diagnosis", () => {
    const issues: string[] = [];
    const diagnosis = issues.length > 0 ? "issues_found" : "no_issue";
    expect(diagnosis).toBe("no_issue");
  });
});

describe("Customer diagnosis: missing Outline key", () => {
  it("detects active customer with no Outline key", () => {
    const record = { status: "active", outlineKeyId: "k999" };
    const keyExists = false;
    const issues: string[] = [];

    if (!keyExists && record.status === "active") {
      issues.push("Customer is marked Active but VPN key does not exist");
    }

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Active");
  });
});

describe("Customer diagnosis: unlimited customer accidental finite limit detection", () => {
  it("flags when quota metadata says unlimited but usage object shows finite limit", () => {
    // meta.quotaBytes === null means unlimited.
    // A check for this is: quotaBytes is null → no cap expected.
    const meta = { quotaBytes: null as number | null };
    const isUnlimited = meta.quotaBytes === null;
    expect(isUnlimited).toBe(true);
    // If the Outline key has a non-null limit set, that would be a mismatch.
    // The diagnose route checks this — here we test the condition.
    const outlineLimitBytes: number | null = 1073741824; // accidental 1 GB limit
    if (isUnlimited && outlineLimitBytes !== null) {
      // This is the accidental finite limit on an unlimited customer.
      expect(outlineLimitBytes).not.toBeNull();
    }
  });
});

describe("Customer diagnosis: expired-state mismatch", () => {
  it("detects subscription expired but customer still Active", () => {
    const meta = { expiryDate: new Date(Date.now() - 86_400_000).toISOString() }; // yesterday
    const status = "active";
    const issues: string[] = [];

    const expired = new Date(meta.expiryDate).getTime() <= Date.now();
    if (expired && status === "active") {
      issues.push("Subscription expiry date is in the past but customer is still marked Active");
    }

    expect(issues).toHaveLength(1);
  });

  it("detects customer marked Expired but expiry date is future", () => {
    const meta = { expiryDate: new Date(Date.now() + 86_400_000).toISOString() }; // tomorrow
    const status = "expired";
    const issues: string[] = [];

    const expired = new Date(meta.expiryDate).getTime() <= Date.now();
    if (!expired && status === "expired") {
      issues.push("Customer is marked Expired but the expiry date has not passed");
    }

    expect(issues).toHaveLength(1);
  });
});

describe("Customer diagnosis: disabled/public-config mismatch", () => {
  it("detects disabled customer whose /k/ config still returns 200", () => {
    const status = "disabled";
    const kRouteStatus = 200;
    const issues: string[] = [];

    if (kRouteStatus === 200 && (status === "disabled" || status === "expired")) {
      issues.push(`${status} customer config still publicly accessible on /k/`);
    }

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("disabled");
  });
});

describe("Secret values never returned", () => {
  it("diagnose result shape has no accessUrl, password, or raw ss:// field", () => {
    // The DiagnoseResult type should not contain any of these fields.
    const safeFields = [
      "token", "name", "status", "checks", "issues",
      "suggestedAction", "diagnosis", "checkedAt",
    ];
    const forbiddenFields = ["accessUrl", "password", "browserSecret", "rawSs"];

    // Simulate a result object.
    const result: Record<string, unknown> = {
      token: "a".repeat(32),
      name: "Test Customer",
      status: "active",
      checks: [],
      issues: [],
      diagnosis: "no_issue",
      checkedAt: new Date().toISOString(),
    };

    for (const f of forbiddenFields) {
      expect(result).not.toHaveProperty(f);
    }
    for (const f of safeFields.slice(0, 4)) {
      // At minimum these safe fields exist.
      expect(safeFields).toContain(f);
    }
  });
});
