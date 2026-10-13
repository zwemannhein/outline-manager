/**
 * Legacy login-approval polling endpoint.
 * Dashboard login now issues a session immediately after valid credentials.
 * This endpoint intentionally cannot exchange old approval attempts for JWTs.
 */

import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "Telegram approval is no longer required for admin login.",
      code: "LOGIN_APPROVAL_DISABLED",
    },
    { status: 410 }
  );
}
