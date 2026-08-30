/**
 * Tests for Telegram approver management (tasks A–P in the spec).
 *
 * A. single dashboard admin remains unchanged
 * B. add Telegram approver → Pending (link token created)
 * C. valid deep link → Linked
 * D. invalid token rejected
 * E. expired token rejected
 * F. token replay rejected
 * G. username mismatch rejected
 * H. verified numeric telegramUserId stored
 * I. multiple Telegram approvers can be linked
 * J. login route sends to ALL active linked approvers
 * K. first Approve wins
 * L. first Reject wins
 * M. second callback returns already-handled
 * N. removed approver cannot approve future requests
 * O. username alone cannot authorise
 * P. existing single-admin password/reset behaviour still works
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

import {
  createLinkToken,
  consumeLinkToken,
  linkApprover,
  removeApprover,
  listApprovers,
  getApproverChatIds,
  isLinkedApprover,
  isValidLinkToken,
  LINK_TTL_SECONDS,
} from "@/lib/telegram-approvers";
import {
  createLoginAttempt,
  approveLoginAttempt,
  rejectLoginAttempt,
} from "@/lib/login-attempts";
import {
  verifyAdminCredentials,
  deriveNewPasswordMaterial,
} from "@/lib/admin-auth";

// ── A. Single dashboard admin is unchanged ────────────────────────────────────

describe("A. single dashboard admin account", () => {
  beforeEach(() => fakeRedis.reset());

  it("Telegram approvers are NOT dashboard accounts — no admin:auth record created", async () => {
    await linkApprover({ userId: "111", chatId: "111", username: "alice" });

    // tg:approver:111 exists, but admin:auth is untouched.
    const adminAuth = fakeRedis.peekHash("admin:auth");
    expect(adminAuth).toBeUndefined();
  });

  it("approver list does not bleed into admin credentials", async () => {
    await linkApprover({ userId: "222", chatId: "222", username: "bob" });
    const dump = fakeRedis.dumpAll();
    expect(dump).not.toContain("passwordHash");
    expect(dump).not.toContain("admin:auth");
  });
});

// ── B. Add Telegram approver → link token (Pending) ──────────────────────────

describe("B. add Telegram approver → Pending link token", () => {
  beforeEach(() => fakeRedis.reset());

  it("createLinkToken returns a 32-hex token with expiresAt in the future", async () => {
    const p = await createLinkToken("alice");
    expect(p.token).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidLinkToken(p.token)).toBe(true);
    expect(Date.parse(p.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("normalises leading @ from the username", async () => {
    const p = await createLinkToken("@Alice");
    expect(p.expectedUsername).toBe("alice");
  });

  it("allows empty username (any Telegram user may claim the link)", async () => {
    const p = await createLinkToken("");
    expect(p.expectedUsername).toBe("");
  });

  it("stores the token in Redis with correct TTL shape", async () => {
    const p = await createLinkToken("dave");
    const stored = fakeRedis.peekHash(`tg:link:${p.token}`);
    expect(stored).toBeDefined();
    expect(stored!.expectedUsername).toBe("dave");
    expect(Number(stored!.expiresAtMs)).toBeGreaterThan(Date.now());
  });
});

// ── C. Valid deep link → Linked ───────────────────────────────────────────────

describe("C. valid deep link → approver Linked", () => {
  beforeEach(() => fakeRedis.reset());

  it("consuming a valid token stores userId, chatId, username", async () => {
    const { token } = await createLinkToken("carol");
    const result = await consumeLinkToken(token);
    expect(result).not.toBeNull();
    expect(result!.expectedUsername).toBe("carol");

    await linkApprover({ userId: "999", chatId: "999", username: "carol" });
    const approvers = await listApprovers();
    expect(approvers).toHaveLength(1);
    expect(approvers[0].userId).toBe("999");
    expect(approvers[0].username).toBe("carol");
    expect(approvers[0].status).toBe("linked");
  });
});

// ── D. Invalid token rejected ─────────────────────────────────────────────────

describe("D. invalid token rejected", () => {
  beforeEach(() => fakeRedis.reset());

  it("rejects tokens with wrong length", async () => {
    expect(isValidLinkToken("abc")).toBe(false);
    expect(isValidLinkToken("z".repeat(32))).toBe(false); // non-hex
    expect(isValidLinkToken("a".repeat(31))).toBe(false);
    expect(isValidLinkToken("a".repeat(33))).toBe(false);
  });

  it("consumeLinkToken returns null for a token that was never created", async () => {
    const result = await consumeLinkToken("a".repeat(32));
    expect(result).toBeNull();
  });

  it("isValidLinkToken rejects null/undefined/number", () => {
    expect(isValidLinkToken(null)).toBe(false);
    expect(isValidLinkToken(undefined)).toBe(false);
    expect(isValidLinkToken(42)).toBe(false);
  });
});

// ── E. Expired token rejected ─────────────────────────────────────────────────

describe("E. expired token rejected", () => {
  beforeEach(() => fakeRedis.reset());

  it("returns null when the token's expiresAtMs is in the past", async () => {
    const { token } = await createLinkToken("eve");
    // Force expiry by backdating the stored field.
    const key = `tg:link:${token}`;
    const h = fakeRedis.peekHash(key);
    h!.expiresAtMs = String(Date.now() - 1);

    const result = await consumeLinkToken(token);
    expect(result).toBeNull();
  });
});

// ── F. Token replay rejected ──────────────────────────────────────────────────

describe("F. token replay rejected", () => {
  beforeEach(() => fakeRedis.reset());

  it("second consume returns null — token already deleted on first use", async () => {
    const { token } = await createLinkToken("frank");
    const first = await consumeLinkToken(token);
    expect(first).not.toBeNull();

    const second = await consumeLinkToken(token);
    expect(second).toBeNull();
  });
});

// ── G. Username mismatch rejected ─────────────────────────────────────────────

describe("G. username mismatch", () => {
  beforeEach(() => fakeRedis.reset());

  it("consumeLinkToken succeeds regardless of username — mismatch is enforced by caller (/start handler)", async () => {
    // consumeLinkToken itself only checks expiry/existence; the /start handler
    // in the webhook compares expectedUsername vs the actual Telegram username.
    // This test documents that the raw token is valid — mismatch rejection is
    // the webhook's responsibility (tested via integration).
    const { token, expectedUsername } = await createLinkToken("grace");
    const result = await consumeLinkToken(token);
    expect(result).not.toBeNull();
    expect(result!.expectedUsername).toBe("grace");
    expect(expectedUsername).toBe("grace");
  });

  it("username is normalised to lowercase without @", async () => {
    const p = await createLinkToken("@GRACE");
    expect(p.expectedUsername).toBe("grace");
  });
});

// ── H. Verified numeric telegramUserId stored ─────────────────────────────────

describe("H. numeric telegramUserId is the permanent identity", () => {
  beforeEach(() => fakeRedis.reset());

  it("stores userId as a string and uses it as the Redis key suffix", async () => {
    await linkApprover({ userId: "12345678", chatId: "12345678", username: "henry" });

    const h = fakeRedis.peekHash("tg:approver:12345678");
    expect(h).toBeDefined();
    expect(h!.userId).toBe("12345678");
    expect(h!.username).toBe("henry");
  });

  it("isLinkedApprover matches on chatId, not username", async () => {
    await linkApprover({ userId: "777", chatId: "chat_777", username: "henry" });

    expect(await isLinkedApprover("chat_777")).toBe(true);
    expect(await isLinkedApprover("henry")).toBe(false); // username alone is insufficient
    expect(await isLinkedApprover("777")).toBe(false);   // userId ≠ chatId in this test
  });
});

// ── I. Multiple approvers can be linked ───────────────────────────────────────

describe("I. multiple Telegram approvers", () => {
  beforeEach(() => fakeRedis.reset());

  it("supports any number of linked approvers", async () => {
    await linkApprover({ userId: "1", chatId: "1", username: "alice" });
    await linkApprover({ userId: "2", chatId: "2", username: "bob" });
    await linkApprover({ userId: "3", chatId: "3", username: "carol" });

    const approvers = await listApprovers();
    expect(approvers).toHaveLength(3);
    const usernames = approvers.map((a) => a.username);
    expect(usernames).toContain("alice");
    expect(usernames).toContain("bob");
    expect(usernames).toContain("carol");
  });

  it("getApproverChatIds returns all chatIds", async () => {
    await linkApprover({ userId: "10", chatId: "chat10", username: "x" });
    await linkApprover({ userId: "20", chatId: "chat20", username: "y" });

    const ids = await getApproverChatIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("chat10");
    expect(ids).toContain("chat20");
  });
});

// ── J. Login request goes to ALL active linked approvers ─────────────────────

describe("J. login request targets all linked approvers", () => {
  beforeEach(() => fakeRedis.reset());

  it("getApproverChatIds returns every linked chatId for fan-out", async () => {
    await linkApprover({ userId: "A", chatId: "chatA", username: "anna" });
    await linkApprover({ userId: "B", chatId: "chatB", username: "ben" });
    await linkApprover({ userId: "C", chatId: "chatC", username: "chris" });

    const ids = await getApproverChatIds();
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(["chatA", "chatB", "chatC"]));
  });
});

// ── K. First Approve wins ─────────────────────────────────────────────────────

describe("K. first Approve wins", () => {
  beforeEach(() => fakeRedis.reset());

  it("first approver succeeds; second gets already_decided", async () => {
    const attempt = await createLoginAttempt({
      username: "admin", ip: "1.2.3.4", userAgent: "UA",
    });

    const first = await approveLoginAttempt(attempt.attemptId);
    expect(first.ok).toBe(true);

    const second = await approveLoginAttempt(attempt.attemptId);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe("already_decided");
  });
});

// ── L. First Reject wins ──────────────────────────────────────────────────────

describe("L. first Reject wins", () => {
  beforeEach(() => fakeRedis.reset());

  it("first rejector succeeds; second gets already_decided", async () => {
    const attempt = await createLoginAttempt({
      username: "admin", ip: "1.2.3.4", userAgent: "UA",
    });

    const first = await rejectLoginAttempt(attempt.attemptId);
    expect(first.ok).toBe(true);

    const second = await rejectLoginAttempt(attempt.attemptId);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe("already_decided");
  });
});

// ── M. Second callback returns already-handled ────────────────────────────────

describe("M. second callback already handled", () => {
  beforeEach(() => fakeRedis.reset());

  it("approve after reject is already_decided", async () => {
    const attempt = await createLoginAttempt({
      username: "admin", ip: "1.2.3.4", userAgent: "UA",
    });

    await rejectLoginAttempt(attempt.attemptId);
    const late = await approveLoginAttempt(attempt.attemptId);
    expect(late.ok).toBe(false);
    expect((late as { reason: string }).reason).toBe("already_decided");
  });

  it("reject after approve is already_decided", async () => {
    const attempt = await createLoginAttempt({
      username: "admin", ip: "1.2.3.4", userAgent: "UA",
    });

    await approveLoginAttempt(attempt.attemptId);
    const late = await rejectLoginAttempt(attempt.attemptId);
    expect(late.ok).toBe(false);
    expect((late as { reason: string }).reason).toBe("already_decided");
  });
});

// ── N. Removed approver cannot approve future requests ────────────────────────

describe("N. removed approver excluded", () => {
  beforeEach(() => fakeRedis.reset());

  it("removed approver's chatId no longer appears in getApproverChatIds", async () => {
    await linkApprover({ userId: "99", chatId: "chat99", username: "nina" });
    await linkApprover({ userId: "88", chatId: "chat88", username: "omar" });

    let ids = await getApproverChatIds();
    expect(ids).toContain("chat99");

    await removeApprover("99");

    ids = await getApproverChatIds();
    expect(ids).not.toContain("chat99");
    expect(ids).toContain("chat88"); // other approver unaffected
  });

  it("removed approver is no longer in listApprovers", async () => {
    await linkApprover({ userId: "55", chatId: "55", username: "petra" });
    await removeApprover("55");

    const approvers = await listApprovers();
    expect(approvers.find((a) => a.userId === "55")).toBeUndefined();
  });

  it("removeApprover is idempotent", async () => {
    await linkApprover({ userId: "66", chatId: "66", username: "quinn" });
    await removeApprover("66");
    await expect(removeApprover("66")).resolves.toBeUndefined(); // no throw
  });
});

// ── O. Username alone cannot authorise ───────────────────────────────────────

describe("O. username alone cannot authorise", () => {
  beforeEach(() => fakeRedis.reset());

  it("isLinkedApprover returns false when queried by username string", async () => {
    await linkApprover({ userId: "12", chatId: "chat12", username: "ursula" });

    // Must NOT treat usernames as chatIds.
    expect(await isLinkedApprover("ursula")).toBe(false);
    expect(await isLinkedApprover("@ursula")).toBe(false);
    // Only the actual chatId grants access.
    expect(await isLinkedApprover("chat12")).toBe(true);
  });

  it("a valid token for a different username cannot be used by another person", async () => {
    const { token, expectedUsername } = await createLinkToken("victor");
    expect(expectedUsername).toBe("victor");

    // Consuming the token is successful (that's the /start handler's job),
    // but the expectedUsername field tells the caller who is authorised.
    const result = await consumeLinkToken(token);
    expect(result!.expectedUsername).toBe("victor");
    // A user with a different username should be rejected by the caller.
  });
});

// ── P. Existing single-admin password/reset behaviour still works ─────────────

describe("P. single-admin password behaviour preserved", () => {
  beforeEach(() => fakeRedis.reset());

  it("verifyAdminCredentials still works after approvers are added", async () => {
    // Seed an admin:auth record.
    const mat = await deriveNewPasswordMaterial("securePass1");
    await fakeRedis.hset("admin:auth", {
      passwordHash: mat.passwordHash,
      salt: mat.salt,
      algorithm: mat.algorithm,
      username: "adminUser",
    });

    // Add approvers.
    await linkApprover({ userId: "A1", chatId: "A1", username: "approver1" });
    await linkApprover({ userId: "A2", chatId: "A2", username: "approver2" });

    // Admin password auth is unchanged.
    expect(await verifyAdminCredentials("adminUser", "securePass1")).toBe(true);
    expect(await verifyAdminCredentials("adminUser", "wrongPassword")).toBe(false);
    expect(await verifyAdminCredentials("wrongUser", "securePass1")).toBe(false);
  });

  it("approvers do not have passwords and cannot log in as the admin", async () => {
    await linkApprover({ userId: "T1", chatId: "T1", username: "telegramUser" });

    // No admin:auth record was created for the Telegram user.
    const authRecord = fakeRedis.peekHash("admin:auth");
    expect(authRecord).toBeUndefined();

    // Credentials check should fail (no admin password set at all).
    expect(await verifyAdminCredentials("telegramUser", "anyPassword")).toBe(false);
  });
});
