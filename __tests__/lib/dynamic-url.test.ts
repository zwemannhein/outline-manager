import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildDynamicUrl,
  buildDynamicHttpsUrl,
  parseDynamicUrl,
  encodeDisplayName,
  isValidDynamicToken,
  getDynamicBaseHost,
  DEFAULT_DYNAMIC_HOST,
} from "@/lib/dynamic-url";

const TOKEN = "8f3a1c9e7b42d6f0a51e9c34b287de61";

describe("token validation", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(isValidDynamicToken(TOKEN)).toBe(true);
    expect(isValidDynamicToken("0".repeat(32))).toBe(true);
  });

  it("rejects uppercase, wrong length and non-hex", () => {
    expect(isValidDynamicToken(TOKEN.toUpperCase())).toBe(false);
    expect(isValidDynamicToken(TOKEN.slice(0, 31))).toBe(false);
    expect(isValidDynamicToken(`${TOKEN}a`)).toBe(false);
    expect(isValidDynamicToken("g".repeat(32))).toBe(false);
    expect(isValidDynamicToken("")).toBe(false);
    expect(isValidDynamicToken(null)).toBe(false);
    expect(isValidDynamicToken(12345)).toBe(false);
  });
});

describe("permanent URL format", () => {
  it("is path-based and never uses a query string", () => {
    const url = buildDynamicUrl(TOKEN);
    expect(url).toContain(`/k/${TOKEN}`);
    expect(url).not.toContain("?id=");
    expect(url).not.toContain("?");
  });

  it("uses the ssconf scheme", () => {
    expect(buildDynamicUrl(TOKEN).startsWith("ssconf://")).toBe(true);
  });

  it("matches the canonical shape", () => {
    expect(buildDynamicUrl(TOKEN, "Ko Aung")).toBe(
      `ssconf://outline-manager.vercel.app/k/${TOKEN}`
    );
  });

  it("never emits a customer-name fragment", () => {
    expect(buildDynamicUrl(TOKEN)).toBe(`ssconf://${DEFAULT_DYNAMIC_HOST}/k/${TOKEN}`);
    expect(buildDynamicUrl(TOKEN, "Ko Aung")).not.toContain("#");
    expect(buildDynamicUrl(TOKEN, "ကိုအောင်")).not.toContain("#");
    expect(buildDynamicUrl(TOKEN, "")).not.toContain("#");
    expect(buildDynamicUrl(TOKEN, "   ")).not.toContain("#");
    expect(buildDynamicUrl(TOKEN, null)).not.toContain("#");
  });

  it("refuses to build from an invalid token", () => {
    expect(() => buildDynamicUrl("nope")).toThrow(/invalid dynamic token/i);
    expect(() => buildDynamicUrl(TOKEN.toUpperCase())).toThrow();
  });

  it("exposes an https form for diagnostics", () => {
    expect(buildDynamicHttpsUrl(TOKEN)).toBe(`https://${DEFAULT_DYNAMIC_HOST}/k/${TOKEN}`);
  });
});

describe("customer display name encoding", () => {
  it("encodes ASCII with spaces", () => {
    expect(encodeDisplayName("Ko Aung")).toBe("Ko%20Aung");
  });

  it("encodes Burmese Unicode", () => {
    const burmese = "ကိုအောင်";
    const encoded = encodeDisplayName(burmese);
    expect(encoded).toMatch(/^(%[0-9A-F]{2})+$/);
    // Round-trips exactly.
    expect(decodeURIComponent(encoded)).toBe(burmese);
  });

  it("encodes emoji", () => {
    const encoded = encodeDisplayName("VIP 🎉");
    expect(decodeURIComponent(encoded)).toBe("VIP 🎉");
  });

  it("escapes characters encodeURIComponent leaves literal", () => {
    // These can be treated as delimiters by some clients.
    const encoded = encodeDisplayName("a!b'c(d)e*f");
    expect(encoded).not.toContain("!");
    expect(encoded).not.toContain("'");
    expect(encoded).not.toContain("(");
    expect(encoded).not.toContain(")");
    expect(encoded).not.toContain("*");
    expect(decodeURIComponent(encoded)).toBe("a!b'c(d)e*f");
  });

  it("never emits a raw # or newline that could break the URL", () => {
    const encoded = encodeDisplayName("we#ird\nname");
    expect(encoded).not.toContain("#");
    expect(encoded).not.toContain("\n");
  });

  it("trims surrounding whitespace", () => {
    expect(encodeDisplayName("  Ko Aung  ")).toBe("Ko%20Aung");
  });
});

