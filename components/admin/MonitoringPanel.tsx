"use client";

/**
 * System Monitoring panel — read-only health dashboard.
 *
 * Shows: App, Redis, Telegram, Cron, Dynamic Config, Outline servers.
 * All data fetched server-side; never exposes credentials to the browser.
 * 30-second server-side cache; manual Refresh button.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw, Activity, Server, Database, MessageCircle, Clock,
  Globe, AlertTriangle, CheckCircle2, XCircle, HelpCircle, ChevronDown,
  ChevronUp, Wifi, WifiOff, Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  fetchSystemHealth,
  fetchOutlineHealth,
  type SystemHealth,
  type OutlineMonitorResult,
  type MonitorHealthStatus,
} from "@/lib/sync";

// ── Status helpers ────────────────────────────────────────────────────────────

function statusDot(s: MonitorHealthStatus) {
  switch (s) {
    case "healthy":        return <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 shrink-0" title="Healthy" />;
    case "warning":        return <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0" title="Warning" />;
    case "critical":       return <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500 shrink-0" title="Critical" />;
    case "not_configured": return <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-gray-400 shrink-0" title="Not configured" />;
  }
}

function statusLabel(s: MonitorHealthStatus) {
  const map = { healthy: "Healthy", warning: "Warning", critical: "Critical", not_configured: "Not configured" };
  return map[s] ?? s;
}

function statusBadge(s: MonitorHealthStatus) {
  const cls = {
    healthy:        "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800",
    warning:        "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    critical:       "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800",
    not_configured: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700",
  }[s] ?? "";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {statusDot(s)} {statusLabel(s)}
    </span>
  );
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function ms(n?: number) {
  return n !== undefined ? `${n}ms` : "—";
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({
  icon, title, status, children, defaultOpen = true,
}: {
  icon: React.ReactNode;
  title: string;
  status: MonitorHealthStatus;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-white/70 dark:bg-gray-900/70 backdrop-blur-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="shrink-0 text-muted-foreground">{icon}</div>
          <span className="font-medium text-sm truncate">{title}</span>
          {statusBadge(status)}
        </div>
        {open ? <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-2 text-sm">{children}</div>}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-muted-foreground text-xs shrink-0 w-36">{label}</span>
      <span className={`text-xs font-medium text-right break-all ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

// ── Overall summary cards ─────────────────────────────────────────────────────

function SummaryCards({ health, outline }: { health: SystemHealth; outline: OutlineMonitorResult | null }) {
  const cards = [
    { label: "Application",     status: health.app.status },
    { label: "VPN Servers",     status: outline?.overall ?? "not_configured" },
    { label: "Redis",           status: health.redis.status },
    { label: "Telegram",        status: health.telegram.status },
    { label: "Cron",            status: health.cron.status },
    { label: "Dynamic Config",  status: health.dynamicConfig.status },
  ] as { label: string; status: MonitorHealthStatus }[];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {cards.map((c) => (
        <div
          key={c.label}
          className="flex items-center gap-2 rounded-lg border bg-white/60 dark:bg-gray-900/60 px-3 py-2"
        >
          {statusDot(c.status)}
          <span className="text-xs font-medium truncate">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MonitoringPanel() {
  const { toast } = useToast();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [outline, setOutline] = useState<OutlineMonitorResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const lastFetchRef = useRef<number>(0);

  const load = useCallback(async (force = false) => {
    const now = Date.now();
    // Enforce 30-second client-side rate limit for non-forced refreshes.
    if (!force && now - lastFetchRef.current < 30_000) return;
    lastFetchRef.current = now;

    setRefreshing(true);
    try {
      const [h, o] = await Promise.allSettled([
        fetchSystemHealth(force),
        fetchOutlineHealth(force),
      ]);
      if (h.status === "fulfilled") setHealth(h.value);
      else toast({ title: "System health unavailable", description: (h.reason as Error).message, variant: "destructive" });
      if (o.status === "fulfilled") setOutline(o.value);
      // Outline failure is non-fatal — already shows degraded state.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load(false); }, [load]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 text-muted-foreground">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto" />
          <p className="text-sm">Running health checks…</p>
        </div>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3 text-muted-foreground">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
          <p className="text-sm">Health check unavailable. Check your admin session.</p>
          <Button size="sm" onClick={() => void load(true)}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 shrink-0">
            <Activity className="w-4 h-4 text-white" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-semibold leading-tight">System Monitoring</h2>
            <p className="text-xs text-muted-foreground">
              {health.cached ? "Cached · " : "Live · "}
              Checked {ago(health.checkedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge(health.overall)}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="min-h-[36px]"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""} sm:mr-1.5`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Overall summary */}
      <SummaryCards health={health} outline={outline} />

      {/* Application */}
      <SectionCard icon={<Globe className="w-4 h-4" />} title="Application" status={health.app.status}>
        <Row label="Status"      value={statusBadge(health.app.status)} />
        <Row label="Environment" value={health.app.environment} />
        <Row label="Region"      value={health.app.region} />
        {health.app.commitSha && <Row label="Commit" value={<code className="font-mono">{health.app.commitSha}</code>} />}
        <Row label="Provider usage" value={<span className="text-muted-foreground">Not configured</span>} />
      </SectionCard>

      {/* Dynamic Config */}
      <SectionCard icon={<Shield className="w-4 h-4" />} title="Dynamic Config (/k/)" status={health.dynamicConfig.status}>
        <Row label="Status"      value={statusBadge(health.dynamicConfig.status)} />
        <Row label="Latency"     value={ms(health.dynamicConfig.latencyMs)} />
        <Row label="HTTP status" value={health.dynamicConfig.httpStatus ?? "—"} />
        {health.dynamicConfig.detail && <Row label="Detail" value={health.dynamicConfig.detail} tone="text-amber-600" />}
        <Row label="Last checked" value={ago(health.dynamicConfig.checkedAt)} />
      </SectionCard>

      {/* Redis */}
      <SectionCard icon={<Database className="w-4 h-4" />} title="Upstash Redis" status={health.redis.status}>
        <Row label="Status"     value={statusBadge(health.redis.status)} />
        <Row label="Latency"    value={ms(health.redis.latencyMs)} />
        <Row label="Dirty queue" value={health.redis.dirtyQueueSize} />
        {health.redis.kvBudget && (
          <>
            <Row label="KV writes today" value={`${health.redis.kvBudget.used} / ${health.redis.kvBudget.limit}`} tone={health.redis.kvBudget.warn ? "text-amber-600" : undefined} />
            <Row label="KV remaining"    value={health.redis.kvBudget.remaining} />
          </>
        )}
        {health.redis.detail && <Row label="Detail" value={health.redis.detail} tone="text-amber-600" />}
        <Row label="Provider usage" value={<span className="text-muted-foreground">Not configured</span>} />
      </SectionCard>

      {/* Telegram */}
      <SectionCard icon={<MessageCircle className="w-4 h-4" />} title="Telegram Bot" status={health.telegram.status}>
        <Row label="Status"           value={statusBadge(health.telegram.status)} />
        {health.telegram.botUsername && <Row label="Bot"  value={`@${health.telegram.botUsername}`} />}
        <Row label="Latency"          value={ms(health.telegram.latencyMs)} />
        <Row label="Webhook"          value={health.telegram.webhookConfigured ? "Configured" : "Not configured"} />
        <Row label="Linked approvers" value={health.telegram.linkedApprovers} />
        <Row label="Pending links"    value={health.telegram.pendingLinks} />
        {health.telegram.detail && <Row label="Detail" value={health.telegram.detail} tone="text-amber-600" />}
      </SectionCard>

      {/* Cron */}
      <SectionCard icon={<Clock className="w-4 h-4" />} title="Cron Jobs" status={health.cron.status}>
        <Row label="Status" value={statusBadge(health.cron.status)} />
        {health.cron.detail && <Row label="Detail" value={health.cron.detail} tone={health.cron.status === "critical" ? "text-red-600" : "text-amber-600"} />}
        {health.cron.summary ? (
          <>
            <Row label="Last run"     value={ago(health.cron.summary.lastCompletedAt)} />
            <Row label="Duration"     value={`${health.cron.summary.durationMs}ms`} />
            <Row label="Processed"    value={health.cron.summary.processed} />
            <Row label="Failed"       value={health.cron.summary.failed} tone={health.cron.summary.failed > 0 ? "text-amber-600" : undefined} />
            <Row label="Expiries"     value={health.cron.summary.expiryProcessed} />
            <Row label="Quota cycles" value={health.cron.summary.quotaProcessed} />
            <Row label="Dirty syncs"  value={health.cron.summary.dirtySyncProcessed} />
          </>
        ) : (
          <Row label="Last run" value={<span className="text-muted-foreground">No run recorded</span>} />
        )}
        {health.cron.overdueMs !== undefined && (
          <Row label="Overdue by" value={`${Math.round(health.cron.overdueMs / 60_000)} min`} tone="text-amber-600" />
        )}
      </SectionCard>

      {/* Outline VPN Servers */}
      {outline && (
        <SectionCard icon={<Server className="w-4 h-4" />} title="Outline VPN Servers" status={outline.overall} defaultOpen>
          {outline.servers.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No servers configured.</p>
          ) : (
            <div className="space-y-3">
              {outline.servers.map((s) => (
                <div key={s.serverId} className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{s.name}</span>
                    {statusBadge(s.status)}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                    <Row label="Latency"      value={ms(s.latencyMs)} />
                    <Row label="Total keys"   value={s.totalKeys} />
                    <Row label="Managed"      value={s.managedKeys} />
                    <Row label="Unmanaged"    value={s.unmanagedKeys} tone={s.unmanagedKeys > 0 ? "text-amber-600" : undefined} />
                    <Row label="Active"       value={s.activeCustomers} />
                    <Row label="Disabled"     value={s.disabledCustomers} />
                    {s.missingKeys > 0 && <Row label="Missing keys" value={s.missingKeys} tone="text-red-600" />}
                    {s.duplicateMappings > 0 && <Row label="Duplicates" value={s.duplicateMappings} tone="text-red-600" />}
                  </div>
                  {s.detail && <p className="text-xs text-amber-600 dark:text-amber-400">{s.detail}</p>}
                  <p className="text-[10px] text-muted-foreground">Checked {ago(s.checkedAt)}</p>
                </div>
              ))}
            </div>
          )}
          <Row label="Resource metrics" value={<span className="text-muted-foreground">Not configured (no AWS credentials)</span>} />
        </SectionCard>
      )}

      {!outline && (
        <SectionCard icon={<Server className="w-4 h-4" />} title="Outline VPN Servers" status="warning" defaultOpen>
          <p className="text-xs text-amber-600">Could not load Outline server health.</p>
        </SectionCard>
      )}
    </div>
  );
}
