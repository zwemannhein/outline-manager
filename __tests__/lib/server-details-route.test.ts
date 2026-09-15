import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resolveServer: vi.fn(),
  getServerInfo: vi.fn(),
  listAccessKeys: vi.fn(),
  getTransferMetrics: vi.fn(),
  listDynamicRecords: vi.fn(),
  getTokenByOutlineKey: vi.fn(),
}));

vi.mock("@/lib/api-utils", () => ({
  checkAuth: vi.fn(async () => ({ authenticated: true, username: "admin" })),
  successResponse: vi.fn((data: unknown) => Response.json(data)),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 })),
  handleApiError: vi.fn(() => new Response(null, { status: 500 })),
  AppError: class AppError extends Error {},
}));

vi.mock("@/lib/outline-admin", () => ({
  resolveServer: mocks.resolveServer,
  getServerInfo: mocks.getServerInfo,
  listAccessKeys: mocks.listAccessKeys,
  getTransferMetrics: mocks.getTransferMetrics,
}));

vi.mock("@/lib/dynamic-keys", () => ({
  listDynamicRecords: mocks.listDynamicRecords,
  getTokenByOutlineKey: mocks.getTokenByOutlineKey,
}));

import { GET } from "@/app/api/v1/servers/[serverId]/details/route";

const request = new NextRequest(
  "https://outline-manager.vercel.app/api/v1/servers/server-1/details"
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveServer.mockResolvedValue({ id: "server-1", name: "Server" });
  mocks.getServerInfo.mockResolvedValue({
    name: "Server",
    version: "1.12.3",
    metricsEnabled: true,
  });
  mocks.getTransferMetrics.mockResolvedValue({ bytesTransferredByUserId: {} });
});

describe("server details route", () => {
  it("does not report a string customer key missing when Outline returns a numeric ID", async () => {
    mocks.listAccessKeys.mockResolvedValue([{ id: 30 }]);
    mocks.listDynamicRecords.mockResolvedValue([
      { serverId: "server-1", outlineKeyId: "30", status: "active" },
    ]);
    mocks.getTokenByOutlineKey.mockResolvedValue("a".repeat(32));

    const response = await GET(request, { params: { serverId: "server-1" } });
    const data = await response.json();

    expect(data.missingKeys).toBe(0);
    expect(data.unmanagedKeys).toBe(0);
    expect(data.customerDataAvailable).toBe(true);
    expect(mocks.getTokenByOutlineKey).toHaveBeenCalledWith("server-1", "30");
  });

  it("marks customer-derived counts unavailable instead of treating every Outline key as unmanaged", async () => {
    mocks.listAccessKeys.mockResolvedValue([{ id: 30 }]);
    mocks.listDynamicRecords.mockRejectedValue(new Error("Redis unavailable"));

    const response = await GET(request, { params: { serverId: "server-1" } });
    const data = await response.json();

    expect(data.status).toBe("warning");
    expect(data.customerDataAvailable).toBe(false);
    expect(data.missingKeys).toBe(0);
    expect(data.unmanagedKeys).toBe(0);
    expect(data.detail).toContain("Customer records unavailable");
    expect(mocks.getTokenByOutlineKey).not.toHaveBeenCalled();
  });
});
