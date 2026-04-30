// ─── Server / Admin types ────────────────────────────────────────────────────

export interface OutlineServer {
  id: string;           // uuid generated on save
  name: string;         // friendly label
  apiUrl: string;       // e.g. https://1.2.3.4:12345/AbCdEf
  certSha256: string;   // hex fingerprint
  addedAt: number;      // Date.now()
}

export interface AccessKey {
  id: string;
  name: string;
  password: string;
  port: number;
  method: string;
  accessUrl: string;
  dataLimit?: { bytes: number };  // from GET /access-keys response
  limit?: { bytes: number };      // some Outline versions use "limit" instead of "dataLimit"
}

export interface ServerInfo {
  name: string;
  serverId: string;
  metricsEnabled: boolean;
  createdTimestampMs: number;
  version: string;
  portForNewAccessKeys: number;
  hostnameForAccessKeys: string;
}

export interface TransferMetrics {
  bytesTransferredByUserId: Record<string, number>;
}

/** Per-key metadata stored locally by the admin (expiry date etc.) */
export interface KeyMeta {
  expiryDate: string | null; // ISO date string or null = no expiry
}

// ─── User / SS types ─────────────────────────────────────────────────────────

export interface DecodedSsKey {
  host: string;
  port: number;
  method: string;
  password: string;
  keyId: string | null;
  tag: string | null;
  raw: string;
  // Embedded server credentials (added by admin's Share button)
  embeddedApiUrl?: string;
  embeddedCertSha256?: string;
}

export interface SsConfKey {
  server: string;
  server_port: number;
  method: string;
  password: string;
  prefix?: string;
}

// ─── Role ────────────────────────────────────────────────────────────────────

export type AppRole = "none" | "admin" | "user";

// ─── API proxy request/response ──────────────────────────────────────────────

export interface ProxyRequest {
  apiUrl: string;
  certSha256: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;         // e.g. "/access-keys"
  body?: unknown;
}

export interface ProxyError {
  error: string;
  status?: number;
}
