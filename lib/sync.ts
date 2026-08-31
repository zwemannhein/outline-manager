/**
 * Sync client — reads/writes admin data to the server-side KV store.
 * Uses JWT tokens stored in sessionStorage.
 */

import type { OutlineServer, KeyMeta } from "./types";

export interface AdminData {
  servers: OutlineServer[];
  keyMeta: Record<string, KeyMeta>;
}

const TOKEN_KEY = "outline_admin_token";
const USERNAME_KEY = "outline_admin_username";

// ── Token management ──────────────────────────────────────────────────────────

export function setAuthToken(token: string, username: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USERNAME_KEY, username);
}

export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USERNAME_KEY);
}

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUsername(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(USERNAME_KEY);
}

export function hasAuthToken(): boolean {
  if (typeof window === "undefined") return false;
  return !!sessionStorage.getItem(TOKEN_KEY);
}

function makeAuthHeader(): string {
  const token = getAuthToken();
  return token ? `Bearer ${token}` : "";
}

/**
 * Public accessor for the admin Authorization header.
 * Used by lib/outline-client.ts so that /api/outline calls are authenticated.
 * Returns an empty string when no admin session exists.
 */
export function getAuthHeader(): string {
  return makeAuthHeader();
}

// ── API calls ─────────────────────────────────────────────────────────────────

// ── Admin login (two-step: credentials, then Telegram approval) ───────────────

export interface LoginApprovalHandle {
  attemptId: string;
  /** Held in memory / sessionStorage only, never persisted long-term. */
  browserSecret: string;
  expiresAt: string;
}

export type LoginPollStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "consumed"
  | "expired";

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return (data as { error?: string } | null)?.error || fallback;
}

/**
 * Step 1: submit credentials. On success this does NOT log in — it returns a
 * handle for the Telegram approval that must follow.
 */
export async function login(
  username: string,
  password: string
): Promise<LoginApprovalHandle> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Login failed"));
  }

  const data = (await res.json()) as {
    status: string;
    attemptId: string;
    browserSecret: string;
    expiresAt: string;
  };

  if (data.status !== "approval_required" || !data.attemptId || !data.browserSecret) {
    throw new Error("Unexpected login response");
  }

  return {
    attemptId: data.attemptId,
    browserSecret: data.browserSecret,
    expiresAt: data.expiresAt,
  };
}

/**
 * Step 2: poll for the Telegram decision. When approved, the server issues the
 * JWT and this stores it.
 */
export async function pollLoginStatus(
  handle: LoginApprovalHandle
): Promise<LoginPollStatus> {
  const res = await fetch("/api/v1/auth/login/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attemptId: handle.attemptId,
      browserSecret: handle.browserSecret,
    }),
  });

  if (!res.ok) {
    // Treat transport/rate-limit errors as "still pending" so the UI keeps trying.
    return "pending";
  }

  const data = (await res.json()) as {
    status: LoginPollStatus;
    token?: string;
    username?: string;
  };

  if (data.status === "approved" && data.token && data.username) {
    setAuthToken(data.token, data.username);
    return "approved";
  }

  return data.status;
}

/** Abandon a pending approval so it cannot later be used. */
export async function cancelLogin(handle: LoginApprovalHandle): Promise<void> {
  try {
    await fetch("/api/v1/auth/login/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: handle.attemptId,
        browserSecret: handle.browserSecret,
      }),
    });
  } catch {
    // Best-effort: the attempt expires on its own within 5 minutes.
  }
}

// ── Password management ───────────────────────────────────────────────────────

/** Authenticated dashboard password change. */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");

  const res = await fetch("/api/v1/auth/change-password", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Could not change password"));
  }
}

export interface ForgotPasswordStart {
  status: "code_sent" | "cooldown";
  resetId?: string;
  retryAfterSeconds?: number;
  resendCooldownSeconds?: number;
}

/**
 * Begin recovery. Sends NO username: the server resolves the current admin
 * username itself and delivers it over Telegram along with the code.
 */
