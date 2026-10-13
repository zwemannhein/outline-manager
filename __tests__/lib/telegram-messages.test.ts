import { describe, it, expect } from "vitest";
import { buildPasswordResetText } from "@/lib/telegram";
import { parseCallbackData } from "@/lib/telegram-callback";

const USERNAME = "the-admin-user";

describe("password reset message", () => {
  const CODE = "483921";
  const text = buildPasswordResetText({
    username: USERNAME,
    code: CODE,
    expiresInMinutes: 5,
  });

  it("includes the current admin username so a forgotten username is recoverable", () => {
    expect(text).toContain(USERNAME);
    expect(text).toContain("Username:");
  });

  it("includes a 6-digit reset code", () => {
    expect(text).toContain(CODE);
    const match = text.match(/Reset Code: (\d{6})/);
    expect(match).not.toBeNull();
    expect(match![1]).toHaveLength(6);
  });

  it("states the expiry window and a warning", () => {
    expect(text).toContain("Expires in: 5 minutes");
    expect(text).toContain("ignore this message");
  });

  it("contains no password, hash, salt, or other secret", () => {
    for (const forbidden of ["passwordHash", "salt", "jwt", "browserSecret", "ss://", "certSha256", "apiUrl", "redis"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("carries no inline buttons implied by callback prefixes", () => {
    expect(text).not.toContain("login_approve");
    expect(text).not.toContain("order_approve");
  });
});

describe("order callback routing", () => {
  it("parses current order callbacks", () => {
    expect(parseCallbackData("order_approve:ord_123_abc")).toEqual({
      kind: "order",
      action: "approve",
      id: "ord_123_abc",
    });
    expect(parseCallbackData("order_reject:ord_123_abc")).toEqual({
      kind: "order",
      action: "reject",
      id: "ord_123_abc",
    });
  });

  it("still parses legacy order buttons already sitting in chat history", () => {
    expect(parseCallbackData("approve_ord_1700000000000_abcdef")).toEqual({
      kind: "order",
      action: "approve",
      id: "ord_1700000000000_abcdef",
    });
    expect(parseCallbackData("reject_ord_1700000000000_abcdef")).toEqual({
      kind: "order",
      action: "reject",
      id: "ord_1700000000000_abcdef",
    });
  });

  it("rejects unknown, empty and id-less payloads", () => {
    expect(parseCallbackData("")).toEqual({ kind: "unknown" });
    expect(parseCallbackData("something_else:abc")).toEqual({ kind: "unknown" });
    expect(parseCallbackData("login_approve:old-attempt")).toEqual({ kind: "unknown" });
    expect(parseCallbackData("approve_")).toEqual({ kind: "unknown" });
  });

  it("keeps callback_data inside Telegram's 64-byte limit", () => {
    const orderId = `ord_${Date.now()}_${"a".repeat(16)}`;
    expect(Buffer.byteLength(`order_approve:${orderId}`)).toBeLessThanOrEqual(64);
  });
});
