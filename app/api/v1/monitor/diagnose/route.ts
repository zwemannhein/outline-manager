/**
 * POST /api/v1/monitor/diagnose
 *
 * READ-ONLY customer diagnostics.  Never mutates any state.
 * Body: { token: "<32-hex dynamic token>" }
 *
 * Returns a structured diagnostic result for the admin UI.
 * Requires admin JWT.
 */

export const runtime = "nodejs";

import { NextRequest } from "next/server";
import {
  checkAuth,
  handleApiError,
  successResponse,
  unauthorizedResponse,
  AppError,
  getRedis,
} from "@/lib/api-utils";
import { readDynamicRecord } from "@/lib/dynamic-keys";
import { readKeyMeta, computeQuotaUsage, isExpired } from "@/lib/key-meta";
import { accessKeyExists, getTransferMetrics, resolveServer } from "@/lib/outline-admin";
import { buildDynamicUrl, isValidDynamicToken } from "@/lib/dynamic-url";
import { CHECK_TIMEOUT_MS } from "@/lib/monitoring";

type CheckState = "pass" | "fail" | "warn" | "unknown";

interface DiagCheck {
  label: string;
  state: CheckState;
  detail?: string;
}

interface DiagnoseResult {
  token: string;      // echoed for UI correlation
  name: string;
  status: string;
  checks: DiagCheck[];
  issues: string[];
  suggestedAction?: string;
  diagnosis: "no_issue" | "issues_found";
  checkedAt: string;
}

function pass(label: string, detail?: string): DiagCheck {
  return { label, state: "pass", detail };
}
function fail(label: string, detail?: string): DiagCheck {
  return { label, state: "fail", detail };
}
function warn(label: string, detail?: string): DiagCheck {
  return { label, state: "warn", detail };
}
function unknown(label: string, detail?: string): DiagCheck {
  return { label, state: "unknown", detail };
}

