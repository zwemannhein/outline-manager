/**
 * GET /k/<token> — production dynamic config resolver.
 *
 * Returns the customer's current Shadowsocks configuration in the official
 * Outline JSON format. The permanent URL the customer holds is:
 *
 *     ssconf://outline-manager.vercel.app/k/<32-hex-token>
 *
 * Security posture:
 * - No authentication required (Outline clients cannot present credentials).
 * - Every failure returns an identical empty 404 so the endpoint cannot be
 *   used to enumerate or probe tokens.
 * - No secret values are logged or returned.
 * - Disabled / expired / revoked tokens are indistinguishable from unknown ones.
 */

export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { isValidDynamicToken } from "@/lib/dynamic-url";
import { readDynamicRecord } from "@/lib/dynamic-keys";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
} as const;

function notFound(): NextResponse {
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/** Parse ss://<base64(method:password)>@host:port[/...] into Outline JSON. */
function parseSsUrl(
  ssUrl: string
): { server: string; server_port: number; method: string; password: string } | null {
  const m = /^ss:\/\/([A-Za-z0-9+/=]+)@([\d.a-zA-Z.-]+):(\d+)/.exec(ssUrl);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return {
    method: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
    server: m[2],
    server_port: Number(m[3]),
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const { token } = params;

  if (!isValidDynamicToken(token)) return notFound();

  let record;
  try {
    record = await readDynamicRecord(token);
  } catch {
    return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  if (!record || record.status !== "active" || !record.accessUrl) {
    return notFound();
  }

  const parsed = parseSsUrl(record.accessUrl);
  if (!parsed) return notFound();

  return new NextResponse(JSON.stringify(parsed), {
    status: 200,
    headers: NO_STORE,
  });
}
