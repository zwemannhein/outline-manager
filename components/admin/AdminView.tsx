"use client";

import React, { useState, useEffect, useCallback } from "react";
import { ServerSidebar } from "./ServerSidebar";
import { ServerDashboard } from "./ServerDashboard";
import { AddServerDialog } from "./Dialogs";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { FirstRunPasswordSetup } from "./FirstRunPasswordSetup";
import { SettingsPanel } from "./SettingsPanel";
import { MonitoringPanel } from "./MonitoringPanel";
import { addServer, removeServer, updateServerName } from "@/lib/storage";
import {
  fetchAdminData,
  saveLocalData,
  loadLocalData,
  pushAdminData,
  getAuthHeader,
  fetchSessionInfo,
} from "@/lib/sync";
import { uuid } from "@/lib/utils";
import { resolveServerSelection, resolveSelectionAfterRemoval } from "@/lib/server-selection";
import { useToast } from "@/hooks/use-toast";
import {
  LogOut, Menu, X, RefreshCw, ShoppingBag, Server, KeyRound, Users, Settings, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrdersPanel } from "./OrdersPanel";
import { CustomersPanel } from "./CustomersPanel";
import type { OutlineServer } from "@/lib/types";

interface AdminViewProps {
  onLogout: () => void;
}

type AdminTab = "servers" | "customers" | "orders" | "settings" | "monitoring";

const TABS: Array<{ id: AdminTab; label: string; icon: React.ReactNode }> = [
  { id: "servers",    label: "Servers",    icon: <Server      className="w-4 h-4" /> },
  { id: "customers",  label: "Customers",  icon: <Users       className="w-4 h-4" /> },
  { id: "orders",     label: "Orders",     icon: <ShoppingBag className="w-4 h-4" /> },
  { id: "monitoring", label: "Monitoring", icon: <Activity    className="w-4 h-4" /> },
  { id: "settings",   label: "Settings",   icon: <Settings    className="w-4 h-4" /> },
];

