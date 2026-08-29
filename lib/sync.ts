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

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error(error.error || "Login failed");
  }

  const data = await res.json();
  setAuthToken(data.token, data.username);
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
