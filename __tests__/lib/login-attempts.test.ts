import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({
  getRedis: () => fakeRedis,
}));

import {
  createLoginAttempt,
  approveLoginAttempt,
  rejectLoginAttempt,
  cancelLoginAttempt,
  consumeApprovedAttempt,
  getAttemptStatusForBrowser,
  getAttemptView,
  verifyAttemptSecret,
  isValidAttemptId,
  isValidBrowserSecret,
  sanitizeUserAgent,
  describeUserAgent,
  attemptKey,
} from "@/lib/login-attempts";

const BASE = { username: "admin-user", ip: "203.0.113.5", userAgent: "Mozilla/5.0 (Macintosh) Chrome/120" };

describe("login attempt creation", () => {
  beforeEach(() => fakeRedis.reset());

  it("generates a 32-hex attemptId and 64-hex browserSecret", async () => {
    const a = await createLoginAttempt(BASE);

    expect(a.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.browserSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidAttemptId(a.attemptId)).toBe(true);
    expect(isValidBrowserSecret(a.browserSecret)).toBe(true);
  });

  it("never stores the raw browserSecret, only its hash", async () => {
    const a = await createLoginAttempt(BASE);

    const stored = fakeRedis.peekHash(attemptKey(a.attemptId));
    expect(stored?.browserSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.browserSecretHash).not.toBe(a.browserSecret);

    expect(fakeRedis.dumpAll()).not.toContain(a.browserSecret);
  });

  it("starts pending and is only readable with the correct secret", async () => {
    const a = await createLoginAttempt(BASE);

    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("pending");

    const wrong = "b".repeat(64);
    await expect(getAttemptStatusForBrowser(a.attemptId, wrong)).resolves.toBe("expired");
    await expect(verifyAttemptSecret(a.attemptId, wrong)).resolves.toBe(false);
  });

  it("reports expired for unknown or malformed ids", async () => {
    await expect(getAttemptStatusForBrowser("f".repeat(32), "a".repeat(64))).resolves.toBe("expired");
    await expect(getAttemptStatusForBrowser("nope", "a".repeat(64))).resolves.toBe("expired");
  });
});

describe("login attempt decisions are atomic and mutually exclusive", () => {
  beforeEach(() => fakeRedis.reset());

  it("approves a pending attempt", async () => {
    const a = await createLoginAttempt(BASE);

    await expect(approveLoginAttempt(a.attemptId)).resolves.toEqual({ ok: true });
    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("approved");
  });

  it("cannot reject an already-approved attempt", async () => {
    const a = await createLoginAttempt(BASE);
    await approveLoginAttempt(a.attemptId);

    const rejected = await rejectLoginAttempt(a.attemptId);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe("already_decided");

    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("approved");
  });

  it("cannot approve an already-rejected attempt", async () => {
    const a = await createLoginAttempt(BASE);
    await rejectLoginAttempt(a.attemptId);

    const approved = await approveLoginAttempt(a.attemptId);
    expect(approved.ok).toBe(false);
    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("rejected");
  });

  it("is idempotent under repeated taps", async () => {
    const a = await createLoginAttempt(BASE);

    const first = await approveLoginAttempt(a.attemptId);
    const second = await approveLoginAttempt(a.attemptId);
    const third = await approveLoginAttempt(a.attemptId);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
  });

  it("resolves only one winner when approve and reject race", async () => {
    const a = await createLoginAttempt(BASE);

    const [r1, r2] = await Promise.all([
      approveLoginAttempt(a.attemptId),
      rejectLoginAttempt(a.attemptId),
    ]);

    const winners = [r1, r2].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
  });

  it("refuses to decide an expired attempt", async () => {
    const a = await createLoginAttempt(BASE);
    fakeRedis.forceExpire(attemptKey(a.attemptId));

    const result = await approveLoginAttempt(a.attemptId);
    expect(result.ok).toBe(false);
  });
});

describe("login attempt consumption issues exactly one session", () => {
  beforeEach(() => fakeRedis.reset());

  it("does not consume while still pending", async () => {
    const a = await createLoginAttempt(BASE);

    const result = await consumeApprovedAttempt(a.attemptId, a.browserSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("pending");
  });

  it("does not consume a rejected attempt", async () => {
    const a = await createLoginAttempt(BASE);
    await rejectLoginAttempt(a.attemptId);

    const result = await consumeApprovedAttempt(a.attemptId, a.browserSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("rejected");
  });

  it("requires the correct browserSecret even after approval", async () => {
    const a = await createLoginAttempt(BASE);
    await approveLoginAttempt(a.attemptId);

    const result = await consumeApprovedAttempt(a.attemptId, "c".repeat(64));
    expect(result.ok).toBe(false);
  });

  it("consumes once and never again", async () => {
    const a = await createLoginAttempt(BASE);
    await approveLoginAttempt(a.attemptId);

    const first = await consumeApprovedAttempt(a.attemptId, a.browserSecret);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.username).toBe(BASE.username);

    const second = await consumeApprovedAttempt(a.attemptId, a.browserSecret);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe("consumed");
  });

  it("yields exactly one winner when two consumers race", async () => {
    const a = await createLoginAttempt(BASE);
    await approveLoginAttempt(a.attemptId);

    const [c1, c2] = await Promise.all([
      consumeApprovedAttempt(a.attemptId, a.browserSecret),
      consumeApprovedAttempt(a.attemptId, a.browserSecret),
    ]);

    expect([c1, c2].filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("login attempt cancellation", () => {
  beforeEach(() => fakeRedis.reset());

  it("cancels with the correct secret and blocks later approval", async () => {
    const a = await createLoginAttempt(BASE);

    await expect(cancelLoginAttempt(a.attemptId, a.browserSecret)).resolves.toEqual({ ok: true });
    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("cancelled");

    const approved = await approveLoginAttempt(a.attemptId);
    expect(approved.ok).toBe(false);
  });

  it("cannot be cancelled without the browserSecret", async () => {
    const a = await createLoginAttempt(BASE);

    const result = await cancelLoginAttempt(a.attemptId, "d".repeat(64));
    expect(result.ok).toBe(false);
    await expect(getAttemptStatusForBrowser(a.attemptId, a.browserSecret)).resolves.toBe("pending");
  });
});

describe("user agent handling", () => {
  it("truncates and strips control characters", () => {
    expect(sanitizeUserAgent("Mozilla\n\nInjected: line")).not.toContain("\n");
    expect(sanitizeUserAgent(null)).toBe("Unknown device");
    expect(sanitizeUserAgent("")).toBe("Unknown device");

    const long = "A".repeat(500);
    const out = sanitizeUserAgent(long);
    expect(out.length).toBeLessThanOrEqual(203);
    expect(out.endsWith("...")).toBe(true);
  });

  it("summarises common browser/OS pairs", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120 Safari/537")).toBe("Chrome / macOS");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604")).toBe("Safari / iOS");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Firefox/121")).toBe("Firefox / Windows");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });
});

describe("attempt view for the Telegram handler", () => {
  beforeEach(() => fakeRedis.reset());

  it("exposes display fields but no secret", async () => {
    const a = await createLoginAttempt(BASE);
    const view = await getAttemptView(a.attemptId);

    expect(view).not.toBeNull();
    expect(view!.username).toBe(BASE.username);
    expect(view!.ip).toBe(BASE.ip);
    expect(view!.status).toBe("pending");
    expect(JSON.stringify(view)).not.toContain(a.browserSecret);
  });

  it("returns null for an unknown attempt", async () => {
    await expect(getAttemptView("a".repeat(32))).resolves.toBeNull();
  });
});
