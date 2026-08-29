/**
 * Shared API utilities for authentication, Redis, rate limiting, and error handling
 */

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "./validation";
import { createLogger } from "./logger";
import { ZodError } from "zod";

const logger = createLogger("api-utils");

// ── Redis client ──────────────────────────────────────────────────────────────

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (redisClient) return redisClient;

  try {
    const env = getEnv();
    const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;

    if (!url || !token) {
      throw new Error("Redis configuration missing");
    }

    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (error) {
    logger.error({ error }, "Failed to initialize Redis client");
    throw error;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimiters = new Map<string, Ratelimit>();

export function getRateLimiter(
  name: string,
  options: { requests: number; window: `${number} ${"ms" | "s" | "m" | "h" | "d"}` | `${number}ms` | `${number}s` | `${number}m` | `${number}h` | `${number}d` }
): Ratelimit {
  if (rateLimiters.has(name)) {
    return rateLimiters.get(name)!;
  }

  const redis = getRedis();
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(options.requests, options.window as any),
    analytics: true,
    prefix: `ratelimit:${name}`,
  });

  rateLimiters.set(name, limiter);
  return limiter;
}

export async function checkRateLimit(
  identifier: string,
  limiterName: string,
  options: { requests: number; window: string }
): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
  const limiter = getRateLimiter(limiterName, options as any);
  const result = await limiter.limit(identifier);

  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  };
}

// ── JWT Authentication ────────────────────────────────────────────────────────

const JWT_ALGORITHM = "HS256";
const JWT_EXPIRY = "24h";

interface JWTPayload {
  username: string;
  iat: number;
  exp: number;
}

export async function createToken(username: string): Promise<string> {
  const env = getEnv();
  const secret = new TextEncoder().encode(env.JWT_SECRET);

  const token = await new SignJWT({ username })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(secret);

  return token;
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const env = getEnv();
    const secret = new TextEncoder().encode(env.JWT_SECRET);

    const { payload } = await jwtVerify(token, secret, {
      algorithms: [JWT_ALGORITHM],
    });

    return payload as unknown as JWTPayload;
  } catch (error) {
    logger.debug({ error }, "Token verification failed");
    return null;
  }
}

export async function checkAuth(req: NextRequest): Promise<{ authenticated: boolean; username?: string }> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return { authenticated: false };
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload) {
    return { authenticated: false };
  }

  return { authenticated: true, username: payload.username };
}

// ── Error handling ────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = "INTERNAL_ERROR",
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function handleApiError(error: unknown): NextResponse<ApiError> {
  // Zod validation errors
  if (error instanceof ZodError) {
    logger.warn({ error: error.errors }, "Validation error");
    return NextResponse.json(
      {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.errors,
      },
      { status: 400 }
    );
  }

  // Application errors
  if (error instanceof AppError) {
    logger.warn({ error: error.message, code: error.code }, "Application error");
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      { status: error.statusCode }
    );
  }

  // Unknown errors
  logger.error({ error }, "Unexpected error");
  return NextResponse.json(
    {
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    },
    { status: 500 }
  );
}

// ── Request helpers ───────────────────────────────────────────────────────────

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0] ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function parseJsonBody<T>(req: NextRequest): Promise<T> {
  try {
    return await req.json();
  } catch {
    throw new AppError("Invalid JSON body", 400, "INVALID_JSON");
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────

export function successResponse<T>(data: T, status: number = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export function unauthorizedResponse(message: string = "Unauthorized"): NextResponse<ApiError> {
  return NextResponse.json(
    { error: message, code: "UNAUTHORIZED" },
    { status: 401 }
  );
}

export function rateLimitResponse(reset: number): NextResponse<ApiError> {
  return NextResponse.json(
    {
      error: "Too many requests",
      code: "RATE_LIMIT_EXCEEDED",
      details: { reset },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil((reset - Date.now()) / 1000)),
      },
    }
  );
}
