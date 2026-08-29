/**
 * /api/orders — REMOVED (410 Gone). Superseded by /api/v1/orders.
 *
 * The previous implementation authenticated with base64 `user:pass` and fell
 * back to hardcoded default credentials. That code has been removed.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

const OPTIONS_META = { route: "/api/orders", replacement: "/api/v1/orders" };

export async function GET(req: NextRequest) {
  return goneResponse(req, OPTIONS_META);
}

export async function POST(req: NextRequest) {
  return goneResponse(req, OPTIONS_META);
}
