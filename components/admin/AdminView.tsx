"use client";

import React, { useState, useEffect, useCallback } from "react";
import { ServerSidebar } from "./ServerSidebar";
import { ServerDashboard } from "./ServerDashboard";
import { AddServerDialog } from "./Dialogs";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { FirstRunPasswordSetup } from "./FirstRunPasswordSetup";
import { addServer, loadServers, removeServer, updateServerName } from "@/lib/storage";
import {
  fetchAdminData,
  saveLocalData,
  loadLocalData,
  pushAdminData,
  getAuthHeader,
  fetchSessionInfo,
} from "@/lib/sync";
import { uuid } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { LogOut, Menu, X, RefreshCw, ShoppingBag, Server, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrdersPanel } from "./OrdersPanel";
import type { OutlineServer } from "@/lib/types";

interface AdminViewProps {
  onLogout: () => void;
}

export function AdminView({ onLogout }: AdminViewProps) {
  const { toast } = useToast();
  const [servers, setServers] = useState<OutlineServer[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [activeTab, setActiveTab] = useState<"servers" | "orders">("servers");

  // Server-authoritative check for outstanding first-run password setup.
  // null = still checking, so the dashboard is never rendered prematurely.
  const [passwordSetupRequired, setPasswordSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessionInfo()
      .then((info) => {
        if (!cancelled) setPasswordSetupRequired(info.passwordChangeRequired);
      })
      .catch(() => {
        // Fail safe: if the check cannot complete, require setup rather than
        // silently granting normal dashboard access.
        if (!cancelled) setPasswordSetupRequired(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // On mount: always fetch from KV first — this is what syncs across devices
  useEffect(() => {
    setSyncing(true);
    fetchAdminData()
      .then((kvData) => {
        let data = kvData;
        // If KV returned empty but we have local data, push local up to KV
        if (data.servers.length === 0) {
          const local = loadLocalData();
          if (local.servers.length > 0) {
            pushAdminData(local).catch(() => {});
            data = local;
          }
        }
        saveLocalData(data);
        setServers(data.servers);
        setActiveId((prev) => {
          if (prev && data.servers.find((s) => s.id === prev)) return prev;
          return data.servers[0]?.id ?? "";
        });
      })
      .catch(() => {
        const local = loadLocalData();
        setServers(local.servers);
        setActiveId(local.servers[0]?.id ?? "");
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
    const newServer: OutlineServer = {
      id: uuid(),
      name,
      apiUrl,
      certSha256,
      addedAt: Date.now(),
    };
    const updated = addServer(newServer);
    setServers(updated);
    setActiveId(newServer.id);
    toast({ title: "Server added", description: name });
  }

  function handleRemoveServer(id: string) {
    const updated = removeServer(id);
    setServers(updated);
    if (activeId === id) {
      setActiveId(updated[0]?.id ?? "");
    }
    toast({ title: "Server removed" });
  }

  function handleRenameServer(id: string, newName: string) {
    const updated = updateServerName(id, newName);
    setServers(updated);
    toast({ title: "Server renamed", description: newName });
  }

  const activeServer = servers.find((s) => s.id === activeId) ?? null;

  // Auth header for API calls. Reads the JWT written at login; the previous
  // implementation looked up a key that is never set, so this was always empty.
  const authHeader = getAuthHeader();

  // Wait for the password-provenance check before rendering anything, so the
  // dashboard is never briefly visible when setup is still required.
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

  // Forced first-run setup: blocks all normal dashboard usage.
  if (passwordSetupRequired) {
    return (
      <FirstRunPasswordSetup
        onComplete={() => setPasswordSetupRequired(false)}
        onLogout={onLogout}
      />
    );
  }

  // Show a brief loading screen while fetching from KV
  if (syncing) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center space-y-3 text-muted-foreground">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto" />
          <p className="text-sm">Syncing server list…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 dark:from-gray-900 dark:via-purple-900/20 dark:to-blue-900/20 relative">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 -left-4 w-96 h-96 bg-purple-300 dark:bg-purple-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob" />
        <div className="absolute top-0 -right-4 w-96 h-96 bg-blue-300 dark:bg-blue-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob animation-delay-2000" />
        <div className="absolute -bottom-8 left-20 w-96 h-96 bg-pink-300 dark:bg-pink-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob animation-delay-4000" />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed inset-y-0 left-0 z-30 lg:static lg:z-auto
          transform transition-transform duration-200
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        <ServerSidebar
          servers={servers}
          activeId={activeId}
          onlineIds={onlineIds}
          onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
          onAdd={() => setShowAddDialog(true)}
          onRemove={handleRemoveServer}
          onRename={handleRenameServer}
        />
      </div>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 relative">
        {/* Top bar */}
        <header className="relative flex items-center justify-between px-4 py-3 backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border-b border-white/20 shrink-0 shadow-sm">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden hover:bg-white/50 dark:hover:bg-gray-800/50"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
            {/* Tab switcher */}
            <div className="flex items-center gap-1 backdrop-blur-sm bg-white/50 dark:bg-gray-800/50 rounded-lg p-1">
              <button
                onClick={() => setActiveTab("servers")}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  activeTab === "servers"
                    ? "bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Servers
              </button>
              <button
                onClick={() => setActiveTab("orders")}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                  activeTab === "orders"
                    ? "bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <ShoppingBag className="w-3.5 h-3.5" />
                Orders
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowChangePassword(true)}
              className="hover:bg-white/50 dark:hover:bg-gray-800/50"
            >
              <KeyRound className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Change Password</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={onLogout} className="hover:bg-white/50 dark:hover:bg-gray-800/50">
              <LogOut className="w-4 h-4 mr-1.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        {/* Content */}
        {activeTab === "orders" ? (
          <OrdersPanel authHeader={authHeader} servers={servers.map((s) => ({ id: s.id, name: s.name }))} />
        ) : activeServer ? (
          <ServerDashboard
            key={activeServer.id}
            server={activeServer}
            onOnlineChange={handleOnlineChange}
          />
        ) : (
          <div className="relative flex-1 flex items-center justify-center">
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
