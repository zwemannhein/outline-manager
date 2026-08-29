/**
 * REAL-UPSTASH validation of the three authentication Lua scripts.
 *
 * Purpose: unit tests transcribe the Lua into JavaScript to exercise the state
 * machines, which cannot catch a Lua syntax error, an `eval` argument-format
 * mismatch, or a Redis behavioural surprise. This file runs the ACTUAL exported
 * script constants against the genuine configured Upstash instance.
 *
 * SAFETY MODEL
 *  - Every key is namespaced `__auth_itest__:<uuid>:` and registered before use.
 *  - guardKey() hard-refuses anything outside that prefix, and explicitly
 *    refuses `admin:auth` and any real `adminlogin:` / `adminreset:` key, so a
 *    coding mistake cannot reach production data.
 *  - The real admin password is never read, compared, or written. The two-key
 *    script is pointed at a THROWAWAY fake admin-auth key.
 *  - No Telegram message is sent and no JWT is issued.
 *  - try/finally deletes every registered key and then verifies deletion.
 *  - No credential, hash, code, or URL value is ever printed.
 *
 * Run with: npm run test:upstash
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes, createHmac } from "crypto";
import { loadEnvConfig } from "@next/env";

// Load the real .env exactly as Next.js would, before any Redis access.
loadEnvConfig(process.cwd());

import { getRedis } from "@/lib/api-utils";
import { LUA_VERIFY_RESET_CODE, LUA_CONSUME_RESET_AND_SET_PASSWORD } from "@/lib/password-reset";
import { LUA_TRANSITION_ATTEMPT } from "@/lib/login-attempts";

// ── Isolation namespace ───────────────────────────────────────────────────────

const RUN_ID = randomUUID();
const PREFIX = `__auth_itest__:${RUN_ID}:`;

/** Keys that must never be touched, regardless of any other logic. */
const FORBIDDEN_EXACT = new Set(["admin:auth", "adminlogin:pending", "adminreset:cooldown"]);
const FORBIDDEN_PATTERNS = [/^admin:/, /^adminlogin:/, /^adminreset:/, /^outline_/];

const created = new Set<string>();

/**
 * Refuse any key outside the throwaway namespace. Called on every key before it
 * reaches Redis, including inside the Lua KEYS arrays.
 */
function guardKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Integration guard: empty key");
  }
  if (!key.startsWith("__auth_itest__:")) {
    throw new Error(`Integration guard: key lacks the __auth_itest__: prefix`);
  }
  if (!key.startsWith(PREFIX)) {
    throw new Error("Integration guard: key belongs to a different run");
  }
  if (FORBIDDEN_EXACT.has(key)) {
    throw new Error("Integration guard: refused a production key");
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(key)) {
      throw new Error("Integration guard: refused a production key pattern");
    }
  }
  return key;
}

/** Allocate + register a throwaway key. */
function testKey(suffix: string): string {
  const key = guardKey(`${PREFIX}${suffix}`);
  created.add(key);
  return key;
}

const redis = () => getRedis();

/** Run one of the real Lua scripts, guarding every key first. */
async function runLua(script: string, keys: string[], args: string[]): Promise<string> {
  keys.forEach(guardKey);
  const result = await redis().eval(script, keys, args);
  return String(result);
}

const nowMs = () => Date.now();
const futureMs = (secs = 300) => String(Date.now() + secs * 1000);
const pastMs = () => String(Date.now() - 1000);
const iso = () => new Date().toISOString();

/**
 * Peppered code hash, mirroring lib/password-reset.ts. Recomputed locally rather
 * than imported so this file does not depend on getEnv() validating the whole
 * environment schema.
 */
function codeHashFor(resetId: string, code: string): string {
  const pepper = process.env.JWT_SECRET ?? "";
  return createHmac("sha256", pepper).update(`${resetId}:${code}`, "utf8").digest("hex");
}

const FAKE_RESET_ID = randomBytes(16).toString("hex");
const CORRECT_CODE = "424242";
const WRONG_CODE = "111111";
const MAX_ATTEMPTS = "5";

/** Create a throwaway reset record. */
async function makeResetRecord(
  suffix: string,
  overrides: Record<string, string> = {}
): Promise<string> {
  const key = testKey(suffix);
  await redis().hset(key, {
    state: "pending",
    codeHash: codeHashFor(FAKE_RESET_ID, CORRECT_CODE),
    expiresAtMs: futureMs(),
    attempts: "0",
    username: "itest-user",
    ...overrides,
  });
  await redis().expire(key, 600);
  return key;
}

