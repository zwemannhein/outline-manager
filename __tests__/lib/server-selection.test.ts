import { describe, expect, it } from "vitest";
import {
  resolveServerSelection,
  resolveSelectionAfterRemoval,
} from "@/lib/server-selection";
import type { OutlineServer } from "@/lib/types";

const servers = ["one", "two", "three"].map((id) => ({
  id,
  name: id,
  apiUrl: `https://example.com/${id}`,
  certSha256: id.repeat(16),
  addedAt: 1,
})) satisfies OutlineServer[];

describe("server selection stability", () => {
  it("preserves a valid selection across a harmless refetch", () => {
    expect(resolveServerSelection("two", [...servers])).toBe("two");
  });

  it("selects the first server predictably when no selection exists", () => {
    expect(resolveServerSelection("", servers)).toBe("one");
  });

  it("falls back safely when the selected server disappears", () => {
    expect(resolveServerSelection("missing", servers)).toBe("one");
    expect(resolveServerSelection("missing", [])).toBe("");
  });

  it("selects the next nearby server after deleting the active server", () => {
    expect(resolveSelectionAfterRemoval("two", "two", servers, [servers[0], servers[2]])).toBe("three");
    expect(resolveSelectionAfterRemoval("three", "three", servers, servers.slice(0, 2))).toBe("two");
  });
});
