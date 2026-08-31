/**
 * POST /api/v1/admin/customers — create a managed customer without a public order.
 *
 * Two modes:
 *   keyMode = "new"      — create one new Outline key on the chosen server
 *   keyMode = "existing" — attach an already-existing, currently-unmanaged key
 *
 * In both modes exactly ONE dynamic identity is created and the customer
 * immediately appears in the Customers panel.  No order, no payment reference,
 * no claim token.
 *
 * The permanent ssconf:// URL is returned.  The raw ss:// URL is never in the
 * response body; the admin can retrieve it via the revealRaw action if needed.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  checkRateLimit,
  getClientIp,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  rateLimitResponse,
  AppError,
} from "@/lib/api-utils";
import { adminCreateCustomerSchema } from "@/lib/validation";
import {
  generateDynamicToken,
  createDynamicIdentity,
  getTokenByOutlineKey,
  buildDynamicUrl,
  scheduleCycleDue,
  scheduleExpiryDue,
} from "@/lib/dynamic-keys";
import {
  buildInitialMeta,
  writeKeyMeta,
  cycleDueAt,
  expiryAt,
  GIB,
} from "@/lib/key-meta";
import {
  createAccessKey,
  getAccessKey,
  renameAccessKey,
  applyDataLimit,
  resolveServer,
} from "@/lib/outline-admin";
import { putDynamicProjection } from "@/lib/kv-sync";
import { createLogger } from "@/lib/logger";

const logger = createLogger("admin-customers");

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const ip = getClientIp(req);
    const rl = await checkRateLimit(ip, "admin-create-customer", { requests: 20, window: "5m" });
    if (!rl.success) return rateLimitResponse(rl.reset);

    const body = await req.json().catch(() => ({}));
    const input = adminCreateCustomerSchema.safeParse(body);
    if (!input.success) {
      throw new AppError("Validation failed", 400, "VALIDATION_ERROR", input.error.issues);
    }
    const data = input.data;

    // Verify server exists before touching Outline.
    await resolveServer(data.serverId).catch(() => {
      throw new AppError("Server not found.", 400, "SERVER_NOT_FOUND");
    });

    let outlineKey: { id: string; accessUrl: string };

    if (data.keyMode === "new") {
      // Create a fresh Outline key.
      const created = await createAccessKey(data.serverId, data.name).catch(() => {
        throw new AppError("Could not create Outline key.", 502, "OUTLINE_FAILED");
      });
      outlineKey = { id: created.id, accessUrl: created.accessUrl };
    } else {
      // Attach an existing unmanaged key.
      if (!data.existingKeyId) {
        throw new AppError("existingKeyId is required when keyMode is 'existing'.", 400, "VALIDATION_ERROR");
      }
      const existing = await getAccessKey(data.serverId, data.existingKeyId).catch(() => null);
      if (!existing) {
        throw new AppError("Outline key not found on the specified server.", 404, "KEY_NOT_FOUND");
      }
      // Refuse a key already managed by another customer.
      const alreadyManaged = await getTokenByOutlineKey(data.serverId, data.existingKeyId);
      if (alreadyManaged) {
        throw new AppError(
          "This Outline key is already managed by another customer.",
          409,
          "KEY_ALREADY_MANAGED"
        );
      }
      outlineKey = { id: existing.id, accessUrl: existing.accessUrl };
    }

    // Mint a new permanent token — generated BEFORE any further writes so a
    // crash can be diagnosed rather than silently producing a duplicate.
    const token = generateDynamicToken();

    // Quota / expiry metadata.
    const quotaBytes = data.quotaGB === null ? null : Math.floor(data.quotaGB * GIB);
    const expiryOverride = data.expiryDate ? new Date(data.expiryDate) : null;

    // cyclesTotal: derive from expiry span so the 30-day cycle machinery is
    // anchored correctly.  If no expiry is given, default to 1 cycle (infinite
    // renewal is handled by the admin editing the expiry later).
    const now = new Date();
    let cyclesTotal = 1;
    if (expiryOverride) {
      const spanMs = expiryOverride.getTime() - now.getTime();
      const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
      cyclesTotal = Math.max(1, Math.ceil(spanMs / CYCLE_MS));
    }

    const meta = buildInitialMeta({
      quotaBytes,
      cyclesTotal,
      startedAt: now,
    });

    // Override expiryDate with the admin-supplied value if provided so the
    // cron fires at the right time regardless of rounding in cyclesTotal.
    const finalMeta = expiryOverride
      ? { ...meta, expiryDate: expiryOverride.toISOString() }
      : meta;

    // Apply the data limit on the Outline key immediately.
    const initialLimit = quotaBytes; // full allowance at cycle start
    await applyDataLimit(data.serverId, outlineKey.id, initialLimit).catch(() => {
      throw new AppError("Could not apply data limit on Outline server.", 502, "OUTLINE_FAILED");
    });

    // Rename existing key to match the customer name (best-effort for "existing" mode).
    if (data.keyMode === "existing") {
      await renameAccessKey(data.serverId, outlineKey.id, data.name).catch(() => {/* non-fatal */});
    }

    // Write the metadata, identity, and KV projection.
    await writeKeyMeta(data.serverId, outlineKey.id, finalMeta);

    const record = await createDynamicIdentity({
      token,
      orderId: null,   // no order — this is a direct admin creation
      serverId: data.serverId,
      outlineKeyId: outlineKey.id,
      accessUrl: outlineKey.accessUrl,
      name: data.name,
      status: "active",
    });

    // Schedule cron entries.
    const cycleDue = cycleDueAt(finalMeta);
    if (cycleDue) await scheduleCycleDue(token, cycleDue);
    const expiry = expiryAt(finalMeta);
    if (expiry) await scheduleExpiryDue(token, expiry);

    // Push the public projection to Cloudflare KV (best-effort; dirty if it fails).
    const sync = await putDynamicProjection(record);

    const dynamicUrl = buildDynamicUrl(token, data.name);

    logger.info(
      {
        user: auth.username,
        token: token.slice(0, 8) + "…",
        serverId: data.serverId,
        outlineKeyId: outlineKey.id,
        keyMode: data.keyMode,
      },
      "Admin created managed customer"
    );

    return successResponse({
      ok: true,
      token,
      dynamicUrl,
      outlineKeyId: outlineKey.id,
      serverId: data.serverId,
      syncPending: !sync.ok,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** GET /api/v1/admin/customers — list unmanaged Outline keys on a server. */
export async function GET(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const serverId = req.nextUrl.searchParams.get("serverId");
    if (!serverId) {
      throw new AppError("serverId query param required.", 400, "VALIDATION_ERROR");
    }

    await resolveServer(serverId).catch(() => {
      throw new AppError("Server not found.", 400, "SERVER_NOT_FOUND");
    });

    const { listAccessKeys } = await import("@/lib/outline-admin");
    const { getTokenByOutlineKey } = await import("@/lib/dynamic-keys");

    const allKeys = await listAccessKeys(serverId);

    // Filter to keys NOT already tracked by a dynamic identity.
    const unmanaged: Array<{ id: string; name: string }> = [];
    for (const key of allKeys) {
      const managed = await getTokenByOutlineKey(serverId, key.id);
      if (!managed) unmanaged.push({ id: key.id, name: key.name || `Key ${key.id}` });
    }

    return successResponse({ keys: unmanaged });
  } catch (error) {
    return handleApiError(error);
  }
}