/** Create a throwaway login-attempt record. */
async function makeAttemptRecord(
  suffix: string,
  overrides: Record<string, string> = {}
): Promise<string> {
  const key = testKey(suffix);
  await redis().hset(key, {
    state: "pending",
    expiresAtMs: futureMs(),
    username: "itest-user",
    ...overrides,
  });
  await redis().expire(key, 600);
  return key;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Fail fast and loudly rather than silently testing nothing.
  const hasUrl = Boolean(
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  );
  const hasToken = Boolean(
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  );
  if (!hasUrl || !hasToken) {
    throw new Error(
      "Real Upstash credentials are not configured; refusing to run the integration check."
    );
  }
  if (!PREFIX.startsWith("__auth_itest__:")) {
    throw new Error("Integration guard: prefix is malformed");
  }

  // Prove the connection works before asserting anything about Lua.
  const probe = testKey("probe");
  await redis().set(probe, "1", { ex: 60 });
  await expect(redis().get(probe)).resolves.toBe(1);
});

afterAll(async () => {
  // Cleanup runs regardless of test outcome.
  const keys = Array.from(created);
  const failures: string[] = [];

  for (const key of keys) {
    try {
      guardKey(key);
      await redis().del(key);
    } catch {
      failures.push(key);
    }
  }

  // Verify deletion.
  for (const key of keys) {
    try {
      const stillThere = await redis().exists(key);
      if (stillThere) failures.push(key);
    } catch {
      failures.push(key);
    }
  }

  if (failures.length > 0) {
    // Key names only — never any value.
    console.error(
      `CLEANUP FAILED for ${failures.length} integration key(s):\n${failures.join("\n")}`
    );
    throw new Error(`Integration cleanup failed for ${failures.length} key(s)`);
  }

  console.log(
    `Integration cleanup verified: ${keys.length} key(s) removed under prefix ${PREFIX}`
  );
});

// ── 1. LUA_VERIFY_RESET_CODE ──────────────────────────────────────────────────

describe("REAL UPSTASH: LUA_VERIFY_RESET_CODE", () => {
  it("A. wrong code returns wrong:<n> and increments attempts", async () => {
    const key = await makeResetRecord("reset-wrong");

    const first = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, WRONG_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );
    expect(first).toBe("wrong:1");
    await expect(redis().hget(key, "attempts")).resolves.toBe(1);
    await expect(redis().hget(key, "state")).resolves.toBe("pending");

    const second = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, WRONG_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );
    expect(second).toBe("wrong:2");
    await expect(redis().hget(key, "attempts")).resolves.toBe(2);
  });

  it("B. correct code transitions pending -> verified and returns ok", async () => {
    const key = await makeResetRecord("reset-correct");

    const result = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );

    expect(result).toBe("ok");
    await expect(redis().hget(key, "state")).resolves.toBe("verified");
    await expect(redis().hget(key, "verifiedAt")).resolves.toBeTruthy();
  });

  it("C. a second verification does not succeed again", async () => {
    const key = await makeResetRecord("reset-double");

    const first = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );
    expect(first).toBe("ok");

    const second = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );

    // The bare state name, NOT "ok" — this is the ambiguity that was fixed.
    expect(second).toBe("verified");
    expect(second).not.toBe("ok");
  });

  it("D. the 5th incorrect attempt transitions pending -> locked", async () => {
    const key = await makeResetRecord("reset-lock");
    const wrongHash = codeHashFor(FAKE_RESET_ID, WRONG_CODE);

    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        await runLua(LUA_VERIFY_RESET_CODE, [key], [wrongHash, String(nowMs()), iso(), MAX_ATTEMPTS])
      );
    }

    expect(results.slice(0, 4)).toEqual(["wrong:1", "wrong:2", "wrong:3", "wrong:4"]);
    expect(results[4]).toBe("locked");

    await expect(redis().hget(key, "state")).resolves.toBe("locked");
    await expect(redis().hget(key, "lockedAt")).resolves.toBeTruthy();
  });

  it("E. the correct code is refused once locked", async () => {
    const key = await makeResetRecord("reset-lock-then-correct");
    const wrongHash = codeHashFor(FAKE_RESET_ID, WRONG_CODE);

    for (let i = 0; i < 5; i += 1) {
      await runLua(LUA_VERIFY_RESET_CODE, [key], [wrongHash, String(nowMs()), iso(), MAX_ATTEMPTS]);
    }

    const result = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );

    expect(result).toBe("locked");
    await expect(redis().hget(key, "state")).resolves.toBe("locked");
  });

  it("F. a logically expired record returns expired and is not mutated", async () => {
    const key = await makeResetRecord("reset-expired", { expiresAtMs: pastMs() });

    const result = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );

    expect(result).toBe("expired");
    await expect(redis().hget(key, "state")).resolves.toBe("pending");
  });

  it("G. an absent record returns missing", async () => {
    const key = testKey("reset-absent");

    const result = await runLua(
      LUA_VERIFY_RESET_CODE,
      [key],
      [codeHashFor(FAKE_RESET_ID, CORRECT_CODE), String(nowMs()), iso(), MAX_ATTEMPTS]
    );

    expect(result).toBe("missing");
  });
});

