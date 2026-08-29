"use client";

/**
 * Admin panel for permanent customer identities.
 *
 * The primary action on every row is "Copy Key", which copies the permanent
 * ssconf:// URL. The raw ss:// key is NOT rendered by default — it must be
 * revealed deliberately, which makes an audited server call. That keeps key
 * material out of routine table renders, browser caches and devtools logs.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw, Copy, Check, Ban, Play, ArrowRightLeft, Eye, EyeOff,
  CalendarPlus, Gauge, AlertTriangle, CloudOff, Trash2, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/utils";
import {
  fetchDynamicCustomers,
  disableCustomer,
  enableCustomer,
  renewCustomer,
  updateCustomerQuota,
  migrateCustomer,
  cleanupCustomerMigration,
  revealRawKey,
  resyncCustomer,
  type DynamicCustomerRow,
  type DynamicHealth,
} from "@/lib/sync";
import { MigrateServerDialog, RenewDialog, QuotaDialog } from "./CustomerDialogs";

interface CustomersPanelProps {
  servers: Array<{ id: string; name: string }>;
}

type Busy = { token: string; action: string } | null;

function statusBadge(row: DynamicCustomerRow) {
  switch (row.status) {
    case "active":
      return <Badge className="bg-green-600 hover:bg-green-600">Active</Badge>;
    case "disabled":
      return <Badge variant="secondary">Disabled</Badge>;
    case "expired":
      return <Badge className="bg-amber-600 hover:bg-amber-600">Expired</Badge>;
    default:
      return <Badge variant="destructive">Revoked</Badge>;
  }
}

function usageLabel(row: DynamicCustomerRow): string {
  if (row.quotaBytes === null) return `${formatBytes(row.usedBytes)} / Unlimited`;
  return `${formatBytes(row.usedBytes)} / ${formatBytes(row.quotaBytes)}`;
}

function usagePercent(row: DynamicCustomerRow): number {
  if (row.quotaBytes === null || row.quotaBytes === 0) return 0;
  return Math.min(100, Math.round((row.usedBytes / row.quotaBytes) * 100));
}

function expiryLabel(row: DynamicCustomerRow): { text: string; tone: string } {
  if (!row.expiryDate) return { text: "No expiry", tone: "text-muted-foreground" };
  const ts = Date.parse(row.expiryDate);
  if (Number.isNaN(ts)) return { text: "Unknown", tone: "text-muted-foreground" };

  const days = Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000));
  const date = new Date(ts).toLocaleDateString();

  if (days < 0) return { text: `Expired ${date}`, tone: "text-destructive font-medium" };
  if (days <= 5) return { text: `${date} (${days}d left)`, tone: "text-amber-600 font-medium" };
  return { text: `${date} (${days}d)`, tone: "text-muted-foreground" };
}

export function CustomersPanel({ servers }: CustomersPanelProps) {
  const { toast } = useToast();

  const [rows, setRows] = useState<DynamicCustomerRow[]>([]);
  const [health, setHealth] = useState<DynamicHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

  const [migrateFor, setMigrateFor] = useState<DynamicCustomerRow | null>(null);
  const [renewFor, setRenewFor] = useState<DynamicCustomerRow | null>(null);
  const [quotaFor, setQuotaFor] = useState<DynamicCustomerRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDynamicCustomers();
      setRows(data.customers);
      setHealth(data.health);
    } catch (err) {
      toast({
        title: "Could not load customers",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.serverName.toLowerCase().includes(q) ||
        r.outlineKeyId.includes(q)
    );
  }, [rows, search]);

  async function copyKey(row: DynamicCustomerRow) {
    try {
      await navigator.clipboard.writeText(row.dynamicUrl);
      setCopied(row.token);
      setTimeout(() => setCopied(null), 1500);
      toast({ title: "Permanent key copied", description: row.name });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  }

  /** Wrap a mutation with busy state, error surfacing and a refresh. */
  async function run(
    row: DynamicCustomerRow,
    action: string,
    fn: () => Promise<unknown>,
    successTitle: string
  ) {
    setBusy({ token: row.token, action });
    try {
      const result = (await fn()) as { syncPending?: boolean } | undefined;
      toast({
        title: successTitle,
        description: result?.syncPending
          ? "Edge sync is queued and will retry automatically."
          : row.name,
      });
      await load();
    } catch (err) {
      const e = err as Error & { code?: string; details?: unknown };
      toast({
        title: e.code === "QUOTA_EXHAUSTED" ? "Quota exhausted" : "Action failed",
        description: e.message,
        variant: "destructive",
      });
      throw e;
    } finally {
      setBusy(null);
    }
  }

  async function toggleReveal(row: DynamicCustomerRow) {
    if (revealed[row.token]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[row.token];
        return next;
      });
      return;
    }
    try {
      const result = await revealRawKey(row.token);
      setRevealed((prev) => ({ ...prev, [row.token]: result.accessUrl }));
    } catch (err) {
      toast({
        title: "Could not reveal key",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }

  const isBusy = (row: DynamicCustomerRow, action?: string) =>
    busy?.token === row.token && (action ? busy.action === action : true);

  return (
    <div className="relative flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Customers</h2>
            <p className="text-xs text-muted-foreground">
              {rows.length} permanent {rows.length === 1 ? "identity" : "identities"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, server, key id"
            aria-label="Search customers"
            className="h-9 rounded-md border bg-background px-3 text-sm w-48"
          />
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Infrastructure health: free-tier headroom and queued syncs */}
      {health && (health.kvBudgetWarning || health.pendingEdgeSyncs > 0) && (
        <div
          role="status"
          className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-1"
        >
          {health.kvBudgetWarning && (
            <p className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4" />
              Edge config writes today: {health.kvWritesUsedToday} / {health.kvWriteLimit}. Approaching the
              free-tier daily limit.
            </p>
          )}
          {health.pendingEdgeSyncs > 0 && (
            <p className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
              <CloudOff className="w-4 h-4" />
              {health.pendingEdgeSyncs} customer{health.pendingEdgeSyncs === 1 ? "" : "s"} awaiting edge sync.
              The hourly job retries automatically.
            </p>
          )}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" />
          Loading customers…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 space-y-3 text-muted-foreground">
          <Users className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">
            {rows.length === 0
              ? "No permanent customer identities yet. Approve an order, or run the backfill for existing keys."
              : "No customers match that search."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => {
            const expiry = expiryLabel(row);
            const pct = usagePercent(row);

            return (
              <div
                key={row.token}
                className="rounded-xl border bg-white/70 dark:bg-gray-900/70 backdrop-blur-sm p-4 space-y-3"
              >
                {/* Row 1: identity + status */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate">{row.name || "Unnamed"}</p>
                      {statusBadge(row)}
                      {row.cleanupPending && (
                        <Badge variant="outline" className="text-amber-600 border-amber-400">
                          Cleanup pending
                        </Badge>
                      )}
                      {row.syncState === "pending" && (
                        <Badge variant="outline" className="text-amber-600 border-amber-400">
                          Sync pending
                        </Badge>
                      )}
                      {row.syncState === "not_configured" && (
                        <Badge variant="outline">Edge not configured</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {row.serverName} · key {row.outlineKeyId}
                      {row.planDescription ? ` · ${row.planDescription}` : ""}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => void copyKey(row)}
                    className="bg-gradient-to-r from-blue-600 to-purple-600"
                  >
                    {copied === row.token ? (
                      <Check className="w-4 h-4 mr-1.5" />
                    ) : (
                      <Copy className="w-4 h-4 mr-1.5" />
                    )}
                    Copy Key
                  </Button>
                </div>

                {/* Row 2: permanent URL */}
                <div className="rounded-lg bg-muted/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Permanent key (give this to the customer)
                  </p>
                  <p className="text-xs font-mono break-all">{row.dynamicUrl}</p>
                </div>

                {/* Row 3: usage + cycle + expiry */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground mb-1">Usage this cycle</p>
                    <p className={row.quotaExhausted ? "text-destructive font-medium" : "font-medium"}>
                      {usageLabel(row)}
                    </p>
                    {row.quotaBytes !== null && (
                      <div className="h-1.5 rounded-full bg-muted mt-1.5 overflow-hidden">
                        <div
                          className={`h-full ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-blue-600"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    {row.carriedBytes > 0 && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        includes {formatBytes(row.carriedBytes)} carried from a previous server
                      </p>
                    )}
                  </div>

                  <div>
                    <p className="text-muted-foreground mb-1">Cycle</p>
                    <p className="font-medium">
                      {row.cyclesUsed ?? "?"} of {row.cyclesTotal ?? "?"}
                    </p>
                  </div>

                  <div>
                    <p className="text-muted-foreground mb-1">Expiry</p>
                    <p className={expiry.tone}>{expiry.text}</p>
                  </div>
                </div>

                {/* Row 4: actions */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {row.status === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isBusy(row)}
                      onClick={() =>
                        void run(row, "disable", () => disableCustomer(row.token), "Customer disabled").catch(
                          () => {}
                        )
                      }
                    >
                      <Ban className="w-3.5 h-3.5 mr-1.5" />
                      Disable
                    </Button>
                  ) : row.status !== "revoked" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isBusy(row)}
                      onClick={() =>
                        void run(row, "enable", () => enableCustomer(row.token), "Customer enabled").catch(
                          () => {}
                        )
                      }
                    >
                      <Play className="w-3.5 h-3.5 mr-1.5" />
                      Enable
                    </Button>
                  ) : null}

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isBusy(row) || row.status !== "active"}
                    onClick={() => setMigrateFor(row)}
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 mr-1.5" />
                    Migrate
                  </Button>

                  <Button variant="outline" size="sm" disabled={isBusy(row)} onClick={() => setQuotaFor(row)}>
                    <Gauge className="w-3.5 h-3.5 mr-1.5" />
                    Quota
                  </Button>

                  <Button variant="outline" size="sm" disabled={isBusy(row)} onClick={() => setRenewFor(row)}>
                    <CalendarPlus className="w-3.5 h-3.5 mr-1.5" />
                    Renew
                  </Button>

                  {row.cleanupPending && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isBusy(row)}
                      onClick={() =>
                        void run(
                          row,
                          "cleanup",
                          () => cleanupCustomerMigration(row.token),
                          "Old key removed"
                        ).catch(() => {})
                      }
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      Clean up old key
                    </Button>
                  )}

                  {row.syncState === "pending" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isBusy(row)}
                      onClick={() =>
                        void run(row, "resync", () => resyncCustomer(row.token), "Edge resynced").catch(
                          () => {}
                        )
                      }
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                      Resync
                    </Button>
                  )}

                  {/* Troubleshooting only. Audited server-side. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground ml-auto"
                    onClick={() => void toggleReveal(row)}
                  >
                    {revealed[row.token] ? (
                      <EyeOff className="w-3.5 h-3.5 mr-1.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {revealed[row.token] ? "Hide raw key" : "Reveal raw key"}
                  </Button>
                </div>

                {revealed[row.token] && (
                  <div className="rounded-lg border border-dashed border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">
                      Raw key — admin troubleshooting only, do not send to customers
                    </p>
                    <p className="text-xs font-mono break-all">{revealed[row.token]}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      <MigrateServerDialog
        customer={migrateFor}
        servers={servers}
        onClose={() => setMigrateFor(null)}
        onConfirm={async (destServerId, allowExhausted) => {
          const row = migrateFor!;
          setMigrateFor(null);
          await run(
            row,
            "migrate",
            () => migrateCustomer(row.token, destServerId, allowExhausted),
            "Customer migrated — permanent key unchanged"
          ).catch(() => {});
        }}
      />

      <RenewDialog
        customer={renewFor}
        onClose={() => setRenewFor(null)}
        onConfirm={async (cycles) => {
          const row = renewFor!;
          setRenewFor(null);
          await run(row, "renew", () => renewCustomer(row.token, cycles), "Subscription renewed").catch(
            () => {}
          );
        }}
      />

      <QuotaDialog
        customer={quotaFor}
        onClose={() => setQuotaFor(null)}
        onConfirm={async (quotaGB) => {
          const row = quotaFor!;
          setQuotaFor(null);
          await run(
            row,
            "quota",
            () => updateCustomerQuota(row.token, quotaGB),
            "Quota updated — permanent key unchanged"
          ).catch(() => {});
        }}
      />
    </div>
  );
}
