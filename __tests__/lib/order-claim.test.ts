import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeRedis } from "../helpers/fake-redis";

vi.mock("@/lib/api-utils", () => ({ getRedis: () => fakeRedis }));

import {
  generateClaimToken,
  isValidClaimToken,
  hashClaimToken,
  claimHashEquals,
  issueClaimToken,
  resolveClaimToken,
  revokeClaimToken,
  claimIndexKey,
  CLAIM_TTL_SECONDS,
} from "@/lib/order-claim";

const ORDER_ID = "ord_1700000000000_abcdef0123456789";

beforeEach(() => fakeRedis.reset());

describe("claim token generation", () => {
  it("produces 32 lowercase hex characters (128 bits)", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateClaimToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(isValidClaimToken(token)).toBe(true);
    }
  });

  it("produces distinct values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateClaimToken());
    expect(seen.size).toBe(200);
  });

  it("rejects malformed candidates", () => {
    expect(isValidClaimToken("")).toBe(false);
    expect(isValidClaimToken("abc")).toBe(false);
    expect(isValidClaimToken("A".repeat(32))).toBe(false);
    expect(isValidClaimToken(null)).toBe(false);
  });
});

describe("only the hash is stored", () => {
  it("never persists the raw claim token anywhere", async () => {
    const { claimToken, claimHash } = await issueClaimToken(ORDER_ID);

    expect(claimHash).toMatch(/^[0-9a-f]{64}$/);
    expect(claimHash).not.toBe(claimToken);

    // A Redis dump must not yield a usable claim token.
    const dump = fakeRedis.dumpAll();
    expect(dump).not.toContain(claimToken);
    expect(dump).toContain(claimHash);
  });

  it("indexes by hash, mapping to the order id", async () => {
    const { claimToken, claimHash } = await issueClaimToken(ORDER_ID);
    await expect(fakeRedis.get(claimIndexKey(claimHash))).resolves.toBe(ORDER_ID);
    expect(hashClaimToken(claimToken)).toBe(claimHash);
  });

  it("applies a 30-day TTL", async () => {
    const { claimHash } = await issueClaimToken(ORDER_ID);
    const ttl = await fakeRedis.ttl(claimIndexKey(claimHash));
    expect(ttl).toBeGreaterThan(CLAIM_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(CLAIM_TTL_SECONDS);
  });

  it("compares hashes in constant time and rejects mismatches", () => {
    const a = hashClaimToken("a".repeat(32));
    const b = hashClaimToken("b".repeat(32));
    expect(claimHashEquals(a, a)).toBe(true);
    expect(claimHashEquals(a, b)).toBe(false);
    expect(claimHashEquals(a, "short")).toBe(false);
  });
});

describe("resolution", () => {
  it("resolves a valid token to its order", async () => {
    const { claimToken } = await issueClaimToken(ORDER_ID);
    await expect(resolveClaimToken(claimToken)).resolves.toBe(ORDER_ID);
  });

  it("returns null for unknown, malformed and expired tokens alike", async () => {
    await expect(resolveClaimToken("f".repeat(32))).resolves.toBeNull();
    await expect(resolveClaimToken("nope")).resolves.toBeNull();
    await expect(resolveClaimToken("")).resolves.toBeNull();

    const { claimToken, claimHash } = await issueClaimToken(ORDER_ID);
    fakeRedis.forceEvict(claimIndexKey(claimHash));
    await expect(resolveClaimToken(claimToken)).resolves.toBeNull();
  });

  it("does not resolve a token whose order id is not what was issued", async () => {
    await issueClaimToken(ORDER_ID);
    // Guessing the order id gets you nothing: it is not the credential.
    await expect(resolveClaimToken(ORDER_ID.replace(/[^0-9a-f]/g, "").slice(0, 32))).resolves.toBeNull();
  });

  it("issues independent tokens for different orders", async () => {
    const a = await issueClaimToken("ord_a");
    const b = await issueClaimToken("ord_b");

    expect(a.claimToken).not.toBe(b.claimToken);
    await expect(resolveClaimToken(a.claimToken)).resolves.toBe("ord_a");
    await expect(resolveClaimToken(b.claimToken)).resolves.toBe("ord_b");
  });
});

describe("revocation", () => {
  it("invalidates a leaked claim link", async () => {
    const { claimToken, claimHash } = await issueClaimToken(ORDER_ID);
    await revokeClaimToken(claimHash);
    await expect(resolveClaimToken(claimToken)).resolves.toBeNull();
  });

  it("tolerates revoking an unknown hash", async () => {
    await expect(revokeClaimToken("")).resolves.toBeUndefined();
    await expect(revokeClaimToken("0".repeat(64))).resolves.toBeUndefined();
  });
});

describe("separation from the VPN credential", () => {
  it("a claim token is not a dynamic token and vice versa", async () => {
    const { claimToken } = await issueClaimToken(ORDER_ID);

    // Both are 32 hex, but they live in different namespaces and neither can be
    // used in the other's place.
    await expect(fakeRedis.get(`dynamic:${claimToken}`)).resolves.toBeNull();
    await expect(resolveClaimToken("0".repeat(32))).resolves.toBeNull();
  });
});