describe("parsing customer input", () => {
  it("parses a full ssconf URL with a name", () => {
    const parsed = parseDynamicUrl(`ssconf://${DEFAULT_DYNAMIC_HOST}/k/${TOKEN}#Ko%20Aung`);
    expect(parsed).toEqual({ token: TOKEN, name: "Ko Aung" });
  });

  it("continues to parse names from legacy fragmented URLs", () => {
    const burmese = "ကိုအောင်";
    const url = `ssconf://${DEFAULT_DYNAMIC_HOST}/k/${TOKEN}#${encodeDisplayName(burmese)}`;
    expect(parseDynamicUrl(url)).toEqual({ token: TOKEN, name: burmese });
  });

  it("parses an https URL, a bare path and a bare token", () => {
    expect(parseDynamicUrl(`https://${DEFAULT_DYNAMIC_HOST}/k/${TOKEN}`)?.token).toBe(TOKEN);
    expect(parseDynamicUrl(`/k/${TOKEN}`)?.token).toBe(TOKEN);
    expect(parseDynamicUrl(TOKEN)?.token).toBe(TOKEN);
  });

  it("tolerates surrounding whitespace and a trailing slash", () => {
    expect(parseDynamicUrl(`  ssconf://h/k/${TOKEN}  `)?.token).toBe(TOKEN);
    expect(parseDynamicUrl(`ssconf://h/k/${TOKEN}/`)?.token).toBe(TOKEN);
  });

  it("accepts a host that differs from the configured one", () => {
    // Links already in circulation must keep parsing if the base changes.
    expect(parseDynamicUrl(`ssconf://some-other-host.workers.dev/k/${TOKEN}`)?.token).toBe(TOKEN);
  });

  it("rejects anything without a valid token", () => {
    expect(parseDynamicUrl("")).toBeNull();
    expect(parseDynamicUrl("ssconf://host/k/tooshort")).toBeNull();
    expect(parseDynamicUrl(`ssconf://host/k/${TOKEN.toUpperCase()}`)).toBeNull();
    expect(parseDynamicUrl("ss://abc@1.2.3.4:1234")).toBeNull();
    expect(parseDynamicUrl(`ssconf://host/other/${TOKEN}`)).toBeNull();
  });

  it("rejects a query-string form, which is deliberately unsupported", () => {
    expect(parseDynamicUrl(`ssconf://host/?id=${TOKEN}`)).toBeNull();
  });

  it("survives a malformed percent-escape in the fragment", () => {
    const parsed = parseDynamicUrl(`ssconf://host/k/${TOKEN}#%E0%A1`);
    expect(parsed?.token).toBe(TOKEN);
  });

  it("preserves the token while deliberately dropping new display-name fragments", () => {
    for (const name of ["Ko Aung", "ကိုအောင်", "VIP 🎉", "a!b'c(d)", "Plain"]) {
      const parsed = parseDynamicUrl(buildDynamicUrl(TOKEN, name));
      expect(parsed).toEqual({ token: TOKEN, name: null });
    }
  });
});

describe("URL stability across backend changes", () => {
  it("depends only on the unchanged token, not on name, server, or quota", () => {
    // The permanent URL is derived, never stored, so nothing about the
    // underlying key can influence it.
    const a = buildDynamicUrl(TOKEN, "Ko Aung");
    const b = buildDynamicUrl(TOKEN, "Different Name");
    expect(a).toBe(b);
    expect(parseDynamicUrl(a)?.token).toBe(TOKEN);
  });
});

describe("base URL configuration", () => {
  const originalPublic = process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL;
  const originalServer = process.env.DYNAMIC_KEY_BASE_URL;

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL;
    else process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL = originalPublic;
    if (originalServer === undefined) delete process.env.DYNAMIC_KEY_BASE_URL;
    else process.env.DYNAMIC_KEY_BASE_URL = originalServer;
  });

  it("falls back to the default host", () => {
    delete process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL;
    delete process.env.DYNAMIC_KEY_BASE_URL;
    expect(DEFAULT_DYNAMIC_HOST).toBe("outline-manager.vercel.app");
    expect(getDynamicBaseHost()).toBe(DEFAULT_DYNAMIC_HOST);
  });

  it("accepts a bare host and normalises trailing slashes", () => {
    process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL = "my-worker.example.dev/";
    expect(buildDynamicUrl(TOKEN)).toBe(`ssconf://my-worker.example.dev/k/${TOKEN}`);
  });

  it("accepts an explicit scheme", () => {
    process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL = "https://cfg.example.dev";
    expect(buildDynamicUrl(TOKEN)).toBe(`ssconf://cfg.example.dev/k/${TOKEN}`);
  });
});
