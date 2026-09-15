import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const SERVER = {
  id: "server-1",
  name: "Production server",
  apiUrl: "https://outline.invalid/secret",
  certSha256: "fingerprint",
  addedAt: 1,
};

vi.mock("@/lib/sync", () => ({
  fetchSessionInfo: vi.fn(async () => ({ passwordChangeRequired: false })),
  fetchAdminData: vi.fn(async () => ({ servers: [SERVER] })),
  saveLocalData: vi.fn(),
  loadLocalData: vi.fn(() => ({ servers: [] })),
  pushAdminData: vi.fn(),
  getAuthHeader: vi.fn(() => ({})),
}));

vi.mock("@/lib/storage", () => ({
  addServer: vi.fn(() => [SERVER]),
  removeServer: vi.fn(() => []),
  updateServerName: vi.fn(() => [SERVER]),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/admin/ServerSidebar", () => ({
  ServerSidebar: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <aside aria-label="Server sidebar">
      <button onClick={() => onSelect(SERVER.id)}>Production server</button>
    </aside>
  ),
}));
vi.mock("@/components/admin/ServerDashboard", () => ({
  ServerDashboard: () => <div>Server dashboard</div>,
}));
vi.mock("@/components/admin/CustomersPanel", () => ({
  CustomersPanel: () => <div>Customer management</div>,
}));
vi.mock("@/components/admin/OrdersPanel", () => ({ OrdersPanel: () => <div>Orders</div> }));
vi.mock("@/components/admin/MonitoringPanel", () => ({ MonitoringPanel: () => <div>Monitoring</div> }));
vi.mock("@/components/admin/SettingsPanel", () => ({ SettingsPanel: () => <div>Settings</div> }));
vi.mock("@/components/admin/Dialogs", () => ({ AddServerDialog: () => null }));
vi.mock("@/components/admin/ChangePasswordDialog", () => ({ ChangePasswordDialog: () => null }));
vi.mock("@/components/admin/FirstRunPasswordSetup", () => ({ FirstRunPasswordSetup: () => null }));

import { AdminView } from "@/components/admin/AdminView";

afterEach(() => cleanup());

describe("AdminView server navigation", () => {
  it("omits the duplicate top Servers tab while keeping server management reachable", async () => {
    const user = userEvent.setup();
    render(<AdminView onLogout={vi.fn()} />);

    expect(await screen.findByText("Server dashboard")).toBeInTheDocument();
    const topNav = screen.getByRole("navigation", { name: "Admin navigation" });
    expect(within(topNav).queryByRole("button", { name: "Servers" })).not.toBeInTheDocument();

    await user.click(within(topNav).getByRole("button", { name: "Customers" }));
    expect(await screen.findByText("Customer management")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Production server" }));
    await waitFor(() => expect(screen.getByText("Server dashboard")).toBeInTheDocument());
  });
});
