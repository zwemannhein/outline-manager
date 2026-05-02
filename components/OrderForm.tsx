"use client";

import React, { useState } from "react";
import { Shield, Smartphone, Wifi, CheckCircle2, Copy, Check, Clock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PLANS } from "@/lib/types";
import type { Plan } from "@/lib/types";

interface OrderFormProps {
  onAdminClick: () => void;
}

type Step = "form" | "pending" | "approved" | "rejected";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied!" : "Copy key"}
    </button>
  );
}

export function OrderForm({ onAdminClick }: OrderFormProps) {
  const [name, setName] = useState("");
  const [kpayRef, setKpayRef] = useState("");
  const [plan, setPlan] = useState<Plan>("plan_a");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("form");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [accessUrl, setAccessUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    if (!/^\d{6}$/.test(kpayRef.trim())) e.kpayRef = "Enter exactly 6 digits";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kpayRef: kpayRef.trim(), plan }),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok) { setErrors({ form: data.error ?? "Submission failed" }); return; }
      setOrderId(data.id!);
      setStep("pending");
      startPolling(data.id!);
    } catch {
      setErrors({ form: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  function startPolling(id: string) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${id}/status`);
        const data = await res.json() as { status: string; accessUrl?: string };
        if (data.status === "approved") {
          clearInterval(interval);
          setAccessUrl(data.accessUrl ?? null);
          setStep("approved");
        } else if (data.status === "rejected") {
          clearInterval(interval);
          setStep("rejected");
        }
      } catch { /* keep polling */ }
    }, 3000); // poll every 3 seconds
  }

  // ── Approved screen ───────────────────────────────────────────────────────
  if (step === "approved") {
    return (
      <div className="space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
          <CheckCircle2 className="w-8 h-8 text-emerald-500" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Payment Approved!</h2>
          <p className="text-sm text-muted-foreground mt-1">Your VPN access key is ready.</p>
        </div>
        {accessUrl && (
          <div className="rounded-xl border bg-muted/50 p-4 space-y-3 text-left">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Your Access Key</p>
            <p className="text-xs font-mono break-all text-foreground leading-relaxed">{accessUrl}</p>
            <CopyButton text={accessUrl} />
          </div>
        )}
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 p-4 text-sm text-blue-700 dark:text-blue-300 text-left space-y-1">
          <p className="font-medium">How to connect:</p>
          <ol className="list-decimal list-inside space-y-1 text-xs opacity-90">
            <li>Download the <strong>Outline</strong> app on your device</li>
            <li>Tap <strong>Add Server</strong> and paste your key above</li>
            <li>Tap <strong>Connect</strong></li>
          </ol>
        </div>
        <Button variant="outline" size="sm" onClick={() => {
          setStep("form"); setName(""); setKpayRef(""); setPlan("plan_a");
          setOrderId(null); setAccessUrl(null);
        }}>
          Place another order
        </Button>
      </div>
    );
  }

  // ── Rejected screen ───────────────────────────────────────────────────────
  if (step === "rejected") {
    return (
      <div className="space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10">
          <XCircle className="w-8 h-8 text-destructive" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Order Rejected</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Your payment could not be verified. Please contact support.
          </p>
        </div>
        <Button variant="outline" onClick={() => {
          setStep("form"); setOrderId(null);
        }}>
          Try again
        </Button>
      </div>
    );
  }

  // ── Pending screen ────────────────────────────────────────────────────────
  if (step === "pending") {
    return (
      <div className="space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30">
          <Clock className="w-8 h-8 text-amber-500 animate-pulse" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Order Submitted!</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Waiting for admin to verify your payment…
          </p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4 text-left space-y-2">
          <p className="text-xs text-muted-foreground">Order ID</p>
          <p className="text-xs font-mono text-foreground">{orderId}</p>
        </div>
        <p className="text-xs text-muted-foreground">
          This page will update automatically once approved. Keep it open.
        </p>
      </div>
    );
  }

  // ── Order form ────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor="order-name">Your Name</Label>
        <Input
          id="order-name"
          value={name}
          onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: "" })); }}
          placeholder="e.g. Zaw Min Hein"
          autoFocus
          className={errors.name ? "border-destructive" : ""}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
      </div>

      {/* KPay ref */}
      <div className="space-y-1.5">
        <Label htmlFor="kpay-ref">KPay Transaction Number</Label>
        <p className="text-xs text-muted-foreground">Last 6 digits of your KPay slip</p>
        <Input
          id="kpay-ref"
          value={kpayRef}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(0, 6);
            setKpayRef(v);
            setErrors((p) => ({ ...p, kpayRef: "" }));
          }}
          placeholder="123456"
          inputMode="numeric"
          maxLength={6}
          className={cn("font-mono tracking-widest", errors.kpayRef ? "border-destructive" : "")}
        />
        {errors.kpayRef && <p className="text-xs text-destructive">{errors.kpayRef}</p>}
      </div>

      {/* Plan selection */}
      <div className="space-y-2">
        <Label>Select Plan</Label>
        <div className="grid grid-cols-1 gap-3">
          {PLANS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlan(p.id)}
              className={cn(
                "rounded-xl border-2 p-4 text-left transition-all",
                plan === p.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  {p.id === "plan_a"
                    ? <Smartphone className="w-4 h-4 text-primary shrink-0" />
                    : <Wifi className="w-4 h-4 text-primary shrink-0" />}
                  <div>
                    <p className="font-semibold text-sm">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-sm text-primary">{p.price.split(" / ")[0]}</p>
                  <p className="text-xs text-muted-foreground">/ month</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {errors.form && <p className="text-sm text-destructive">{errors.form}</p>}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Submitting…" : "Submit Order"}
      </Button>

      {/* Admin link — small, unobtrusive */}
      <div className="text-center pt-2">
        <button
          type="button"
          onClick={onAdminClick}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
        >
          Admin Login
        </button>
      </div>
    </form>
  );
}
