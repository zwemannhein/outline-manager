/**
 * Storage helpers — thin wrappers that read/write through the sync layer.
 * All sync operations are async; localStorage is used as a synchronous cache.
 */

import type { OutlineServer, KeyMeta } from "./types";
import { loadLocalData, saveLocalData, pushAdminData } from "./sync";

// ─── Servers ──────────────────────────────────────────────────────────────────

export function loadServers(): OutlineServer[] {
  return loadLocalData().servers;
}

export function saveServers(servers: OutlineServer[]): void {
  const data = loadLocalData();
  data.servers = servers;
  saveLocalData(data);
  // Fire-and-forget push to KV
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

// ─── Key metadata ─────────────────────────────────────────────────────────────

function metaKey(serverId: string, keyId: string): string {
  return `${serverId}:${keyId}`;
}

export function getKeyMeta(serverId: string, keyId: string): KeyMeta {
  const map = loadLocalData().keyMeta;
  return map[metaKey(serverId, keyId)] ?? { expiryDate: null };
}

export function setKeyMeta(serverId: string, keyId: string, meta: KeyMeta): void {
  const data = loadLocalData();
  data.keyMeta[metaKey(serverId, keyId)] = meta;
  saveLocalData(data);
  pushAdminData(data).catch(() => {});
}

export function deleteKeyMeta(serverId: string, keyId: string): void {
  const data = loadLocalData();
  delete data.keyMeta[metaKey(serverId, keyId)];
  saveLocalData(data);
  pushAdminData(data).catch(() => {});
}
