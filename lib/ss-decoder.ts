/**
 * Shadowsocks URL decoder
 *
 * Supports:
 *   ss://<base64(method:password)>@host:port[#tag]          (SIP002 legacy)
 *   ss://<base64(method:password@host:port)>[#tag]           (old format)
 *   ssconf://<host>/<path>[#tag]                             (dynamic config)
 *
 * Key-ID extraction: Outline Desktop encodes the key id in the fragment as
 * the numeric suffix after the last "/" or as a bare number, e.g.:
 *   ss://...#key-3   → keyId = "3"
 *   ss://...#3       → keyId = "3"
 */

import type { DecodedSsKey } from "./types";

function safeBase64Decode(s: string): string {
  // Pad to multiple of 4
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  // URL-safe → standard
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(standard, "base64").toString("utf-8");
}

function extractKeyId(fragment: string | null): {
  keyId: string | null;
  tag: string | null;
} {
  if (!fragment) return { keyId: null, tag: null };

  // Outline uses fragments like "key-3" or just "3"
  const match = fragment.match(/(?:^|[-/])(\d+)$/);
  return {
    keyId: match ? match[1] : null,
    tag: fragment || null,
  };
}

export function decodeSsUrl(input: string): DecodedSsKey {
  const trimmed = input.trim();

  // ── ssconf:// ──────────────────────────────────────────────────────────────
  if (trimmed.startsWith("ssconf://")) {
    // ssconf is a URL pointing to a JSON config; we can only extract host/tag
    const withoutScheme = trimmed.slice("ssconf://".length);
    const [hostPath, fragment] = withoutScheme.split("#");
    const host = hostPath.split("/")[0];
    const { keyId, tag } = extractKeyId(fragment ?? null);
    return {
      host,
      port: 0,
      method: "dynamic",
      password: "",
      keyId,
      tag,
      raw: trimmed,
    };
  }

  // ── ss:// ──────────────────────────────────────────────────────────────────
  if (!trimmed.startsWith("ss://")) {
    throw new Error("Input is not a valid ss:// or ssconf:// URL");
  }

  const withoutScheme = trimmed.slice("ss://".length);

  // Split fragment
  const hashIdx = withoutScheme.indexOf("#");
  const fragment = hashIdx !== -1 ? withoutScheme.slice(hashIdx + 1) : null;
  const body = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

  const { keyId, tag } = extractKeyId(fragment);

  // ── SIP002: userinfo@host:port ─────────────────────────────────────────────
  const atIdx = body.lastIndexOf("@");
  if (atIdx !== -1) {
    const userinfo = body.slice(0, atIdx);
    const hostPort = body.slice(atIdx + 1);

    // userinfo may be plain "method:password" or base64-encoded
    let method: string;
    let password: string;
    try {
      const decoded = safeBase64Decode(userinfo);
      const colonIdx = decoded.indexOf(":");
      method = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);
    } catch {
      // Already plain text
      const colonIdx = userinfo.indexOf(":");
      method = userinfo.slice(0, colonIdx);
      password = userinfo.slice(colonIdx + 1);
    }

    // host:port — handle IPv6 [::1]:port
    let host: string;
    let port: number;
    if (hostPort.startsWith("[")) {
      const closeBracket = hostPort.indexOf("]");
      host = hostPort.slice(1, closeBracket);
      port = parseInt(hostPort.slice(closeBracket + 2), 10);
    } else {
      const lastColon = hostPort.lastIndexOf(":");
      host = hostPort.slice(0, lastColon);
      port = parseInt(hostPort.slice(lastColon + 1), 10);
    }

    return { host, port, method, password, keyId, tag, raw: trimmed };
  }

  // ── Legacy: base64(method:password@host:port) ──────────────────────────────
  const decoded = safeBase64Decode(body);
  // format: method:password@host:port
  const legacyAt = decoded.lastIndexOf("@");
  if (legacyAt === -1) {
    throw new Error("Cannot parse Shadowsocks URL: missing '@' in decoded payload");
  }
  const userPart = decoded.slice(0, legacyAt);
  const hostPart = decoded.slice(legacyAt + 1);

  const colonIdx = userPart.indexOf(":");
  const method = userPart.slice(0, colonIdx);
  const password = userPart.slice(colonIdx + 1);

  const lastColon = hostPart.lastIndexOf(":");
  const host = hostPart.slice(0, lastColon);
  const port = parseInt(hostPart.slice(lastColon + 1), 10);

  return { host, port, method, password, keyId, tag, raw: trimmed };
}

/**
 * Detect whether a string is a JSON admin key, ss:// link, or ssconf:// link.
 */
export type InputKind = "admin-json" | "ss-url" | "ssconf-url" | "unknown";

export function detectInputKind(input: string): InputKind {
  const t = input.trim();
  if (t.startsWith("ss://")) return "ss-url";
  if (t.startsWith("ssconf://")) return "ssconf-url";
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed.apiUrl === "string" && typeof parsed.certSha256 === "string") {
      return "admin-json";
    }
  } catch {
    // not JSON
  }
  return "unknown";
}
