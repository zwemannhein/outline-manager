"use client";

import React, { useState, useEffect } from "react";
import { OrderForm } from "@/components/OrderForm";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { AdminView } from "@/components/admin/AdminView";
import { UserView } from "@/components/user/UserView";
import { setAdminCreds, clearAdminCreds } from "@/lib/sync";
import { Server } from "lucide-react";

type AppState =
  | { role: "none" }           // show order form
  | { role: "admin-login" }    // show admin login
  | { role: "admin" }
  | { role: "user"; ssUrl: string };

const SESSION_KEY = "outline_session";

function saveSession(state: AppState) {
  if (state.role === "none" || state.role === "admin-login") {
    sessionStorage.removeItem(SESSION_KEY);
  } else {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  }
}

function readSession(): AppState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return { role: "none" };
    return JSON.parse(raw) as AppState;
  } catch {
    return { role: "none" };
  }
}

export default function Home() {
  const [state, setState] = useState<AppState>({ role: "none" });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = readSession();
    setState(saved);
    setHydrated(true);
  }, []);

  function transition(next: AppState) {
    setState(next);
    saveSession(next);
    if (next.role === "none" || next.role === "admin-login") clearAdminCreds();
  }

  function handleAdminUnlock(username: string, password: string) {
    setAdminCreds(username, password);
    transition({ role: "admin" });
  }

  if (!hydrated) return null;

  if (state.role === "admin") {
    return <AdminView onLogout={() => transition({ role: "none" })} />;
  }

  if (state.role === "user") {
    return (
      <UserView
        ssUrl={state.ssUrl}
        onLogout={() => transition({ role: "none" })}
        onSwitchKey={(newUrl) => transition({ role: "user", ssUrl: newUrl })}
      />
    );
  }

  if (state.role === "admin-login") {
    return (
      <AdminLoginForm
        onUnlock={handleAdminUnlock}
        onBack={() => transition({ role: "none" })}
      />
    );
  }

  // Default: Order form + "My Key" tab
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card px-4 py-3 flex items-center gap-2 sticky top-0 z-10">
        <Server className="w-5 h-5 text-primary" />
        <span className="font-bold text-sm sm:text-base">Outline VPN</span>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 py-6 sm:py-10">
        <div className="w-full max-w-md space-y-5">
          {/* Title */}
          <div className="text-center space-y-1">
            <h1 className="text-xl sm:text-2xl font-bold">Get VPN Access</h1>
            <p className="text-sm text-muted-foreground">
              Pay via KPay and get your key instantly after approval.
            </p>
          </div>

          {/* Tabs: Order / My Key */}
          <TabView onAdminClick={() => transition({ role: "admin-login" })}
            onUserUnlock={(ssUrl) => transition({ role: "user", ssUrl })} />
        </div>
      </main>
    </div>
  );
}

// ── Tab view ──────────────────────────────────────────────────────────────────

import { cn } from "@/lib/utils";
import { detectInputKind } from "@/lib/ss-decoder";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { User } from "lucide-react";

function TabView({
  onAdminClick,
  onUserUnlock,
}: {
  onAdminClick: () => void;
  onUserUnlock: (ssUrl: string) => void;
}) {
  const [tab, setTab] = useState<"order" | "mykey">("order");
  const [ssValue, setSsValue] = useState("");
  const [ssError, setSsError] = useState("");

  function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault();
    setSsError("");
    const trimmed = ssValue.trim();
    if (!trimmed) { setSsError("Paste your access key."); return; }
    const kind = detectInputKind(trimmed);
    if (kind === "ss-url" || kind === "ssconf-url") {
      onUserUnlock(trimmed);
    } else {
      setSsError("Not a valid key. Must start with ss:// or ssconf://");
    }
  }

  return (
    <div className="space-y-4">
      {/* Tab switcher */}
      <div className="flex rounded-lg border overflow-hidden">
        <button
          type="button"
          onClick={() => setTab("order")}
          className={cn(
            "flex-1 py-2.5 text-sm font-medium transition-colors",
            tab === "order" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"
          )}
        >
          Order Key
        </button>
        <button
          type="button"
          onClick={() => setTab("mykey")}
          className={cn(
            "flex-1 py-2.5 text-sm font-medium transition-colors",
            tab === "mykey" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"
          )}
        >
          My Key
        </button>
      </div>

      {tab === "order" && <OrderForm onAdminClick={onAdminClick} />}

      {tab === "mykey" && (
        <form onSubmit={handleKeySubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ss-key">Access Key</Label>
            <textarea
              id="ss-key"
              value={ssValue}
              onChange={(e) => { setSsValue(e.target.value); setSsError(""); }}
              placeholder={"Paste your access key:\nss://… or ssconf://…"}
              rows={3}
              className={cn(
                "w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-none",
                "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring",
                ssError ? "border-destructive" : "border-input"
              )}
              spellCheck={false}
              autoComplete="off"
            />
            {ssError && <p className="text-sm text-destructive">{ssError}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={!ssValue.trim()}>
            <User className="w-4 h-4 mr-2" /> Check My Key
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Paste the <code className="bg-muted px-1 rounded">ss://</code> key you received after approval.
          </p>
        </form>
      )}
    </div>
  );
}
