"use client";

import React, { useState, useEffect, useCallback } from "react";
import { ServerSidebar } from "./ServerSidebar";
import { ServerDashboard } from "./ServerDashboard";
import { AddServerDialog } from "./Dialogs";
import { addServer, loadServers, removeServer, updateServerName } from "@/lib/storage";
import { fetchAdminData, saveLocalData, loadLocalData } from "@/lib/sync";
import { uuid } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { LogOut, Menu, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [syncing, setSyncing] = useState(true);

  // On mount: always fetch from KV first — this is what syncs across devices
  useEffect(() => {
    setSyncing(true);
    fetchAdminData()
      .then((data) => {
        saveLocalData(data);
        setServers(data.servers);
        // Keep the previously active server if it still exists, else pick first
        setActiveId((prev) => {
          if (prev && data.servers.find((s) => s.id === prev)) return prev;
          return data.servers[0]?.id ?? "";
        });
      })
      .catch(() => {
        // KV failed — load from localStorage
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
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
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
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header className="flex items-center justify-between px-4 py-3 border-b bg-card shrink-0">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
            <span className="font-semibold text-sm truncate max-w-[160px] sm:max-w-none">
              {activeServer?.name ?? "Outline VPN Manager"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="w-4 h-4 mr-1.5" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>

        {/* Dashboard */}
        {activeServer ? (
          <ServerDashboard
            key={activeServer.id}
            server={activeServer}
            onOnlineChange={handleOnlineChange}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3 text-muted-foreground">
              <p className="text-sm">No servers configured yet.</p>
              <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
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
    </div>
  );
}
