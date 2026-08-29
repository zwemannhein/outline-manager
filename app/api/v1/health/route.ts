/**
 * GET /api/v1/health — Health check endpoint
 */

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getRedis } from "@/lib/api-utils";
import { createLogger } from "@/lib/logger";

const logger = createLogger("health");

export async function GET() {
  const checks = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: "unknown" as "healthy" | "unhealthy" | "unknown",
  };

  // Check Redis connectivity
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = "healthy";
  } catch (error) {
    logger.error({ error }, "Redis health check failed");
    checks.redis = "unhealthy";
    checks.status = "degraded";
  }

  const statusCode = checks.status === "healthy" ? 200 : 503;

  return NextResponse.json(checks, { status: statusCode });
}
