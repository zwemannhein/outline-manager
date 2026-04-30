/**
 * Sync client — reads/writes admin data to the server-side KV store.
 * Falls back to localStorage-only when the server returns an error.
 *
 * Data shape stored in KV:
 *   { servers: OutlineServer[], keyMeta: Record<string, KeyMeta> }
 */

import type { OutlineServer, KeyMeta } from "./types";

export interface AdminData {
  servers: OutlineServer[];
  keyMeta: Record<string, KeyMeta>; // "serverId:keyId" → KeyMeta
}

function makeAuthHeader(): string {
  const user = process.env.NEXT_PUBLIC_ADMIN_USERNAME ?? "";
  const pass = process.env.NEXT_PUBLIC_ADMIN_PASSWORD ?? "";
  // Credentials are passed from the client session (stored in memory after login)
  // We read them from the module-level cache set at login time.
  const creds = getStoredCreds();
  return "Bearer " + btoa(`${creds.username}:${creds.password}`);
}

// ── In-memory credential cache (set once at login) ────────────────────────────
let _creds = { username: "", password: "" };

export function setAdminCreds(username: string, password: string) {
  _creds = { username, password };
}

export function getStoredCreds() {
  return _creds;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchAdminData(): Promise<AdminData> {
  try {
    const res = await fetch("/api/store", {
      headers: { Authorization: makeAuthHeader() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as AdminData;
  } catch {
    // Fall back to localStorage
    return loadLocalData();
  }
}

export async function pushAdminData(data: AdminData): Promise<void> {
  // Always write to localStorage immediately (fast, offline-safe)
  saveLocalData(data);

  // Then push to KV in the background
  try {
    await fetch("/api/store", {
      method: "POST",
      headers: {
        Authorization: makeAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  } catch {
    // KV push failed — localStorage already updated, will sync next time
    console.warn("[sync] KV push failed, data saved locally only");
  }
}

// ── localStorage fallback ─────────────────────────────────────────────────────

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
