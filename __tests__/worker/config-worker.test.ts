/**
 * Tests for the public Cloudflare config Worker.
 *
 * The Worker is the only unauthenticated surface in the system, so the properties
 * asserted here matter most: uniform failure responses, no caching, and never
 * returning a config for a customer who should be blocked.
 */

import { describe, it, expect, beforeEach } from "vitest";
import worker, {
  withFragment,
  type Env,
  type KvReadNamespace,
} from "../../worker/src/index";

interface StoredProjection {
  accessUrl?: string;
  status?: string;
  rev?: number;
  updatedAt?: string;
  name?: string;
}

/** Minimal KVNamespace double supporting the get(type:"json") form used. */
function makeKv(entries: Record<string, StoredProjection> = {}) {
  const store = new Map<string, StoredProjection>(Object.entries(entries));
  return {
    store,
    throwOnGet: false,
    async get(key: string) {
      if (this.throwOnGet) throw new Error("kv unavailable");
      return store.get(key) ?? null;
    },
  };
}

const TOKEN = "8f3a1c9e7b42d6f0a51e9c34b287de61";
const ACCESS_URL = "ss://Y2hhY2hhMjA6cGFzc3dvcmQ=@13.229.101.58:10620/?outline=1";

let kv: ReturnType<typeof makeKv>;
let env: Env;

function req(path: string, method = "GET"): Request {
  return new Request(`https://outline-config.example.dev${path}`, { method });
}

beforeEach(() => {
  kv = makeKv();
  env = { DYN: kv as unknown as KvReadNamespace };
});

