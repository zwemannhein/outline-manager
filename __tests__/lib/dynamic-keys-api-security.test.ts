import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const RAW_URL = "ss://raw-credential@vpn.example:1234";

vi.mock("@/lib/api-utils", () => ({
  checkAuth: vi.fn(async () => ({ authenticated: true, username: "admin" })),
  handleApiError: vi.fn((error: unknown) => {
    throw error;
  }),
  successResponse: vi.fn((data: unknown) => Response.json(data)),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 })),
}));

vi.mock("@/lib/dynamic-keys", () => ({
  listDynamicRecords: vi.fn(async () => [{
    token: "a".repeat(32),
    name: "Customer",
    orderId: null,
    serverId: "server-1",
    outlineKeyId: "key-1",
    accessUrl: RAW_URL,
    status: "active",
    rev: 1,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    suspendedState: null,
    history: [],
  }]),
  buildDynamicUrl: vi.fn((token: string) => `ssconf://outline-manager.vercel.app/k/${token}`),
  pendingCleanupEntries: vi.fn(() => []),
}));

vi.mock("@/lib/key-meta", () => ({
  readAllKeyMeta: vi.fn(async () => ({})),
  metaField: vi.fn((serverId: string, keyId: string) => `${serverId}:${keyId}`),
  computeQuotaUsage: vi.fn(),
  describeQuota: vi.fn(),
}));

vi.mock("@/lib/kv-sync", () => ({
  getSyncState: vi.fn(async () => "synced"),
  getWriteBudget: vi.fn(async () => ({ used: 0, limit: 1000, remaining: 1000, warn: false })),
  countDirtyTokens: vi.fn(async () => 0),
}));

vi.mock("@/lib/outline-admin", () => ({
  listRegisteredServers: vi.fn(async () => [{ id: "server-1", name: "Server" }]),
  getTransferMetrics: vi.fn(async () => ({ bytesTransferredByUserId: { "key-1": 0 } })),
}));

import { GET } from "@/app/api/v1/dynamic-keys/route";

describe("dynamic customer API raw-key protection", () => {
  it("does not expose raw ss:// credentials through the former includeRaw query", async () => {
    const request = new NextRequest(
      "https://outline-manager.vercel.app/api/v1/dynamic-keys?includeRaw=true"
    );
    const response = await GET(request);
    const payload = await response.json() as { customers: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(payload.customers[0]).not.toHaveProperty("accessUrl");
    expect(JSON.stringify(payload)).not.toContain(RAW_URL);
    expect(JSON.stringify(payload)).not.toContain("ss://raw-credential");
  });
});
