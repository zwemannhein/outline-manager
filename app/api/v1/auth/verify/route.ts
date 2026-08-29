/**
 * GET /api/v1/auth/verify — Verify JWT token
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-utils";

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse("Invalid or expired token");
    }

    return successResponse({
      valid: true,
      username: auth.username,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
