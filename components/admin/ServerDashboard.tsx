"use client";

import React, { useEffect, useState, useCallback } from "react";
import { RefreshCw, AlertCircle, Server, Users, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyTable } from "./KeyTable";
import {
  RenameKeyDialog, SetLimitDialog, CreateKeyDialog,
  ConfirmDeleteDialog, SetExpiryDialog,
} from "./Dialogs";
import {
  getServerInfo, listAccessKeys, getTransferMetrics,
  createAccessKey, deleteAccessKey, renameAccessKey,
  setDataLimit, removeDataLimit,
} from "@/lib/outline-client";
import {
  getKeyMeta, setKeyMeta, deleteKeyMeta,
} from "@/lib/storage";
import { formatBytes } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { OutlineServer, AccessKey, ServerInfo, KeyMeta } from "@/lib/types";

interface ServerDashboardProps {
  server: OutlineServer;
  onOnlineChange: (id: string, online: boolean) => void;
}

type DialogState =
  | { type: "none" }
  | { type: "create" }
  | { type: "rename"; keyId: string; currentName: string }
  | { type: "limit"; keyId: string; currentBytes?: number }
  | { type: "expiry"; keyId: string; keyName: string; currentExpiry: string | null }
  | { type: "delete"; keyId: string; keyName: string };

