"use client";

/**
 * Admin panel for permanent customer identities.
 *
 * Performance improvements:
 * - Search is client-side on already-loaded data (no network per keystroke).
 * - Mutations update the local row in-place; full reload only on create/delete.
 * - Immediate pending states prevent double-clicks.
 * - Loading skeletons on initial fetch.
 * - No console.log in production.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw, Copy, Check, Ban, Play, ArrowRightLeft, Eye, EyeOff,
  Gauge, AlertTriangle, CloudOff, Trash2, Users, UserPlus, Stethoscope,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/utils";
import {
  fetchDynamicCustomers,
  disableCustomer,
  enableCustomer,
  migrateCustomer,
  cleanupCustomerMigration,
  revealRawKey,
  resyncCustomer,
  editCustomerSubscription,
  createAdminCustomer,
  deleteAdminCustomer,
  type DynamicCustomerRow,
  type DynamicHealth,
} from "@/lib/sync";
import { MigrateServerDialog, EditSubscriptionDialog, AddCustomerDialog } from "./CustomerDialogs";
import { DiagnoseDialog } from "./DiagnoseDialog";
import { DeleteCustomerDialog } from "./DeleteCustomerDialog";

interface CustomersPanelProps {
  servers: Array<{ id: string; name: string }>;
}

type Busy = { token: string; action: string } | null;
type CustomerFilter = "all" | "active" | "disabled" | "expired" | "unlimited" | "finite";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(row: DynamicCustomerRow) {
  switch (row.status) {
    case "active":   return <Badge className="bg-green-600 hover:bg-green-600 text-xs">Active</Badge>;
    case "disabled": return <Badge variant="secondary" className="text-xs">Disabled</Badge>;
    case "expired":  return <Badge className="bg-amber-600 hover:bg-amber-600 text-xs">Expired</Badge>;
    default:         return <Badge variant="destructive" className="text-xs">Revoked</Badge>;
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

function durationLabel(row: DynamicCustomerRow): string {
  const n = row.cyclesTotal;
  if (!n || n <= 0) return "—";
  return n === 1 ? "1 Month" : `${n} Months`;
}

function quotaAllowanceLabel(row: DynamicCustomerRow): string {
  const configured = row.configuredQuotaBytes ?? row.quotaBytes;
  if (configured === null) return "Unlimited";
  const gb = configured / (1024 * 1024 * 1024);
  const display = gb >= 1 ? `${Math.round(gb)} GB` : formatBytes(configured);
  return `${display} / 30 days`;
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

// ── Loading skeleton ──────────────────────────────────────────────────────────

function CustomerSkeleton() {
  return (
    <div className="admin-card space-y-4 p-4 animate-pulse sm:p-5">
      <div className="flex justify-between gap-3">
        <div className="space-y-2 flex-1">
          <div className="h-4 bg-muted rounded w-32" />
          <div className="h-3 bg-muted rounded w-48" />
        </div>
        <div className="h-8 bg-muted rounded w-24" />
      </div>
      <div className="h-12 bg-muted/50 rounded-lg" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 bg-muted rounded w-12" />
            <div className="h-4 bg-muted rounded w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CustomersPanel({ servers }: CustomersPanelProps) {
  const { toast } = useToast();

  const [rows, setRows] = useState<DynamicCustomerRow[]>([]);
  const [health, setHealth] = useState<DynamicHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<CustomerFilter>("all");

  // Debounce: update search state 250 ms after the user stops typing.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSearchChange(v: string) {
    setRawSearch(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(v), 250);
  }
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const [migrateFor, setMigrateFor] = useState<DynamicCustomerRow | null>(null);
  const [editSubFor, setEditSubFor] = useState<DynamicCustomerRow | null>(null);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [diagnoseFor, setDiagnoseFor] = useState<DynamicCustomerRow | null>(null);
  const [deleteFor, setDeleteFor] = useState<DynamicCustomerRow | null>(null);

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

  useEffect(() => { void load(); }, [load]);

  // Client-side filter — no network on every keystroke.
  const counts = useMemo(() => ({
    all: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    disabled: rows.filter((r) => r.status === "disabled").length,
    expired: rows.filter((r) => r.status === "expired").length,
    unlimited: rows.filter((r) => r.quotaBytes === null).length,
    finite: rows.filter((r) => r.quotaBytes !== null).length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const s = (v: unknown) => String(v ?? "").toLowerCase();
    return rows.filter((r) => {
      const matchesFilter = filter === "all" ||
        (filter === "unlimited" ? r.quotaBytes === null :
          filter === "finite" ? r.quotaBytes !== null : r.status === filter);
      const matchesSearch = !q ||
        s(r.name).includes(q) ||
        s(r.serverName).includes(q) ||
        s(r.outlineKeyId).includes(q) ||
        s(r.token).includes(q) ||
        s(r.orderId).includes(q) ||
        s(r.status).includes(q);
      return matchesFilter && matchesSearch;
    });
  }, [rows, search, filter]);

  async function copyKey(row: DynamicCustomerRow) {
    const url = row.dynamicUrl;
    if (!url?.startsWith("ssconf://")) {
      toast({
        title: "Key not ready",
        description: "Still syncing. Try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(row.token);
      setTimeout(() => setCopied(null), 1500);
      toast({ title: "Key copied", description: row.name });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  }

  /**
   * Wrap a mutation with:
   *  - immediate busy state (prevents double-click)
   *  - optimistic row patch (no full reload)
   *  - error surfacing
   *
   * `patch` receives the result and returns the fields to merge into the row.
   * Pass `patch: null` to skip the optimistic update and do a full reload instead.
   */
  async function run<T extends Record<string, unknown>>(
    row: DynamicCustomerRow,
    action: string,
    fn: () => Promise<T>,
    successTitle: string,
    patch?: (result: T) => Partial<DynamicCustomerRow>
  ) {
    if (busy?.token === row.token) return; // already busy for this row
    setBusy({ token: row.token, action });
    try {
      const result = await fn();
      toast({
        title: successTitle,
        description: (result as { syncPending?: boolean }).syncPending
          ? "Edge sync is queued and will retry automatically."
          : row.name,
      });
      if (patch) {
        // Optimistically update the row in place — no full network reload.
        setRows((prev) =>
          prev.map((r) => (r.token === row.token ? { ...r, ...patch(result) } : r))
        );
      } else {
        await load();
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      toast({
        title: e.code === "QUOTA_EXHAUSTED" ? "Quota exhausted" : "Action failed",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function toggleReveal(row: DynamicCustomerRow) {
    if (revealed[row.token]) {
      setRevealed((prev) => { const n = { ...prev }; delete n[row.token]; return n; });
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

  const busyLabel = (row: DynamicCustomerRow) => {
    if (busy?.token !== row.token) return null;
    const map: Record<string, string> = {
      disable: "Disabling…",
      enable: "Enabling…",
      migrate: "Migrating…",
      editSubscription: "Saving…",
      cleanup: "Cleaning up…",
      resync: "Syncing…",
    };
    return map[busy.action] ?? "Working…";
  };

  return (
    <div className="admin-page">
      <div className="admin-page-inner">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        {/* Title */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary shrink-0">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Customers</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Manage {rows.length} permanent {rows.length === 1 ? "identity" : "identities"}
            </p>
          </div>
        </div>

        {/* Controls — stack on 320px, row on wider */}
        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={rawSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search name, server or key…"
            aria-label="Search customers"
            className="h-10 pl-9"
          />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="min-h-10" aria-label="Refresh customers">
            <RefreshCw className={`w-4 h-4 ${loading && rows.length > 0 ? "animate-spin" : ""}`} />
            <span className="ml-1.5 hidden sm:inline">Refresh</span>
          </Button>
          <Button
            size="sm"
            className="min-h-10"
            onClick={() => setAddingCustomer(true)}
          >
            <UserPlus className="w-4 h-4 mr-1.5" />
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pb-1" aria-label="Filter customers">
        {(["all", "active", "disabled", "expired", "unlimited", "finite"] as CustomerFilter[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              filter === value
                ? "border-primary/20 bg-primary text-primary-foreground"
                : "bg-white text-muted-foreground hover:text-foreground dark:bg-slate-950"
            }`}
          >
            <span className="capitalize">{value}</span>
            <span className={filter === value ? "text-white/75" : "text-muted-foreground/75"}>{counts[value]}</span>
          </button>
        ))}
      </div>

      {/* Health warnings */}
      {health && (health.kvBudgetWarning || health.pendingEdgeSyncs > 0) && (
        <div role="status" className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-1">
          {health.kvBudgetWarning && (
            <p className="flex items-start gap-2 text-amber-900 dark:text-amber-200 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              Edge writes today: {health.kvWritesUsedToday} / {health.kvWriteLimit}. Approaching free-tier limit.
            </p>
          )}
          {health.pendingEdgeSyncs > 0 && (
            <p className="flex items-start gap-2 text-amber-900 dark:text-amber-200 text-xs">
              <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
              {health.pendingEdgeSyncs} customer{health.pendingEdgeSyncs === 1 ? "" : "s"} awaiting edge sync.
            </p>
          )}
        </div>
      )}

      {/* Loading skeletons on first load */}
      {loading && rows.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <CustomerSkeleton key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 space-y-3 text-muted-foreground">
          <Users className="w-10 h-10 mx-auto opacity-30" />
          <p className="text-sm">
            {rows.length === 0
              ? "No customers yet. Approve an order or add one manually."
              : "No customers match the current search or filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => {
            const expiry = expiryLabel(row);
            const pct = usagePercent(row);
            const busy = isBusy(row);
            const busyMsg = busyLabel(row);

            return (
              <div
                key={row.token}
                className="admin-card space-y-4 p-4 transition-shadow hover:shadow-md sm:p-5"
              >
                {/* Row 1: identity + copy key button */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm truncate max-w-[200px] sm:max-w-none">
                        {row.name || "Unnamed"}
                      </p>
                      {statusBadge(row)}
                      {row.cleanupPending && (
                        <Badge variant="outline" className="text-amber-600 border-amber-400 text-xs">
                          Cleanup pending
                        </Badge>
                      )}
                      {row.syncState === "pending" && (
                        <Badge variant="outline" className="text-amber-600 border-amber-400 text-xs">
                          Sync pending
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {row.serverName} · key {row.outlineKeyId}
                      {row.planDescription ? ` · ${row.planDescription}` : ""}
                    </p>
                    {busyMsg && (
                      <p className="text-xs text-blue-500 font-medium mt-0.5 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        {busyMsg}
                      </p>
                    )}
                  </div>

                  <Button
                    size="sm"
                    onClick={() => void copyKey(row)}
                    disabled={!row.dynamicUrl?.startsWith("ssconf://")}
                    className="min-h-10 shrink-0 px-4"
                    aria-label={`${row.dynamicUrl?.startsWith("ssconf://") ? "Copy permanent key for" : "Permanent key not ready for"} ${row.name}`}
                  >
                    {copied === row.token ? (
                      <Check className="mr-1.5 h-4 w-4" />
                    ) : (
                      <Copy className="mr-1.5 h-4 w-4" />
                    )}
                    <span>
                      {row.dynamicUrl?.startsWith("ssconf://") ? "Copy Key" : "Not ready"}
                    </span>
                  </Button>
                </div>

                {/* Row 2: permanent URL — truncates cleanly on mobile */}
                <div className="min-w-0 rounded-xl border bg-slate-50 px-3.5 py-2.5 dark:bg-slate-900/60">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Permanent key
                  </p>
                  <p className="text-xs font-mono break-all leading-relaxed">{row.dynamicUrl}</p>
                </div>

                {/* Row 3: stats grid — 2 cols on mobile, 4 on sm+ */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 text-xs">
                  <div>
                    <p className="text-muted-foreground mb-0.5">Usage</p>
                    <p className={row.quotaExhausted ? "text-destructive font-medium" : "font-medium"}>
                      {usageLabel(row)}
                    </p>
                    {row.quotaBytes !== null && (
                      <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                        <div
                          className={`h-full ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-blue-600"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Quota</p>
                    <p className="font-medium">{quotaAllowanceLabel(row)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Duration</p>
                    <p className="font-medium">{durationLabel(row)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Expiry</p>
                    <p className={expiry.tone}>{expiry.text}</p>
                  </div>
                </div>

                {/* All customer actions stay visible and wrap without horizontal scrolling. */}
                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    className="min-h-11"
                    onClick={() => setEditSubFor(row)}
                  >
                    <Gauge className="mr-1.5 h-3.5 w-3.5" />
                    Edit Subscription
                  </Button>
                  {row.status === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="min-h-11"
                      onClick={() =>
                        void run(
                          row, "disable",
                          () => disableCustomer(row.token),
                          "Customer disabled",
                          (r) => ({ status: "disabled" as const, syncPending: r.syncPending })
                        )
                      }
                    >
                      <Ban className="mr-1.5 h-3.5 w-3.5" />
                      <span>Disable</span>
                    </Button>
                  ) : row.status !== "revoked" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="min-h-11"
                      onClick={() =>
                        void run(
                          row, "enable",
                          () => enableCustomer(row.token),
                          "Customer enabled",
                          () => ({ status: "active" as const })
                        )
                      }
                    >
                      <Play className="mr-1.5 h-3.5 w-3.5" />
                      <span>Enable</span>
                    </Button>
                  ) : null}

                  {row.cleanupPending && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="min-h-11"
                      onClick={() =>
                        void run(
                          row, "cleanup",
                          () => cleanupCustomerMigration(row.token),
                          "Old key removed",
                          () => ({ cleanupPending: false })
                        )
                      }
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      <span>Clean up</span>
                    </Button>
                  )}

                  {row.syncState === "pending" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="min-h-11"
                      onClick={() =>
                        void run(
                          row, "resync",
                          () => resyncCustomer(row.token),
                          "Edge resynced",
                          () => ({ syncState: "synced" as const })
                        )
                      }
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      <span>Resync</span>
                    </Button>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => setDiagnoseFor(row)}
                  >
                    <Stethoscope className="mr-1.5 h-3.5 w-3.5" />
                    Diagnose
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={Boolean(busy) || row.status !== "active"}
                    onClick={() => setMigrateFor(row)}
                  >
                    <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                    Migrate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11"
                    onClick={() => void toggleReveal(row)}
                  >
                    {revealed[row.token]
                      ? <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                      : <Eye className="mr-1.5 h-3.5 w-3.5" />}
                    {revealed[row.token] ? "Hide raw key" : "Reveal raw key"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={Boolean(busy)}
                    onClick={() => setDeleteFor(row)}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete Customer
                  </Button>
                </div>

                {revealed[row.token] && (
                  <div className="rounded-lg border border-dashed border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">
                      Raw key — admin only, do not send to customers
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
            row, "migrate",
            () => migrateCustomer(row.token, destServerId, allowExhausted),
            "Customer migrated — permanent key unchanged",
            () => ({ cleanupPending: true })
          );
        }}
      />

      <EditSubscriptionDialog
        customer={editSubFor}
        onClose={() => setEditSubFor(null)}
        onConfirm={async (quotaGB, expiryDate) => {
          const row = editSubFor!;
          setEditSubFor(null);
          await run(
            row, "editSubscription",
            () => editCustomerSubscription(row.token, quotaGB, expiryDate),
            "Subscription updated",
            (r) => ({
              quotaBytes: r.quotaBytes,
              expiryDate: r.expiryDate,
              status: r.disabledImmediately ? ("disabled" as const) : row.status,
            })
          );
        }}
      />

      {addingCustomer && (
        <AddCustomerDialog
          servers={servers}
          onClose={() => setAddingCustomer(false)}
          onConfirm={async (params) => {
            setAddingCustomer(false);
            try {
              await createAdminCustomer(params);
              toast({ title: "Customer created", description: params.name });
              // Full reload needed: new row to insert.
              await load();
            } catch (err) {
              toast({
                title: "Could not create customer",
                description: err instanceof Error ? err.message : "Unknown error",
                variant: "destructive",
              });
            }
          }}
        />
      )}

      {diagnoseFor && (
        <DiagnoseDialog
          token={diagnoseFor.token}
          name={diagnoseFor.name}
          onClose={() => setDiagnoseFor(null)}
        />
      )}

      {deleteFor && (
        <DeleteCustomerDialog
          name={deleteFor.name}
          serverName={deleteFor.serverName}
          outlineKeyId={deleteFor.outlineKeyId}
          onClose={() => setDeleteFor(null)}
          onConfirm={async () => {
            const row = deleteFor;
            setDeleteFor(null);
            try {
              await deleteAdminCustomer(row.token);
              toast({ title: "Customer deleted", description: row.name });
              // Remove from list immediately — no full reload needed.
              setRows((prev) => prev.filter((r) => r.token !== row.token));
            } catch (err) {
              const e = err as Error & { code?: string };
              toast({
                title: e.code === "MIGRATION_IN_PROGRESS"
                  ? "Migration in progress"
                  : e.code === "OUTLINE_DELETE_FAILED"
                    ? "VPN key deletion failed"
                    : "Delete failed",
                description: e.message,
                variant: "destructive",
              });
            }
          }}
        />
      )}
      </div>
    </div>
  );
}
