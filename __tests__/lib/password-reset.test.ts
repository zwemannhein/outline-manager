import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({
  getRedis: () => fakeRedis,
}));

vi.mock("@/lib/validation", () => ({
  getEnv: () => ({
    ADMIN_USERNAME: "bootstrap-admin",
    ADMIN_PASSWORD: "bootstrap-pass-123",
    JWT_SECRET: "test-pepper-secret-at-least-32-characters",
  }),
}));

import {
  createResetRequest,
  invalidateResetRequest,
  verifyResetCode,
  consumeResetAndSetPassword,
  getResetStatus,
  getResetUsername,
  getResendCooldownRemaining,
  startResendCooldown,
  generateResetCode,
  hashResetCode,
  codeMatchesStoredHash,
  isValidResetId,
  isValidCodeFormat,
  resetKey,
  MAX_CODE_ATTEMPTS,
  RESET_TTL_SECONDS,
  RESEND_COOLDOWN_SECONDS,
} from "@/lib/password-reset";

const USERNAME = "recovered-admin";
const ADMIN_AUTH_KEY = "admin:auth";

const MATERIAL = {
  passwordHash: "a".repeat(128),
  salt: "b".repeat(32),
  algorithm: "scrypt",
};

async function newRequest() {
  return createResetRequest({ username: USERNAME, ip: "203.0.113.9" });
}

function wrongCodeFor(code: string): string {
  return code === "111111" ? "222222" : "111111";
}

describe("reset code generation", () => {
  it("always produces exactly 6 digits", () => {
    for (let i = 0; i < 300; i += 1) {
      const code = generateResetCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThanOrEqual(999999);
    }
  });

  it("produces varied codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateResetCode());
    expect(seen.size).toBeGreaterThan(50);
  });

  it("binds the hash to the resetId so a code cannot be replayed across requests", () => {
    const code = "123456";
    expect(hashResetCode("a".repeat(32), code)).not.toBe(hashResetCode("b".repeat(32), code));
  });

  it("produces an HMAC-shaped digest that is not a bare sha256 of resetId:code", async () => {
    const { createHash } = await import("crypto");
    const resetId = "c".repeat(32);
    const code = "654321";

    const peppered = hashResetCode(resetId, code);
    const bare = createHash("sha256").update(`${resetId}:${code}`, "utf8").digest("hex");

    expect(peppered).toMatch(/^[0-9a-f]{64}$/);
    // Keyed with the server secret, so it differs from an unkeyed digest.
    expect(peppered).not.toBe(bare);
  });

  it("validates formats", () => {
    expect(isValidResetId("a".repeat(32))).toBe(true);
    expect(isValidResetId("A".repeat(32))).toBe(false);
    expect(isValidResetId("abc")).toBe(false);
    expect(isValidCodeFormat("123456")).toBe(true);
    expect(isValidCodeFormat("12345")).toBe(false);
    expect(isValidCodeFormat("12345a")).toBe(false);
  });
});

describe("reset request creation", () => {
  beforeEach(() => fakeRedis.reset());

  it("returns a 32-hex resetId and a 6-digit code", async () => {
    const r = await newRequest();
    expect(r.resetId).toMatch(/^[0-9a-f]{32}$/);
    expect(r.code).toMatch(/^[0-9]{6}$/);
  });

  it("never stores the raw reset code, only the peppered hash", async () => {
    const r = await newRequest();

    const stored = fakeRedis.peekHash(resetKey(r.resetId));
    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.codeHash).not.toBe(r.code);
    expect(fakeRedis.dumpAll()).not.toContain(r.code);
  });

  it("stores the server-resolved username so the browser never supplies it", async () => {
    const r = await newRequest();
    expect(fakeRedis.peekHash(resetKey(r.resetId))?.username).toBe(USERNAME);
    await expect(getResetUsername(r.resetId)).resolves.toBe(USERNAME);
  });

  it("starts in the pending state with an expiry about 5 minutes out", async () => {
    const r = await newRequest();

    expect(fakeRedis.peekHash(resetKey(r.resetId))?.state).toBe("pending");
    await expect(getResetStatus(r.resetId)).resolves.toBe("pending");

    const ttl = await fakeRedis.ttl(resetKey(r.resetId));
    expect(ttl).toBeGreaterThan(RESET_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(RESET_TTL_SECONDS);
  });

  it("does NOT start the cooldown by itself", async () => {
    await newRequest();
    // Cooldown begins only after successful Telegram delivery, which the route
    // triggers explicitly.
    await expect(getResendCooldownRemaining()).resolves.toBe(0);
  });

  it("does NOT touch any previous request", async () => {
    const first = await newRequest();
    const second = await newRequest();

    // Creating a replacement leaves the old one usable until explicitly retired.
    await expect(getResetStatus(first.resetId)).resolves.toBe("pending");
    await expect(getResetStatus(second.resetId)).resolves.toBe("pending");
  });

  it("expires once past its lifetime", async () => {
    const r = await newRequest();
    fakeRedis.forceExpire(resetKey(r.resetId));
    await expect(getResetStatus(r.resetId)).resolves.toBe("expired");
  });

  it("matches its own code and rejects another", async () => {
    const r = await newRequest();
    await expect(codeMatchesStoredHash(r.resetId, r.code)).resolves.toBe(true);
    await expect(codeMatchesStoredHash(r.resetId, wrongCodeFor(r.code))).resolves.toBe(false);
  });
});

