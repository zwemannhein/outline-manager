"use client";

import React from "react";
import {
  Trash2, Edit2, BarChart2, Plus,
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
        <h2 className="text-base font-semibold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">Access Keys</h2>
        <Button 
          size="sm" 
          onClick={onCreateKey} 
          disabled={loading}
          className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-lg"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          New Key
        </Button>
      </div>

      {/* ── Desktop table (md+) ── */}
      <div className="hidden md:block rounded-xl backdrop-blur-md bg-white/80 dark:bg-gray-900/80 border border-white/20 shadow-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b backdrop-blur-sm bg-gradient-to-r from-blue-50 to-purple-50 dark:from-gray-800 dark:to-gray-800">
                <th className="text-left px-4 py-3 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Name / ID</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Data Used</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Limit</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Expiry</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wide">Actions</th>
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
                  <tr key={key.id} className="border-b last:border-0 hover:bg-gradient-to-r hover:from-blue-50/50 hover:to-purple-50/50 dark:hover:from-gray-800/50 dark:hover:to-gray-800/50 transition-all">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[160px]">
                            {key.name || <span className="text-muted-foreground italic">Unnamed</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">ID: {key.id}</p>
                        </div>
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
                        ? <Badge variant={overLimit ? "destructive" : "secondary"} className={overLimit ? "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900" : "bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900"}>{formatBytes(limit)}</Badge>
                        : <span className="text-muted-foreground text-xs">Unlimited</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {expiry.urgent && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                        <Badge 
                          variant={expiry.variant} 
                          className={`text-xs whitespace-nowrap ${
                            expiry.variant === "destructive" ? "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900" :
                            expiry.variant === "warning" ? "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900" :
                            "bg-gray-100 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700"
                          }`}
                        >
                          {expiry.label}
                        </Badge>
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
            <div key={key.id} className="rounded-xl backdrop-blur-md bg-white/80 dark:bg-gray-900/80 border border-white/20 shadow-lg hover:shadow-xl transition-all p-4 space-y-3">
              {/* Name row */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">
                    {key.name || <span className="text-muted-foreground italic font-normal">Unnamed</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">ID: {key.id}</p>
                </div>
              </div>

              {/* Data usage */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className={overLimit ? "text-destructive font-medium" : ""}>{formatBytes(used)} used</span>
                  <span>{limit ? formatBytes(limit) + " limit" : "Unlimited"}</span>
                </div>
                {pct !== null && (
                  <Progress value={pct} className={`h-2 rounded-full ${overLimit ? "[&>div]:bg-gradient-to-r [&>div]:from-red-500 [&>div]:to-pink-500" : "[&>div]:bg-gradient-to-r [&>div]:from-blue-500 [&>div]:to-purple-500"}`} />
                )}
              </div>

              {/* Expiry */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  {expiry.urgent && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
                  <Badge 
                    variant={expiry.variant} 
                    className={`text-xs ${
                      expiry.variant === "destructive" ? "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900" :
                      expiry.variant === "warning" ? "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900" :
                      "bg-gray-100 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700"
                    }`}
                  >
                    {expiry.label}
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">Port {key.port}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 pt-1 border-t border-gray-200 dark:border-gray-700">
                <Button variant="ghost" size="sm" className="flex-1 h-9 text-xs hover:bg-blue-50 dark:hover:bg-blue-950/30" onClick={() => onRename(key.id, key.name)}>
                  <Edit2 className="w-3.5 h-3.5 mr-1" /> Rename
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 h-9 text-xs hover:bg-purple-50 dark:hover:bg-purple-950/30" onClick={() => onSetLimit(key.id, key.dataLimit?.bytes ?? key.limit?.bytes)}>
                  <BarChart2 className="w-3.5 h-3.5 mr-1" /> Limit
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 h-9 text-xs hover:bg-pink-50 dark:hover:bg-pink-950/30" onClick={() => onSetExpiry(key.id, meta.expiryDate)}>
                  <CalendarClock className="w-3.5 h-3.5 mr-1" /> Expiry
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0" onClick={() => onDelete(key.id)}>
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
