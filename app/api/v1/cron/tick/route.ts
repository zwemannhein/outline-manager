/**
 * POST /api/v1/cron/tick — the scheduled maintenance pass.
 *
 * Driven hourly by the Cloudflare scheduled Worker (free), because Vercel's Hobby
 * plan caps cron at once per day and a daily-only tick would leave a customer
 * blocked for up to 24h after their cycle should have reset.
 *
 * Authenticated with CRON_SECRET. Vercel Cron also sends this header, so the same
 * endpoint works as a daily fallback with no extra code.
 *
 * PROPERTIES
 *  - idempotent: safe if both the Cloudflare and Vercel schedules fire
 *  - bounded: every pass has a hard item limit, so one run cannot exhaust the
 *    Cloudflare KV write budget or time out the function
 *  - due-index driven: never scans all customers
 *
 * ORDER MATTERS: expiry runs BEFORE rollover, otherwise a subscription that has
 * just ended could be granted one extra cycle by a rollover processed first.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { timingSafeEqual, createHash } from "crypto";
import { handleApiError, successResponse } from "@/lib/api-utils";
import { processExpiries, processCycleRollovers } from "@/lib/quota-cycles";
import { drainDirtyDynamicRecords } from "@/lib/kv-sync";
import { createLogger } from "@/lib/logger";

const logger = createLogger("cron");

/** Per-pass bounds. Keeps the invocation well inside the function timeout. */
const EXPIRY_LIMIT = 50;
const ROLLOVER_LIMIT = 50;
const DRAIN_LIMIT = 25;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && timingSafeEqualStr(bearer, secret)) return true;

  // Vercel Cron sends the secret in this header.
  const vercelHeader = req.headers.get("x-vercel-cron-signature") ?? "";
  if (vercelHeader && timingSafeEqualStr(vercelHeader, secret)) return true;

  return false;
}

async function runTick() {
  const startedAt = Date.now();

  // 1. Expiry first, so an ended subscription cannot gain a cycle below.
  const expiry = await processExpiries(startedAt, EXPIRY_LIMIT);

  // 2. Cycle rollovers. Costs ZERO Cloudflare KV writes: the public projection
  //    is unchanged, only the Outline limit and Redis metadata move.
  const rollover = await processCycleRollovers(startedAt, ROLLOVER_LIMIT);

  // 3. Retry any queued edge projections.
  const drain = await drainDirtyDynamicRecords(DRAIN_LIMIT);

  const durationMs = Date.now() - startedAt;

  logger.info({ expiry, rollover, drain, durationMs }, "Cron tick complete");

  return { expiry, rollover, drain, durationMs };
}

export async function POST(req: NextRequest) {
  try {
    if (!authorised(req)) {
      // No detail: this endpoint should be invisible to anyone without the secret.
      logger.warn("Unauthorised cron invocation rejected");
      return new Response(null, { status: 404 });
    }

    const result = await runTick();
    return successResponse({ ok: true, ...result });
  } catch (error) {
    return handleApiError(error);
  }
}

/** GET is accepted so Vercel Cron, which issues GET, can drive the same work. */
export async function GET(req: NextRequest) {
  return POST(req);
}
