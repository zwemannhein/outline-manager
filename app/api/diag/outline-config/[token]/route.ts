/**
 * GET /api/diag/outline-config/<token>
 *
 * Temporary diagnostic endpoint. Returns the same Outline JSON config
 * as the Cloudflare Worker but served from the Vercel domain, so we can
 * isolate whether the client failure is domain- or path-specific.
 *
 * Reads the same authoritative Redis record the Worker's KV projection
 * is derived from. Never logs or returns raw ss:// in the response.
 *
 * Remove this route once the ssconf domain test is concluded.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { isValidDynamicToken } from "@/lib/dynamic-url";
import { readDynamicRecord } from "@/lib/dynamic-keys";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

function notFound() {
  return new NextResponse(null, { status: 404, headers: NO_STORE });
}

/** Parse ss://<base64(method:password)>@host:port[/...] */
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

  const record = await readDynamicRecord(token).catch(() => null);

  if (!record || record.status !== "active" || !record.accessUrl) {
    return notFound();
  }

  const parsed = parseSsUrl(record.accessUrl);
  if (!parsed) return notFound();

  return NextResponse.json(parsed, {
    status: 200,
    headers: NO_STORE,
  });
}
