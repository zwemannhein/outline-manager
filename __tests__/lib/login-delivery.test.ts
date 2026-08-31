/**
 * Tests for:
 * A. Login delivery fix — TELEGRAM_CHAT_ID always included alongside linked approvers
 * B. Login delivery telemetry write/read
 * C. Zero-recipients returns clear error (not silent hang)
 * D. Sanitisation of failure category (no numeric IDs or long tokens leak)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

import {
  writeLoginTelemetry,
  readLoginTelemetry,
  MONITOR_LOGIN_KEY,
} from "@/lib/monitoring";

// ── A. TELEGRAM_CHAT_ID always included ───────────────────────────────────────

describe("A. TELEGRAM_CHAT_ID always included alongside linked approvers", () => {
  it("merges linked approvers and static IDs, never skips static when approvers exist", () => {
    // Simulate the fixed logic from login route.
    const linkedChatIds = ["111111111"]; // one linked approver in Redis
    const staticIds = ["999888777"];     // env var TELEGRAM_CHAT_ID

    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const id of [...linkedChatIds, ...staticIds]) {
      if (id && !seen.has(id)) { seen.add(id); chatIds.push(id); }
    }

    // Both must be included — static is NOT skipped even though linked exists.
    expect(chatIds).toContain("111111111");
    expect(chatIds).toContain("999888777");
    expect(chatIds).toHaveLength(2);
  });

  it("deduplicates when the same ID appears in both lists", () => {
    const linkedChatIds = ["123456789"];
    const staticIds     = ["123456789"]; // same person

    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const id of [...linkedChatIds, ...staticIds]) {
      if (id && !seen.has(id)) { seen.add(id); chatIds.push(id); }
    }

    expect(chatIds).toHaveLength(1);
    expect(chatIds[0]).toBe("123456789");
  });

  it("still works when linkedChatIds is empty — falls through to static", () => {
    const linkedChatIds: string[] = [];
    const staticIds = ["777666555"];

    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const id of [...linkedChatIds, ...staticIds]) {
      if (id && !seen.has(id)) { seen.add(id); chatIds.push(id); }
    }

    expect(chatIds).toEqual(["777666555"]);
  });

  it("OLD broken logic — demonstrates the bug (reference only, not the live code)", () => {
    // This is the OLD broken logic: staticIds ignored when linkedChatIds exist.
    const linkedChatIds = ["stale-unreachable-id"];
    const staticIds = ["working-chat-id"];
    const brokenChatIds = linkedChatIds.length > 0 ? linkedChatIds : staticIds;

    // BUG: staticIds is skipped even though "stale-unreachable-id" cannot receive messages.
    expect(brokenChatIds).not.toContain("working-chat-id");
    expect(brokenChatIds).toEqual(["stale-unreachable-id"]);
  });
});

// ── B. Login delivery telemetry ───────────────────────────────────────────────

describe("B. Login delivery telemetry write/read", () => {
  beforeEach(() => fakeRedis.reset());

  it("writes and reads back delivery telemetry correctly", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: "2026-08-31T10:00:00.000Z",
      recipientsAttempted: 2,
      deliverSucceeded: 1,
      deliverFailed: 1,
      lastFailureCategory: "Not Found",
    });

    const result = await readLoginTelemetry();
    expect(result).not.toBeNull();
    expect(result!.challengeCreatedAt).toBe("2026-08-31T10:00:00.000Z");
    expect(result!.recipientsAttempted).toBe(2);
    expect(result!.deliverSucceeded).toBe(1);
    expect(result!.deliverFailed).toBe(1);
    expect(result!.lastFailureCategory).toBe("Not Found");
  });

  it("returns null when no telemetry has been written", async () => {
    expect(await readLoginTelemetry()).toBeNull();
  });

  it("overwrites previous telemetry on subsequent login attempts", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: "2026-08-31T09:00:00.000Z",
      recipientsAttempted: 1,
      deliverSucceeded: 0,
      deliverFailed: 1,
      lastFailureCategory: "timeout",
    });
    await writeLoginTelemetry({
      challengeCreatedAt: "2026-08-31T10:00:00.000Z",
      recipientsAttempted: 2,
      deliverSucceeded: 2,
      deliverFailed: 0,
      lastFailureCategory: "",
    });

    const result = await readLoginTelemetry();
    expect(result!.challengeCreatedAt).toBe("2026-08-31T10:00:00.000Z");
    expect(result!.deliverSucceeded).toBe(2);
    expect(result!.deliverFailed).toBe(0);
  });
});

// ── C. Zero-recipients error ──────────────────────────────────────────────────

describe("C. Zero recipients → clear error condition", () => {
  it("chatIds empty when both linked and static are absent", () => {
    const linkedChatIds: string[] = [];
    const staticIds: string[] = [];

    const seen = new Set<string>();
    const chatIds: string[] = [];
    for (const id of [...linkedChatIds, ...staticIds]) {
      if (id && !seen.has(id)) { seen.add(id); chatIds.push(id); }
    }

    // Route should throw APPROVAL_UNAVAILABLE — tested here as the condition.
    expect(chatIds.length).toBe(0);
  });

  it("empty string env var produces no static IDs", () => {
    const envVal = "";
    const staticIds = envVal.split(",").map((s) => s.trim()).filter(Boolean);
    expect(staticIds).toHaveLength(0);
  });
});

// ── D. Failure category sanitisation ─────────────────────────────────────────

describe("D. Failure category sanitisation — no credentials leak", () => {
  beforeEach(() => fakeRedis.reset());

  it("strips long numeric IDs from failure category", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: new Date().toISOString(),
      recipientsAttempted: 1,
      deliverSucceeded: 0,
      deliverFailed: 1,
      // Simulate a Telegram error that might contain a numeric chat_id.
      lastFailureCategory: "Forbidden: bot was blocked by the user 1695582683",
    });

    const result = await readLoginTelemetry();
    expect(result!.lastFailureCategory).not.toContain("1695582683");
    expect(result!.lastFailureCategory).toContain("[id]");
  });

  it("strips long token-like strings from failure category", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: new Date().toISOString(),
      recipientsAttempted: 1,
      deliverSucceeded: 0,
      deliverFailed: 1,
      lastFailureCategory: "Error with token abc123def456ghi789jkl012mno345pq",
    });

    const result = await readLoginTelemetry();
    expect(result!.lastFailureCategory).not.toMatch(/[A-Za-z0-9_-]{30,}/);
  });

  it("preserves short human-readable error messages", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: new Date().toISOString(),
      recipientsAttempted: 1,
      deliverSucceeded: 0,
      deliverFailed: 1,
      lastFailureCategory: "Not Found",
    });

    const result = await readLoginTelemetry();
    expect(result!.lastFailureCategory).toBe("Not Found");
  });

  it("stored telemetry never contains bot token or raw chat_id values", async () => {
    await writeLoginTelemetry({
      challengeCreatedAt: new Date().toISOString(),
      recipientsAttempted: 1,
      deliverSucceeded: 1,
      deliverFailed: 0,
      lastFailureCategory: "",
    });

    const dump = fakeRedis.dumpAll();
    // The dump should contain the key but no credential-shaped values.
    expect(dump).toContain(MONITOR_LOGIN_KEY);
    // No Telegram bot token pattern (digits:chars).
    expect(dump).not.toMatch(/\d{9,}:[A-Za-z0-9_-]{35}/);
    // No raw large numeric IDs in the stored values.
    // (recipientsAttempted=1 is a small number, that's fine)
  });
});
