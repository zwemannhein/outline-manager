"use client";

/**
 * Settings panel — currently contains Telegram Approvers management.
 *
 * Telegram approvers are NOT dashboard accounts. They are Telegram users who
 * can approve/reject admin login requests. The single dashboard admin account
 * is unchanged.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  RefreshCw, UserPlus, Copy, Check, Trash2, Link2, Settings, MessageCircle,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  fetchTelegramApprovers,
  createTelegramLinkToken,
  removeTelegramApprover,
  type TelegramApproverRow,
} from "@/lib/sync";

// ── Add Approver Dialog ───────────────────────────────────────────────────────

interface PendingLink {
  deepLink: string;
  expectedUsername: string;
  expiresAt: string;
}

function AddApproverDialog({
  onClose,
  onLinked,
}: {
  onClose: () => void;
  onLinked: () => void;
}) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    try {
      const result = await createTelegramLinkToken(username.trim());
      setPending({
        deepLink: result.deepLink,
        expectedUsername: result.expectedUsername,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      toast({
        title: "Could not create link",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.deepLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  }

  const expiresLabel = pending
    ? new Date(pending.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add Telegram Approver"
        className="relative w-full sm:max-w-md bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl shadow-2xl border p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 shrink-0">
            <UserPlus className="w-4 h-4 text-white" />
          </div>
          <h2 className="text-base font-semibold">Add Telegram Approver</h2>
        </div>

        <p className="text-xs text-muted-foreground">
          This does <strong>not</strong> create a dashboard account. The approver can only
          approve or reject admin login requests via Telegram.
        </p>

        {!pending ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="tg-username" className="text-sm">
                Telegram Username <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="tg-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username"
                className="text-base sm:text-sm"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                If entered, the link is locked to that username. Leave blank to allow any user.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={onClose}>
                Cancel
              </Button>
              <Button
                className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
                onClick={handleGenerate}
                disabled={loading}
              >
                {loading ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Link2 className="w-4 h-4 mr-2" />
                )}
                Generate Link
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Telegram deep link
                </span>
                <Badge variant="outline" className="text-amber-600 border-amber-400 text-xs">
                  Expires {expiresLabel}
                </Badge>
              </div>
              <p className="text-xs font-mono break-all text-foreground select-all">
                {pending.deepLink}
              </p>
              {pending.expectedUsername && (
                <p className="text-xs text-muted-foreground">
                  Locked to: <strong>@{pending.expectedUsername}</strong>
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Send this link to the Telegram user. They tap it, the bot verifies their identity, and
              they are added as an approver. The link expires in 15 minutes and can only be used once.
            </p>

            <div className="flex gap-2">
              <Button
                className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="w-4 h-4 mr-2" />
                ) : (
                  <Copy className="w-4 h-4 mr-2" />
                )}
                {copied ? "Copied!" : "Copy Telegram Link"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  onLinked();
                  onClose();
                }}
              >
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Settings Panel ───────────────────────────────────────────────────────

export function SettingsPanel() {
  const { toast } = useToast();
  const [approvers, setApprovers] = useState<TelegramApproverRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchTelegramApprovers();
      setApprovers(rows);
    } catch (err) {
      toast({
        title: "Could not load approvers",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRemove(userId: string) {
    setRemoving(userId);
    try {
      await removeTelegramApprover(userId);
      toast({ title: "Approver removed" });
      setApprovers((prev) => prev.filter((a) => a.userId !== userId));
    } catch (err) {
      toast({
        title: "Could not remove approver",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="admin-page">
      <div className="mx-auto w-full max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5 text-primary shrink-0">
          <Settings className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Settings</h1>
          <p className="text-sm text-muted-foreground">Admin configuration</p>
        </div>
      </div>

      {/* Telegram Approvers section */}
      <section className="admin-card space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-blue-500 shrink-0" />
            <h3 className="font-medium text-sm">Telegram Approvers</h3>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              size="sm"
              className="text-xs"
              onClick={() => setShowAdd(true)}
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Add Approver
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          These Telegram users receive admin login approval requests. They are <strong>not</strong> dashboard
          accounts — they can only approve or reject logins. Any number of approvers may be linked.
          Any one of them can approve a login request.
        </p>

        {/* Info box: no approvers */}
        {!loading && approvers.length === 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 flex gap-3">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                No approvers linked
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                The system will fall back to <code>TELEGRAM_CHAT_ID</code> from your environment
                variables. Add at least one approver here to use dynamic approvers.
              </p>
            </div>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg bg-muted/40 animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Approver list */}
        {!loading && approvers.length > 0 && (
          <div className="space-y-2">
            {approvers.map((a) => (
              <div
                key={a.userId}
                className="flex items-center justify-between gap-3 rounded-xl border bg-background px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">
                      {a.username ? `@${a.username}` : "Telegram user"}
                    </span>
                    <Badge className="bg-green-600 hover:bg-green-600 text-xs">Linked</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Linked {new Date(a.linkedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30 min-w-[44px] min-h-[44px]"
                  disabled={removing === a.userId}
                  onClick={() => void handleRemove(a.userId)}
                  aria-label={a.username ? `Remove @${a.username}` : "Remove Telegram approver"}
                >
                  {removing === a.userId ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {showAdd && (
        <AddApproverDialog
          onClose={() => setShowAdd(false)}
          onLinked={() => void load()}
        />
      )}
      </div>
    </div>
  );
}
