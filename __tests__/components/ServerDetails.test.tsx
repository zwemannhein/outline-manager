import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const SERVER = {
  id: "server-1",
  name: "Production server",
  apiUrl: "https://outline.invalid/secret-management-path",
  certSha256: "AA:BB:CC:DD",
  addedAt: 1,
};

const DETAILS = {
  serverId: "server-1",
  name: "Prod Outline",
  online: true,
  status: "healthy" as const,
  version: "1.11.0",
  metricsEnabled: true,
  totalKeys: 12,
  totalDataUsedBytes: 1610612736, // 1.5 GiB
  managedCustomers: 10,
  activeCustomers: 8,
  disabledCustomers: 1,
  expiredCustomers: 1,
  unmanagedKeys: 2,
  missingKeys: 0,
  customerDataAvailable: true,
  checkedAt: new Date().toISOString(),
};

const fetchServerDetails = vi.fn(async () => DETAILS);

vi.mock("@/lib/sync", () => ({
  fetchServerDetails: (...args: unknown[]) => fetchServerDetails(...(args as [])),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ServerDetails } from "@/components/admin/ServerDetails";

afterEach(() => {
  cleanup();
  fetchServerDetails.mockClear();
});

describe("ServerDetails (read-only)", () => {
  it("renders the required safe operational metrics", async () => {
    render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Total Outline keys")).toBeInTheDocument());
    expect(screen.getByText("12")).toBeInTheDocument();               // total keys
    expect(screen.getByText("Outline version")).toBeInTheDocument();
    expect(screen.getByText("1.11.0")).toBeInTheDocument();
    expect(screen.getByText("Managed customers")).toBeInTheDocument();
    expect(screen.getByText("Active customers")).toBeInTheDocument();
    expect(screen.getByText("Disabled customers")).toBeInTheDocument();
    expect(screen.getByText("Expired customers")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();          // metrics
  });

  it("has no raw key mutation buttons", async () => {
    render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Total Outline keys")).toBeInTheDocument());

    for (const label of [/new key/i, /rename key/i, /set data limit/i, /set expiry/i, /delete key/i, /create key/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("shows unmanaged-key guidance pointing to Customers → Add → Use Existing Outline Key", async () => {
    render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/unmanaged Outline key/i)).toBeInTheDocument());
    expect(screen.getByText(/Use Existing Outline Key/i)).toBeInTheDocument();
  });

  it("never renders the management API URL or cert fingerprint", async () => {
    const { container } = render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Total Outline keys")).toBeInTheDocument());

    const html = container.innerHTML;
    expect(html).not.toContain("secret-management-path");
    expect(html).not.toContain("outline.invalid");
    expect(html).not.toContain("AA:BB:CC:DD");
    // No ss:// raw key is rendered.
    expect(html).not.toContain("ss://");
  });

  it("has a manual Refresh button", async () => {
    render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Total Outline keys")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("hides customer-derived counts when customer records are unavailable", async () => {
    fetchServerDetails.mockResolvedValueOnce({
      ...DETAILS,
      customerDataAvailable: false,
      managedCustomers: 0,
      activeCustomers: 0,
      disabledCustomers: 0,
      expiredCustomers: 0,
      unmanagedKeys: 0,
      missingKeys: 0,
    });

    render(<ServerDetails server={SERVER} onOnlineChange={vi.fn()} />);

    expect(await screen.findByText(/Customer records are temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/unmanaged Outline key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reference an Outline key that no longer exists/i)).not.toBeInTheDocument();
  });
});
