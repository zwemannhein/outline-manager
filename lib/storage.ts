/**
 * Storage helpers — read/write through the sync layer.
 * localStorage is used as a synchronous cache.
 */

import type { OutlineServer } from "./types";
import { loadLocalData, saveLocalData, pushAdminData, AdminData } from "./sync";

// ── Migration: move old localStorage keys into the new unified format ─────────
// Old keys: "outline_servers", "outline_key_meta"
// New key:  "outline_admin_data_v2"

function migrateIfNeeded(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem("outline_admin_data_v2")) return; // already migrated

  try {
    const oldServers = localStorage.getItem("outline_servers");
    const oldMeta = localStorage.getItem("outline_key_meta");
    if (oldServers || oldMeta) {
      const data: AdminData = {
        servers: oldServers ? JSON.parse(oldServers) : [],
        keyMeta: oldMeta ? JSON.parse(oldMeta) : {},
      };
      saveLocalData(data);
      // Push migrated data to KV
      pushAdminData(data).catch(() => {});
    }
  } catch {
    // ignore migration errors
  }
}

// Run migration once on module load (client-side only)
if (typeof window !== "undefined") {
  migrateIfNeeded();
}

// ─── Servers ──────────────────────────────────────────────────────────────────

export function loadServers(): OutlineServer[] {
  return loadLocalData().servers;
}

export function saveServers(servers: OutlineServer[]): void {
  const data = loadLocalData();
  data.servers = servers;
  saveLocalData(data);
  pushAdminData(data).catch(() => {});
}

export function addServer(server: OutlineServer): OutlineServer[] {
  const existing = loadServers();
  const deduped = existing.filter((s) => s.apiUrl !== server.apiUrl);
  const updated = [...deduped, server];
  saveServers(updated);
  return updated;
}

export function removeServer(id: string): OutlineServer[] {
  const updated = loadServers().filter((s) => s.id !== id);
  saveServers(updated);
  return updated;
}

export function updateServerName(id: string, name: string): OutlineServer[] {
  const updated = loadServers().map((s) =>
    s.id === id ? { ...s, name } : s
  );
  saveServers(updated);
  return updated;
}
