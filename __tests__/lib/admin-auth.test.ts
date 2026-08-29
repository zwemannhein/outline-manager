import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

const BOOTSTRAP_PASSWORD = "bootstrap-pass-123";
const BOOTSTRAP_USERNAME = "bootstrap-admin";

vi.mock("@/lib/api-utils", () => ({
  getRedis: () => fakeRedis,
}));

vi.mock("@/lib/validation", () => ({
  getEnv: () => ({
    ADMIN_USERNAME: BOOTSTRAP_USERNAME,
    ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  }),
}));

import {
  hashPassword,
  deriveNewPasswordMaterial,
  verifyPassword,
  setAdminPassword,
  verifyAdminPassword,
  verifyAdminCredentials,
  getCurrentAdminUsername,
  getCurrentAdminPasswordState,
  isBootstrapPasswordInUse,
  readAdminAuthRecord,
  ADMIN_AUTH_KEY,
} from "@/lib/admin-auth";

describe("admin-auth password hashing", () => {
  beforeEach(() => fakeRedis.reset());

  it("produces a different salt and hash each time for the same password", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");

    expect(a.salt).not.toBe(b.salt);
    expect(a.passwordHash).not.toBe(b.passwordHash);
    expect(a.algorithm).toBe("scrypt");
  });

  it("never returns the plaintext password in the hash output", async () => {
    const secret = "plaintext-should-not-appear";
    const { passwordHash, salt } = await hashPassword(secret);

    expect(passwordHash).not.toContain(secret);
    expect(salt).not.toContain(secret);
    expect(passwordHash).toMatch(/^[0-9a-f]{128}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("verifies a correct password and rejects an incorrect one", async () => {
    const { passwordHash, salt } = await hashPassword("correct-horse");

    await expect(verifyPassword("correct-horse", passwordHash, salt)).resolves.toBe(true);
    await expect(verifyPassword("wrong-horse", passwordHash, salt)).resolves.toBe(false);
    await expect(verifyPassword("", passwordHash, salt)).resolves.toBe(false);
  });

  it("rejects gracefully when the stored material is malformed", async () => {
    await expect(verifyPassword("anything", "not-hex", "also-not-hex")).resolves.toBe(false);
  });
});

describe("admin-auth bootstrap vs redis authority", () => {
  beforeEach(() => fakeRedis.reset());

  it("uses the environment password when admin:auth does not exist", async () => {
    expect(await readAdminAuthRecord()).toBeNull();

    const state = await getCurrentAdminPasswordState();
    expect(state.source).toBe("env");

    await expect(verifyAdminPassword(BOOTSTRAP_PASSWORD)).resolves.toBe(true);
    await expect(verifyAdminPassword("something-else")).resolves.toBe(false);
  });

  it("ignores the environment password once admin:auth exists", async () => {
    await setAdminPassword("brand-new-password");

    const state = await getCurrentAdminPasswordState();
    expect(state.source).toBe("redis");

    // The new password is authoritative...
    await expect(verifyAdminPassword("brand-new-password")).resolves.toBe(true);
    // ...and the old environment password stops working immediately.
    await expect(verifyAdminPassword(BOOTSTRAP_PASSWORD)).resolves.toBe(false);
  });

  it("stores only a hash and salt, never the plaintext password", async () => {
    const plaintext = "never-store-me-raw";
    await setAdminPassword(plaintext);

    const stored = fakeRedis.peekHash(ADMIN_AUTH_KEY);
    expect(stored).toBeDefined();
    expect(stored!.passwordHash).toBeDefined();
    expect(stored!.salt).toBeDefined();

    // Nothing anywhere in Redis contains the plaintext.
    expect(fakeRedis.dumpAll()).not.toContain(plaintext);
  });

  it("rejects a new password below the minimum length", async () => {
    await expect(setAdminPassword("short")).rejects.toThrow(/at least 8/i);
  });

  it("supports changing the password more than once", async () => {
    await setAdminPassword("first-password-1");
    await setAdminPassword("second-password-2");

    await expect(verifyAdminPassword("second-password-2")).resolves.toBe(true);
    await expect(verifyAdminPassword("first-password-1")).resolves.toBe(false);
  });
});

describe("admin-auth username resolution", () => {
  beforeEach(() => fakeRedis.reset());

  it("falls back to the environment username", async () => {
    await expect(getCurrentAdminUsername()).resolves.toBe(BOOTSTRAP_USERNAME);
  });

  it("prefers a runtime username stored on admin:auth", async () => {
    await fakeRedis.hset(ADMIN_AUTH_KEY, { username: "runtime-admin" });
    await expect(getCurrentAdminUsername()).resolves.toBe("runtime-admin");
  });

  it("requires both username and password to be correct", async () => {
    await setAdminPassword("pair-password-1");

    await expect(verifyAdminCredentials(BOOTSTRAP_USERNAME, "pair-password-1")).resolves.toBe(true);
    await expect(verifyAdminCredentials("wrong-user", "pair-password-1")).resolves.toBe(false);
    await expect(verifyAdminCredentials(BOOTSTRAP_USERNAME, "wrong-pass")).resolves.toBe(false);
  });
});

describe("first-run forced password change", () => {
  beforeEach(() => fakeRedis.reset());

  it("reports the bootstrap password as in use before any runtime password exists", async () => {
    await expect(isBootstrapPasswordInUse()).resolves.toBe(true);

    const state = await getCurrentAdminPasswordState();
    expect(state.source).toBe("env");
    // This is the flag the dashboard uses to force first-run setup.
    expect(state.source !== "redis").toBe(true);
  });

  it("stops reporting bootstrap once the first runtime password is set", async () => {
    await setAdminPassword("first-runtime-password");

    await expect(isBootstrapPasswordInUse()).resolves.toBe(false);
    const state = await getCurrentAdminPasswordState();
    expect(state.source).toBe("redis");
    expect(state.updatedAt).toBeTruthy();
  });

  it("creates the admin:auth record on first setup", async () => {
    expect(fakeRedis.peekHash(ADMIN_AUTH_KEY)).toBeUndefined();

    await setAdminPassword("first-runtime-password");

    const stored = fakeRedis.peekHash(ADMIN_AUTH_KEY)!;
    expect(stored.passwordHash).toMatch(/^[0-9a-f]{128}$/);
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.algorithm).toBe("scrypt");
  });

  it("makes the old environment password fail immediately afterwards", async () => {
    // Bootstrap works first.
    await expect(verifyAdminPassword(BOOTSTRAP_PASSWORD)).resolves.toBe(true);

    await setAdminPassword("first-runtime-password");

    // Environment password is now dead, with no hosting config change needed.
    await expect(verifyAdminPassword(BOOTSTRAP_PASSWORD)).resolves.toBe(false);
    await expect(verifyAdminPassword("first-runtime-password")).resolves.toBe(true);
  });

  it("does not require setup again on subsequent logins", async () => {
    await setAdminPassword("first-runtime-password");

    // Simulates a later session performing the same server-side check.
    for (let i = 0; i < 3; i += 1) {
      await expect(isBootstrapPasswordInUse()).resolves.toBe(false);
      const state = await getCurrentAdminPasswordState();
      expect(state.source).toBe("redis");
    }
  });

  it("still requires the length policy during first-run setup", async () => {
    await expect(setAdminPassword("tiny")).rejects.toThrow(/at least 8/i);
    // Nothing was written, so setup is still outstanding.
    await expect(isBootstrapPasswordInUse()).resolves.toBe(true);
  });
});

describe("derived material for atomic writes", () => {
  it("enforces the length policy before deriving", async () => {
    await expect(deriveNewPasswordMaterial("short")).rejects.toThrow(/at least 8/i);
  });

  it("returns hex hash, hex salt and the algorithm name", async () => {
    const material = await deriveNewPasswordMaterial("long-enough-password");

    expect(material.passwordHash).toMatch(/^[0-9a-f]{128}$/);
    expect(material.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(material.algorithm).toBe("scrypt");
    // The plaintext is not recoverable from what crosses the Redis boundary.
    expect(JSON.stringify(material)).not.toContain("long-enough-password");
  });

  it("verifies against material derived separately", async () => {
    const material = await deriveNewPasswordMaterial("atomic-write-password");

    await expect(
      verifyPassword("atomic-write-password", material.passwordHash, material.salt)
    ).resolves.toBe(true);
    await expect(
      verifyPassword("wrong-password", material.passwordHash, material.salt)
    ).resolves.toBe(false);
  });
});