export async function forgotPassword(
  previousResetId?: string | null
): Promise<ForgotPasswordStart> {
  const res = await fetch("/api/v1/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(previousResetId ? { previousResetId } : {}),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Could not start password reset"));
  }

  return (await res.json()) as ForgotPasswordStart;
}

export async function verifyResetCode(resetId: string, code: string): Promise<void> {
  const res = await fetch("/api/v1/auth/forgot-password/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetId, code }),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Invalid or expired code"));
  }
}

export async function resetPassword(resetId: string, newPassword: string): Promise<void> {
  const res = await fetch("/api/v1/auth/forgot-password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetId, newPassword }),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Could not reset password"));
  }
}

export async function verifyToken(): Promise<boolean> {
  const auth = makeAuthHeader();
  if (!auth) return false;

  try {
    const res = await fetch("/api/v1/auth/verify", {
      headers: { Authorization: auth },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SessionInfo {
  valid: boolean;
  username: string | null;
  /** "env" while still on the bootstrap password, "redis" once one is set. */
  passwordSource: "env" | "redis" | "none" | null;
  /** True while first-run password setup must be completed. */
  passwordChangeRequired: boolean;
}

/**
 * Ask the server about the current session, including whether first-run password
 * setup is still outstanding. Server-authoritative, so it survives a refresh and
 * cannot be bypassed by clearing client state.
 */
export async function fetchSessionInfo(): Promise<SessionInfo> {
  const auth = makeAuthHeader();
  if (!auth) {
    return { valid: false, username: null, passwordSource: null, passwordChangeRequired: false };
  }

  try {
    const res = await fetch("/api/v1/auth/verify", { headers: { Authorization: auth } });
    if (!res.ok) {
      return { valid: false, username: null, passwordSource: null, passwordChangeRequired: false };
    }
    const data = (await res.json()) as {
      valid: boolean;
      username: string;
      passwordSource: "env" | "redis" | "none";
      passwordChangeRequired: boolean;
    };
    return {
      valid: Boolean(data.valid),
      username: data.username ?? null,
      passwordSource: data.passwordSource ?? null,
      passwordChangeRequired: Boolean(data.passwordChangeRequired),
    };
  } catch {
    return { valid: false, username: null, passwordSource: null, passwordChangeRequired: false };
  }
}

/**
 * First-run password setup. Only valid while no runtime password exists.
 * Requires no current password; see the route for why that is safe.
 */
export async function setBootstrapPassword(newPassword: string): Promise<void> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");

  const res = await fetch("/api/v1/auth/bootstrap-password", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword }),
  });

  if (!res.ok) {
    throw new Error(await readError(res, "Could not set password"));
  }
}

