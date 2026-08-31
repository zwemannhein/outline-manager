"use client";

/**
 * Delete Customer confirmation dialog.
 * Requires explicit typed confirmation before the destructive action.
 */

import React, { useState } from "react";
import { X, Trash2, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DeleteCustomerDialogProps {
  name: string;
  serverName: string;
  outlineKeyId: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

export function DeleteCustomerDialog({
  name,
  serverName,
  outlineKeyId,
  onClose,
  onConfirm,
}: DeleteCustomerDialogProps) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete Customer"
        className="relative w-full sm:max-w-md bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl border p-5 sm:p-6 space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-red-100 dark:bg-red-900/40 shrink-0">
              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="text-base font-semibold">Delete Customer</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground mt-0.5"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Warning */}
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 flex gap-2.5">
          <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-800 dark:text-red-200">
            This permanently revokes VPN access and removes the customer. This action cannot be undone.
          </p>
        </div>

        {/* Details */}
        <div className="rounded-lg border bg-muted/30 divide-y divide-border text-sm">
          <div className="flex justify-between gap-2 px-3 py-2">
            <span className="text-muted-foreground">Customer</span>
            <span className="font-medium truncate max-w-[200px]">{name || "Unnamed"}</span>
          </div>
          <div className="flex justify-between gap-2 px-3 py-2">
            <span className="text-muted-foreground">Server</span>
            <span className="font-medium truncate max-w-[200px]">{serverName}</span>
          </div>
          <div className="flex justify-between gap-2 px-3 py-2">
            <span className="text-muted-foreground">Key ID</span>
            <span className="font-mono text-xs">{outlineKeyId}</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          What will happen:
        </p>
        <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
          <li>VPN access revoked immediately (permanent key stops working)</li>
          <li>Outline key deleted from server</li>
          <li>Customer removed from active list</li>
          <li>Order/payment history is preserved</li>
        </ul>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            className="flex-1 min-h-[44px]"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="flex-1 min-h-[44px]"
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Customer
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
