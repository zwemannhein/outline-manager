"use client";

/**
 * Dialogs for customer lifecycle actions.
 *
 * Each one states explicitly whether the customer's permanent key changes,
 * because "will my customer have to re-add their key?" is the only question that
 * really matters for these operations. The answer is always no.
 */

import React, { useEffect, useState } from "react";
import { X, ArrowRightLeft, CalendarPlus, Gauge, AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/utils";
import type { DynamicCustomerRow } from "@/lib/sync";

function Shell({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border p-6 space-y-5"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">{icon}</div>
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const KEY_UNCHANGED_NOTE = (
  <p className="text-xs text-muted-foreground">
    The customer&apos;s permanent key does not change. They do not need to re-add anything.
  </p>
);

// ── Migrate ───────────────────────────────────────────────────────────────────

export function MigrateServerDialog({
  customer,
  servers,
  onClose,
  onConfirm,
}: {
  customer: DynamicCustomerRow | null;
  servers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onConfirm: (destServerId: string, allowExhausted: boolean) => void | Promise<void>;
}) {
  const [dest, setDest] = useState("");
  const [allowExhausted, setAllowExhausted] = useState(false);

  const options = servers.filter((s) => s.id !== customer?.serverId);

  // Reset the selection whenever a different customer is opened. `options` is
  // derived from props each render, so depending on its identity would loop.
  const firstOptionId = options[0]?.id ?? "";
  useEffect(() => {
    setDest(firstOptionId);
    setAllowExhausted(false);
  }, [customer, firstOptionId]);

  if (!customer) return null;

  const remaining = customer.remainingBytes;
  const exhausted = customer.quotaExhausted;

  return (
    <Shell
      title="Migrate to another server"
      icon={<ArrowRightLeft className="w-5 h-5 text-white" />}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">Customer:</span> {customer.name}
          </p>
          <p>
            <span className="text-muted-foreground">Current server:</span> {customer.serverName}
          </p>
          <p>
            <span className="text-muted-foreground">Used this cycle:</span>{" "}
            {formatBytes(customer.usedBytes)}
            {customer.quotaBytes !== null ? ` of ${formatBytes(customer.quotaBytes)}` : " (unlimited)"}
          </p>
        </div>

        {/* The key behaviour an operator needs to understand. */}
        <div className="rounded-lg bg-muted/60 p-3 text-xs space-y-1">
          <p className="font-medium">What happens</p>
          <p>
            The destination key receives{" "}
            <span className="font-medium">
              {customer.quotaBytes === null
                ? "unlimited data"
                : `${formatBytes(Math.max(0, remaining ?? 0))} remaining`}
            </span>
            , not a fresh allowance. The full quota returns at the next 30-day cycle.
          </p>
          <p>The old key stays alive until you run cleanup, so there is no downtime.</p>
        </div>

        {options.length === 0 ? (
          <p className="text-sm text-destructive">
            No other server is registered. Add one before migrating.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="dest-server">Destination server</Label>
            <select
              id="dest-server"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              className="w-full h-10 rounded-md border bg-background px-3 text-sm"
            >
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {exhausted && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={allowExhausted}
              onChange={(e) => setAllowExhausted(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-amber-900 dark:text-amber-200">
              <span className="font-medium flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Admin override
              </span>
              This customer has used their whole cycle quota, so the new key will pass no traffic until the
              next cycle. Only override when decommissioning a server.
            </span>
          </label>
        )}

        {KEY_UNCHANGED_NOTE}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
            disabled={!dest || (exhausted && !allowExhausted)}
            onClick={() => void onConfirm(dest, allowExhausted)}
          >
            Migrate
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// ── Renew ─────────────────────────────────────────────────────────────────────

export function RenewDialog({
  customer,
  onClose,
  onConfirm,
}: {
  customer: DynamicCustomerRow | null;
  onClose: () => void;
  onConfirm: (cycles: number) => void | Promise<void>;
}) {
  const [cycles, setCycles] = useState(1);

  useEffect(() => setCycles(1), [customer]);

  if (!customer) return null;

  return (
    <Shell title="Renew subscription" icon={<CalendarPlus className="w-5 h-5 text-white" />} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">Customer:</span> {customer.name}
          </p>
          <p>
            <span className="text-muted-foreground">Cycles used:</span> {customer.cyclesUsed ?? "?"} of{" "}
            {customer.cyclesTotal ?? "?"}
          </p>
          <p>
            <span className="text-muted-foreground">Current expiry:</span>{" "}
            {customer.expiryDate ? new Date(customer.expiryDate).toLocaleDateString() : "None"}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="renew-cycles">Additional 30-day cycles</Label>
          <Input
            id="renew-cycles"
            type="number"
            min={1}
            max={24}
            value={cycles}
            onChange={(e) => setCycles(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
          />
          <p className="text-xs text-muted-foreground">
            Each cycle grants the monthly quota again. Unused data does not carry over.
          </p>
        </div>

        {(customer.status === "expired" || customer.status === "disabled") && (
          <div className="rounded-lg bg-muted/60 p-3 text-xs">
            This customer is currently blocked. Renewing will restore their access immediately.
          </div>
        )}

        {KEY_UNCHANGED_NOTE}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
            onClick={() => void onConfirm(cycles)}
          >
            Renew
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// ── Quota ─────────────────────────────────────────────────────────────────────

export function QuotaDialog({
  customer,
  onClose,
  onConfirm,
}: {
  customer: DynamicCustomerRow | null;
  onClose: () => void;
  onConfirm: (quotaGB: number | null) => void | Promise<void>;
}) {
  const [unlimited, setUnlimited] = useState(false);
  const [gb, setGb] = useState(100);

  useEffect(() => {
    if (!customer) return;
    const isUnlimited = customer.quotaBytes === null;
    setUnlimited(isUnlimited);
    setGb(
      isUnlimited
        ? 100
        : Math.max(1, Math.round((customer.quotaBytes ?? 0) / (1024 * 1024 * 1024)))
    );
  }, [customer]);

  if (!customer) return null;

  return (
    <Shell title="Change monthly quota" icon={<Gauge className="w-5 h-5 text-white" />} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">Customer:</span> {customer.name}
          </p>
          <p>
            <span className="text-muted-foreground">Used this cycle:</span>{" "}
            {formatBytes(customer.usedBytes)}
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
          Unlimited data
        </label>

        {!unlimited && (
          <div className="space-y-2">
            <Label htmlFor="quota-gb">GB every 30 days</Label>
            <Input
              id="quota-gb"
              type="number"
              min={1}
              max={100000}
              value={gb}
              onChange={(e) => setGb(Math.max(1, Number(e.target.value) || 1))}
            />
            <p className="text-xs text-muted-foreground">
              This is the allowance per 30-day cycle, not a total for the whole subscription.
            </p>
          </div>
        )}

        {KEY_UNCHANGED_NOTE}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
            onClick={() => void onConfirm(unlimited ? null : gb)}
          >
            Save quota
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// ── Edit Subscription (quota + expiry together) ───────────────────────────────

export function EditSubscriptionDialog({
  customer,
  onClose,
  onConfirm,
}: {
  customer: DynamicCustomerRow | null;
  onClose: () => void;
  onConfirm: (quotaGB: number | null, expiryDate: string | null) => void | Promise<void>;
}) {
  const [unlimited, setUnlimited] = useState(false);
  const [gb, setGb] = useState(100);
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    if (!customer) return;
    const isUnlimited = customer.quotaBytes === null;
    setUnlimited(isUnlimited);
    setGb(
      isUnlimited
        ? 100
        : Math.max(1, Math.round(((customer.configuredQuotaBytes ?? customer.quotaBytes ?? 0)) / (1024 * 1024 * 1024)))
    );
    setExpiry(customer.expiryDate ? customer.expiryDate.slice(0, 10) : "");
  }, [customer]);

  if (!customer) return null;

  function handleSave() {
    const quotaGB = unlimited ? null : gb;
    const expiryIso = expiry ? new Date(expiry + "T23:59:59Z").toISOString() : null;
    void onConfirm(quotaGB, expiryIso);
  }

  return (
    <Shell title="Edit subscription" icon={<Gauge className="w-5 h-5 text-white" />} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm space-y-1">
          <p><span className="text-muted-foreground">Customer:</span> {customer.name}</p>
          <p>
            <span className="text-muted-foreground">Used this period:</span>{" "}
            {formatBytes(customer.usedBytes)}
          </p>
        </div>

        {/* Unlimited toggle */}
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
          Unlimited data
        </label>

        {/* Quota input */}
        {!unlimited && (
          <div className="space-y-2">
            <Label htmlFor="edit-sub-quota">Quota</Label>
            <div className="flex items-center gap-2">
              <Input
                id="edit-sub-quota"
                type="number"
                min={1}
                max={100000}
                value={gb}
                onChange={(e) => setGb(Math.max(1, Number(e.target.value) || 1))}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">GB every 30 days</span>
            </div>
          </div>
        )}

        {/* Expiry date */}
        <div className="space-y-2">
          <Label htmlFor="edit-sub-expiry">Expiry Date</Label>
          <Input
            id="edit-sub-expiry"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank for no expiry. A past date disables the customer immediately.
          </p>
        </div>

        {KEY_UNCHANGED_NOTE}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
            onClick={handleSave}
          >
            Save Changes
          </Button>
        </div>
      </div>
    </Shell>
  );
}

// ── Add Customer ──────────────────────────────────────────────────────────────

export function AddCustomerDialog({
  servers,
  onClose,
  onConfirm,
}: {
  servers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onConfirm: (params: {
    name: string;
    serverId: string;
    keyMode: "new" | "existing";
    existingKeyId?: string | null;
    quotaGB: number | null;
    expiryDate: string | null;
  }) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState(servers[0]?.id ?? "");
  const [keyMode, setKeyMode] = useState<"new" | "existing">("new");
  const [unmanagedKeys, setUnmanagedKeys] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [unlimited, setUnlimited] = useState(true);
  const [gb, setGb] = useState(100);
  const [expiry, setExpiry] = useState("");

  // Load unmanaged keys when mode=existing + server changes
  useEffect(() => {
    if (keyMode !== "existing" || !serverId) return;
    setLoadingKeys(true);
    import("@/lib/sync").then(({ listUnmanagedKeys }) =>
      listUnmanagedKeys(serverId)
        .then((keys) => {
          setUnmanagedKeys(keys);
          setSelectedKeyId(keys[0]?.id ?? "");
        })
        .catch(() => setUnmanagedKeys([]))
        .finally(() => setLoadingKeys(false))
    );
  }, [keyMode, serverId]);

  function handleCreate() {
    const quotaGB = unlimited ? null : gb;
    const expiryIso = expiry ? new Date(expiry + "T23:59:59Z").toISOString() : null;
    void onConfirm({
      name: name.trim(),
      serverId,
      keyMode,
      existingKeyId: keyMode === "existing" ? selectedKeyId : null,
      quotaGB,
      expiryDate: expiryIso,
    });
  }

  const canSubmit = name.trim().length > 0 &&
    serverId &&
    (keyMode === "new" || (keyMode === "existing" && !!selectedKeyId));

  return (
    <Shell title="Add Customer" icon={<Users className="w-5 h-5 text-white" />} onClose={onClose}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="add-cust-name">Customer Name</Label>
          <Input
            id="add-cust-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ko Aung"
          />
        </div>

        {/* Server */}
        <div className="space-y-2">
          <Label htmlFor="add-cust-server">Server</Label>
          <select
            id="add-cust-server"
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="w-full h-10 rounded-md border bg-background px-3 text-sm"
          >
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* Key mode */}
        <div className="space-y-2">
          <Label>Key Mode</Label>
          <div className="flex gap-3">
            {(["new", "existing"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="keyMode"
                  value={m}
                  checked={keyMode === m}
                  onChange={() => setKeyMode(m)}
                />
                {m === "new" ? "Create New Outline Key" : "Use Existing Outline Key"}
              </label>
            ))}
          </div>
        </div>

        {/* Existing key selector */}
        {keyMode === "existing" && (
          <div className="space-y-2">
            <Label htmlFor="add-cust-key">Existing Key (unmanaged only)</Label>
            {loadingKeys ? (
              <p className="text-xs text-muted-foreground">Loading keys…</p>
            ) : unmanagedKeys.length === 0 ? (
              <p className="text-xs text-destructive">No unmanaged keys found on this server.</p>
            ) : (
              <select
                id="add-cust-key"
                value={selectedKeyId}
                onChange={(e) => setSelectedKeyId(e.target.value)}
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
              >
                {unmanagedKeys.map((k) => (
                  <option key={k.id} value={k.id}>ID {k.id} — {k.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Quota */}
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
          Unlimited data
        </label>
        {!unlimited && (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={100000}
              value={gb}
              onChange={(e) => setGb(Math.max(1, Number(e.target.value) || 1))}
              className="w-32"
            />
            <span className="text-sm text-muted-foreground">GB every 30 days</span>
          </div>
        )}

        {/* Expiry */}
        <div className="space-y-2">
          <Label htmlFor="add-cust-expiry">Expiry Date (optional)</Label>
          <Input
            id="add-cust-expiry"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </div>

        {KEY_UNCHANGED_NOTE}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
            disabled={!canSubmit}
            onClick={handleCreate}
          >
            Create Customer
          </Button>
        </div>
      </div>
    </Shell>
  );
}
