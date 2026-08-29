/**
 * GET /api/v1/orders/[id]/status — REMOVED (410 Gone).
 *
 * This endpoint returned the customer's key material to anyone who knew or
 * guessed an order id. Order ids are `ord_<timestamp>_<random>`, and the
 * timestamp component is highly predictable, so the id was never a sound
 * credential. With permanent dynamic keys the exposure would have been worse: the
 * ssconf:// URL survives server migration and quota changes, so a single leak
 * would be permanent rather than limited to one key.
 *
 * Replacement: POST /api/v1/orders/status with a 128-bit claim token that is
 * issued once at order creation and stored only as a SHA-256 hash.
 *
 * Kept as an explicit 410 with access logging rather than deleted, so any
 * lingering client surfaces in the logs instead of failing mysteriously.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

export async function GET(req: NextRequest) {
  return goneResponse(req, {
    route: "/api/v1/orders/[id]/status",
    replacement: "/api/v1/orders/status",
  });
}
