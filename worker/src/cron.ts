/**
 * outline-cron — zero-cost scheduled trigger.
 *
 * WHY A SEPARATE WORKER
 * Vercel's Hobby plan caps cron at once per day. A daily-only tick would leave a
 * customer blocked for up to 24 hours after their cycle should have reset, which
 * is customer-visible. Cloudflare cron triggers are free and support any cadence,
 * so this Worker fires hourly and POSTs to the Vercel endpoint.
 *
 * It is deliberately a DIFFERENT Worker from outline-config so the public
 * config resolver keeps holding zero secrets. This one holds CRON_SECRET; the
 * public one holds nothing.
 *
 * All the actual work happens on Vercel:
 *   - Outline requires cert-pinned TLS to a self-signed server, which Workers
 *     cannot do.
 *   - Upstash writes and the business logic live in the Next.js runtime.
 *
 * So this Worker is a trigger and nothing more. It never touches Outline, KV,
 * or Redis.
 */

export interface Env {
  /** Absolute URL of the Vercel cron endpoint. */
  ROLLOVER_URL: string;
  /** Shared bearer secret; must match CRON_SECRET on Vercel. */
  CRON_SECRET: string;
}

async function tick(env: Env): Promise<{ ok: boolean; status: number; detail: string }> {
  if (!env.ROLLOVER_URL || !env.CRON_SECRET) {
    return { ok: false, status: 0, detail: "cron worker is not configured" };
  }

  try {
    const res = await fetch(env.ROLLOVER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "cloudflare-cron" }),
    });

    // Body is read only for log context and is bounded.
    const text = (await res.text().catch(() => "")).slice(0, 500);
    return { ok: res.ok, status: res.status, detail: text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

export default {
  /** Hourly trigger. The endpoint is idempotent, so a duplicate run is harmless. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tick(env).then((result) => {
        if (!result.ok) {
          console.error(`cron tick failed status=${result.status} detail=${result.detail}`);
        } else {
          console.log(`cron tick ok status=${result.status}`);
        }
      })
    );
  },

  /**
   * Manual trigger for verification. Requires the same bearer secret, so it
   * cannot be used by anyone who does not already hold it.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${env.CRON_SECRET}`;

    if (!env.CRON_SECRET || auth !== expected) {
      return new Response(null, { status: 404 });
    }

    const result = await tick(env);
    return new Response(JSON.stringify({ ok: result.ok, status: result.status }), {
      status: result.ok ? 200 : 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
};
