/**
 * Safe customer deletion.
 *
 * ── ORDER OF OPERATIONS ───────────────────────────────────────────────────────
 * 1. Read + validate record (exists, not already revoked, no pending migration)
 * 2. Revoke public dynamic access first — marks status=revoked, bumps rev,
 *    clears the Outline-key index so /k/<token> returns 404 immediately.
 * 3. Remove the Cloudflare KV projection (best-effort; dirty-queue handles retry).
 * 4. Delete the underlying Outline key from the server.
 *    — FAILS SAFE: if Outline deletion fails after step 2 we still surface the
 *      error. The key was already removed from the public index so it does not
 *      resolve, but we do not hide the server-side failure from the caller.
 * 5. Persist the final tombstone via revokeDynamicIdentity (clears due-indexes,
 *    removes outlineKeyIndex entry, preserves historical identity hash in Redis).
 *
 * ── WHAT IS PRESERVED ────────────────────────────────────────────────────────
 * - Order records (order:*, orderclaim:*)        — never touched
 * - The dyn:<token> tombstone (status=revoked)  — preserved for audit
 * - key-meta hash                               — preserved for audit
 * History entries inside the identity record are preserved too; the record is
 * not deleted, only tombstoned (status=revoked, accessUrl="", name="").
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * If the record is already revoked, return ok immediately without re-touching
 * Outline or any other state. Repeating deletion is safe.
 *
 * ── MIGRATION GUARD ──────────────────────────────────────────────────────────
 * If pendingCleanupEntries.length > 0 (a migration is in progress), refuse with
 * a clear error. The admin must finish cleanup first.
 */

import { createLogger, maskId } from "./logger";
import {
  readDynamicRecord,
  revokeDynamicIdentity,
  pendingCleanupEntries,
  isValidDynamicToken,
} from "./dynamic-keys";
import { deleteAccessKey, accessKeyExists } from "./outline-admin";
import { deleteDynamicProjection } from "./kv-sync";

const logger = createLogger("delete-customer");

export type DeleteCustomerResult =
  | { ok: true; outlineKeyDeleted: boolean; kvProjectionRemoved: boolean }
  | { ok: false; code: DeleteErrorCode; message: string };

export type DeleteErrorCode =
  | "NOT_FOUND"
  | "ALREADY_DELETED"
  | "MIGRATION_IN_PROGRESS"
  | "OUTLINE_DELETE_FAILED"
  | "INVALID_TOKEN";

export async function deleteCustomer(token: string): Promise<DeleteCustomerResult> {
  if (!isValidDynamicToken(token)) {
    return { ok: false, code: "INVALID_TOKEN", message: "Invalid dynamic token." };
  }

  // ── 1. Read + validate ────────────────────────────────────────────────────
  const record = await readDynamicRecord(token);

  if (!record) {
    return { ok: false, code: "NOT_FOUND", message: "Customer identity not found." };
  }

  // Idempotent: already fully deleted.
  if (record.status === "revoked") {
    logger.info({ dyn: maskId(token) }, "Delete customer: already revoked (idempotent)");
    return { ok: true, outlineKeyDeleted: false, kvProjectionRemoved: false };
  }

  // Migration guard: pending cleanup entries mean there are temporary keys
  // on old servers that have not been cleaned up yet.
  const pendingMigration = pendingCleanupEntries(record);
  if (pendingMigration.length > 0) {
    return {
      ok: false,
      code: "MIGRATION_IN_PROGRESS",
      message:
        `Cannot delete: ${pendingMigration.length} migration key(s) still need cleanup. ` +
        "Use the Clean Up action on this customer first, then retry deletion.",
    };
  }

  logger.info({ dyn: maskId(token), status: record.status }, "Delete customer: starting");

  // ── 2. Revoke public dynamic access immediately ───────────────────────────
  // This is the most important step — after this, /k/<token> returns 404.
  // We do this BEFORE touching Outline so the customer loses access even if
  // the Outline API is temporarily unreachable.
  await revokeDynamicIdentity(token);
  logger.info({ dyn: maskId(token) }, "Delete customer: dynamic identity revoked");

  // ── 3. Remove Cloudflare KV projection (best-effort) ─────────────────────
  let kvProjectionRemoved = false;
  try {
    const kvResult = await deleteDynamicProjection(token);
    kvProjectionRemoved = kvResult.ok;
    if (!kvResult.ok) {
      // Not fatal — the revoked status already prevents resolution.
      // drainDirtyDynamicRecords will clean up the projection on next cron run.
      logger.warn({ dyn: maskId(token), reason: kvResult.reason }, "KV projection delete failed (queued for retry)");
    }
  } catch (err) {
    logger.warn({ dyn: maskId(token), err }, "KV projection delete threw (queued for retry)");
  }

  // ── 4. Delete Outline key from server ─────────────────────────────────────
  let outlineKeyDeleted = false;
  try {
    const keyExists = await accessKeyExists(record.serverId, record.outlineKeyId);
    if (keyExists) {
      await deleteAccessKey(record.serverId, record.outlineKeyId);
      outlineKeyDeleted = true;
      logger.info({ dyn: maskId(token), keyId: record.outlineKeyId }, "Delete customer: Outline key deleted");
    } else {
      // Key already missing from server — not an error (idempotent).
      outlineKeyDeleted = true;
      logger.info({ dyn: maskId(token) }, "Delete customer: Outline key already absent");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ dyn: maskId(token), err }, "Delete customer: Outline key deletion FAILED");
    // FAIL SAFE: the dynamic identity is already revoked (step 2), so the
    // customer cannot get new credentials, but we surface the server error so
    // the admin knows the Outline key may still exist on the server.
    return {
      ok: false,
      code: "OUTLINE_DELETE_FAILED",
      message:
        `VPN access has been revoked, but the Outline key could not be removed from the server: ${msg}. ` +
        "Please remove key " + record.outlineKeyId + " manually from the Outline server.",
    };
  }

  logger.info({ dyn: maskId(token) }, "Delete customer: complete");
  return { ok: true, outlineKeyDeleted, kvProjectionRemoved };
}
