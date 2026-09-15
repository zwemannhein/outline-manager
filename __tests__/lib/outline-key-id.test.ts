import { describe, expect, it } from "vitest";
import {
  normalizeOutlineKeyId,
  outlineKeyIdSet,
} from "@/lib/outline-key-id";

describe("Outline key ID normalization", () => {
  it("matches numeric runtime IDs to persisted string IDs", () => {
    const ids = outlineKeyIdSet([{ id: 30 }, { id: "alpha" }]);

    expect(ids.has("30")).toBe(true);
    expect(ids.has("alpha")).toBe(true);
    expect(ids.has(normalizeOutlineKeyId("30"))).toBe(true);
  });
});
