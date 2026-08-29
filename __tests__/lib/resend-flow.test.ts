import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({
  getRedis: () => fakeRedis,
}));

vi.mock("@/lib/validation", () => ({
  getEnv: () => ({
    ADMIN_USERNAME: "bootstrap-admin",
    JWT_SECRET: "test-pepper-secret-at-least-32-characters",
  }),
}));

import {
  issueResetCode,
  verifyResetCode,
  getResetStatus,
  getResendCooldownRemaining,
  startResendCooldown,
  RESEND_COOLDOWN_SECONDS,
} from "@/lib/password-reset";

const USERNAME = "recovered-admin";
const IP = "203.0.113.11";

/** Capture the code a delivery attempt was given. */
function makeDeliver(succeed: boolean) {
  const seen: string[] = [];
  const fn = vi.fn(async (code: string) => {
    seen.push(code);
    return succeed;
  });
  return { fn, seen };
}

async function issue(succeed: boolean, previousResetId?: string | null) {
  const deliver = makeDeliver(succeed);
  const outcome = await issueResetCode({
    username: USERNAME,
    ip: IP,
    previousResetId: previousResetId ?? null,
    deliver: deliver.fn,
  });
  return { outcome, deliver };
}

describe("first send", () => {
  beforeEach(() => fakeRedis.reset());

  it("creates a request, delivers it, and starts the cooldown", async () => {
    const { outcome, deliver } = await issue(true);

    expect(outcome.status).toBe("sent");
    expect(deliver.fn).toHaveBeenCalledTimes(1);
    expect(deliver.seen[0]).toMatch(/^[0-9]{6}$/);

    if (outcome.status === "sent") {
      await expect(getResetStatus(outcome.resetId)).resolves.toBe("pending");
    }

    const cooldown = await getResendCooldownRemaining();
    expect(cooldown).toBeGreaterThan(RESEND_COOLDOWN_SECONDS - 5);
  });

  it("passes the server-resolved username to the deliverer", async () => {
    const { deliver } = await issue(true);
    expect(deliver.fn).toHaveBeenCalledWith(expect.any(String), USERNAME);
  });
});

describe("resend rejected by cooldown leaves the old code valid", () => {
  beforeEach(() => fakeRedis.reset());

  it("returns cooldown and does NOT touch the existing request", async () => {
    const first = await issue(true);
    expect(first.outcome.status).toBe("sent");
    if (first.outcome.status !== "sent") return;

    const firstResetId = first.outcome.resetId;
    const firstCode = first.deliver.seen[0];

    // Immediately attempt a resend while the cooldown is running.
    const second = await issue(true, firstResetId);

    expect(second.outcome.status).toBe("cooldown");
    if (second.outcome.status === "cooldown") {
      expect(second.outcome.retryAfterSeconds).toBeGreaterThan(0);
    }

    // No delivery was attempted, so Telegram cannot be flooded.
    expect(second.deliver.fn).not.toHaveBeenCalled();

    // Critically: the original request is still pending and its code still works.
    await expect(getResetStatus(firstResetId)).resolves.toBe("pending");
    await expect(verifyResetCode(firstResetId, firstCode)).resolves.toEqual({ ok: true });
  });

  it("creates no replacement request during cooldown", async () => {
    await startResendCooldown();

    const { outcome, deliver } = await issue(true, null);

    expect(outcome.status).toBe("cooldown");
    expect(deliver.fn).not.toHaveBeenCalled();
  });
});

describe("failed Telegram delivery does not destroy a valid old code", () => {
  beforeEach(() => fakeRedis.reset());

  it("keeps the previous request usable and discards the undeliverable one", async () => {
    // First send succeeds.
    const first = await issue(true);
    if (first.outcome.status !== "sent") throw new Error("setup failed");
    const firstResetId = first.outcome.resetId;
    const firstCode = first.deliver.seen[0];

    // Clear the cooldown so the resend is allowed to proceed.
    fakeRedis.forceEvict("adminreset:cooldown");

    // Resend, but delivery fails.
    const second = await issue(false, firstResetId);
    expect(second.outcome.status).toBe("delivery_failed");
    expect(second.deliver.fn).toHaveBeenCalledTimes(1);

    // The OLD request survives and its code still verifies.
    await expect(getResetStatus(firstResetId)).resolves.toBe("pending");
    await expect(verifyResetCode(firstResetId, firstCode)).resolves.toEqual({ ok: true });
  });

  it("does not start the cooldown after a failed delivery, so a retry is possible", async () => {
    const { outcome } = await issue(false);
    expect(outcome.status).toBe("delivery_failed");

    await expect(getResendCooldownRemaining()).resolves.toBe(0);

    // An immediate retry is allowed and can succeed.
    const retry = await issue(true);
    expect(retry.outcome.status).toBe("sent");
  });

  it("treats a throwing deliverer as a failed delivery", async () => {
    const outcome = await issueResetCode({
      username: USERNAME,
      ip: IP,
      deliver: async () => {
        throw new Error("network down");
      },
    });

    expect(outcome.status).toBe("delivery_failed");
    await expect(getResendCooldownRemaining()).resolves.toBe(0);
  });

  it("leaves no usable orphan behind when delivery fails", async () => {
    const { deliver } = await issue(false);
    // The code that was generated but never delivered must not be usable.
    const orphanCode = deliver.seen[0];
    expect(orphanCode).toMatch(/^[0-9]{6}$/);
    // Its record was removed, so nothing in Redis references it.
    expect(fakeRedis.dumpAll()).not.toContain(orphanCode);
  });
});

describe("successful resend rotates the code", () => {
  beforeEach(() => fakeRedis.reset());

  it("invalidates the old code and issues a new resetId and code", async () => {
    const first = await issue(true);
    if (first.outcome.status !== "sent") throw new Error("setup failed");
    const firstResetId = first.outcome.resetId;
    const firstCode = first.deliver.seen[0];

    fakeRedis.forceEvict("adminreset:cooldown");

    const second = await issue(true, firstResetId);
    if (second.outcome.status !== "sent") throw new Error("resend failed");
    const secondResetId = second.outcome.resetId;
    const secondCode = second.deliver.seen[0];

    // A brand-new request.
    expect(secondResetId).not.toBe(firstResetId);

    // The old one is gone and its code no longer works.
    await expect(getResetStatus(firstResetId)).resolves.toBe("expired");
    const oldAttempt = await verifyResetCode(firstResetId, firstCode);
    expect(oldAttempt.ok).toBe(false);

    // The new one works.
    await expect(verifyResetCode(secondResetId, secondCode)).resolves.toEqual({ ok: true });
  });

  it("restarts the cooldown after a successful resend", async () => {
    const first = await issue(true);
    if (first.outcome.status !== "sent") throw new Error("setup failed");

    fakeRedis.forceEvict("adminreset:cooldown");
    await expect(getResendCooldownRemaining()).resolves.toBe(0);

    await issue(true, first.outcome.resetId);
    await expect(getResendCooldownRemaining()).resolves.toBeGreaterThan(
      RESEND_COOLDOWN_SECONDS - 5
    );
  });
});
