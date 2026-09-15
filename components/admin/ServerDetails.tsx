"use client";

/**
 * Read-only Server Details view.
 *
 * Shows safe operational information only. There are NO key mutation actions
 * here (no create/rename/set-limit/set-expiry/delete). All customer and key
 * lifecycle management is centralized in the Customers tab.
 *
 * Never renders the management API URL, cert fingerprint, raw ss:// keys,
 * passwords, or tokens. Manual refresh only — no automatic polling.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  RefreshCw, AlertCircle, Server, Users, Database, KeyRound, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { fetchServerDetails, type ServerDetails as ServerDetailsData } from "@/lib/sync";
import type { OutlineServer } from "@/lib/types";

interface ServerDetailsProps {
  server: OutlineServer;
  onOnlineChange: (id: string, online: boolean) => void;
}

function ago(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function ServerDetails({ server, onOnlineChange }: ServerDetailsProps) {
  const { toast } = useToast();
  const [data, setData] = useState<ServerDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const details = await fetchServerDetails(server.id);
      setData(details);
      onOnlineChange(server.id, details.online);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onOnlineChange(server.id, false);
    } finally {
      setLoading(false);
    }
  }, [server.id, onOnlineChange]);

  useEffect(() => { void load(); }, [load]);

  const connecting = loading && !data;
  const offline = !!data && !data.online;

  const stats: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = data
    ? [
        { icon: <KeyRound className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-500" />, label: "Total Outline keys", value: offline ? "—" : data.totalKeys },
        { icon: <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-purple-500" />, label: "Total data used", value: offline ? "—" : formatBytes(data.totalDataUsedBytes) },
        { icon: <Server className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-pink-500" />, label: "Outline version", value: data.version ?? "—" },
        { icon: <Info className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500" />, label: "Metrics", value: data.metricsEnabled == null ? "—" : data.metricsEnabled ? "Enabled" : "Disabled" },
        { icon: <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />, label: "Managed customers", value: offline ? "—" : data.managedCustomers },
        { icon: <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />, label: "Active customers", value: offline ? "—" : data.activeCustomers },
        { icon: <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" />, label: "Disabled customers", value: offline ? "—" : data.disabledCustomers },
        { icon: <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" />, label: "Expired customers", value: offline ? "—" : data.expiredCustomers },
      ]
    : [];

  return (
    <div className="relative flex-1 flex flex-col overflow-y-auto bg-slate-50 dark:bg-slate-950" data-server-details>
      <div className="space-y-4 p-4 sm:p-6 lg:px-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{data?.name ?? server.name}</h1>
              {connecting ? (
                <Badge variant="secondary" className="gap-1.5">
                  <RefreshCw className="h-3 w-3 animate-spin" /> Connecting
                </Badge>
              ) : offline || error ? (
                <Badge variant="destructive">Offline</Badge>
              ) : (
                <Badge variant="success" className="bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900">Online</Badge>
              )}
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
              Read-only overview · manage keys in the Customers tab
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-xl bg-red-50/90 dark:bg-red-950/50 border border-red-200/50 dark:border-red-900/50 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Retry
            </Button>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {(connecting ? Array.from({ length: 8 }) : stats).map((stat, i) => (
            <Card key={i} className="admin-card">
              <CardHeader className="pb-1 pt-3 px-3 sm:px-5 sm:pt-5 sm:pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  {connecting ? <span className="h-3.5 w-3.5 rounded bg-muted" /> : (stat as { icon: React.ReactNode }).icon}
                  <span className="truncate">{connecting ? "Loading" : (stat as { label: string }).label}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 sm:px-5 sm:pb-5">
                <p className={`text-lg font-bold sm:text-xl ${connecting ? "text-muted-foreground animate-pulse" : ""}`}>
                  {connecting ? "—" : (stat as { value: React.ReactNode }).value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Missing key warning */}
        {data && !offline && data.missingKeys > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
            <p className="text-red-800 dark:text-red-200">
              <strong>{data.missingKeys}</strong> managed customer{data.missingKeys === 1 ? "" : "s"} reference an Outline key that no longer exists on this server. Use <strong>Customers → Diagnose</strong> to investigate.
            </p>
          </div>
        )}

        {/* Unmanaged key guidance */}
        {data && !offline && data.unmanagedKeys > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <p className="text-amber-800 dark:text-amber-200">
              <strong>{data.unmanagedKeys}</strong> unmanaged Outline key{data.unmanagedKeys === 1 ? "" : "s"} on this server {data.unmanagedKeys === 1 ? "is" : "are"} not tracked by any customer. Attach {data.unmanagedKeys === 1 ? "it" : "them"} through <strong>Customers → Add → Use Existing Outline Key</strong>.
            </p>
          </div>
        )}

        {/* Last refreshed */}
        {data && (
          <p className="text-xs text-muted-foreground">Last refreshed {ago(data.checkedAt)}</p>
        )}
      </div>
    </div>
  );
}