// ── 2. LUA_TRANSITION_ATTEMPT ─────────────────────────────────────────────────

describe("REAL UPSTASH: LUA_TRANSITION_ATTEMPT", () => {
  it("performs pending -> approved then approved -> consumed", async () => {
    const key = await makeAttemptRecord("attempt-happy");

    const approve = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );
    expect(approve).toBe("ok");
    await expect(redis().hget(key, "state")).resolves.toBe("approved");
    await expect(redis().hget(key, "decidedAt")).resolves.toBeTruthy();

    const consume = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["approved", "consumed", String(nowMs()), "consumedAt", iso()]
    );
    expect(consume).toBe("ok");
    await expect(redis().hget(key, "state")).resolves.toBe("consumed");
    await expect(redis().hget(key, "consumedAt")).resolves.toBeTruthy();
  });

  it("performs pending -> rejected", async () => {
    const key = await makeAttemptRecord("attempt-reject");

    const reject = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "rejected", String(nowMs()), "decidedAt", iso()]
    );

    expect(reject).toBe("ok");
    await expect(redis().hget(key, "state")).resolves.toBe("rejected");
  });

  it("refuses approve after reject, leaving the state unchanged", async () => {
    const key = await makeAttemptRecord("attempt-reject-then-approve");

    await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "rejected", String(nowMs()), "decidedAt", iso()]
    );

    const approve = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );

    // Returns the current state, and performs no write.
    expect(approve).toBe("rejected");
    await expect(redis().hget(key, "state")).resolves.toBe("rejected");
  });

  it("refuses the illegal pending -> consumed shortcut", async () => {
    const key = await makeAttemptRecord("attempt-illegal");

    const result = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["approved", "consumed", String(nowMs()), "consumedAt", iso()]
    );

    // Expected "approved" but found "pending": no transition, no JWT possible.
    expect(result).toBe("pending");
    await expect(redis().hget(key, "state")).resolves.toBe("pending");
    await expect(redis().hget(key, "consumedAt")).resolves.toBeNull();
  });

  it("is idempotent under a repeated approve", async () => {
    const key = await makeAttemptRecord("attempt-idempotent");

    const first = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );
    const second = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [key],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );

    expect(first).toBe("ok");
    expect(second).toBe("approved");
  });

  it("returns expired for a logically expired attempt, and missing when absent", async () => {
    const expiredKey = await makeAttemptRecord("attempt-expired", { expiresAtMs: pastMs() });
    const expired = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [expiredKey],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );
    expect(expired).toBe("expired");
    await expect(redis().hget(expiredKey, "state")).resolves.toBe("pending");

    const absentKey = testKey("attempt-absent");
    const missing = await runLua(
      LUA_TRANSITION_ATTEMPT,
      [absentKey],
      ["pending", "approved", String(nowMs()), "decidedAt", iso()]
    );
    expect(missing).toBe("missing");
  });
});

// ── 3. LUA_CONSUME_RESET_AND_SET_PASSWORD ─────────────────────────────────────