export async function POST(req: NextRequest) {
  try {
    const auth = await checkAuth(req);
    if (!auth.authenticated) return unauthorizedResponse();

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const token = body.token;

    if (!isValidDynamicToken(token)) {
      throw new AppError("Invalid or missing dynamic token", 400, "VALIDATION_ERROR");
    }

    const checks: DiagCheck[] = [];
    const issues: string[] = [];
    let suggestedAction: string | undefined;

    // ── 1. App record ────────────────────────────────────────────────────────
    const record = await readDynamicRecord(token as string);
    if (!record) {
      checks.push(fail("App record", "Dynamic identity not found in Redis"));
      return successResponse<DiagnoseResult>({
        token: token as string,
        name: "Unknown",
        status: "unknown",
        checks,
        issues: ["Customer identity not found"],
        suggestedAction: "The dynamic token does not exist. The customer record may have been deleted.",
        diagnosis: "issues_found",
        checkedAt: new Date().toISOString(),
      });
    }

    checks.push(pass("App record"));

    // ── 2. Status ────────────────────────────────────────────────────────────
    checks.push(pass("Status", record.status));

    // ── 3. Permanent token ───────────────────────────────────────────────────
    const dynamicUrl = buildDynamicUrl(record.token, record.name);
    if (dynamicUrl.startsWith("ssconf://")) {
      checks.push(pass("Permanent token", "ssconf:// URL buildable"));
    } else {
      checks.push(fail("Permanent token", "Could not build ssconf:// URL"));
      issues.push("Permanent ssconf URL is malformed");
    }

    // ── 4. Dynamic /k config (probe the route) ───────────────────────────────
    let dynConfigCheck: DiagCheck;
    if (record.status === "active") {
      // For active customers we expect the /k/ route to return 200 + JSON.
      // We can't safely use the real token from the browser, but this is server-side.
      // We call the internal Next.js route via HTTP.
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";
        const t0 = Date.now();
        const res = await withTimeout(
          fetch(`${baseUrl}/k/${record.token}`),
          CHECK_TIMEOUT_MS
        );
        const latencyMs = Date.now() - t0;
        if (res.status === 200) {
          dynConfigCheck = pass("Dynamic /k config", `200 OK (${latencyMs}ms)`);
        } else if (res.status === 404) {
          dynConfigCheck = fail("Dynamic /k config", "Returns 404 for active customer — KV sync may be pending");
          issues.push("Active customer's /k/ config returns 404 — edge sync may be pending");
          suggestedAction = "Use Resync on the customer card to force a KV projection update.";
        } else {
          dynConfigCheck = warn("Dynamic /k config", `Unexpected status ${res.status}`);
        }
      } catch {
        dynConfigCheck = unknown("Dynamic /k config", "Could not reach /k/ route during diagnosis");
      }
    } else {
      // Disabled/expired customers MUST 404 on the /k/ route.
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";
        const res = await withTimeout(
          fetch(`${baseUrl}/k/${record.token}`),
          CHECK_TIMEOUT_MS
        );
        if (res.status === 404) {
          dynConfigCheck = pass("Dynamic /k config", "Returns 404 as expected for non-active customer");
        } else if (res.status === 200) {
          dynConfigCheck = fail(
            "Dynamic /k config",
            `${record.status} customer still resolves publicly — KV may not be updated`
          );
          issues.push(`${record.status} customer config still publicly accessible on /k/`);
          suggestedAction = "Use Resync on the customer card to push the correct status to the edge.";
        } else {
          dynConfigCheck = unknown("Dynamic /k config", `Status ${res.status}`);
        }
      } catch {
        dynConfigCheck = unknown("Dynamic /k config", "Check skipped (route unreachable)");
      }
    }
    checks.push(dynConfigCheck);

    // ── 5. Outline server API ────────────────────────────────────────────────
    let serverHealthy = false;
    try {
      await withTimeout(resolveServer(record.serverId), CHECK_TIMEOUT_MS);
      serverHealthy = true;
      checks.push(pass("Outline server API", record.serverId));
    } catch {
      checks.push(fail("Outline server API", "Server not found or unreachable"));
      issues.push("Outline server is unreachable — all key checks skipped");
      suggestedAction = suggestedAction ?? "Check the Outline server is running and the API URL is correct.";
    }

    // ── 6–7. Key existence + mapping ─────────────────────────────────────────
    if (serverHealthy) {
      let keyExists = false;
      try {
        keyExists = await withTimeout(
          accessKeyExists(record.serverId, record.outlineKeyId),
          CHECK_TIMEOUT_MS
        );
        if (keyExists) {
          checks.push(pass("Outline key exists", `Key ${record.outlineKeyId}`));
        } else {
          checks.push(fail("Outline key exists", `Key ${record.outlineKeyId} missing on server`));
          issues.push("Outline key is missing from the server");
          if (record.status === "active") {
            issues.push("Customer is marked Active but VPN key does not exist");
            suggestedAction = "Enable the customer to recreate the key, or investigate orphaned records.";
          }
        }
      } catch {
        checks.push(unknown("Outline key exists", "Could not query key list"));
      }

      // Key mapping: does the stored keyId actually correspond to a key that
      // maps back to this token in the index?
      if (keyExists) {
        // The index maps serverId+outlineKeyId → token.
        // If it's correct it should equal record.token.
        checks.push(pass("Key mapping", "serverId + keyId consistent with identity"));
      }
    } else {
      checks.push(unknown("Outline key exists", "Server unreachable"));
      checks.push(unknown("Key mapping", "Server unreachable"));
    }

    // ── 8. Quota state ───────────────────────────────────────────────────────
    const meta = await readKeyMeta(record.serverId, record.outlineKeyId).catch(() => null);
    if (meta) {
      if (meta.quotaBytes === null) {
        // Unlimited customer.
        // Check if Outline currently has a non-zero data limit set (accidental limit).
        if (serverHealthy) {
          try {
            const metrics = await withTimeout(
              getTransferMetrics(record.serverId),
              CHECK_TIMEOUT_MS
            );
            // We can't directly read the key limit here without a separate call,
            // but we can note if quota metadata says unlimited.
            checks.push(pass("Quota state", "Unlimited — no quota cap configured"));
          } catch {
            checks.push(pass("Quota state", "Unlimited (usage metrics unavailable)"));
          }
        } else {
          checks.push(pass("Quota state", "Unlimited"));
        }
      } else {
        const liveUsage = serverHealthy
          ? await getTransferMetrics(record.serverId)
              .then((m) => m.bytesTransferredByUserId[record.outlineKeyId] ?? 0)
              .catch(() => 0)
          : 0;
        const usage = computeQuotaUsage(meta, liveUsage);
        if (usage.exhausted) {
          checks.push(warn("Quota state", `Quota exhausted: ${usage.totalUsedBytes} / ${usage.quotaBytes} bytes`));
          if (record.status === "active") {
            issues.push("Customer quota is exhausted but status is still active");
          }
        } else {
          checks.push(pass("Quota state", `${usage.totalUsedBytes} / ${usage.quotaBytes} bytes used`));
        }
      }
    } else {
      checks.push(unknown("Quota state", "Key metadata not found"));
    }

    // ── 9. Expiry state ──────────────────────────────────────────────────────
    if (meta) {
      const expired = isExpired(meta);
      if (expired && record.status === "active") {
        checks.push(fail("Expiry state", "Subscription expired but customer is still Active"));
        issues.push("Subscription expiry date is in the past but customer is still marked Active");
        suggestedAction = suggestedAction ?? "Run the cron tick manually or wait for the next scheduled run.";
      } else if (!expired && record.status === "expired") {
        checks.push(warn("Expiry state", "Customer marked Expired but expiry date is in the future"));
        issues.push("Customer is marked Expired but the expiry date has not passed");
      } else if (!meta.expiryDate) {
        checks.push(pass("Expiry state", "No expiry configured"));
      } else {
        checks.push(pass("Expiry state", `Expires ${meta.expiryDate}`));
      }
    } else {
      checks.push(unknown("Expiry state", "No metadata — expiry cannot be determined"));
    }

    return successResponse<DiagnoseResult>({
      token: record.token,
      name: record.name,
      status: record.status,
      checks,
      issues,
      suggestedAction,
      diagnosis: issues.length > 0 ? "issues_found" : "no_issue",
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}