describe("health endpoint", () => {
  it("returns ok without touching KV", async () => {
    const res = await worker.fetch(req("/health"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // No KV read means no consumption of the free-tier read quota.
    expect(kv.store.size).toBe(0);
  });

  it("is not cached", async () => {
    const res = await worker.fetch(req("/health"), env);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("resolving an active key", () => {
  beforeEach(() => {
    kv.store.set(`dyn:${TOKEN}`, {
      accessUrl: ACCESS_URL,
      status: "active",
      rev: 3,
      updatedAt: "now",
    });
  });

  it("returns the stored ss:// URL verbatim", async () => {
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    expect(res.status).toBe(200);
    // Byte-for-byte: base64 userinfo and the query string must not be rewritten.
    expect(await res.text()).toBe(ACCESS_URL);
  });

  it("serves plain text and forbids caching", async () => {
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    // no-store is what lets a migration or disable propagate promptly.
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not leak internal metadata", async () => {
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    const body = await res.text();
    expect(body).not.toContain("rev");
    expect(body).not.toContain("status");
    expect(body).not.toContain("updatedAt");
  });

  it("leaves the inner fragment untouched by default", async () => {
    kv.store.set(`dyn:${TOKEN}`, {
      accessUrl: ACCESS_URL,
      status: "active",
      name: "Ko Aung",
    });
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    // The name lives in the OUTER ssconf fragment, which never reaches the Worker.
    expect(await res.text()).toBe(ACCESS_URL);
  });

  it("rewrites the inner fragment only when explicitly enabled", async () => {
    kv.store.set(`dyn:${TOKEN}`, {
      accessUrl: ACCESS_URL,
      status: "active",
      name: "Ko Aung",
    });
    const res = await worker.fetch(req(`/k/${TOKEN}`), {
      ...env,
      DYNAMIC_KEY_INNER_FRAGMENT: "true",
    });
    expect(await res.text()).toBe(`${ACCESS_URL}#Ko%20Aung`);
  });
});

describe("every failure is indistinguishable", () => {
  const cases: Array<[string, string]> = [
    ["unknown token", `/k/${"f".repeat(32)}`],
    ["malformed token", "/k/nope"],
    ["too short", `/k/${"a".repeat(31)}`],
    ["too long", `/k/${"a".repeat(33)}`],
    ["uppercase hex", `/k/${TOKEN.toUpperCase()}`],
    ["non-hex", `/k/${"g".repeat(32)}`],
    ["query-string form", `/?id=${TOKEN}`],
    ["wrong path", `/config/${TOKEN}`],
    ["root", "/"],
    ["path traversal attempt", `/k/../${TOKEN}`],
  ];

  it.each(cases)("returns an empty 404 for %s", async (_label, path) => {
    const res = await worker.fetch(req(path), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("returns the same 404 for disabled, expired and revoked keys", async () => {
    for (const status of ["disabled", "expired", "revoked", "pending"]) {
      kv.store.set(`dyn:${TOKEN}`, { accessUrl: ACCESS_URL, status });
      const res = await worker.fetch(req(`/k/${TOKEN}`), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it("returns 404 when the record has no accessUrl", async () => {
    kv.store.set(`dyn:${TOKEN}`, { status: "active" });
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    expect(res.status).toBe(404);
  });

  it("produces byte-identical responses for unknown vs disabled", async () => {
    const unknown = await worker.fetch(req(`/k/${"1".repeat(32)}`), env);
    kv.store.set(`dyn:${TOKEN}`, { accessUrl: ACCESS_URL, status: "disabled" });
    const disabled = await worker.fetch(req(`/k/${TOKEN}`), env);

    // Enumeration and status probing are both impossible.
    expect(unknown.status).toBe(disabled.status);
    expect(await unknown.text()).toBe(await disabled.text());
    expect(unknown.headers.get("Cache-Control")).toBe(disabled.headers.get("Cache-Control"));
  });
});

describe("method and infrastructure handling", () => {
  it("rejects non-GET methods", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(req(`/k/${TOKEN}`, method), env);
      expect(res.status).toBe(405);
    }
  });

  it("allows HEAD", async () => {
    kv.store.set(`dyn:${TOKEN}`, { accessUrl: ACCESS_URL, status: "active" });
    const res = await worker.fetch(req(`/k/${TOKEN}`, "HEAD"), env);
    expect(res.status).toBe(200);
  });

  it("returns 503 for a KV failure, never 404", async () => {
    kv.throwOnGet = true;
    const res = await worker.fetch(req(`/k/${TOKEN}`), env);
    // Infrastructure trouble is not a statement about the token.
    expect(res.status).toBe(503);
  });
});

describe("withFragment", () => {
  it("appends an encoded name", () => {
    expect(withFragment(ACCESS_URL, "Ko Aung")).toBe(`${ACCESS_URL}#Ko%20Aung`);
  });

  it("replaces an existing fragment rather than appending", () => {
    const withServerName = `${ACCESS_URL}#server-name`;
    const result = withFragment(withServerName, "Ko Aung");
    expect(result).toBe(`${ACCESS_URL}#Ko%20Aung`);
    expect(result).not.toContain("server-name");
    expect(result.match(/#/g)).toHaveLength(1);
  });

  it("preserves base64 userinfo and the query string byte-for-byte", () => {
    const tricky = "ss://YWVzLTI1Ni1nY206cGErc3M vd29yZA==@1.2.3.4:8388/?outline=1&prefix=%16%03";
    const result = withFragment(tricky, "Name");
    expect(result.startsWith(tricky)).toBe(true);
    expect(result).toContain("==@");
    expect(result).toContain("?outline=1&prefix=%16%03");
  });

  it("handles Burmese and emoji names", () => {
    const burmese = "ကိုအောင်";
    const result = withFragment(ACCESS_URL, burmese);
    expect(decodeURIComponent(result.split("#")[1])).toBe(burmese);

    const emoji = withFragment(ACCESS_URL, "VIP 🎉");
    expect(decodeURIComponent(emoji.split("#")[1])).toBe("VIP 🎉");
  });

  it("strips the fragment entirely for an empty name", () => {
    expect(withFragment(`${ACCESS_URL}#old`, "")).toBe(ACCESS_URL);
    expect(withFragment(`${ACCESS_URL}#old`, null)).toBe(ACCESS_URL);
    expect(withFragment(`${ACCESS_URL}#old`, "   ")).toBe(ACCESS_URL);
  });

  it("escapes characters that could act as delimiters", () => {
    const result = withFragment(ACCESS_URL, "a!b'c(d)e*f");
    const fragment = result.split("#")[1];
    expect(fragment).not.toContain("!");
    expect(fragment).not.toContain("(");
    expect(decodeURIComponent(fragment)).toBe("a!b'c(d)e*f");
  });

  it("cannot be used to inject a second fragment", () => {
    const result = withFragment(ACCESS_URL, "evil#injected");
    expect(result.match(/#/g)).toHaveLength(1);
    expect(decodeURIComponent(result.split("#")[1])).toBe("evil#injected");
  });
});
