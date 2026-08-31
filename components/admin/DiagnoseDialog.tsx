"use client";

/**
 * Customer Diagnose dialog — read-only diagnostic view.
 */

import React, { useEffect, useState } from "react";
import { X, CheckCircle2, XCircle, AlertTriangle, HelpCircle, RefreshCw, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diagnoseCustomer, type DiagnoseResult, type DiagCheckState } from "@/lib/sync";

function CheckIcon({ state }: { state: DiagCheckState }) {
  switch (state) {
    case "pass":    return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />;
    case "fail":    return <XCircle      className="w-4 h-4 text-red-500 shrink-0" />;
    case "warn":    return <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />;
    case "unknown": return <HelpCircle   className="w-4 h-4 text-gray-400 shrink-0" />;
  }
}

function stateLabel(state: DiagCheckState) {
  return { pass: "PASS", fail: "FAIL", warn: "WARN", unknown: "UNKNOWN" }[state];
}

function stateColor(state: DiagCheckState) {
  return {
    pass:    "text-green-700 dark:text-green-400",
    fail:    "text-red-700 dark:text-red-400",
    warn:    "text-amber-700 dark:text-amber-400",
    unknown: "text-gray-500",
  }[state];
}

interface DiagnoseDialogProps {
  token: string;
  name: string;
  onClose: () => void;
}

export function DiagnoseDialog({ token, name, onClose }: DiagnoseDialogProps) {
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await diagnoseCustomer(token);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Diagnosis failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void run(); }, [token]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Diagnose ${name}`}
        className="relative w-full sm:max-w-lg bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl border p-5 sm:p-6 space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 shrink-0">
              <Stethoscope className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Diagnose Customer</h2>
              <p className="text-xs text-muted-foreground truncate">{name}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground mt-0.5">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-10">
            <div className="text-center space-y-2 text-muted-foreground">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto" />
              <p className="text-sm">Running diagnostics…</p>
            </div>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3 space-y-2">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            <Button size="sm" variant="outline" onClick={run}>Retry</Button>
          </div>
        )}

        {/* Results */}
        {!loading && result && (
          <>
            {/* Check list */}
            <div className="rounded-lg border divide-y divide-border overflow-hidden">
              {result.checks.map((c) => (
                <div key={c.label} className="flex items-start justify-between gap-2 px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckIcon state={c.state} />
                    <span className="text-sm truncate">{c.label}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`text-xs font-semibold ${stateColor(c.state)}`}>
                      {stateLabel(c.state)}
                    </span>
                    {c.detail && (
                      <p className="text-[10px] text-muted-foreground max-w-[160px] text-right">{c.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Diagnosis summary */}
            <div className={`rounded-lg border p-3 space-y-1.5 ${
              result.diagnosis === "no_issue"
                ? "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900"
                : "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900"
            }`}>
              <p className={`text-sm font-medium ${result.diagnosis === "no_issue" ? "text-green-800 dark:text-green-200" : "text-amber-800 dark:text-amber-200"}`}>
                {result.diagnosis === "no_issue" ? "✓ No issues detected" : `⚠ ${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} found`}
              </p>
              {result.issues.map((issue, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-300">• {issue}</p>
              ))}
              {result.suggestedAction && (
                <p className="text-xs text-muted-foreground pt-1 border-t border-amber-200 dark:border-amber-800 mt-1">
                  <span className="font-medium">Suggested: </span>{result.suggestedAction}
                </p>
              )}
            </div>

            {/* Footer info */}
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Checked at {new Date(result.checkedAt).toLocaleTimeString()}</span>
              <Button size="sm" variant="ghost" onClick={run} className="min-h-[36px]">
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Re-run
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
