/**
 * /api/orders/[id]/approve — REMOVED (410 Gone).
 * Superseded by /api/v1/orders/[id]/approve.
 *
 * The previous implementation authenticated with base64 `user:pass` and fell
 * back to hardcoded default credentials, meaning an unauthenticated caller
 * could create real Outline access keys. That code has been removed.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { goneResponse } from "@/lib/deprecated-route";

export async function POST(req: NextRequest) {
  return goneResponse(req, {
    route: "/api/orders/[id]/approve",
    replacement: "/api/v1/orders/[id]/approve",
  });
}
