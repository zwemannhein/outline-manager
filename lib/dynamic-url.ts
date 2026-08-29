/**
 * The ONE ssconf:// URL builder/parser, isomorphic.
 *
 * Lives in its own module with no server-only imports so the admin UI can render
 * a customer's permanent key without a round trip, while server code still uses
 * the same functions. There is exactly one implementation of this format.
 *
 * The base URL is not a secret — it appears verbatim in every customer's key.
 * `NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL` is read first so the browser can resolve it;
 * server code falls back to `DYNAMIC_KEY_BASE_URL`, then to the known host.
 */

/** Fallback when neither environment variable is configured. */
export const DEFAULT_DYNAMIC_HOST = "outline-config.zwellmunheimn.workers.dev";

/** Exactly 32 lowercase hex characters (128 bits). Uppercase is rejected. */
export function isValidDynamicToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** Canonical base, normalised to `https://host[/path]` with no trailing slash. */
export function getDynamicBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_DYNAMIC_KEY_BASE_URL?.trim() ||
    process.env.DYNAMIC_KEY_BASE_URL?.trim();

  if (!raw) return `https://${DEFAULT_DYNAMIC_HOST}`;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** Host portion of the configured base. */
export function getDynamicBaseHost(): string {
  try {
    return new URL(getDynamicBaseUrl()).host;
  } catch {
    return DEFAULT_DYNAMIC_HOST;
  }
}

/**
 * Percent-encode a customer name for use as a URI fragment.
 *
 * encodeURIComponent handles spaces, Burmese script and emoji. `!'()*` are
 * additionally escaped because encodeURIComponent leaves them literal and some
 * clients treat them as delimiters.
 */
export function encodeDisplayName(name?: string | null): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  return encodeURIComponent(trimmed).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The permanent customer URL.
 *
 * Path-based (`/k/<token>`) rather than a query string: some Outline clients drop
 * the query when fetching a remote config, and a path survives copy-paste and
 * chat-app link detection better.
 *
 * The name goes in the OUTER fragment. Fragments are never transmitted in an HTTP
 * request, so the Worker cannot see it — the name is presentation metadata and
 * structurally cannot participate in lookup.
 */
export function buildDynamicUrl(token: string, name?: string | null): string {
  if (!isValidDynamicToken(token)) {
    throw new Error("buildDynamicUrl: invalid dynamic token");
  }

  const base = getDynamicBaseUrl().replace(/^https?:\/\//i, "");
  const url = `ssconf://${base}/k/${token}`;

  const label = encodeDisplayName(name);
  return label ? `${url}#${label}` : url;
}

/** The https:// form of the same endpoint, for diagnostics. */
export function buildDynamicHttpsUrl(token: string): string {
  if (!isValidDynamicToken(token)) {
    throw new Error("buildDynamicHttpsUrl: invalid dynamic token");
  }
  return `${getDynamicBaseUrl()}/k/${token}`;
}

export interface ParsedDynamicUrl {
  token: string;
  /** Decoded display name, or null when the URL carried no fragment. */
  name: string | null;
}

/**
 * Accepts any form a customer might paste:
 *   ssconf://host/k/<token>#Name
 *   https://host/k/<token>
 *   /k/<token>
 *   <token>
 *
 * Host is deliberately not required to match, so changing the configured base
 * does not break parsing of links already in circulation.
 */
export function parseDynamicUrl(input: string): ParsedDynamicUrl | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hashAt = trimmed.indexOf("#");
  const locator = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);
  const rawFragment = hashAt === -1 ? "" : trimmed.slice(hashAt + 1);

  let name: string | null = null;
  if (rawFragment) {
    try {
      name = decodeURIComponent(rawFragment);
    } catch {
      // A malformed fragment must not invalidate an otherwise valid token.
      name = rawFragment;
    }
  }

  if (isValidDynamicToken(locator)) {
    return { token: locator, name };
  }

  const match = /\/k\/([0-9a-f]{32})\/?$/.exec(locator);
  if (match) {
    return { token: match[1], name };
  }

  return null;
}
