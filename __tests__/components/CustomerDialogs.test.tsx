import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditSubscriptionDialog } from "@/components/admin/CustomerDialogs";
import type { DynamicCustomerRow } from "@/lib/sync";

const customer: DynamicCustomerRow = {
  token: "a".repeat(32),
  name: "Ko Aung",
  orderId: null,
  serverId: "srv-a",
  serverName: "Server A",
  outlineKeyId: "key-1",
  status: "active",
  rev: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  dynamicUrl: "ssconf://outline-manager.vercel.app/k/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#Ko%20Aung",
  configuredQuotaBytes: 50 * 1024 ** 3,
  quotaBytes: 50 * 1024 ** 3,
  usedBytes: 0,
  carriedBytes: 0,
  remainingBytes: 50 * 1024 ** 3,
  quotaExhausted: false,
  planDescription: "50 GB every 30 days",
  periodStart: "2026-01-01T00:00:00.000Z",
  expiryDate: "2099-01-01T23:59:59.000Z",
  cyclesTotal: 1,
  cyclesUsed: 1,
  syncState: "synced",
  suspendedState: null,
  cleanupPending: false,
  orphaned: false,
};

describe("EditSubscriptionDialog quick plans", () => {
  it("sets the one-month 100 GB preset", async () => {
    const user = userEvent.setup();
    render(
      <EditSubscriptionDialog
        customer={customer}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    const plan = screen.getByRole("button", { name: /1 month \+ 100 gb/i });
    await user.click(plan);

    const expectedExpiry = new Date();
    expectedExpiry.setUTCDate(expectedExpiry.getUTCDate() + 30);

    expect(screen.getByLabelText("Quota")).toHaveValue(100);
    expect(screen.getByLabelText("Expiry Date")).toHaveValue(expectedExpiry.toISOString().slice(0, 10));
    expect(plan).toHaveAttribute("aria-pressed", "true");
    expect(plan).toHaveTextContent("Selected");

    await user.clear(screen.getByLabelText("Expiry Date"));
    expect(plan).toHaveAttribute("aria-pressed", "false");
  });
});