describe("cooldown is explicit and independent of creation", () => {
  beforeEach(() => fakeRedis.reset());

  it("reports remaining seconds once started", async () => {
    await startResendCooldown();
    const remaining = await getResendCooldownRemaining();
    expect(remaining).toBeGreaterThan(RESEND_COOLDOWN_SECONDS - 5);
    expect(remaining).toBeLessThanOrEqual(RESEND_COOLDOWN_SECONDS);
  });
});

describe("explicit invalidation (used by resend after successful delivery)", () => {
  beforeEach(() => fakeRedis.reset());

  it("makes the old code and id unusable", async () => {
    const first = await newRequest();
    await invalidateResetRequest(first.resetId);

    await expect(getResetStatus(first.resetId)).resolves.toBe("expired");
    const attempt = await verifyResetCode(first.resetId, first.code);
    expect(attempt.ok).toBe(false);
  });

  it("ignores a malformed id safely", async () => {
    await expect(invalidateResetRequest("not-a-valid-id")).resolves.toBeUndefined();
  });
});

describe("code verification is atomic", () => {
  beforeEach(() => fakeRedis.reset());

  it("rejects a malformed code without consuming an attempt", async () => {
    const r = await newRequest();

    const result = await verifyResetCode(r.resetId, "12ab");
    expect(result.ok).toBe(false);
    expect(fakeRedis.peekHash(resetKey(r.resetId))?.attempts).toBe("0");
  });

  it("rejects a wrong code and increments the attempt counter", async () => {
    const r = await newRequest();

    const result = await verifyResetCode(r.resetId, wrongCodeFor(r.code));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong_code");
      expect(result.attemptsRemaining).toBe(MAX_CODE_ATTEMPTS - 1);
    }
    expect(fakeRedis.peekHash(resetKey(r.resetId))?.attempts).toBe("1");
  });

  it("locks the request after the maximum number of wrong codes", async () => {
    const r = await newRequest();
    const wrong = wrongCodeFor(r.code);

    for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
      const res = await verifyResetCode(r.resetId, wrong);
      expect(res.ok).toBe(false);
    }

    const final = await verifyResetCode(r.resetId, wrong);
    expect(final.ok).toBe(false);
    if (!final.ok) expect(final.reason).toBe("locked");

    await expect(getResetStatus(r.resetId)).resolves.toBe("locked");

    // Even the correct code no longer works once locked.
    const afterLock = await verifyResetCode(r.resetId, r.code);
    expect(afterLock.ok).toBe(false);
    if (!afterLock.ok) expect(afterLock.reason).toBe("locked");
  });

  it("moves pending to verified on the correct code", async () => {
    const r = await newRequest();

    await expect(verifyResetCode(r.resetId, r.code)).resolves.toEqual({ ok: true });
    await expect(getResetStatus(r.resetId)).resolves.toBe("verified");
  });

  it("cannot re-verify after the state has moved on", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);

    const again = await verifyResetCode(r.resetId, r.code);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("not_pending");
  });

  it("rejects verification of an expired request", async () => {
    const r = await newRequest();
    fakeRedis.forceExpire(resetKey(r.resetId));

    const result = await verifyResetCode(r.resetId, r.code);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown resetId", async () => {
    const result = await verifyResetCode("f".repeat(32), "123456");
    expect(result.ok).toBe(false);
  });
});

// ── The races ChatGPT asked for ──────────────────────────────────────────────

describe("RACE: correct code vs the 5th incorrect code", () => {
  beforeEach(() => fakeRedis.reset());

  it("never leaves the record both verified and locked", async () => {
    const r = await newRequest();
    const wrong = wrongCodeFor(r.code);

    // Burn 4 attempts so the next wrong code is the one that would lock.
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) {
      await verifyResetCode(r.resetId, wrong);
    }

    const [correct, fifthWrong] = await Promise.all([
      verifyResetCode(r.resetId, r.code),
      verifyResetCode(r.resetId, wrong),
    ]);

    // Exactly one terminal outcome.
    const status = await getResetStatus(r.resetId);
    expect(["verified", "locked"]).toContain(status);

    const stored = fakeRedis.peekHash(resetKey(r.resetId))!;
    // A single `state` field cannot represent both, and CAS cannot produce it.
    expect(stored.state).toBe(status);
    expect(Object.keys(stored)).not.toContain("verified");

    // Whichever lost must report failure.
    const winners = [correct, fifthWrong].filter((x) => x.ok);
    if (status === "verified") {
      expect(correct.ok).toBe(true);
      expect(fifthWrong.ok).toBe(false);
      expect(winners).toHaveLength(1);
    } else {
      expect(correct.ok).toBe(false);
      expect(winners).toHaveLength(0);
    }
  });

  it("holds under repeated interleavings", async () => {
    for (let round = 0; round < 25; round += 1) {
      fakeRedis.reset();
      const r = await newRequest();
      const wrong = wrongCodeFor(r.code);
      for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i += 1) {
        await verifyResetCode(r.resetId, wrong);
      }

      await Promise.all([
        verifyResetCode(r.resetId, wrong),
        verifyResetCode(r.resetId, r.code),
      ]);

      const stored = fakeRedis.peekHash(resetKey(r.resetId))!;
      expect(["verified", "locked"]).toContain(stored.state);
    }
  });
});

