"use client";

/**
 * System Monitoring panel — read-only health dashboard.
 *
 * Shows: App, Redis (+ due jobs), Telegram (+ login telemetry),
 * Cron, Dynamic Config, Outline servers (+ VPN port status).
 * All data fetched server-side; never exposes credentials.
 * 30-second server-side cache; manual Refresh button.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw, Activity, Server, Database, MessageCircle, Clock,
  Globe, AlertTriangle, ChevronDown, ChevronUp, Shield, Wifi, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const cls: Record<MonitorHealthStatus, string> = {
    healthy:        "bg-green-500",
    warning:        "bg-amber-500",
    critical:       "bg-red-500",
    not_configured: "border-2 border-gray-400 bg-transparent",
  };
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${cls[s]}`}
      title={s}
    />
  );
}

function statusBadge(s: MonitorHealthStatus) {
  const cfg: Record<MonitorHealthStatus, { bg: string; text: string; label: string }> = {
    healthy:        { bg: "bg-green-100 dark:bg-green-900/40 border-green-200 dark:border-green-800",  text: "text-green-800 dark:text-green-300",  label: "Healthy" },
    warning:        { bg: "bg-amber-100 dark:bg-amber-900/40 border-amber-200 dark:border-amber-800",  text: "text-amber-800 dark:text-amber-300",  label: "Warning" },
    critical:       { bg: "bg-red-100   dark:bg-red-900/40   border-red-200   dark:border-red-800",    text: "text-red-800   dark:text-red-300",    label: "Critical" },
    not_configured: { bg: "bg-gray-100  dark:bg-gray-800     border-gray-200  dark:border-gray-700",   text: "text-gray-600  dark:text-gray-400",   label: "Not configured" },
  };
  const c = cfg[s];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text}`}>
      {statusDot(s)}{c.label}
    </span>
  );
}

function portBadge(status: string) {
  const cfg: Record<string, string> = {
    open:    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200",
    timeout: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200",
    refused: "bg-red-100   text-red-800   dark:bg-red-900/40   dark:text-red-300   border-red-200",
    unknown: "bg-gray-100  text-gray-600  dark:bg-gray-800     dark:text-gray-400  border-gray-200",
  };
  const cls = cfg[status] ?? cfg.unknown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status === "open" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {status.toUpperCase()}
    </span>
  );
}

function ago(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function ms(n?: number) { return n !== undefined ? `${n}ms` : "—"; }

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
    <div className="admin-card overflow-hidden">
      <button
        className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="shrink-0 text-muted-foreground">{icon}</span>
          <span className="font-medium text-sm truncate">{title}</span>
          {statusBadge(status)}
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" />
          : <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && <div className="space-y-1.5 border-t bg-slate-50/60 px-4 pb-4 pt-3 text-sm dark:bg-slate-900/30">{children}</div>}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-muted-foreground text-xs shrink-0 w-40">{label}</span>
      <span className={`text-xs font-medium text-right min-w-0 break-words ${tone ?? ""}`}>{value ?? "—"}</span>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-2 pb-0.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">{label}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ health, outline }: { health: SystemHealth; outline: OutlineMonitorResult | null }) {
  const cards: { label: string; status: MonitorHealthStatus }[] = [
    { label: "Application",    status: health.app.status },
    { label: "VPN Servers",    status: outline?.overall ?? "not_configured" },
    { label: "Redis",          status: health.redis.status },
    { label: "Telegram",       status: health.telegram.status },
    { label: "Cron",           status: health.cron.status },
    { label: "Dynamic Config", status: health.dynamicConfig.status },
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.label} className="admin-card flex min-h-16 min-w-0 flex-col items-start justify-center gap-1.5 px-3 py-2.5">
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

  const tg = health.telegram;
  const lt = tg.loginTelemetry;

  return (
    <div className="admin-page">
      <div className="admin-page-inner">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary shrink-0">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">System Monitoring</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {health.cached ? "Cached · " : "Live · "}Checked {ago(health.checkedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge(health.overall)}
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing} className="min-h-[44px]">
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""} sm:mr-1.5`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Summary grid */}
      <SummaryCards health={health} outline={outline} />

      {/* Application */}
      <SectionCard icon={<Globe className="w-4 h-4" />} title="Application" status={health.app.status}>
        <Row label="Status"         value={statusBadge(health.app.status)} />
        <Row label="Environment"    value={health.app.environment} />
        <Row label="Region"         value={health.app.region} />
        {health.app.commitSha && <Row label="Commit" value={<code className="font-mono text-xs">{health.app.commitSha}</code>} />}
        <Row label="Provider usage" value={<span className="text-muted-foreground italic">Not configured</span>} />
      </SectionCard>

      {/* Dynamic Config */}
      <SectionCard icon={<Shield className="w-4 h-4" />} title="Dynamic Config (/k/)" status={health.dynamicConfig.status}>
        <Row label="Status"       value={statusBadge(health.dynamicConfig.status)} />
        <Row label="HTTP status"  value={health.dynamicConfig.httpStatus ?? "—"} />
        <Row label="Latency"      value={ms(health.dynamicConfig.latencyMs)} />
        {health.dynamicConfig.detail && <Row label="Detail" value={health.dynamicConfig.detail} tone="text-amber-600" />}
        <Row label="Last checked" value={ago(health.dynamicConfig.checkedAt)} />
      </SectionCard>

      {/* Redis */}
      <SectionCard icon={<Database className="w-4 h-4" />} title="Upstash Redis" status={health.redis.status}>
        <Row label="Status"      value={statusBadge(health.redis.status)} />
        <Row label="Latency"     value={ms(health.redis.latencyMs)} />
        {health.redis.detail && <Row label="Detail" value={health.redis.detail} tone="text-amber-600" />}
        {health.redis.kvBudget && (
          <>
            <Divider label="KV Budget" />
            <Row label="Writes today"  value={`${health.redis.kvBudget.used} / ${health.redis.kvBudget.limit}`} tone={health.redis.kvBudget.warn ? "text-amber-600" : undefined} />
            <Row label="Remaining"     value={health.redis.kvBudget.remaining} />
          </>
        )}
        <Divider label="Lifecycle Jobs" />
        <Row label="Dirty queue"   value={health.redis.dirtyQueueSize} tone={health.redis.dirtyQueueSize > 0 ? "text-amber-600" : undefined} />
        <Row label="Expiry due"    value={health.redis.dueJobs?.expiryDue ?? 0} tone={(health.redis.dueJobs?.expiryDue ?? 0) > 0 ? "text-amber-600" : undefined} />
        <Row label="Cycle due"     value={health.redis.dueJobs?.cycleDue ?? 0} tone={(health.redis.dueJobs?.cycleDue ?? 0) > 0 ? "text-amber-600" : undefined} />
        <Row label="Provider usage" value={<span className="text-muted-foreground italic">Not configured</span>} />
      </SectionCard>

      {/* Telegram */}
      <SectionCard icon={<MessageCircle className="w-4 h-4" />} title="Telegram Bot" status={tg.status}>
        <Row label="Status"           value={statusBadge(tg.status)} />
        {tg.botUsername && <Row label="Bot"  value={`@${tg.botUsername}`} />}
        <Row label="Latency"          value={ms(tg.latencyMs)} />
        <Row label="Webhook"          value={tg.webhookConfigured ? "Configured" : "Not configured"} />
        <Row label="Linked approvers" value={tg.linkedApprovers} />
        <Row label="Pending links"    value={tg.pendingLinks} />
        {tg.detail && <Row label="Detail" value={tg.detail} tone="text-amber-600" />}

        <Divider label="Login Approval Telemetry" />
        {lt ? (
          <>
            <Row label="Last challenge"   value={ago(lt.challengeCreatedAt)} />
            <Row label="Recipients tried" value={lt.recipientsAttempted} />
            <Row label="Delivered"        value={lt.deliverSucceeded} tone={lt.deliverSucceeded === 0 ? "text-red-600" : "text-green-700 dark:text-green-400"} />
            <Row label="Failed"           value={lt.deliverFailed} tone={lt.deliverFailed > 0 ? "text-red-600" : undefined} />
            {lt.deliverFailed > 0 && lt.lastFailureCategory && (
              <Row label="Last error" value={lt.lastFailureCategory} tone="text-amber-600" />
            )}
          </>
        ) : (
          <Row label="Login telemetry" value={<span className="text-muted-foreground italic">No login attempt recorded</span>} />
        )}
      </SectionCard>

      {/* Cron */}
      <SectionCard icon={<Clock className="w-4 h-4" />} title="Cron Jobs" status={health.cron.status}>
        <Row label="Status" value={statusBadge(health.cron.status)} />
        {health.cron.detail && (
          <Row label="Detail" value={health.cron.detail}
            tone={health.cron.status === "critical" ? "text-red-600" : "text-amber-600"} />
        )}
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
          <Row label="Last run" value={<span className="text-muted-foreground italic">No run recorded yet</span>} />
        )}
        {health.cron.overdueMs !== undefined && (
          <Row label="Overdue by" value={`${Math.round(health.cron.overdueMs / 60_000)} min`} tone="text-amber-600" />
        )}
      </SectionCard>

      {/* Outline VPN Servers */}
      {outline ? (
        <SectionCard icon={<Server className="w-4 h-4" />} title="Outline VPN Servers" status={outline.overall}>
          {outline.servers.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No servers configured.</p>
          ) : (
            <div className="space-y-3 pt-1">
              {outline.servers.map((s) => (
                <div key={s.serverId} className="rounded-lg border bg-muted/20 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{s.name}</span>
                    {statusBadge(s.status)}
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                    <Row label="API latency"    value={ms(s.latencyMs)} />
                    <Row label="Total keys"     value={s.totalKeys} />
                    <Row label="Managed"        value={s.managedKeys} />
                    <Row label="Unmanaged"      value={s.unmanagedKeys} tone={s.unmanagedKeys > 0 ? "text-amber-600" : undefined} />
                    <Row label="Active"         value={s.activeCustomers} />
                    <Row label="Disabled"       value={s.disabledCustomers} />
                    {s.missingKeys > 0      && <Row label="Missing keys"  value={s.missingKeys}      tone="text-red-600" />}
                    {s.duplicateMappings > 0 && <Row label="Duplicates"   value={s.duplicateMappings} tone="text-red-600" />}
                  </div>

                  {/* VPN endpoint */}
                  {s.vpnEndpoint && (
                    <div className="pt-1 border-t space-y-1">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          VPN port {s.vpnEndpoint.host}:{s.vpnEndpoint.port}
                        </span>
                        {portBadge(s.vpnEndpoint.portStatus)}
                        {s.vpnEndpoint.portStatus === "open" && (
                          <span className="text-xs text-muted-foreground">{ms(s.vpnEndpoint.portLatencyMs)}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground italic">{s.vpnEndpoint.note}</p>
                    </div>
                  )}

                  {s.detail && <p className="text-xs text-amber-600 dark:text-amber-400">{s.detail}</p>}
                  <p className="text-[10px] text-muted-foreground">Checked {ago(s.checkedAt)}</p>
                </div>
              ))}
            </div>
          )}

          <Divider label="Resource Metrics" />
          <Row label="CPU"           value={<span className="text-muted-foreground italic">Not configured</span>} />
          <Row label="RAM"           value={<span className="text-muted-foreground italic">Not configured</span>} />
          <Row label="Disk"          value={<span className="text-muted-foreground italic">Not configured</span>} />
          <Row label="Network usage" value={<span className="text-muted-foreground italic">Not configured</span>} />
          <p className="text-[10px] text-muted-foreground pt-1">
            AWS / Lightsail credentials required for resource metrics. Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION to enable.
          </p>
        </SectionCard>
      ) : (
        <SectionCard icon={<Server className="w-4 h-4" />} title="Outline VPN Servers" status="warning">
          <p className="text-xs text-amber-600 py-2">Could not load Outline server health.</p>
        </SectionCard>
      )}
      </div>
    </div>
  );
}
