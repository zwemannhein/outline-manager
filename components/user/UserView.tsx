"use client";

import React, { useMemo, useState, useCallback } from "react";
import {
  Shield, LogOut, RefreshCw, AlertCircle,
  AlertTriangle, Wifi, WifiOff, CalendarX, KeyRound, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { decodeSsUrl, detectInputKind } from "@/lib/ss-decoder";
import { formatBytes, clamp } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface UserViewProps {
  ssUrl: string;
  onLogout: () => void;
  onSwitchKey: (newUrl: string) => void;
}

interface KeyStatus {
  serverName: string;
  keyName: string | null;
  keyId: string;
  bytesUsed: number;
  dataLimit: number | null;
  expiryDate: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function UserView({ ssUrl, onLogout, onSwitchKey }: UserViewProps) {
  const decoded = useMemo(() => {
    try { return decodeSsUrl(ssUrl); }
    catch { return null; }
  }, [ssUrl]);

  const [keyStatus, setKeyStatus]   = useState<KeyStatus | null>(null);
  const [status, setStatus]         = useState<"idle" | "loading" | "ok" | "error" | "no-server">("idle");
  const [errMsg, setErrMsg]         = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // ── Switch key panel ──────────────────────────────────────────────────────
  const [showSwitch, setShowSwitch]   = useState(false);
  const [switchValue, setSwitchValue] = useState("");
  const [switchError, setSwitchError] = useState("");

  function handleSwitchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSwitchError("");
    const trimmed = switchValue.trim();
    if (!trimmed) { setSwitchError("Paste an access key."); return; }
    const kind = detectInputKind(trimmed);
    if (kind !== "ss-url" && kind !== "ssconf-url") {
      setSwitchError("Not a valid key. Must start with ss:// or ssconf://");
      return;
    }
    setShowSwitch(false);
    setSwitchValue("");
    onSwitchKey(trimmed);
  }

  // ── Load via public API — no user credentials needed ─────────────────────
  const load = useCallback(async (isRefresh = false) => {
    if (!decoded) { 
      console.log("[UserView] No decoded key available");
      setStatus("no-server"); 
      return; 
    }
    
    if (isRefresh) setRefreshing(true);
    else setStatus("loading");

    console.log(`[UserView] Loading key status for: ${decoded.host}`);
    const startTime = Date.now();

    try {
      const res = await fetch("/api/v1/key-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssHost: decoded.host,
          keyId: decoded.keyId ?? undefined,
          password: decoded.password,
        }),
      });

      const data = await res.json() as KeyStatus & { error?: string };
      const loadTime = Date.now() - startTime;

      if (!res.ok) {
        console.error(`[UserView] Key check failed (${res.status}) in ${loadTime}ms:`, data.error);
        if (res.status === 404 && data.error?.includes("not found")) {
          setStatus("no-server");
          setErrMsg(data.error);
        } else {
          setStatus("error");
          setErrMsg(data.error ?? `HTTP ${res.status}`);
        }
        return;
      }

      console.log(`[UserView] Key status loaded successfully in ${loadTime}ms`);
      setKeyStatus(data);
      setStatus("ok");
    } catch (e) {
      const loadTime = Date.now() - startTime;
      console.error(`[UserView] Network error after ${loadTime}ms:`, e);
      setStatus("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [decoded]);

  React.useEffect(() => { load(false); }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const dataLimit  = keyStatus?.dataLimit ?? null;
  const bytesUsed  = keyStatus?.bytesUsed ?? 0;
  const remaining  = dataLimit !== null ? Math.max(0, dataLimit - bytesUsed) : null;
  const pct        = dataLimit ? clamp((bytesUsed / dataLimit) * 100, 0, 100) : 0;
  const overLimit  = dataLimit !== null && bytesUsed >= dataLimit;
  const expiryDate = keyStatus?.expiryDate ?? null;
  const days       = expiryDate ? daysLeft(expiryDate) : null;
  const isExpired  = days !== null && days <= 0;
  const soonExpiry = days !== null && days > 0 && days <= 5;

  if (!decoded) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-destructive font-medium">Could not decode access key.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 dark:from-gray-900 dark:via-purple-900/20 dark:to-blue-900/20 flex flex-col relative overflow-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 -left-4 w-72 h-72 bg-purple-300 dark:bg-purple-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob" />
        <div className="absolute top-0 -right-4 w-72 h-72 bg-blue-300 dark:bg-blue-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob animation-delay-2000" />
        <div className="absolute -bottom-8 left-20 w-72 h-72 bg-pink-300 dark:bg-pink-500 rounded-full mix-blend-multiply dark:mix-blend-soft-light filter blur-xl opacity-20 animate-blob animation-delay-4000" />
      </div>

      {/* ── Header ── */}
      <header className="relative backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border-b border-white/20 px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-sm bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">VPN Key</span>
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <Button
            variant="ghost" size="sm" className="px-2 sm:px-3 hover:bg-white/50 dark:hover:bg-gray-800/50"
            onClick={() => { setShowSwitch((v) => !v); setSwitchValue(""); setSwitchError(""); }}
            title="Check another key"
          >
            <KeyRound className="w-4 h-4 sm:mr-1.5" />
            <span className="hidden sm:inline text-xs">Switch Key</span>
          </Button>
          <Button
            variant="ghost" size="sm" className="px-2 sm:px-3 hover:bg-white/50 dark:hover:bg-gray-800/50"
            onClick={() => load(true)} disabled={refreshing} title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="sm" className="px-2 sm:px-3 hover:bg-white/50 dark:hover:bg-gray-800/50" onClick={onLogout}>
            <LogOut className="w-4 h-4 sm:mr-1.5" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      {/* ── Switch key panel ── */}
      {showSwitch && (
        <div className="relative backdrop-blur-md bg-white/60 dark:bg-gray-900/60 border-b border-white/20 px-4 py-4 shadow-sm">
          <form onSubmit={handleSwitchSubmit} className="max-w-sm mx-auto space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-semibold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">Check another key</p>
              <button type="button"
                onClick={() => { setShowSwitch(false); setSwitchValue(""); setSwitchError(""); }}
                className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={switchValue}
              onChange={(e) => { setSwitchValue(e.target.value); setSwitchError(""); }}
              placeholder="Paste ss:// or ssconf:// key…"
              rows={3} autoFocus
              className={cn(
                "w-full rounded-lg border backdrop-blur-sm bg-white/80 dark:bg-gray-800/80 px-3 py-2 text-sm font-mono resize-none",
                "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all",
                switchError ? "border-destructive" : "border-gray-200 dark:border-gray-700"
              )}
              spellCheck={false}
            />
            {switchError && <p className="text-xs text-destructive font-medium">{switchError}</p>}
            <Button type="submit" size="sm" className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-lg" disabled={!switchValue.trim()}>
              Check Key
            </Button>
          </form>
        </div>
      )}

      <main className="relative flex-1 flex flex-col items-center justify-start sm:justify-center px-4 py-6 sm:py-10">
        <div className="w-full max-w-sm space-y-4">

          {/* Loading */}
          {(status === "idle" || status === "loading") && (
            <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
              <div className="p-4 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
                <RefreshCw className="w-6 h-6 animate-spin text-white" />
              </div>
              <p className="text-sm font-medium">Loading key details…</p>
            </div>
          )}

          {/* Server not found in admin's list */}
          {status === "no-server" && (
            <div className="rounded-2xl backdrop-blur-md bg-amber-50/90 dark:bg-amber-950/50 border border-amber-200/50 dark:border-amber-900/50 p-5 space-y-2 shadow-lg">
              <p className="font-semibold text-amber-700 dark:text-amber-300 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 shrink-0" /> Server not configured
              </p>
              <p className="text-sm text-amber-700/80 dark:text-amber-300/80">
                {errMsg || `The server for this key (${decoded.host}) hasn't been added to the admin dashboard yet. Ask your admin to add it.`}
              </p>
            </div>
          )}

          {/* Error */}
          {status === "error" && (
            <div className="rounded-2xl backdrop-blur-md bg-red-50/90 dark:bg-red-950/50 border border-red-200/50 dark:border-red-900/50 p-5 space-y-3 shadow-lg">
              <p className="font-semibold text-destructive flex items-center gap-2">
                <AlertCircle className="w-5 h-5" /> Error
              </p>
              <p className="text-sm text-destructive/80">{errMsg}</p>
              <Button variant="outline" size="sm" onClick={() => load(true)} className="bg-white/50 dark:bg-gray-800/50 hover:bg-white dark:hover:bg-gray-800">
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          )}

          {/* Main card */}
          {status === "ok" && keyStatus && (
            <div className="rounded-2xl backdrop-blur-md bg-white/80 dark:bg-gray-900/80 border border-white/20 shadow-xl overflow-hidden">
              {/* Status strip */}
              <div className={`px-5 py-3 flex items-center gap-3 backdrop-blur-sm ${
                isExpired ? "bg-red-100/80 dark:bg-red-950/50 border-b border-red-200/50 dark:border-red-900/50"
                : soonExpiry ? "bg-amber-100/80 dark:bg-amber-950/50 border-b border-amber-200/50 dark:border-amber-900/50"
                : "bg-emerald-100/80 dark:bg-emerald-950/50 border-b border-emerald-200/50 dark:border-emerald-900/50"
              }`}>
                {isExpired
                  ? <WifiOff className="w-4 h-4 text-destructive shrink-0" />
                  : <Wifi className={`w-4 h-4 shrink-0 ${soonExpiry ? "text-amber-500" : "text-emerald-500"}`} />}
                <span className={`text-sm font-medium ${
                  isExpired ? "text-destructive"
                  : soonExpiry ? "text-amber-700 dark:text-amber-300"
                  : "text-emerald-700 dark:text-emerald-300"
                }`}>
                  {isExpired ? "Key expired"
                    : soonExpiry ? `Expiring in ${days} day${days !== 1 ? "s" : ""}`
                    : "Active"}
                </span>
              </div>

              <div className="px-5 py-5 space-y-5">
                {/* Server */}
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Server</p>
                  <p className="text-lg font-bold leading-tight">{keyStatus.serverName}</p>
                  <p className="text-sm text-muted-foreground">{decoded.host}</p>
                </div>

                <div className="h-px bg-border" />

                {/* Key name */}
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Key Name</p>
                  <p className="text-base font-semibold">
                    {keyStatus.keyName || <span className="italic text-muted-foreground">Unnamed</span>}
                  </p>
                </div>

                <div className="h-px bg-border" />

                {/* Expiry */}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Expiry Date</p>
                    {expiryDate ? (
                      <p className={`text-base font-semibold ${isExpired ? "text-destructive" : soonExpiry ? "text-amber-500" : ""}`}>
                        {formatDate(expiryDate)}
                      </p>
                    ) : (
                      <p className="text-base font-semibold text-muted-foreground">No expiry</p>
                    )}
                  </div>
                  {days !== null && !isExpired && (
                    <span className={`text-2xl font-bold tabular-nums ${soonExpiry ? "text-amber-500" : "text-emerald-500"}`}>
                      {days}d
                    </span>
                  )}
                  {isExpired && <CalendarX className="w-6 h-6 text-destructive" />}
                </div>

                <div className="h-px bg-border" />

                {/* Data */}
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Data</p>
                  {dataLimit !== null ? (
                    <>
                      <div className="flex justify-between text-sm font-medium">
                        <span className={overLimit ? "text-destructive" : ""}>{formatBytes(bytesUsed)} used</span>
                        <span className={overLimit ? "text-destructive" : "text-muted-foreground"}>{formatBytes(remaining!)} left</span>
                      </div>
                      <Progress value={pct} className={`h-2.5 rounded-full ${overLimit ? "[&>div]:bg-destructive" : "[&>div]:bg-primary"}`} />
                      <p className="text-xs text-muted-foreground text-right">of {formatBytes(dataLimit)} total</p>
                    </>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-base font-semibold">Unlimited</span>
                      <span className="text-sm text-muted-foreground">{formatBytes(bytesUsed)} used</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
