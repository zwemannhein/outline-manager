import { Writable } from "stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS, SENSITIVE_FIELDS } from "@/lib/logger";

describe("Telegram log redaction", () => {
  it("classifies Telegram identities and bindings as sensitive fields", () => {
    expect(SENSITIVE_FIELDS).toEqual(expect.arrayContaining([
      "userId",
      "telegramUserId",
      "chatId",
      "incomingChatId",
      "targetUserId",
      "token",
    ]));
  });

  it("redacts Telegram IDs and tokens before serialization", () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const testLogger = pino({
      base: undefined,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    }, stream);

    testLogger.info({
      userId: "123456789",
      chatId: "987654321",
      token: "a".repeat(32),
      event: "telegram_callback",
    });

    expect(output).toContain("telegram_callback");
    expect(output).not.toContain("123456789");
    expect(output).not.toContain("987654321");
    expect(output).not.toContain("a".repeat(32));
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(3);
  });
});