export function AdminView({ onLogout }: AdminViewProps) {
  const { toast } = useToast();
  const [servers, setServers] = useState<OutlineServer[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [activeTab, setActiveTab] = useState<AdminTab>("servers");

  const [passwordSetupRequired, setPasswordSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessionInfo()
      .then((info) => { if (!cancelled) setPasswordSetupRequired(info.passwordChangeRequired); })
      .catch(() => { if (!cancelled) setPasswordSetupRequired(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Hydrate the stable sidebar immediately from the local cache while the
    // server copy refreshes in the background.
    const cached = loadLocalData();
    if (cached.servers.length > 0) {
      setServers(cached.servers);
      setActiveId((prev) => resolveServerSelection(prev, cached.servers));
    }
    setSyncing(true);
    fetchAdminData()
      .then((kvData) => {
        let data = kvData;
        if (data.servers.length === 0) {
          const local = loadLocalData();
          if (local.servers.length > 0) {
            pushAdminData(local).catch(() => {});
            data = local;
          }
        }
        saveLocalData(data);
        setServers(data.servers);
        setActiveId((prev) => resolveServerSelection(prev, data.servers));
      })
      .catch(() => {
        const local = loadLocalData();
        setServers(local.servers);
        setActiveId((prev) => resolveServerSelection(prev, local.servers));
      })
      .finally(() => setSyncing(false));
  }, []);

  const handleOnlineChange = useCallback((id: string, online: boolean) => {
    setOnlineIds((prev) => {
      const next = new Set(prev);
      online ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  function handleAddServer(apiUrl: string, certSha256: string, name: string) {
    setShowAddDialog(false);
    const newServer: OutlineServer = { id: uuid(), name, apiUrl, certSha256, addedAt: Date.now() };
    const updated = addServer(newServer);
    setServers(updated);
    setActiveId(newServer.id);
    toast({ title: "Server added", description: name });
  }

  function handleRemoveServer(id: string) {
    const previous = servers;
    const updated = removeServer(id);
    setServers(updated);
    setActiveId((current) => resolveSelectionAfterRemoval(current, id, previous, updated));
    toast({ title: "Server removed" });
  }

  function handleRenameServer(id: string, newName: string) {
    const updated = updateServerName(id, newName);
    setServers(updated);
    toast({ title: "Server renamed", description: newName });
  }

  const activeServer = servers.find((s) => s.id === activeId) ?? null;
  const authHeader = getAuthHeader();

  if (passwordSetupRequired === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center space-y-3 text-muted-foreground">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto" />
          <p className="text-sm">Checking account…</p>
        </div>
      </div>
    );
  }

  if (passwordSetupRequired) {
    return (
      <FirstRunPasswordSetup
        onComplete={() => setPasswordSetupRequired(false)}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="relative flex h-[100dvh] overflow-hidden bg-slate-50 dark:bg-slate-950">

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Server sidebar — only shown on Servers tab */}
      {activeTab === "servers" && (
        <div
          className={`
            fixed inset-y-0 left-0 z-30 md:static md:z-auto
            transform transition-transform duration-200
            ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
          `}
        >
          <ServerSidebar
            servers={servers}
            activeId={activeId}
            onlineIds={onlineIds}
            loading={syncing}
            onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
            onAdd={() => setShowAddDialog(true)}
            onRemove={handleRemoveServer}
            onRename={handleRenameServer}
          />
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 relative">
        {/* Top bar */}
        <header className="relative flex min-h-16 items-center justify-between border-b bg-white/95 px-2.5 py-2 shadow-sm shadow-slate-900/[0.03] backdrop-blur-md dark:bg-slate-950/95 sm:px-5">
          <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-1">
            {/* Hamburger — only on Servers tab where sidebar exists */}
            {activeTab === "servers" && (
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden hover:bg-white/50 dark:hover:bg-gray-800/50 shrink-0 min-w-[44px] min-h-[44px]"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label="Toggle server list"
              >
                {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </Button>
            )}

            {/* Tab bar — scrollable on very small screens */}
            <nav
              className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 scrollbar-none dark:bg-slate-900"
              aria-label="Admin navigation"
            >
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-label={tab.label}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`
                    flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors sm:px-3 sm:text-sm
                    ${activeTab === tab.id
                      ? "bg-white text-primary shadow-sm dark:bg-slate-800 dark:text-blue-300"
                      : "text-muted-foreground hover:bg-white/70 hover:text-foreground dark:hover:bg-slate-800/70"
                    }
                  `}
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          {/* Right-side actions */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowChangePassword(true)}
              className="hover:bg-white/50 dark:hover:bg-gray-800/50 min-h-[44px] px-2 sm:px-3"
              aria-label="Change password"
            >
              <KeyRound className="w-4 h-4" />
              <span className="hidden md:inline ml-1.5">Password</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onLogout}
              className="hover:bg-white/50 dark:hover:bg-gray-800/50 min-h-[44px] px-2 sm:px-3"
              aria-label="Sign out"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden md:inline ml-1.5">Sign out</span>
            </Button>
          </div>
        </header>

        {/* Content area */}
        {activeTab === "orders" ? (
          <OrdersPanel
            authHeader={authHeader}
            servers={servers.map((s) => ({ id: s.id, name: s.name }))}
          />
        ) : activeTab === "customers" ? (
          <CustomersPanel servers={servers.map((s) => ({ id: s.id, name: s.name }))} />
        ) : activeTab === "settings" ? (
          <SettingsPanel />
        ) : activeTab === "monitoring" ? (
          <MonitoringPanel />
        ) : activeServer ? (
          <ServerDashboard
            key={activeServer.id}
            server={activeServer}
            onOnlineChange={handleOnlineChange}
          />
        ) : syncing ? (
          <div className="relative flex-1 p-4 sm:p-6 lg:p-8" aria-label="Loading server details">
            <div className="mx-auto max-w-6xl space-y-4 animate-pulse">
              <div className="h-8 w-48 rounded-lg bg-muted" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[1, 2, 3].map((item) => <div key={item} className="admin-card h-24 bg-muted/50" />)}
              </div>
              <div className="admin-card h-48 bg-muted/40" />
            </div>
          </div>
        ) : (
          <div className="relative flex-1 flex items-center justify-center p-4">
            <div className="text-center space-y-4 text-muted-foreground">
              <div className="p-4 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg mx-auto w-fit">
                <Server className="w-8 h-8 text-white" />
              </div>
              <p className="text-sm font-medium">No servers configured yet.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddDialog(true)}
                className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white border-0 shadow-lg"
              >
                Add your first server
              </Button>
            </div>
          </div>
        )}
      </div>

      <AddServerDialog
        open={showAddDialog}
        onConfirm={handleAddServer}
        onClose={() => setShowAddDialog(false)}
      />

      <ChangePasswordDialog
        open={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
    </div>
  );
}
