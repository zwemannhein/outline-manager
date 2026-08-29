"use client";

/**
 * Admin login with two additional flows:
 *
 *  1. Telegram approval — correct credentials do not log you in. The server
 *     creates a pending attempt, Telegram shows Approve/Reject, and this form
 *     polls until a decision arrives.
 *
 *  2. Forgot Password — deliberately asks for NO username. The server resolves
 *     the current admin username and sends it, with a 6-digit code, to Telegram.
 *     That is how a forgotten username is recovered.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Shield, Eye, EyeOff, ArrowLeft, Server, Sparkles, Lock,
  MessageCircle, KeyRound, CheckCircle2, XCircle, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  login,
  pollLoginStatus,
  cancelLogin,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  type LoginApprovalHandle,
} from "@/lib/sync";

interface AdminLoginFormProps {
  onUnlock: () => void;
  onBack: () => void;
}

type Step =
  | "credentials"
  | "awaiting-approval"
  | "approval-rejected"
  | "approval-expired"
  | "forgot-sending"
  | "forgot-code"
  | "forgot-new-password"
  | "forgot-success";

const POLL_INTERVAL_MS = 2500;
const RESEND_COOLDOWN_SECONDS = 60;
const MIN_PASSWORD_LENGTH = 8;

export function AdminLoginForm({ onUnlock, onBack }: AdminLoginFormProps) {
  const [step, setStep] = useState<Step>("credentials");

  // Credentials
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Shared
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Telegram approval
  const handleRef = useRef<LoginApprovalHandle | null>(null);

  // Forgot password
  const [resetId, setResetId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // ── Resend cooldown ticker ──────────────────────────────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // ── Poll for the Telegram decision ──────────────────────────────────────────
  useEffect(() => {
    if (step !== "awaiting-approval") return;
    const handle = handleRef.current;
    if (!handle) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      if (cancelled) return;
      try {
        const status = await pollLoginStatus(handle!);
        if (cancelled) return;

        if (status === "approved") {
          handleRef.current = null;
          onUnlock();
          return;
        }
        if (status === "rejected") {
          setStep("approval-rejected");
          return;
        }
        if (status === "expired" || status === "cancelled" || status === "consumed") {
          setStep("approval-expired");
          return;
        }
      } catch {
        // Keep polling on transient failures.
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, onUnlock]);

  function resetAll() {
    handleRef.current = null;
    setStep("credentials");
    setPassword("");
    setCode("");
    setResetId(null);
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setLoading(false);
  }

  // ── Credentials submit ──────────────────────────────────────────────────────
  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError("Please enter your username and password.");
      return;
    }

    setLoading(true);
    try {
      handleRef.current = await login(username.trim(), password);
      setPassword("");
      setStep("awaiting-approval");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelApproval() {
    const handle = handleRef.current;
    handleRef.current = null;
    setStep("credentials");
    if (handle) await cancelLogin(handle);
  }

  // ── Forgot password ─────────────────────────────────────────────────────────
  const startForgot = useCallback(async (previous?: string | null) => {
    setError(null);
    setStep("forgot-sending");
    try {
      const result = await forgotPassword(previous ?? null);

      if (result.status === "cooldown") {
        setCooldown(result.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS);
        setError(
          `A code was just sent. Please wait ${result.retryAfterSeconds ?? RESEND_COOLDOWN_SECONDS}s before requesting another.`
        );
        setStep("forgot-code");
        return;
      }

      setResetId(result.resetId ?? null);
      setCode("");
      setCooldown(result.resendCooldownSeconds ?? RESEND_COOLDOWN_SECONDS);
      setStep("forgot-code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start password reset");
      setStep("credentials");
    }
  }, []);

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^[0-9]{6}$/.test(code)) {
      setError("Enter the 6-digit code from Telegram.");
      return;
    }
    if (!resetId) {
      setError("This reset request is no longer valid. Please start again.");
      return;
    }

    setLoading(true);
    try {
      await verifyResetCode(resetId, code);
      setStep("forgot-new-password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
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
    if (!resetId) {
      setError("This reset request is no longer valid. Please start again.");
      return;
    }

    setLoading(true);
    try {
      await resetPassword(resetId, newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setResetId(null);
      setStep("forgot-success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password");
    } finally {
      setLoading(false);
    }
  }

  // ── Shell ───────────────────────────────────────────────────────────────────
  const shell = (children: React.ReactNode, showBack = true) => (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-blue-400/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-purple-400/10 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      <div className="w-full max-w-md space-y-8 relative">
        {showBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group"
            disabled={loading}
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            Back to home
          </button>
        )}

        <div className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg rounded-2xl sm:rounded-3xl shadow-2xl border border-gray-200/50 dark:border-gray-700/50 p-8 sm:p-10 space-y-8">
          {children}
        </div>
      </div>
    </div>
  );

  const header = (
    icon: React.ReactNode,
    title: string,
    subtitle: string
  ) => (
    <div className="text-center space-y-4">
      <div className="inline-flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg relative">
        {icon}
        <Sparkles className="w-4 h-4 absolute -top-1 -right-1 text-yellow-400 animate-pulse" />
      </div>
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground mt-2">{subtitle}</p>
      </div>
    </div>
  );

  const errorBox = error && (
    <div
      role="alert"
      className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive"
    >
      {error}
    </div>
  );

  // ── FORGOT: sending ─────────────────────────────────────────────────────────
  if (step === "forgot-sending") {
    return shell(
      <>
        {header(<MessageCircle className="w-8 h-8 sm:w-10 sm:h-10 text-white" />, "Password Reset", "Sending reset code...")}
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Sending reset code...</p>
        </div>
      </>,
      false
    );
  }

  // ── FORGOT: enter code (NO username field) ──────────────────────────────────
  if (step === "forgot-code") {
    return shell(
      <>
        {header(
          <KeyRound className="w-8 h-8 sm:w-10 sm:h-10 text-white" />,
          "Enter Reset Code",
          "Check Telegram for your username and 6-digit reset code."
        )}

        <form onSubmit={handleVerifyCode} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="reset-code" className="text-sm font-medium">
              Reset Code
            </Label>
            <Input
              id="reset-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                setError(null);
              }}
              placeholder="123456"
              maxLength={6}
              autoFocus
              disabled={loading}
              className="h-14 text-center text-2xl tracking-[0.5em] font-mono"
            />
          </div>

          {errorBox}

          <Button
            type="submit"
            className="w-full h-12 text-base font-semibold bg-gradient-to-r from-blue-600 to-purple-600"
            disabled={loading || code.length !== 6}
          >
            {loading ? "Verifying..." : "Verify Code"}
          </Button>

          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => startForgot(resetId)}
              disabled={loading || cooldown > 0}
              className="text-blue-600 hover:underline disabled:text-muted-foreground disabled:no-underline"
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="text-muted-foreground hover:text-foreground"
              disabled={loading}
            >
              Back to Login
            </button>
          </div>
        </form>
      </>,
      false
    );
  }

  // ── FORGOT: new password ────────────────────────────────────────────────────
  if (step === "forgot-new-password") {
    return shell(
      <>
        {header(<Lock className="w-8 h-8 sm:w-10 sm:h-10 text-white" />, "Create New Password", "Choose a new admin password.")}

        <form onSubmit={handleResetPassword} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoFocus
              disabled={loading}
              className="h-12"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm New Password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
              placeholder="Re-enter the new password"
              disabled={loading}
              className="h-12"
            />
          </div>

          {errorBox}

          <Button
            type="submit"
            className="w-full h-12 text-base font-semibold bg-gradient-to-r from-blue-600 to-purple-600"
            disabled={loading}
          >
            {loading ? "Resetting..." : "Reset Password"}
          </Button>

          <button
            type="button"
            onClick={resetAll}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
            disabled={loading}
          >
            Back to Login
          </button>
        </form>
      </>,
      false
    );
  }

  // ── FORGOT: success ─────────────────────────────────────────────────────────
  if (step === "forgot-success") {
    return shell(
      <>
        {header(<CheckCircle2 className="w-8 h-8 sm:w-10 sm:h-10 text-white" />, "Password Reset", "")}
        <div className="text-center space-y-6">
          <p className="text-sm font-medium">Password reset successfully.</p>
          <p className="text-xs text-muted-foreground">
            Sign in with your username from Telegram and your new password.
            You will still need to approve the login in Telegram.
          </p>
          <Button onClick={resetAll} className="w-full h-12 text-base font-semibold">
            Back to Login
          </Button>
        </div>
      </>,
      false
    );
  }

  // ── Awaiting Telegram approval ──────────────────────────────────────────────
  if (step === "awaiting-approval") {
    return shell(
      <>
        {header(
          <MessageCircle className="w-8 h-8 sm:w-10 sm:h-10 text-white" />,
          "Approval Required",
          "Approve this login from Telegram to continue."
        )}
        <div className="flex flex-col items-center gap-5 py-2">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          <p className="text-sm font-medium">Waiting for Telegram approval...</p>
          <p className="text-xs text-muted-foreground text-center">
            A login request was sent to your Telegram. It expires in 5 minutes.
          </p>
          <Button variant="outline" onClick={handleCancelApproval} className="w-full h-11">
            Cancel
          </Button>
        </div>
      </>,
      false
    );
  }

  // ── Rejected ────────────────────────────────────────────────────────────────
  if (step === "approval-rejected") {
    return shell(
      <>
        {header(<XCircle className="w-8 h-8 sm:w-10 sm:h-10 text-white" />, "Login Rejected", "")}
        <div className="text-center space-y-6">
          <p className="text-sm font-medium">Login request rejected.</p>
          <p className="text-xs text-muted-foreground">
            The request was declined in Telegram. If that was not you, change your password.
          </p>
          <Button onClick={resetAll} className="w-full h-12">Back to Login</Button>
        </div>
      </>,
      false
    );
  }

  // ── Expired / cancelled ─────────────────────────────────────────────────────
  if (step === "approval-expired") {
    return shell(
      <>
        {header(<Clock className="w-8 h-8 sm:w-10 sm:h-10 text-white" />, "Request Expired", "")}
        <div className="text-center space-y-6">
          <p className="text-sm font-medium">Approval request expired. Please try again.</p>
          <Button onClick={resetAll} className="w-full h-12">Back to Login</Button>
        </div>
      </>,
      false
    );
  }

  // ── Normal login ────────────────────────────────────────────────────────────
  return shell(
    <>
      {header(
        <Shield className="w-8 h-8 sm:w-10 sm:h-10 text-white" />,
        "Admin Portal",
        "Sign in to manage your VPN servers"
      )}

      <form onSubmit={handleCredentials} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="username" className="text-sm font-medium">Username</Label>
          <div className="relative">
            <Input
              id="username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(null); }}
              placeholder="Enter your username"
              autoComplete="username"
              autoFocus
              disabled={loading}
              className="pl-10 h-12 text-base"
            />
            <Server className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-sm font-medium">Password</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Enter your password"
              autoComplete="current-password"
              className="pl-10 pr-12 h-12 text-base"
              disabled={loading}
            />
            <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
              disabled={loading}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {errorBox}

        <Button
          type="submit"
          className="w-full h-12 text-base font-semibold bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 shadow-lg"
          disabled={loading}
        >
          {loading ? (
            <>
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
              Signing in...
            </>
          ) : (
            <>
              <Shield className="w-5 h-5 mr-2" />
              Login
            </>
          )}
        </Button>

        <div className="text-center">
          <button
            type="button"
            onClick={() => startForgot(null)}
            disabled={loading}
            className="text-sm text-blue-600 hover:underline disabled:text-muted-foreground"
          >
            Forgot Password?
          </button>
        </div>
      </form>

      <div className="text-center text-xs text-muted-foreground">
        <p>Logins require Telegram approval</p>
      </div>
    </>
  );
}