export async function fetchAdminData(): Promise<AdminData> {
  const auth = makeAuthHeader();
  if (!auth) return loadLocalData();

  try {
    const res = await fetch("/api/v1/store", {
      headers: { Authorization: auth },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as AdminData;
    // Cache locally for offline use
    saveLocalData(data);
    return data;
  } catch {
    return loadLocalData();
  }
}

export async function pushAdminData(data: AdminData): Promise<void> {
  saveLocalData(data);

  const auth = makeAuthHeader();
  if (!auth) return;

  try {
    await fetch("/api/v1/store", {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  } catch {
    console.warn("[sync] KV push failed, data saved locally only");
  }
}

// ── localStorage cache ────────────────────────────────────────────────────────

const LS_KEY = "outline_admin_data_v2";

export function loadLocalData(): AdminData {
  if (typeof window === "undefined") return { servers: [], keyMeta: {} };
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as AdminData) : { servers: [], keyMeta: {} };
  } catch {
    return { servers: [], keyMeta: {} };
  }
}

export function saveLocalData(data: AdminData): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

// ── Dynamic customer identities (admin) ───────────────────────────────────────

export interface DynamicCustomerRow {
  token: string;
  name: string;
  orderId: string | null;
  serverId: string;
  serverName: string;
  outlineKeyId: string;
  status: "active" | "disabled" | "expired" | "revoked";
  rev: number;
  createdAt: string;
  updatedAt: string;
  /** The customer's permanent key. This is what "Copy Key" copies. */
  dynamicUrl: string;
  /** Only present when explicitly requested via revealRaw. */
  accessUrl?: string;
  /** Admin-configured allowance per 30-day cycle. Never decremented by usage. */
  configuredQuotaBytes: number | null;
  quotaBytes: number | null;
  usedBytes: number;
  carriedBytes: number;
  remainingBytes: number | null;
  quotaExhausted: boolean;
  planDescription: string | null;
  periodStart: string | null;
  expiryDate: string | null;
  cyclesTotal: number | null;
  cyclesUsed: number | null;
  syncState: "synced" | "pending" | "unknown" | "not_configured";
  suspendedState: { previousLimitBytes: number | null; reason: string } | null;
  cleanupPending: boolean;
}

export interface DynamicHealth {
  kvWritesUsedToday: number;
  kvWriteLimit: number;
  kvWritesRemaining: number;
  kvBudgetWarning: boolean;
  pendingEdgeSyncs: number;
}

export async function fetchDynamicCustomers(): Promise<{
  customers: DynamicCustomerRow[];
  health: DynamicHealth;
}> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");

  const res = await fetch("/api/v1/dynamic-keys", { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(await readError(res, "Could not load customers"));

  return (await res.json()) as { customers: DynamicCustomerRow[]; health: DynamicHealth };
}

/** All admin lifecycle mutations funnel through one endpoint. */
async function dynamicAction<T>(payload: Record<string, unknown>): Promise<T> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");

  const res = await fetch("/api/v1/dynamic-keys/actions", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error(
      (data as { error?: string } | null)?.error || "Action failed"
    ) as Error & { code?: string; details?: unknown };
    err.code = (data as { code?: string } | null)?.code;
    err.details = (data as { details?: unknown } | null)?.details;
    throw err;
  }

  return (await res.json()) as T;
}

export function disableCustomer(token: string) {
  return dynamicAction<{ ok: boolean; status: string; syncPending: boolean }>({
    action: "disable",
    token,
  });
}

export function enableCustomer(token: string, serverId?: string | null) {
  return dynamicAction<{
    ok: boolean;
    recreatedKey: boolean;
    dynamicUrl: string | null;
    syncPending: boolean;
  }>({ action: "enable", token, serverId: serverId ?? null });
}

export function renewCustomer(token: string, additionalCycles: number) {
  return dynamicAction<{ ok: boolean; expiryDate: string | null; cyclesTotal: number }>({
    action: "renew",
    token,
    additionalCycles,
  });
}

export function updateCustomerQuota(token: string, quotaGB: number | null) {
  return dynamicAction<{ ok: boolean; quotaBytes: number | null; urlChanged: boolean }>({
    action: "updateQuota",
    token,
    quotaGB,
  });
}

export function migrateCustomer(
  token: string,
  destServerId: string,
  allowExhausted = false
) {
  return dynamicAction<{
    ok: boolean;
    destServerId: string;
    destKeyId: string;
    carriedBytes: number;
    urlChanged: boolean;
    cleanupRequired: boolean;
    syncPending: boolean;
  }>({ action: "migrate", token, destServerId, allowExhausted });
}

export function cleanupCustomerMigration(token: string) {
  return dynamicAction<{ ok: boolean; deleted: unknown[]; skipped: number }>({
    action: "migrateCleanup",
    token,
  });
}

/** Admin troubleshooting only. Deliberately a separate, audited call. */
export function revealRawKey(token: string) {
  return dynamicAction<{ ok: boolean; accessUrl: string; outlineKeyId: string }>({
    action: "revealRaw",
    token,
  });
}

export function resyncCustomer(token: string) {
  return dynamicAction<{ ok: boolean }>({ action: "resync", token });
}

export function editCustomerSubscription(
  token: string,
  quotaGB: number | null,
  expiryDate: string | null
) {
  return dynamicAction<{
    ok: boolean;
    quotaBytes: number | null;
    expiryDate: string | null;
    disabledImmediately: boolean;
    syncPending: boolean;
    urlChanged: boolean;
  }>({ action: "editSubscription", token, quotaGB, expiryDate });
}

export async function createAdminCustomer(params: {
  name: string;
  serverId: string;
  keyMode: "new" | "existing";
  existingKeyId?: string | null;
  quotaGB: number | null;
  expiryDate: string | null;
}): Promise<{ ok: boolean; token: string; dynamicUrl: string; outlineKeyId: string; syncPending: boolean }> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch("/api/v1/admin/customers", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error((data as { error?: string } | null)?.error || "Create failed") as Error & { code?: string };
    err.code = (data as { code?: string } | null)?.code;
    throw err;
  }
  return (await res.json()) as { ok: boolean; token: string; dynamicUrl: string; outlineKeyId: string; syncPending: boolean };
}

export async function listUnmanagedKeys(serverId: string): Promise<Array<{ id: string; name: string }>> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch(`/api/v1/admin/customers?serverId=${encodeURIComponent(serverId)}`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(await readError(res, "Could not load keys"));
  const data = await res.json() as { keys: Array<{ id: string; name: string }> };
  return data.keys;
}

// ── Customer order flow ───────────────────────────────────────────────────────

const CLAIM_STORAGE_KEY = "outline_order_claim";

interface StoredClaim {
  orderId: string;
  claimToken: string;
  savedAt: number;
}

/**
 * Claim tokens live in localStorage so a customer can close the browser while
 * waiting for approval and still retrieve their key later. The server TTL is 30
 * days; stale entries are pruned client-side.
 *
 * Only the claim token is stored — never a VPN credential.
 */
export function saveOrderClaim(orderId: string, claimToken: string): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredClaim = { orderId, claimToken, savedAt: Date.now() };
    localStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable in private mode; the flow still works in-session.
  }
}

