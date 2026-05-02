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

export type Plan = "plan_a" | "plan_b";

export interface PlanInfo {
  id: Plan;
  label: string;
  description: string;
  price: string;
  dataLimit: number | null; // bytes, null = unlimited
  devices: string;
}

export const PLANS: PlanInfo[] = [
  {
    id: "plan_a",
    label: "Plan A",
    description: "1 Device / Unlimited Data",
    price: "15,000 MMK / month",
    dataLimit: null,
    devices: "1 device",
  },
  {
    id: "plan_b",
    label: "Plan B",
    description: "Unlimited Devices / 100 GB Data",
    price: "5,000 MMK / month",
    dataLimit: 100 * 1024 ** 3, // 100 GB in bytes
    devices: "Unlimited devices",
  },
];

export type OrderStatus = "pending" | "approved" | "rejected";

export interface Order {
  id: string;           // uuid
  name: string;         // customer name
  kpayRef: string;      // last 6 digits of KPay slip
  plan: Plan;
  status: OrderStatus;
  serverId: string | null;  // which server the key was created on
  keyId: string | null;     // Outline key ID after approval
  accessUrl: string | null; // ss:// URL after approval
  createdAt: number;        // Date.now()
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
