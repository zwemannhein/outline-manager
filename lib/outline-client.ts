/**
 * Client-side wrapper around /api/outline proxy.
 * All methods throw on non-2xx responses.
 */

import type {
  AccessKey,
  ServerInfo,
  TransferMetrics,
  ProxyRequest,
} from "./types";

async function proxyFetch<T>(req: Omit<ProxyRequest, never>): Promise<T> {
  const res = await fetch("/api/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  // No-body responses (204, 205, 304) — just check ok and return
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return undefined as T;
  }

  // Guard against empty body before calling .json()
  const text = await res.text();
  const data = text.trim() ? (JSON.parse(text) as unknown) : {};

  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `HTTP ${res.status}`
    );
  }

  return data as T;
}

// ─── Server info ──────────────────────────────────────────────────────────────

export async function getServerInfo(
  apiUrl: string,
  certSha256: string
): Promise<ServerInfo> {
  return proxyFetch<ServerInfo>({
    apiUrl,
    certSha256,
    method: "GET",
    path: "/server",
  });
}

// ─── Access keys ──────────────────────────────────────────────────────────────

export async function listAccessKeys(
  apiUrl: string,
  certSha256: string
): Promise<AccessKey[]> {
  const res = await proxyFetch<{ accessKeys: AccessKey[] }>({
    apiUrl,
    certSha256,
    method: "GET",
    path: "/access-keys",
  });
  return res.accessKeys;
}

export async function createAccessKey(
  apiUrl: string,
  certSha256: string,
  name?: string
): Promise<AccessKey> {
  const key = await proxyFetch<AccessKey>({
    apiUrl,
    certSha256,
    method: "POST",
    path: "/access-keys",
  });

  // Optionally set name right after creation
  if (name) {
    await renameAccessKey(apiUrl, certSha256, key.id, name);
    key.name = name;
  }

  return key;
}

export async function deleteAccessKey(
  apiUrl: string,
  certSha256: string,
  keyId: string
): Promise<void> {
  await proxyFetch<unknown>({
    apiUrl,
    certSha256,
    method: "DELETE",
    path: `/access-keys/${keyId}`,
  });
}

export async function renameAccessKey(
  apiUrl: string,
  certSha256: string,
  keyId: string,
  name: string
): Promise<void> {
  await proxyFetch<unknown>({
    apiUrl,
    certSha256,
    method: "PUT",
    path: `/access-keys/${keyId}/name`,
    body: { name },
  });
}

export async function setDataLimit(
  apiUrl: string,
  certSha256: string,
  keyId: string,
  bytes: number
): Promise<void> {
  // Outline API spec: PUT /access-keys/{id}/data-limit
  // Body format: { "limit": { "bytes": N } }
  await proxyFetch<unknown>({
    apiUrl,
    certSha256,
    method: "PUT",
    path: `/access-keys/${keyId}/data-limit`,
    body: { limit: { bytes } },
  });
}

export async function removeDataLimit(
  apiUrl: string,
  certSha256: string,
  keyId: string
): Promise<void> {
  await proxyFetch<unknown>({
    apiUrl,
    certSha256,
    method: "DELETE",
    path: `/access-keys/${keyId}/data-limit`,
  });
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export async function getTransferMetrics(
  apiUrl: string,
  certSha256: string
): Promise<TransferMetrics> {
  return proxyFetch<TransferMetrics>({
    apiUrl,
    certSha256,
    method: "GET",
    path: "/metrics/transfer",
  });
}