export function loadOrderClaim(): StoredClaim | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CLAIM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredClaim;
    if (!parsed?.claimToken || !/^[0-9a-f]{32}$/.test(parsed.claimToken)) {
      clearOrderClaim();
      return null;
    }
    // Match the server-side 30-day TTL.
    if (Date.now() - (parsed.savedAt ?? 0) > 30 * 24 * 60 * 60 * 1000) {
      clearOrderClaim();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearOrderClaim(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CLAIM_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export interface OrderStatusResponse {
  status: "pending" | "approved" | "rejected";
  name: string;
  plan: string;
  createdAt: number;
  /** The permanent customer key. Null until approved. Never a raw ss:// URL. */
  dynamicUrl: string | null;
  pendingSetup?: boolean;
  keyStatus?: string;
  planDescription?: string | null;
  expiryDate?: string | null;
  cyclesTotal?: number | null;
  cyclesUsed?: number | null;
  usage?: {
    totalUsedBytes: number;
    quotaBytes: number | null;
    remainingBytes: number | null;
  } | null;
}

/**
 * Look up an order by claim token. Returns null for an unknown or expired claim,
 * and clears the stale local copy so the UI does not keep retrying.
 */
export async function fetchOrderStatus(claimToken: string): Promise<OrderStatusResponse | null> {
  const res = await fetch("/api/v1/orders/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimToken }),
  });

  if (res.status === 404) {
    clearOrderClaim();
    return null;
  }
  if (!res.ok) throw new Error(await readError(res, "Could not load order status"));

  return (await res.json()) as OrderStatusResponse;
}

// ── Telegram approvers ────────────────────────────────────────────────────────

export interface TelegramApproverRow {
  userId: string;
  username: string;
  linkedAt: string;
  status: "linked";
}

export async function fetchTelegramApprovers(): Promise<TelegramApproverRow[]> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch("/api/v1/telegram-approvers", {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(await readError(res, "Could not load approvers"));
  const data = (await res.json()) as { approvers: TelegramApproverRow[] };
  return data.approvers;
}

export async function createTelegramLinkToken(
  username: string
): Promise<{ token: string; deepLink: string; expectedUsername: string; expiresAt: string }> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch("/api/v1/telegram-approvers/link-token", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not create link token"));
  return (await res.json()) as {
    token: string;
    deepLink: string;
    expectedUsername: string;
    expiresAt: string;
  };
}

export async function removeTelegramApprover(userId: string): Promise<void> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch("/api/v1/telegram-approvers", {
    method: "DELETE",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not remove approver"));
}

// ── System monitoring ─────────────────────────────────────────────────────────

export type MonitorHealthStatus = "healthy" | "warning" | "critical" | "not_configured";

export interface SystemHealth {
  checkedAt: string;
  cached: boolean;
  overall: MonitorHealthStatus;
  app: {
    status: MonitorHealthStatus;
    environment: string;
    region: string;
    commitSha?: string;
  };
  redis: {
    status: MonitorHealthStatus;
    latencyMs?: number;
    detail?: string;
    kvBudget: { used: number; limit: number; remaining: number; warn: boolean } | null;
    dirtyQueueSize: number;
  };
  telegram: {
    status: MonitorHealthStatus;
    latencyMs?: number;
    detail?: string;
    botUsername?: string;
    webhookConfigured: boolean;
    linkedApprovers: number;
    pendingLinks: number;
  };
  cron: {
    status: MonitorHealthStatus;
    detail?: string;
    overdueMs?: number;
    summary: {
      lastStartedAt: string;
      lastCompletedAt: string;
      durationMs: number;
      processed: number;
      failed: number;
      expiryProcessed: number;
      quotaProcessed: number;
      dirtySyncProcessed: number;
    } | null;
  };
  dynamicConfig: {
    status: MonitorHealthStatus;
    latencyMs?: number;
    detail?: string;
    checkedAt: string;
    httpStatus?: number;
  };
  resourceMetrics: { status: MonitorHealthStatus; detail?: string };
}

export interface OutlineServerHealth {
  serverId: string;
  name: string;
  status: MonitorHealthStatus;
  latencyMs?: number;
  detail?: string;
  totalKeys: number;
  managedKeys: number;
  unmanagedKeys: number;
  activeCustomers: number;
  disabledCustomers: number;
  missingKeys: number;
  duplicateMappings: number;
  checkedAt: string;
}

export interface OutlineMonitorResult {
  checkedAt: string;
  cached: boolean;
  overall: MonitorHealthStatus;
  servers: OutlineServerHealth[];
  resourceMetrics: { status: MonitorHealthStatus };
}

export type DiagCheckState = "pass" | "fail" | "warn" | "unknown";

export interface DiagCheck {
  label: string;
  state: DiagCheckState;
  detail?: string;
}

export interface DiagnoseResult {
  token: string;
  name: string;
  status: string;
  checks: DiagCheck[];
  issues: string[];
  suggestedAction?: string;
  diagnosis: "no_issue" | "issues_found";
  checkedAt: string;
}

export async function fetchSystemHealth(force = false): Promise<SystemHealth> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const url = force ? "/api/v1/monitor?force=1" : "/api/v1/monitor";
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(await readError(res, "Could not load system health"));
  return (await res.json()) as SystemHealth;
}

export async function fetchOutlineHealth(force = false): Promise<OutlineMonitorResult> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const url = force ? "/api/v1/monitor/outline?force=1" : "/api/v1/monitor/outline";
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(await readError(res, "Could not load Outline health"));
  return (await res.json()) as OutlineMonitorResult;
}

export async function diagnoseCustomer(token: string): Promise<DiagnoseResult> {
  const auth = makeAuthHeader();
  if (!auth) throw new Error("Not signed in.");
  const res = await fetch("/api/v1/monitor/diagnose", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(await readError(res, "Diagnosis failed"));
  return (await res.json()) as DiagnoseResult;
}
