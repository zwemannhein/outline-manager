/**
 * /api/orders/[id]/reject — REMOVED (410 Gone).
 * Superseded by /api/v1/orders/[id]/reject.
 *
 * The previous implementation authenticated with base64 `user:pass` and fell
 * back to hardcoded default credentials. That code has been removed.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

export async function POST(req: NextRequest) {
  return goneResponse(req, {
    route: "/api/orders/[id]/reject",
    replacement: "/api/v1/orders/[id]/reject",
  });
}
