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
