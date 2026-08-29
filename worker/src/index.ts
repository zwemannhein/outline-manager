/**
 * outline-config — public dynamic access key resolver.
 *
 * Outline clients fetch this endpoint to obtain their CURRENT Shadowsocks
 * configuration. The permanent URL a customer holds is:
 *
 *     ssconf://<this-host>/k/<32-hex-token>#<URL-encoded name>
 *
 * The fragment is never transmitted in an HTTP request, so this Worker
 * structurally cannot see the customer name. The name is presentation metadata
 * and cannot participate in lookup.
 *
 * ── SECURITY POSTURE ────────────────────────────────────────────────────────
 * This Worker holds NO secrets. Its only binding is a read of the KV namespace.
 * It has no Upstash credentials, no Outline management credentials, no Cloudflare
 * API write token, and no Vercel auth secret. If it were fully compromised the
 * attacker would gain read access to one KV namespace of ss:// URLs and nothing
 * else — no ability to mint, migrate, or revoke anything.
 *
 * Every failure returns a byte-identical empty 404: malformed token, wrong
 * length, uppercase hex, unknown token, disabled, expired, revoked, or a missing
 * accessUrl. Nothing distinguishes "exists" from "does not exist", so the
 * endpoint cannot be used to enumerate or probe tokens. The token's 128 bits of
 * entropy is the capability.
 *
 * The endpoint is intentionally unauthenticated: Outline clients cannot present
 * credentials when fetching a remote config.
 */

/**
 * The slice of Cloudflare's KVNamespace this Worker actually uses.
 *
 * Declared locally rather than pulled from @cloudflare/workers-types so the file
 * type-checks both under worker/tsconfig.json and from the Next.js test suite,
 * without needing the Cloudflare types installed at the repository root.
 */
export interface KvReadNamespace {
  get<T = unknown>(
    key: string,
    options?: { type?: "json" | "text"; cacheTtl?: number }
  ): Promise<T | null>;
}

export interface Env {
  /** Read binding for the dynamic projection namespace. */
  DYN: KvReadNamespace;
  /**
   * "true" makes the Worker rewrite the inner ss:// fragment with the customer
   * name. Default OFF — the outer ssconf fragment is expected to carry it, and
   * returning the stored ss:// verbatim is the least surprising behaviour.
   * Only enable if real client testing proves the outer fragment is ignored.
   */
  DYNAMIC_KEY_INNER_FRAGMENT?: string;
}

/** Shape written by lib/kv-sync.ts. `name` is intentionally absent for MVP. */
interface DynamicProjection {
  accessUrl?: string;
  status?: string;
  rev?: number;
  updatedAt?: string;
  /** Only present if a future revision opts into inner-fragment rewriting. */
  name?: string;
}

const TOKEN_PATTERN = /^\/k\/([0-9a-f]{32})$/;

const NO_STORE: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

/**
 * Uniform failure response. Empty body, so every negative outcome is
 * indistinguishable from every other.
 */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { ...NO_STORE } });
}

/**
 * Replace the fragment of an ss:// URL with an encoded label.
 *
 * Deliberately NOT using `new URL()`: `ss:` is a non-special scheme, and WHATWG
 * URL normalisation can re-encode the base64 userinfo (padding `=`, `+`, `/`),
 * which would corrupt a working key. Splitting on the first `#` touches only the
 * fragment and leaves the authority and query byte-for-byte intact.
 *
 * Any pre-existing fragment is replaced, never appended to, so a stored
 * `ss://...#server-name` cannot become `#server-name#Customer`.
 */
export function withFragment(ssUrl: string, name?: string | null): string {
  const hashAt = ssUrl.indexOf("#");
  const base = hashAt === -1 ? ssUrl : ssUrl.slice(0, hashAt);
  if (!name) return base;

  const trimmed = name.trim();
  if (!trimmed) return base;

  const label = encodeURIComponent(trimmed).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${base}#${label}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...NO_STORE } });
    }

    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return notFound();
    }

    // Liveness probe. Touches no KV, so it costs no read quota.
    if (pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8", ...NO_STORE },
      });
    }

    const match = TOKEN_PATTERN.exec(pathname);
    if (!match) {
      // Includes uppercase hex and wrong-length tokens.
      return notFound();
    }

    const token = match[1];

    let projection: DynamicProjection | null = null;
    try {
      projection = await env.DYN.get<DynamicProjection>(`dyn:${token}`, {
        type: "json",
        // Short edge cache. Cuts KV reads for chatty clients by up to ~60x while
        // keeping migration and disable propagation within a minute.
        cacheTtl: 60,
      });
    } catch {
      // Infrastructure failure is NOT a statement about the token, so it must
      // not be reported as 404.
      return new Response(null, { status: 503, headers: { ...NO_STORE } });
    }

    if (!projection || projection.status !== "active" || !projection.accessUrl) {
      return notFound();
    }

    const body =
      env.DYNAMIC_KEY_INNER_FRAGMENT === "true"
        ? withFragment(projection.accessUrl, projection.name)
        : projection.accessUrl;

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8", ...NO_STORE },
    });
  },
};