describe("RACE: two correct verification requests", () => {
  beforeEach(() => fakeRedis.reset());

  it("verifies exactly once", async () => {
    const r = await newRequest();

    const [a, b] = await Promise.all([
      verifyResetCode(r.resetId, r.code),
      verifyResetCode(r.resetId, r.code),
    ]);

    expect([a, b].filter((x) => x.ok)).toHaveLength(1);
    await expect(getResetStatus(r.resetId)).resolves.toBe("verified");
  });
});

describe("RACE: verification vs expiry", () => {
  beforeEach(() => fakeRedis.reset());

  it("refuses to verify a request that expired first", async () => {
    const r = await newRequest();
    fakeRedis.forceExpire(resetKey(r.resetId));

    const result = await verifyResetCode(r.resetId, r.code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");

    // The state is left untouched by a refused transition.
    const stored = fakeRedis.peekHash(resetKey(r.resetId));
    expect(stored?.state).toBe("pending");
  });
});

// ── Atomic password write + consumption ─────────────────────────────────────

describe("password write and reset consumption are atomic", () => {
  beforeEach(() => fakeRedis.reset());

  it("refuses an unverified request and leaves admin:auth untouched", async () => {
    const r = await newRequest();

    const result = await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_verified");

    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)).toBeUndefined();
  });

  it("refuses a locked request and leaves admin:auth untouched", async () => {
    const r = await newRequest();
    const wrong = wrongCodeFor(r.code);
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) await verifyResetCode(r.resetId, wrong);

    const result = await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("locked");

    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)).toBeUndefined();
  });

  it("refuses an expired request and leaves admin:auth untouched", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);
    fakeRedis.forceExpire(resetKey(r.resetId));

    const result = await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);
    expect(result.ok).toBe(false);

    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)).toBeUndefined();
  });

  it("refuses an unknown resetId and leaves admin:auth untouched", async () => {
    const result = await consumeResetAndSetPassword("e".repeat(32), MATERIAL, ADMIN_AUTH_KEY);
    expect(result.ok).toBe(false);
    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)).toBeUndefined();
  });

  it("writes the password AND consumes the request together", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);

    const result = await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.username).toBe(USERNAME);

    // Both effects are present.
    const auth = fakeRedis.peekHash(ADMIN_AUTH_KEY)!;
    expect(auth.passwordHash).toBe(MATERIAL.passwordHash);
    expect(auth.salt).toBe(MATERIAL.salt);
    expect(auth.algorithm).toBe(MATERIAL.algorithm);
    expect(auth.updatedAt).toBeTruthy();

    await expect(getResetStatus(r.resetId)).resolves.toBe("consumed");
  });

  it("cannot write again once consumed", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);
    await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);

    const second = {
      passwordHash: "c".repeat(128),
      salt: "d".repeat(32),
      algorithm: "scrypt",
    };
    const result = await consumeResetAndSetPassword(r.resetId, second, ADMIN_AUTH_KEY);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("consumed");

    // The second material was NOT written.
    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)!.passwordHash).toBe(MATERIAL.passwordHash);
  });

  it("RACE: two simultaneous consumers produce exactly one password update", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);

    const first = MATERIAL;
    const second = {
      passwordHash: "9".repeat(128),
      salt: "8".repeat(32),
      algorithm: "scrypt",
    };

    const [a, b] = await Promise.all([
      consumeResetAndSetPassword(r.resetId, first, ADMIN_AUTH_KEY),
      consumeResetAndSetPassword(r.resetId, second, ADMIN_AUTH_KEY),
    ]);

    const winners = [a, b].filter((x) => x.ok);
    expect(winners).toHaveLength(1);

    // admin:auth holds exactly one of the two, never a mix of hash and salt.
    const auth = fakeRedis.peekHash(ADMIN_AUTH_KEY)!;
    const isFirst = auth.passwordHash === first.passwordHash && auth.salt === first.salt;
    const isSecond = auth.passwordHash === second.passwordHash && auth.salt === second.salt;
    expect(isFirst || isSecond).toBe(true);

    await expect(getResetStatus(r.resetId)).resolves.toBe("consumed");
  });

  it("never puts a plaintext password into Redis", async () => {
    const r = await newRequest();
    await verifyResetCode(r.resetId, r.code);
    await consumeResetAndSetPassword(r.resetId, MATERIAL, ADMIN_AUTH_KEY);

    // Only derived material crosses the boundary; there is no plaintext to find.
    const dump = fakeRedis.dumpAll();
    expect(dump).toContain(MATERIAL.passwordHash);
    expect(dump).not.toContain(r.code);
  });
});
