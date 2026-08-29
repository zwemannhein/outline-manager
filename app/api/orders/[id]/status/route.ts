/**
 * /api/orders/[id]/status — REMOVED (410 Gone).
 * Superseded by /api/v1/orders/[id]/status.
 *
 * The previous implementation returned the raw Outline ss:// access URL to any
 * unauthenticated caller who knew or guessed an order id. That code has been
 * removed. The replacement endpoint is itself scheduled to be replaced by a
 * claim-token based lookup.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

export async function GET(req: NextRequest) {
  return goneResponse(req, {
    route: "/api/orders/[id]/status",
    replacement: "/api/v1/orders/[id]/status",
  });
}
