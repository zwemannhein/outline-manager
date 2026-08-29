/**
 * /api/key-check — REMOVED (410 Gone). Superseded by /api/v1/key-check.
 *
 * The previous implementation returned diagnostic data on failure, including
 * the full list of access key ids on the server and part of the supplied
 * password. That information disclosure has been removed.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

export async function POST(req: NextRequest) {
  return goneResponse(req, {
    route: "/api/key-check",
    replacement: "/api/v1/key-check",
  });
}
