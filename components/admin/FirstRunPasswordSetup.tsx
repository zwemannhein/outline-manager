"use client";

/**
 * Forced first-run password setup.
 *
 * Shown when the server reports passwordSource === "env", meaning the
 * deployment is still authenticating with the bootstrap ADMIN_PASSWORD. The
 * dashboard is not reachable until a runtime password is saved, which retires
 * the environment password with no Vercel configuration change.
 *
 * The requirement comes from the server on every mount, so it cannot be skipped
 * by refreshing or by clearing client state.
 */

import React, { useState } from "react";
import { ShieldAlert, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setBootstrapPassword } from "@/lib/sync";

const MIN_PASSWORD_LENGTH = 8;

interface FirstRunPasswordSetupProps {
  onComplete: () => void;
  onLogout: () => void;
}

export function FirstRunPasswordSetup({ onComplete, onLogout }: FirstRunPasswordSetupProps) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      await setBootstrapPassword(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="bg-white/85 dark:bg-gray-900/85 backdrop-blur-lg rounded-2xl shadow-2xl border border-amber-300/50 dark:border-amber-700/40 p-8 space-y-7">
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-lg">
              <ShieldAlert className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Set a new admin password</h1>
              <p className="text-sm text-muted-foreground mt-2">
                You signed in with the initial setup password. Choose a new password
                to finish securing this dashboard.
              </p>
            </div>
          </div>

          <div
            role="note"
            className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3 text-xs text-amber-900 dark:text-amber-200"
          >
            Once saved, the initial setup password stops working immediately. No
            environment or hosting configuration needs to change.
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="fr-new">New Password</Label>
              <Input
                id="fr-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                disabled={saving}
                autoFocus
                className="h-12"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fr-confirm">Confirm Password</Label>
              <Input
                id="fr-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
                placeholder="Re-enter the new password"
                disabled={saving}
                className="h-12"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full h-12 text-base font-semibold bg-gradient-to-r from-blue-600 to-purple-600"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Password"}
            </Button>
          </form>

          <button
            type="button"
            onClick={onLogout}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <LogOut className="w-4 h-4" />
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
