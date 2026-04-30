/**
 * Sync client — reads/writes admin data to the server-side KV store.
 * Credentials are stored in sessionStorage so they survive page refreshes.
 */

import type { OutlineServer, KeyMeta } from "./types";

export interface AdminData {
  servers: OutlineServer[];
  keyMeta: Record<string, KeyMeta>;
}

const CREDS_KEY = "outline_admin_creds";

// ── Credential management ─────────────────────────────────────────────────────

export function setAdminCreds(username: string, password: string) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(CREDS_KEY, btoa(`${username}:${password}`));
}

export function clearAdminCreds() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(CREDS_KEY);
}

function makeAuthHeader(): string {
  if (typeof window === "undefined") return "";
  const stored = sessionStorage.getItem(CREDS_KEY);
  if (!stored) return "";
  return `Bearer ${stored}`;
}

export function hasAdminCreds(): boolean {
  if (typeof window === "undefined") return false;
  return !!sessionStorage.getItem(CREDS_KEY);
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchAdminData(): Promise<AdminData> {
  const auth = makeAuthHeader();
  if (!auth) return loadLocalData();

  try {
    const res = await fetch("/api/store", {
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
    await fetch("/api/store", {
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
