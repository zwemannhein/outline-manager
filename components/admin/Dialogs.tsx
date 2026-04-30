"use client";

/**
 * All admin modal dialogs:
 *  - RenameKeyDialog
 *  - SetLimitDialog
 *  - CreateKeyDialog
 *  - AddServerDialog
 *  - ConfirmDeleteDialog
 */

import React, { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseDataLimit } from "@/lib/utils";

// ─── Rename ───────────────────────────────────────────────────────────────────

interface RenameKeyDialogProps {
  open: boolean;
  currentName: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function RenameKeyDialog({ open, currentName, onConfirm, onClose }: RenameKeyDialogProps) {
  const [name, setName] = useState(currentName);
  useEffect(() => { if (open) setName(currentName); }, [open, currentName]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename Key</DialogTitle>
          <DialogDescription>Give this access key a friendly name.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alice's Phone"
            onKeyDown={(e) => e.key === "Enter" && name.trim() && onConfirm(name.trim())}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(name.trim())} disabled={!name.trim()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Set Limit ────────────────────────────────────────────────────────────────

interface SetLimitDialogProps {
  open: boolean;
  currentBytes?: number;
  onConfirm: (bytes: number | null) => void;
  onClose: () => void;
}

export function SetLimitDialog({ open, currentBytes, onConfirm, onClose }: SetLimitDialogProps) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<"MB" | "GB">("GB");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      if (currentBytes) {
        const gb = currentBytes / 1024 ** 3;
        if (gb >= 1) { setValue(gb.toFixed(2)); setUnit("GB"); }
        else { setValue((currentBytes / 1024 ** 2).toFixed(0)); setUnit("MB"); }
      } else {
        setValue("");
        setUnit("GB");
      }
    }
  }, [open, currentBytes]);

  function handleConfirm() {
    if (!value.trim()) {
      setError("Enter a data limit amount.");
      return;
    }
    try {
      const bytes = parseDataLimit(value, unit);
      onConfirm(bytes);
    } catch {
      setError("Enter a valid positive number.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set Data Limit</DialogTitle>
          <DialogDescription>
            {currentBytes
              ? "Update the data limit for this key."
              : "Set a data limit for this key."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="limit-value">Amount</Label>
              <Input
                id="limit-value"
                type="number"
                min="0.1"
                step="any"
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                placeholder="e.g. 10"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label>Unit</Label>
              <Select value={unit} onValueChange={(v) => setUnit(v as "MB" | "GB")}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MB">MB</SelectItem>
                  <SelectItem value="GB">GB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {currentBytes && (
            <Button variant="outline" onClick={() => onConfirm(null)}>
              Remove Limit
            </Button>
          )}
          <Button onClick={handleConfirm} disabled={!value.trim()}>
            {currentBytes ? "Update" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Create Key ───────────────────────────────────────────────────────────────

interface CreateKeyDialogProps {
  open: boolean;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function CreateKeyDialog({ open, onConfirm, onClose }: CreateKeyDialogProps) {
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(""); }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Access Key</DialogTitle>
          <DialogDescription>Optionally give the new key a name.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="new-key-name">Name (optional)</Label>
          <Input
            id="new-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bob's Laptop"
            onKeyDown={(e) => e.key === "Enter" && onConfirm(name.trim())}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(name.trim())}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Server ───────────────────────────────────────────────────────────────

interface AddServerDialogProps {
  open: boolean;
  onConfirm: (apiUrl: string, certSha256: string, name: string) => void;
  onClose: () => void;
}

export function AddServerDialog({ open, onConfirm, onClose }: AddServerDialogProps) {
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setJson(""); setName(""); setError(null); } }, [open]);

  function handleConfirm() {
    setError(null);
    try {
      const parsed = JSON.parse(json.trim()) as { apiUrl?: string; certSha256?: string };
      if (!parsed.apiUrl || !parsed.certSha256) throw new Error("Missing fields");
      onConfirm(parsed.apiUrl, parsed.certSha256, name.trim() || "My Server");
    } catch {
      setError('Paste valid JSON: {"apiUrl":"…","certSha256":"…"}');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
          <DialogDescription>Paste the management API JSON from your Outline Manager.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="server-name">Friendly Name</Label>
            <Input
              id="server-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. US East Server"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="server-json">Management Key JSON</Label>
            <textarea
              id="server-json"
              value={json}
              onChange={(e) => { setJson(e.target.value); setError(null); }}
              rows={4}
              placeholder='{"apiUrl":"https://…","certSha256":"…"}'
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!json.trim()}>Add Server</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Confirm Delete ───────────────────────────────────────────────────────────

interface ConfirmDeleteDialogProps {
  open: boolean;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDeleteDialog({ open, label, onConfirm, onClose }: ConfirmDeleteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Key</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{label || "this key"}</strong>? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Set Expiry ───────────────────────────────────────────────────────────────

interface SetExpiryDialogProps {
  open: boolean;
  keyName: string;
  currentExpiry: string | null; // ISO date string or null
  onConfirm: (isoDate: string | null) => void;
  onClose: () => void;
}

export function SetExpiryDialog({
  open,
  keyName,
  currentExpiry,
  onConfirm,
  onClose,
}: SetExpiryDialogProps) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open) {
      // Pre-fill with current expiry date in YYYY-MM-DD format for the input
      setValue(currentExpiry ? currentExpiry.slice(0, 10) : "");
    }
  }, [open, currentExpiry]);

  function handleConfirm() {
    if (!value) {
      onConfirm(null);
      return;
    }
    // Convert local date string to end-of-day ISO
    const d = new Date(value);
    d.setHours(23, 59, 59, 999);
    onConfirm(d.toISOString());
  }

  // Min date = today
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set Expiry Date</DialogTitle>
          <DialogDescription>
            Set an expiry date for <strong>{keyName || "this key"}</strong>.
            Leave blank to remove the expiry.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="expiry-date">Expiry Date</Label>
          <Input
            id="expiry-date"
            type="date"
            min={today}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          {value && (
            <p className="text-xs text-muted-foreground">
              Key will expire at end of {new Date(value).toLocaleDateString(undefined, {
                year: "numeric", month: "long", day: "numeric",
              })}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {currentExpiry && (
            <Button variant="outline" onClick={() => onConfirm(null)}>
              Remove Expiry
            </Button>
          )}
          <Button onClick={handleConfirm}>
            {value ? "Set Expiry" : "Remove Expiry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
