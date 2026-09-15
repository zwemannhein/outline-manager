import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  fetchDynamicCustomers: vi.fn(),
  resetCustomerUsage: vi.fn(),
  disableCustomer: vi.fn(),
}));

vi.mock("@/lib/sync", () => ({
  ...mocks,
  disableCustomer: mocks.disableCustomer,
  enableCustomer: vi.fn(),
  migrateCustomer: vi.fn(),
  cleanupCustomerMigration: vi.fn(),
  revealRawKey: vi.fn(),
  resyncCustomer: vi.fn(),
  editCustomerSubscription: vi.fn(),
  createAdminCustomer: vi.fn(),
  deleteAdminCustomer: vi.fn(),
}));

import { CustomersPanel } from "@/components/admin/CustomersPanel";

const GIB = 1024 * 1024 * 1024;
const TOKEN = "a".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchDynamicCustomers.mockResolvedValue({
    customers: [{
      token: TOKEN,
      name: "Ko Aung",
      orderId: "ord_1",
      serverId: "srv-a",
      serverName: "Server A",
      outlineKeyId: "key-1",
      status: "active",
      rev: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      dynamicUrl: `ssconf://outline-manager.vercel.app/k/${TOKEN}#Ko%20Aung`,
      configuredQuotaBytes: 100 * GIB,
      quotaBytes: 100 * GIB,
      usedBytes: 100 * GIB,
      carriedBytes: 0,
      remainingBytes: 0,
      quotaExhausted: true,
      planDescription: "100 GB every 30 days",
      periodStart: "2026-08-01T00:00:00.000Z",
      expiryDate: "2026-10-01T00:00:00.000Z",
      cyclesTotal: 2,
      cyclesUsed: 1,
      syncState: "synced",
      suspendedState: null,
      cleanupPending: false,
      orphaned: false,
    }],
    health: {
      kvWritesUsedToday: 0,
      kvWriteLimit: 1000,
      kvWritesRemaining: 1000,
      kvBudgetWarning: false,
      pendingEdgeSyncs: 0,
    },
  });
  mocks.resetCustomerUsage.mockResolvedValue({
    ok: true,
    quotaBytes: 100 * GIB,
    periodStart: "2026-09-10T00:00:00.000Z",
    usedBytes: 0,
    urlChanged: false,
  });
  mocks.disableCustomer.mockResolvedValue({ ok: true, status: "disabled", syncPending: false });
});

afterEach(() => cleanup());

describe("customer usage reset UI", () => {
  it("renders a reachable reset button and explains the exact effect", async () => {
    const user = userEvent.setup();
    render(<CustomersPanel servers={[{ id: "srv-a", name: "Server A" }]} />);

    const reset = await screen.findByRole("button", { name: /reset usage/i });
    expect(reset).toBeEnabled();
    await user.click(reset);

    expect(screen.getByRole("dialog", { name: /reset data usage/i })).toBeInTheDocument();
    expect(screen.getByText(/starts a new 30-day data period now/i)).toBeInTheDocument();
    expect(screen.getByText(/expiry date is not extended/i)).toBeInTheDocument();
    expect(screen.getByText(/permanent key does not change/i)).toBeInTheDocument();
  });

  it("calls reset for the same token and updates displayed usage to zero", async () => {
    const user = userEvent.setup();
    render(<CustomersPanel servers={[{ id: "srv-a", name: "Server A" }]} />);

    await user.click(await screen.findByRole("button", { name: /reset usage/i }));
    const buttons = screen.getAllByRole("button", { name: /reset usage/i });
    await user.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(mocks.resetCustomerUsage).toHaveBeenCalledWith(TOKEN));
    await waitFor(() => expect(screen.getByText("0 B / 100 GB")).toBeInTheDocument());
  });

  it("surfaces a missing key and keeps the recovery disable action available", async () => {
    const payload = await mocks.fetchDynamicCustomers();
    payload.customers[0].orphaned = true;
    payload.customers[0].quotaExhausted = false;
    payload.customers[0].usedBytes = 50 * GIB;
    payload.customers[0].remainingBytes = 50 * GIB;
    mocks.fetchDynamicCustomers.mockResolvedValue(payload);

    render(<CustomersPanel servers={[{ id: "srv-a", name: "Server A" }]} />);

    expect(await screen.findByText("Missing key")).toBeInTheDocument();
    expect(screen.getByText(/disable, then enable this customer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^disable$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /reset usage/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /migrate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /permanent key not ready/i })).toBeDisabled();
  });

  it("shows quota exhaustion as the primary status even when key recovery is also needed", async () => {
    const payload = await mocks.fetchDynamicCustomers();
    payload.customers[0].orphaned = true;
    mocks.fetchDynamicCustomers.mockResolvedValue(payload);

    render(<CustomersPanel servers={[{ id: "srv-a", name: "Server A" }]} />);

    expect(await screen.findByText("Quota exhausted")).toBeInTheDocument();
    expect(screen.queryByText("Missing key")).not.toBeInTheDocument();
    expect(screen.getByText(/key recovery is also required/i)).toBeInTheDocument();
  });

  it("shows expiry as the primary status even when key recovery is also needed", async () => {
    const payload = await mocks.fetchDynamicCustomers();
    payload.customers[0].status = "expired";
    payload.customers[0].orphaned = true;
    mocks.fetchDynamicCustomers.mockResolvedValue(payload);

    render(<CustomersPanel servers={[{ id: "srv-a", name: "Server A" }]} />);

    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(screen.queryByText("Missing key")).not.toBeInTheDocument();
    expect(screen.getByText(/key recovery is also required/i)).toBeInTheDocument();
  });
});
