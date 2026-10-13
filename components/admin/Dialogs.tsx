"use client";

import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AddServerDialogProps {
  open: boolean;
  onConfirm: (apiUrl: string, certSha256: string, name: string) => void;
  onClose: () => void;
}

/** Add a registered Outline server from its management-key JSON. */
export function AddServerDialog({ open, onConfirm, onClose }: AddServerDialogProps) {
  const [json, setJson] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setJson("");
      setName("");
      setError(null);
    }
  }, [open]);

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
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
          <DialogDescription>
            Paste the management API JSON from your Outline Manager.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="server-name">Friendly Name</Label>
            <Input
              id="server-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. US East Server"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="server-json">Management Key JSON</Label>
            <textarea
              id="server-json"
              value={json}
              onChange={(event) => {
                setJson(event.target.value);
                setError(null);
              }}
              rows={4}
              placeholder='{"apiUrl":"https://…","certSha256":"…"}'
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
