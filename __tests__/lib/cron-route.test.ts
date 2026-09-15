/**
 * Tests for the cron tick route's authentication (fail-closed) and safe
 * trigger-source derivation.
 *
 * The heavy lifting (expiry/rollover/drain) is mocked — these tests focus on
 * the auth gate and source derivation, which are the security-relevant parts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const processExpiries = vi.fn(async () => ({ due: 0, expired: 0, skipped: 0, failed: 0 }));
const processCycleRollovers = vi.fn(async () => ({ due: 0, rolled: 0, skippedExpired: 0, skippedExhausted: 0, failed: 0 }));
const drainDirtyDynamicRecords = vi.fn(async () => ({ attempted: 0, synced: 0, deleted: 0, failed: 0, remaining: 0 }));
const writeCronSummary = vi.fn(async () => {});

vi.mock("@/lib/quota-cycles", () => ({ processExpiries, processCycleRollovers }));
vi.mock("@/lib/kv-sync", () => ({ drainDirtyDynamicRecords }));
vi.mock("@/lib/monitoring", () => ({
  writeCronSummary,
  // deriveSource in the route only uses the type import; keep normalize available.
  normalizeCronSource: (h: unknown) =>
    h === "cloudflare" || h === "vercel" || h === "manual" ? h : "unknown",
}));

const SECRET = "unit-test-cron-secret-abcdef0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

async function loadRoute() {
  return await import("@/app/api/v1/cron/tick/route");
}

function makeReq(headers: Record<string, string>, body?: string): Request {
  return new Request("https://outline-manager.vercel.app/api/v1/cron/tick", {
    method: "POST",
    headers,
    body,
  });
}

describe("cron route authentication (fail-closed)", () => {
  it("returns 404 with no Authorization header", async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq({}) as never);
    expect(res.status).toBe(404);
    expect(processExpiries).not.toHaveBeenCalled();
  });

  it("returns 404 with a wrong bearer secret", async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ Authorization: "Bearer wrong-secret" }) as never);
    expect(res.status).toBe(404);
    expect(processExpiries).not.toHaveBeenCalled();
  });

  it("returns 404 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ Authorization: `Bearer ${SECRET}` }) as never);
    expect(res.status).toBe(404);
    process.env.CRON_SECRET = SECRET;
  });

  it("runs the tick with the correct bearer secret", async () => {
    const { POST } = await loadRoute();
    const res = await POST(makeReq({ Authorization: `Bearer ${SECRET}` }) as never);
    expect(res.status).toBe(200);
    expect(processExpiries).toHaveBeenCalledTimes(1);
    expect(writeCronSummary).toHaveBeenCalledTimes(1);
  });
});

describe("cron route trigger-source derivation", () => {
  function lastSource(): string {
    const calls = writeCronSummary.mock.calls as unknown as Array<[{ source: string }]>;
    return calls[calls.length - 1][0].source;
  }

  it("labels a Vercel cron signature as vercel", async () => {
    const { POST } = await loadRoute();
    await POST(makeReq({
      Authorization: `Bearer ${SECRET}`,
      "x-vercel-cron-signature": SECRET,
    }) as never);
    expect(lastSource()).toBe("vercel");
  });

  it("labels the cloudflare-cron body as cloudflare", async () => {
    const { POST } = await loadRoute();
    await POST(makeReq(
      { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      JSON.stringify({ source: "cloudflare-cron" })
    ) as never);
    expect(lastSource()).toBe("cloudflare");
  });

  it("labels an unknown/empty body as manual", async () => {
    const { POST } = await loadRoute();
    await POST(makeReq({ Authorization: `Bearer ${SECRET}` }) as never);
    expect(lastSource()).toBe("manual");
  });

  it("does not label an invalid Vercel signature as vercel when bearer auth succeeds", async () => {
    const { POST } = await loadRoute();
    await POST(makeReq({
      Authorization: `Bearer ${SECRET}`,
      "x-vercel-cron-signature": "invalid-signature",
    }) as never);
    expect(lastSource()).toBe("manual");
  });

  it("does not trust an arbitrary source string in the body", async () => {
    const { POST } = await loadRoute();
    await POST(makeReq(
      { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      JSON.stringify({ source: "cloudflare" }) // not the exact cloudflare-cron literal
    ) as never);
    expect(lastSource()).toBe("manual");
  });
});
