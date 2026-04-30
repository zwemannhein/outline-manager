"use client";

import React, { useState } from "react";
import {
  Trash2, Edit2, BarChart2, Plus, Copy, Check,
  CalendarClock, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/utils";
import type { AccessKey, KeyMeta } from "@/lib/types";

interface KeyTableProps {
  keys: AccessKey[];
  metrics: Record<string, number>;
  keyMetas: Record<string, KeyMeta>;
  onDelete: (keyId: string) => void;
  onRename: (keyId: string, currentName: string) => void;
  onSetLimit: (keyId: string, currentLimit?: number) => void;
  onSetExpiry: (keyId: string, currentExpiry: string | null) => void;
  onCreateKey: () => void;
  loading: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
      title="Copy access URL"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-emerald-500" />
        : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function expiryStatus(isoDate: string | null) {
  if (!isoDate) return { label: "No expiry", variant: "outline" as const, urgent: false };
  const daysLeft = Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86_400_000);
  if (daysLeft <= 0) return { label: "Expired", variant: "destructive" as const, urgent: true };
  if (daysLeft <= 5) return { label: `${daysLeft}d left`, variant: "warning" as const, urgent: true };
  return {
    label: new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    variant: "secondary" as const,
    urgent: false,
  };
}

export function KeyTable({
  keys, metrics, keyMetas, onDelete, onRename,
  onSetLimit, onSetExpiry, onCreateKey, loading,
}: KeyTableProps) {
  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Access Keys</h2>
        <Button size="sm" onClick={onCreateKey} disabled={loading}>
          <Plus className="w-4 h-4 mr-1.5" />
          New Key
        </Button>
      </div>

      {/* ── Desktop table (md+) ── */}
      <div className="hidden md:block rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name / ID</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Data Used</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Limit</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Expiry</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="text-center py-12 text-muted-foreground">Loading keys…</td></tr>
              )}
              {!loading && keys.length === 0 && (
                <tr><td colSpan={5} className="text-center py-12 text-muted-foreground">No access keys. Create one to get started.</td></tr>
              )}
              {!loading && keys.map((key) => {
                const used = metrics[key.id] ?? 0;
                const limit = key.dataLimit?.bytes ?? key.limit?.bytes;
                const pct = limit ? Math.min(100, (used / limit) * 100) : null;
                const overLimit = limit ? used >= limit : false;
                const meta = keyMetas[key.id] ?? { expiryDate: null };
                const expiry = expiryStatus(meta.expiryDate);

                return (
                  <tr key={key.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[160px]">
                            {key.name || <span className="text-muted-foreground italic">Unnamed</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">ID: {key.id}</p>
                        </div>
                        <CopyButton text={key.accessUrl} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <span className={overLimit ? "text-destructive font-medium" : ""}>{formatBytes(used)}</span>
                        {pct !== null && (
                          <div className="w-20 h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div className={`h-full rounded-full ${overLimit ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {limit
                        ? <Badge variant={overLimit ? "destructive" : "secondary"}>{formatBytes(limit)}</Badge>
                        : <span className="text-muted-foreground text-xs">Unlimited</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {expiry.urgent && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                        <Badge variant={expiry.variant} className="text-xs whitespace-nowrap">{expiry.label}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onRename(key.id, key.name)} title="Rename"><Edit2 className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onSetLimit(key.id, key.dataLimit?.bytes ?? key.limit?.bytes)} title="Set data limit"><BarChart2 className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onSetExpiry(key.id, meta.expiryDate)} title="Set expiry"><CalendarClock className="w-3.5 h-3.5" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(key.id)} title="Delete"><Trash2 className="w-3.5 h-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Mobile cards (< md) ── */}
      <div className="md:hidden space-y-3">
        {loading && (
          <p className="text-center py-8 text-sm text-muted-foreground">Loading keys…</p>
        )}
        {!loading && keys.length === 0 && (
          <p className="text-center py-8 text-sm text-muted-foreground">No access keys. Create one to get started.</p>
        )}
        {!loading && keys.map((key) => {
          const used = metrics[key.id] ?? 0;
          const limit = key.dataLimit?.bytes ?? key.limit?.bytes;
          const pct = limit ? Math.min(100, (used / limit) * 100) : null;
          const overLimit = limit ? used >= limit : false;
          const meta = keyMetas[key.id] ?? { expiryDate: null };
          const expiry = expiryStatus(meta.expiryDate);

          return (
            <div key={key.id} className="rounded-lg border bg-card p-4 space-y-3">
              {/* Name row */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">
                    {key.name || <span className="text-muted-foreground italic font-normal">Unnamed</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">ID: {key.id}</p>
                </div>
                <CopyButton text={key.accessUrl} />
              </div>

              {/* Data usage */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className={overLimit ? "text-destructive font-medium" : ""}>{formatBytes(used)} used</span>
                  <span>{limit ? formatBytes(limit) + " limit" : "Unlimited"}</span>
                </div>
                {pct !== null && (
                  <Progress value={pct} className={`h-1.5 ${overLimit ? "[&>div]:bg-destructive" : ""}`} />
                )}
              </div>

              {/* Expiry */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  {expiry.urgent && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                  <Badge variant={expiry.variant} className="text-xs">{expiry.label}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">Port {key.port}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 pt-1 border-t">
                <Button variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={() => onRename(key.id, key.name)}>
                  <Edit2 className="w-3.5 h-3.5 mr-1" /> Rename
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={() => onSetLimit(key.id, key.dataLimit?.bytes ?? key.limit?.bytes)}>
                  <BarChart2 className="w-3.5 h-3.5 mr-1" /> Limit
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 h-8 text-xs" onClick={() => onSetExpiry(key.id, meta.expiryDate)}>
                  <CalendarClock className="w-3.5 h-3.5 mr-1" /> Expiry
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive shrink-0" onClick={() => onDelete(key.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
