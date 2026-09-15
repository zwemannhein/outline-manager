/**
 * Tests for the Cloudflare scheduled cron Worker (outline-cron).
 *
 * The Worker is a trigger only: it POSTs to the Vercel cron endpoint with the
 * shared bearer secret. These tests assert it sends the correct authenticated
 * request and never logs the secret value.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import cronWorker, { type Env } from "../../worker/src/cron";

// Cloudflare Workers ambient types are not in the main tsconfig lib; the Worker
// only uses them structurally, so a minimal local shim keeps the test typed.
type AnyCtx = { waitUntil: (p: Promise<unknown>) => unknown };

const ROLLOVER_URL = "https://outline-manager.vercel.app/api/v1/cron/tick";
const SECRET = "test-cron-secret-value-do-not-log-1234567890";

let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  env = { ROLLOVER_URL, CRON_SECRET: SECRET };
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("outline-cron scheduled Worker", () => {
  it("POSTs to the Vercel cron endpoint with the bearer secret and cloudflare source", async () => {
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as AnyCtx;
    await cronWorker.scheduled({} as never, env, ctx as never);
    // Allow the waitUntil promise to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ROLLOVER_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    // Body identifies the source safely; the Vercel route validates it.
    expect(init.body).toContain("cloudflare-cron");
  });

  it("does not log the secret value on success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as AnyCtx;

    await cronWorker.scheduled({} as never, env, ctx as never);
    await new Promise((r) => setTimeout(r, 0));

    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
    expect(allLogs).not.toContain(SECRET);
  });

  it("does not log the secret value on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { waitUntil: (p: Promise<unknown>) => p } as AnyCtx;

    await cronWorker.scheduled({} as never, env, ctx as never);
    await new Promise((r) => setTimeout(r, 0));

    const allLogs = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
    expect(allLogs).not.toContain(SECRET);
  });

  it("manual fetch trigger requires the bearer secret (fail-closed)", async () => {
    const noAuth = new Request("https://outline-cron.example.dev/", { method: "GET" });
    const res = await cronWorker.fetch(noAuth, env);
    expect(res.status).toBe(404);
    // No cron tick fired without auth.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("manual fetch trigger fires the tick when the correct secret is presented", async () => {
    const authed = new Request("https://outline-cron.example.dev/", {
      method: "GET",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const res = await cronWorker.fetch(authed, env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
