// ─── Server / Admin types ────────────────────────────────────────────────────

export interface OutlineServer {
  id: string;
  name: string;
  apiUrl: string;
  certSha256: string;
  addedAt: number;
}

export interface AccessKey {
  id: string;
  name: string;
  password: string;
  port: number;
  method: string;
  accessUrl: string;
  dataLimit?: { bytes: number };
  limit?: { bytes: number };
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

/**
 * Server-authoritative metadata for one Outline access key.
 *
 * Keyed `<serverId>:<outlineKeyId>` and stored ONLY in the server-owned
 * `outline_key_meta` Redis hash. It must never live inside the browser-writable
 * admin data blob, because these fields drive quota and expiry enforcement.
 *
 * `expiryDate` is retained at the top for backward compatibility with records
 * written before quota cycles existed.
 */
export interface KeyMeta {
  expiryDate: string | null;
  /** Quota per 30-day cycle in bytes. null = unlimited. */
  quotaBytes?: number | null;
  /** ISO anchor for the current cycle. Advances by exactly 30 days. */
  periodStart?: string | null;
  /** Bytes used on PREVIOUS keys during the current cycle (migration debt). */
  carriedBytes?: number;
  /** Number of 30-day cycles purchased. */
  cyclesTotal?: number;
  /** Cycles consumed so far, starting at 1 on approval. */
  cyclesUsed?: number;
  updatedAt?: string;
}

// ─── Dynamic (permanent) access key identity ──────────────────────────────────

/**
 * Lifecycle state of a permanent customer identity.
 *
 * Only `active` resolves in the public Cloudflare Worker. `expired` and
 * `disabled` both block service but keep the token reserved so a renewal reuses
 * the same ssconf:// URL. `revoked` is a tombstone.
 */
export type DynamicKeyStatus = "active" | "disabled" | "expired" | "revoked";

/** Why an identity was suspended, so reactivation can restore correctly. */
export interface SuspendedState {
  /** Outline data limit before suspension. null means it was unlimited. */
  previousLimitBytes: number | null;
  suspendedAt: string;
  reason: "manual" | "expiry";
  /** True when the underlying Outline key was removed rather than limited. */
  keyRemoved: boolean;
}

export interface DynamicHistoryEntry {
  serverId: string;
  outlineKeyId: string;
  at: string;
  reason: "migrate" | "reactivate" | "replace";
  /** False while the superseded Outline key still exists. */
  cleanedUp: boolean;
}

/**
 * The authoritative permanent customer identity. Upstash is the source of truth;
 * Cloudflare KV holds only a slim public projection of it.
 */
export interface DynamicKeyRecord {
  token: string;
  orderId: string | null;
  serverId: string;
  outlineKeyId: string;
  /** Raw ss:// URL. Internal/admin only, never customer-facing. */
  accessUrl: string;
  /** Customer display name, carried in the OUTER ssconf fragment. */
  name: string;
  status: DynamicKeyStatus;
  /** Monotonic revision, incremented whenever the public projection changes. */
  rev: number;
  createdAt: string;
  updatedAt: string;
  suspendedState: SuspendedState | null;
  history: DynamicHistoryEntry[];
}

/** The only fields the public Worker needs. Deliberately excludes the name. */
export interface DynamicKeyProjection {
  accessUrl: string;
  status: DynamicKeyStatus;
  rev: number;
  updatedAt: string;
}

// ─── Phase 2: Orders ─────────────────────────────────────────────────────────

export type Plan = string; // dynamic plan IDs set by admin

export interface PlanInfo {
  id: string;
  label: string;           // e.g. "Plan A"
  description: string;     // e.g. "1 Device / Unlimited Data"
  price: string;           // e.g. "15,000 MMK"
  dataLimitGB: number | null; // null = unlimited, number = GB
  devices: string;         // e.g. "1 device"
  enabled: boolean;
}

export const DEFAULT_PLANS: PlanInfo[] = [
  {
    id: "plan_a",
    label: "Plan A",
    description: "1 Device / Unlimited Data",
    price: "15,000 MMK",
    dataLimitGB: null,
    devices: "1 device",
    enabled: true,
  },
  {
    id: "plan_b",
    label: "Plan B",
    description: "Unlimited Devices / 100 GB Data",
    price: "5,000 MMK",
    dataLimitGB: 100,
    devices: "Unlimited devices",
    enabled: true,
  },
];

export type OrderStatus = "pending" | "approved" | "rejected";

export interface Order {
  id: string;
  name: string;
  kpayRef: string;
  plan: Plan;
  customDataLimitGB?: number | null; // null = unlimited
  customMonths?: number | null;
  customDevices?: string | null;
  status: OrderStatus;
  serverId: string | null;
  keyId: string | null;
  /** Raw ss:// URL. Internal/admin only — never returned to a customer. */
  accessUrl: string | null;
  createdAt: number;
  approvedAt: number | null;
  /**
   * SHA-256 of the customer's order claim token. The raw token is returned once
   * at creation and never stored, so the order id alone is not a credential.
   */
  claimHash?: string | null;
  /** Permanent dynamic identity issued on approval. */
  dynamicToken?: string | null;
  /** Set when approval needs a human to resolve ambiguous orphan keys. */
  needsReconciliation?: boolean;
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

export type AppRole = "none" | "admin" | "user";

export interface ProxyRequest {
  apiUrl: string;
  certSha256: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
}

export interface ProxyError {
  error: string;
  status?: number;
}
