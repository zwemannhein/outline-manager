"use client";

/**
 * EntryGate — two-tab entry:
 *   Admin tab  → username + password login (credentials checked client-side)
 *   User tab   → paste ss:// or ssconf:// link
 */

import React, { useState } from "react";
import { Shield, User, Server, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detectInputKind } from "@/lib/ss-decoder";
import { cn } from "@/lib/utils";

// ── Credentials (change here to update) ──────────────────────────────────────
const ADMIN_USERNAME = "zmh";
const ADMIN_PASSWORD = "admin123";

type Tab = "admin" | "user";

interface EntryGateProps {
  onAdminUnlock: (username: string, password: string) => void;
  onUserUnlock: (ssUrl: string) => void;
}

export function EntryGate({ onAdminUnlock, onUserUnlock }: EntryGateProps) {
  const [tab, setTab] = useState<Tab>("admin");

  // Admin form state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // User form state
  const [ssValue, setSsValue] = useState("");
  const [userError, setUserError] = useState<string | null>(null);

  // ── Admin submit ────────────────────────────────────────────────────────────
  function handleAdminSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAdminError(null);

    if (!username.trim() || !password) {
      setAdminError("Please enter your username and password.");
      return;
    }

    if (username.trim() !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      setAdminError("Invalid username or password.");
      return;
    }

    onAdminUnlock(username.trim(), password);
  }

  // ── User submit ─────────────────────────────────────────────────────────────
  function handleUserSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUserError(null);

    const trimmed = ssValue.trim();
    if (!trimmed) {
      setUserError("Please paste your access key.");
      return;
    }

    const kind = detectInputKind(trimmed);
    if (kind === "ss-url" || kind === "ssconf-url") {
      onUserUnlock(trimmed);
      return;
    }

    setUserError("Not a valid access key. It should start with ss:// or ssconf://");
  }

  const ssKind = detectInputKind(ssValue);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 sm:p-6">
      <div className="w-full max-w-md space-y-5 sm:space-y-6">

        {/* Logo / header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-2">
            <Server className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Outline VPN Manager</h1>
          <p className="text-sm text-muted-foreground">
            Sign in as admin or enter your personal access key.
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex rounded-lg border overflow-hidden">
          <button
            type="button"
            onClick={() => { setTab("admin"); setAdminError(null); }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors",
              tab === "admin"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-accent"
            )}
          >
            <Shield className="w-4 h-4" />
            Admin
          </button>
          <button
            type="button"
            onClick={() => { setTab("user"); setUserError(null); }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors",
              tab === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:bg-accent"
            )}
          >
            <User className="w-4 h-4" />
            My Key
          </button>
        </div>

        {/* ── Admin login form ── */}
        {tab === "admin" && (
          <form onSubmit={handleAdminSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setAdminError(null); }}
                placeholder="Enter username"
                autoComplete="username"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setAdminError(null); }}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword
                    ? <EyeOff className="w-4 h-4" />
                    : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {adminError && (
              <p className="text-sm text-destructive">{adminError}</p>
            )}

            <Button type="submit" className="w-full">
              <Shield className="w-4 h-4 mr-2" />
              Sign In
            </Button>
          </form>
        )}

        {/* ── User access key form ── */}
        {tab === "user" && (
          <form onSubmit={handleUserSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ss-key">Access Key</Label>
              <div className="relative">
                <textarea
                  id="ss-key"
                  value={ssValue}
                  onChange={(e) => { setSsValue(e.target.value); setUserError(null); }}
                  placeholder={"Paste your access key here:\nss://… or ssconf://…"}
                  rows={4}
                  className={cn(
                    "w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-none",
                    "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring",
                    "transition-colors",
                    userError ? "border-destructive" : "border-input"
                  )}
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                />

              </div>
              {userError && (
                <p className="text-sm text-destructive">{userError}</p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={!ssValue.trim()}>
              <User className="w-4 h-4 mr-2" />
              View My Usage
            </Button>

            <p className="text-xs text-muted-foreground text-center">
              Your admin shares an <code className="bg-muted px-1 rounded">ss://</code> link with you — paste it above.
            </p>
          </form>
        )}

      </div>
    </div>
  );
}
