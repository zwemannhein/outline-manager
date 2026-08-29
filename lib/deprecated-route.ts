/**
 * Helper for legacy API routes that are being retired.
 *
 * These routes are superseded by /api/v1/* equivalents and have no callers
 * inside this repository. They are NOT deleted yet because external consumers
 * (scripts, saved curl commands, uptime monitors) cannot be fully verified, and
 * MIGRATION.md previously advertised them as supported.
 *
 * Instead they return 410 Gone and log every access, giving an observation
 * window. Once the logs stay quiet the route files can be deleted outright.
 *
 * The legacy implementations authenticated with base64 `user:pass` and had
 * hardcoded credential fallbacks. Replacing the bodies with this helper removes
 * that code path entirely, which is the security win regardless of deletion.
 */

import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "./logger";

const logger = createLogger("deprecated-route");

export interface GoneOptions {
  /** Legacy path, e.g. "/api/store" */
  route: string;
  /** Replacement path, e.g. "/api/v1/store" */
  replacement: string;
}

/**
 * Log the access and return 410 Gone.
 *
 * Deliberately records only non-sensitive request shape: never the
 * Authorization header value, never the request body.
 */
export function goneResponse(req: NextRequest, options: GoneOptions): NextResponse {
  const { route, replacement } = options;

  logger.warn(
    {
      route,
      method: req.method,
      // Presence only — never the value.
      hadAuthHeader: Boolean(req.headers.get("authorization")),
      userAgent: req.headers.get("user-agent") ?? "unknown",
      referer: req.headers.get("referer") ?? "none",
      ip:
        req.headers.get("x-forwarded-for")?.split(",")[0] ||
        req.headers.get("x-real-ip") ||
        "unknown",
    },
    "Deprecated endpoint accessed"
  );

  return NextResponse.json(
    {
      error: "This endpoint has been removed.",
      code: "ENDPOINT_GONE",
      replacement,
      details:
        "Use the versioned API with JWT authentication obtained from /api/v1/auth/login.",
    },
    {
      status: 410,
      headers: {
        // Advertise the replacement for anything that follows Link headers.
        Link: `<${replacement}>; rel="successor-version"`,
        "Cache-Control": "no-store",
      },
    }
  );
}
