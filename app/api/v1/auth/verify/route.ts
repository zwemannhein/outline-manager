/**
 * GET /api/v1/auth/verify — Verify JWT token and report password provenance.
 *
 * `passwordSource` tells the dashboard whether the deployment is still running
 * on the bootstrap environment password. When it is "env", the UI must force a
 * first-run password change before normal use, which is what lets the admin
 * retire the environment password without editing Vercel configuration.
 *
 * This is a non-secret indicator: it never exposes the password, hash, or salt.
 * It is served from the server on every mount, so the requirement survives a
 * page refresh and cannot be skipped by clearing client state.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-utils";
import { getCurrentAdminPasswordState } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);

    if (!auth.authenticated) {
      return unauthorizedResponse("Invalid or expired token");
    }

    const state = await getCurrentAdminPasswordState();

    return successResponse({
      valid: true,
      username: auth.username,
      // "env"   → still on the bootstrap password, first-run setup required
      // "redis" → a runtime password has been set and is authoritative
      passwordSource: state.source,
      passwordChangeRequired: state.source !== "redis",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
