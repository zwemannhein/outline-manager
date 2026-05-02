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

export interface KeyMeta {
  expiryDate: string | null;
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
  accessUrl: string | null;
  createdAt: number;
  approvedAt: number | null;
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