describe("REAL UPSTASH: LUA_CONSUME_RESET_AND_SET_PASSWORD", () => {
  // Fake, non-secret derived material. The real admin password is never involved.
  const FAKE_A = { hash: "a".repeat(128), salt: "b".repeat(32), algo: "scrypt-itest" };
  const FAKE_B = { hash: "c".repeat(128), salt: "d".repeat(32), algo: "scrypt-itest" };

  it("writes the fake admin-auth key and consumes the reset, together", async () => {
    const resetKeyName = await makeResetRecord("consume-ok", { state: "verified" });
    const fakeAuthKey = testKey("admin-auth-ok");

    const result = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );

    expect(result).toBe("ok");

    // Both effects landed.
    await expect(redis().hget(fakeAuthKey, "passwordHash")).resolves.toBe(FAKE_A.hash);
    await expect(redis().hget(fakeAuthKey, "salt")).resolves.toBe(FAKE_A.salt);
    await expect(redis().hget(fakeAuthKey, "algorithm")).resolves.toBe(FAKE_A.algo);
    await expect(redis().hget(fakeAuthKey, "updatedAt")).resolves.toBeTruthy();

    await expect(redis().hget(resetKeyName, "state")).resolves.toBe("consumed");
    await expect(redis().hget(resetKeyName, "consumedAt")).resolves.toBeTruthy();
  });

  it("a second execution cannot overwrite the first material", async () => {
    const resetKeyName = await makeResetRecord("consume-twice", { state: "verified" });
    const fakeAuthKey = testKey("admin-auth-twice");

    const first = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );
    expect(first).toBe("ok");

    const second = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_B.hash, FAKE_B.salt, FAKE_B.algo]
    );

    expect(second).toBe("consumed");
    // The second material was NOT written.
    await expect(redis().hget(fakeAuthKey, "passwordHash")).resolves.toBe(FAKE_A.hash);
    await expect(redis().hget(fakeAuthKey, "salt")).resolves.toBe(FAKE_A.salt);
  });

  it("an unverified reset writes nothing at all", async () => {
    const resetKeyName = await makeResetRecord("consume-pending"); // state: pending
    const fakeAuthKey = testKey("admin-auth-pending");

    const result = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );

    expect(result).toBe("pending");
    // The fake auth key was never created.
    await expect(redis().exists(fakeAuthKey)).resolves.toBe(0);
    await expect(redis().hget(resetKeyName, "state")).resolves.toBe("pending");
  });

  it("a locked reset writes nothing at all", async () => {
    const resetKeyName = await makeResetRecord("consume-locked", { state: "locked" });
    const fakeAuthKey = testKey("admin-auth-locked");

    const result = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );

    expect(result).toBe("locked");
    await expect(redis().exists(fakeAuthKey)).resolves.toBe(0);
  });

  it("an expired verified reset writes nothing at all", async () => {
    const resetKeyName = await makeResetRecord("consume-expired", {
      state: "verified",
      expiresAtMs: pastMs(),
    });
    const fakeAuthKey = testKey("admin-auth-expired");

    const result = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );

    expect(result).toBe("expired");
    await expect(redis().exists(fakeAuthKey)).resolves.toBe(0);
    await expect(redis().hget(resetKeyName, "state")).resolves.toBe("verified");
  });

  it("an absent reset writes nothing at all", async () => {
    const resetKeyName = testKey("consume-absent");
    const fakeAuthKey = testKey("admin-auth-absent");

    const result = await runLua(
      LUA_CONSUME_RESET_AND_SET_PASSWORD,
      [resetKeyName, fakeAuthKey],
      [String(nowMs()), iso(), FAKE_A.hash, FAKE_A.salt, FAKE_A.algo]
    );

    expect(result).toBe("missing");
    await expect(redis().exists(fakeAuthKey)).resolves.toBe(0);
  });
});

// ── 4. Guardrails themselves ──────────────────────────────────────────────────

describe("integration guardrails", () => {
  it("refuses the real admin:auth key", () => {
    expect(() => guardKey("admin:auth")).toThrow(/prefix/i);
  });

  it("refuses ordinary login and reset keys", () => {
    expect(() => guardKey("adminlogin:deadbeefdeadbeefdeadbeefdeadbeef")).toThrow();
    expect(() => guardKey("adminreset:deadbeefdeadbeefdeadbeefdeadbeef")).toThrow();
    expect(() => guardKey("adminreset:cooldown")).toThrow();
    expect(() => guardKey("adminlogin:pending")).toThrow();
  });

  it("refuses production data keys", () => {
    expect(() => guardKey("outline_admin_data")).toThrow();
    expect(() => guardKey("outline_orders")).toThrow();
  });

  it("refuses a correctly-prefixed key from a different run", () => {
    expect(() => guardKey(`__auth_itest__:${randomUUID()}:something`)).toThrow(/different run/i);
  });

  it("accepts only keys in this run's namespace", () => {
    expect(guardKey(`${PREFIX}ok`)).toBe(`${PREFIX}ok`);
  });
});
