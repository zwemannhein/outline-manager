"use client";

/**
 * Dialogs for customer lifecycle actions.
 *
 * Each one states explicitly whether the customer's permanent key changes,
 * because "will my customer have to re-add their key?" is the only question that
 * really matters for these operations. The answer is always no.
 */

import React, { useEffect, useState } from "react";
import { X, ArrowRightLeft, CalendarPlus, Gauge, AlertTriangle } from "lucide-react";
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