export function ServerDashboard({ server, onOnlineChange }: ServerDashboardProps) {
  const { toast } = useToast();

  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [keyMetas, setKeyMetas] = useState<Record<string, KeyMeta>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ type: "none" });

  // Load metas from localStorage for all keys
  const loadMetas = useCallback((loadedKeys: AccessKey[]) => {
    const map: Record<string, KeyMeta> = {};
    for (const k of loadedKeys) {
      map[k.id] = getKeyMeta(server.id, k.id);
    }
    setKeyMetas(map);
  }, [server.id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [serverInfo, accessKeys, transferMetrics] = await Promise.all([
        getServerInfo(server.apiUrl, server.certSha256),
        listAccessKeys(server.apiUrl, server.certSha256),
        getTransferMetrics(server.apiUrl, server.certSha256),
      ]);
      setInfo(serverInfo);
      setKeys(accessKeys);
      setMetrics(transferMetrics.bytesTransferredByUserId);
      loadMetas(accessKeys);
      onOnlineChange(server.id, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onOnlineChange(server.id, false);
    } finally {
      setLoading(false);
    }
  }, [server, onOnlineChange, loadMetas]);

  useEffect(() => { load(); }, [load]);

  const totalBytes = Object.values(metrics).reduce((a, b) => a + b, 0);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleCreateKey(name: string) {
    setDialog({ type: "none" });
    try {
      const key = await createAccessKey(server.apiUrl, server.certSha256, name);
      setKeys((prev) => [...prev, key]);
      setKeyMetas((prev) => ({ ...prev, [key.id]: { expiryDate: null } }));
      toast({ title: "Key created", description: key.name || `Key #${key.id}` });
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to create key", description: String(err) });
    }
  }

  async function handleDeleteKey(keyId: string) {
    setDialog({ type: "none" });
    try {
      await deleteAccessKey(server.apiUrl, server.certSha256, keyId);
      deleteKeyMeta(server.id, keyId);
      setKeys((prev) => prev.filter((k) => k.id !== keyId));
      setKeyMetas((prev) => { const n = { ...prev }; delete n[keyId]; return n; });
      toast({ title: "Key deleted" });
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to delete key", description: String(err) });
    }
  }

  async function handleRenameKey(keyId: string, name: string) {
    setDialog({ type: "none" });
    try {
      await renameAccessKey(server.apiUrl, server.certSha256, keyId, name);
      setKeys((prev) => prev.map((k) => k.id === keyId ? { ...k, name } : k));
      toast({ title: "Key renamed" });
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to rename key", description: String(err) });
    }
  }

  async function handleSetLimit(keyId: string, bytes: number | null) {
    setDialog({ type: "none" });
    try {
      if (bytes === null) {
        await removeDataLimit(server.apiUrl, server.certSha256, keyId);
        setKeys((prev) => prev.map((k) => k.id === keyId ? { ...k, dataLimit: undefined } : k));
        toast({ title: "Data limit removed" });
      } else {
        await setDataLimit(server.apiUrl, server.certSha256, keyId, bytes);
        setKeys((prev) => prev.map((k) => k.id === keyId ? { ...k, dataLimit: { bytes } } : k));
        toast({ title: "Data limit set", description: formatBytes(bytes) });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to set limit", description: String(err) });
    }
  }

  function handleSetExpiry(keyId: string, isoDate: string | null) {
    setDialog({ type: "none" });
    const meta: KeyMeta = { expiryDate: isoDate };
    setKeyMeta(server.id, keyId, meta);
    setKeyMetas((prev) => ({ ...prev, [keyId]: meta }));
    toast({
      title: isoDate ? "Expiry date set" : "Expiry removed",
      description: isoDate
        ? new Date(isoDate).toLocaleDateString(undefined, {
            year: "numeric", month: "short", day: "numeric",
          })
        : undefined,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading && !info) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Connecting to {server.name}…</p>
        </div>
      </div>
    );
  }

  if (error && !info) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4 max-w-md">
          <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
          <div>
            <p className="font-semibold">Cannot reach server</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
          </div>
          <Button onClick={load} variant="outline">
            <RefreshCw className="w-4 h-4 mr-2" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg sm:text-xl font-bold truncate">{info?.name ?? server.name}</h1>
            <Badge variant="success">Online</Badge>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 truncate">
            {server.apiUrl.replace(/\/[^/]+$/, "")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0">
          <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Stats — 2 cols on mobile, 3 on sm+ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-1 pt-3 px-3 sm:px-6 sm:pt-6 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Keys
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 sm:px-6 sm:pb-6">
            <p className="text-xl sm:text-2xl font-bold">{keys.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1 pt-3 px-3 sm:px-6 sm:pt-6 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Data Used
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 sm:px-6 sm:pb-6">
            <p className="text-xl sm:text-2xl font-bold">{formatBytes(totalBytes)}</p>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardHeader className="pb-1 pt-3 px-3 sm:px-6 sm:pt-6 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Version
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 sm:px-6 sm:pb-6">
            <p className="text-xl sm:text-2xl font-bold">{info?.version ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Key table */}
      <KeyTable
        keys={keys}
        metrics={metrics}
        keyMetas={keyMetas}
        loading={loading}
        onCreateKey={() => setDialog({ type: "create" })}
        onDelete={(keyId) => {
          const key = keys.find((k) => k.id === keyId);
          setDialog({ type: "delete", keyId, keyName: key?.name ?? "" });
        }}
        onRename={(keyId, currentName) =>
          setDialog({ type: "rename", keyId, currentName })
        }
        onSetLimit={(keyId, currentBytes) =>
          setDialog({ type: "limit", keyId, currentBytes })
        }
        onSetExpiry={(keyId, currentExpiry) => {
          const key = keys.find((k) => k.id === keyId);
          setDialog({ type: "expiry", keyId, keyName: key?.name ?? "", currentExpiry });
        }}
      />

      {/* Dialogs */}
      <CreateKeyDialog
        open={dialog.type === "create"}
        onConfirm={handleCreateKey}
        onClose={() => setDialog({ type: "none" })}
      />
      <RenameKeyDialog
        open={dialog.type === "rename"}
        currentName={dialog.type === "rename" ? dialog.currentName : ""}
        onConfirm={(name) =>
          dialog.type === "rename" && handleRenameKey(dialog.keyId, name)
        }
        onClose={() => setDialog({ type: "none" })}
      />
      <SetLimitDialog
        open={dialog.type === "limit"}
        currentBytes={dialog.type === "limit" ? dialog.currentBytes : undefined}
        onConfirm={(bytes) =>
          dialog.type === "limit" && handleSetLimit(dialog.keyId, bytes)
        }
        onClose={() => setDialog({ type: "none" })}
      />
      <SetExpiryDialog
        open={dialog.type === "expiry"}
        keyName={dialog.type === "expiry" ? dialog.keyName : ""}
        currentExpiry={dialog.type === "expiry" ? dialog.currentExpiry : null}
        onConfirm={(isoDate) =>
          dialog.type === "expiry" && handleSetExpiry(dialog.keyId, isoDate)
        }
        onClose={() => setDialog({ type: "none" })}
      />
      <ConfirmDeleteDialog
        open={dialog.type === "delete"}
        label={dialog.type === "delete" ? dialog.keyName : ""}
        onConfirm={() =>
          dialog.type === "delete" && handleDeleteKey(dialog.keyId)
        }
        onClose={() => setDialog({ type: "none" })}
      />
    </div>
  );
}
