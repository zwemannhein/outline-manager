"use client";

import React, { useState, useEffect } from "react";
import {
  Smartphone, Wifi, Sliders, CheckCircle2,
  Copy, Check, Clock, XCircle, Database,
  Users, CalendarDays, Infinity, Server,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ── Pricing ───────────────────────────────────────────────────────────────────
const MMK_PER_GB    = 50;       // per GB per month
const UNLIMITED_PRICE = 15000;  // unlimited data per month

const GB_OPTIONS = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500];
const MONTH_OPTIONS = [1, 2, 3, 6, 12];
const DEVICE_OPTIONS = ["1", "2", "3", "5", "Unlimited"];

function calcDataPrice(gb: number | null): number {
  return gb === null ? UNLIMITED_PRICE : gb * MMK_PER_GB;
}

function formatMMK(n: number): string {
  return n.toLocaleString() + " MMK";
}

// ── KPay info box ─────────────────────────────────────────────────────────────
const KPAY_NUMBER = "09666627107";
const KPAY_NAME   = "Ni Ni Mar";

function KPayInfo() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden mb-1">
      {/* Header strip */}
      <div className="bg-emerald-500 px-4 py-2 flex items-center gap-2">
        <span className="text-white text-xs font-semibold uppercase tracking-wider">
          KPay Payment Details
        </span>
      </div>
      {/* Body */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs text-muted-foreground">Recipient Name</p>
          <p className="font-semibold text-sm">{KPAY_NAME}</p>
          <p className="text-xs text-muted-foreground mt-1.5">Phone Number</p>
          <p className="font-bold text-lg tracking-widest">{KPAY_NUMBER}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(KPAY_NUMBER).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
          className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg border bg-muted/50 hover:bg-muted transition-colors shrink-0"
          title="Copy KPay number"
        >
          {copied
            ? <Check className="w-5 h-5 text-emerald-500" />
            : <Copy className="w-5 h-5 text-muted-foreground" />}
          <span className="text-xs text-muted-foreground">{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      <div className="px-4 pb-3">
        <p className="text-xs text-muted-foreground">
          Send the exact amount, then enter the last 6 digits of your transaction slip below.
        </p>
      </div>
    </div>
  );
}
const FIXED_PLANS = [
  {
    id: "plan_a",
    label: "Plan A",
    description: "1 Device / Unlimited Data / 1 Month",
    price: formatMMK(UNLIMITED_PRICE),
    icon: Smartphone,
  },
  {
    id: "plan_b",
    label: "Plan B",
    description: "Unlimited Devices / 100 GB / 1 Month",
    price: formatMMK(100 * MMK_PER_GB),
    icon: Wifi,
  },
];

type PlanChoice = "plan_a" | "plan_b" | "custom";

interface ServerOption {
  id: string;
  name: string;
}

interface OrderFormProps {
  onAdminClick: () => void;
}

type Step = "form" | "pending" | "approved" | "rejected";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 2000);
      })}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied!" : "Copy key"}
    </button>
  );
}

// ── Slider row ────────────────────────────────────────────────────────────────
function SliderRow<T extends string | number>({
  icon: Icon,
  label,
  options,
  valueIdx,
  onChange,
  formatValue,
}: {
  icon: React.ElementType;
  label: string;
  options: T[];
  valueIdx: number;
  onChange: (i: number) => void;
  formatValue: (v: T) => string;
}) {
  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        <span className="text-sm font-bold text-foreground">
          {formatValue(options[valueIdx])}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={options.length - 1}
        value={valueIdx}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary cursor-pointer h-1.5"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        {options.map((o, i) => (
          <span key={String(o)} className={cn(i === valueIdx ? "text-primary font-semibold" : "")}>
            {formatValue(o)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function OrderForm({ onAdminClick }: OrderFormProps) {
  const [name, setName] = useState("");
  const [kpayRef, setKpayRef] = useState("");
  const [planChoice, setPlanChoice] = useState<PlanChoice>("plan_a");
  const [serverId, setServerId] = useState<string>("");
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serversLoading, setServersLoading] = useState(true);

  // Fetch available servers on mount
  useEffect(() => {
    fetch("/api/v1/servers")
      .then((r) => r.json())
      .then((data: ServerOption[]) => {
        setServers(data);
        if (data.length > 0) setServerId(data[0].id);
      })
      .catch(() => {})
      .finally(() => setServersLoading(false));
  }, []);

  // Custom plan state
  const [dataUnlimited, setDataUnlimited] = useState(false);
  const [gbIdx, setGbIdx] = useState(3);          // default 50 GB
  const [monthIdx, setMonthIdx] = useState(0);    // default 1 month
  const [deviceIdx, setDeviceIdx] = useState(0);  // default 1 device

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("form");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [accessUrl, setAccessUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Derived custom values
  const customGb     = dataUnlimited ? null : GB_OPTIONS[gbIdx];
  const customMonths = MONTH_OPTIONS[monthIdx];
  const customDevices = DEVICE_OPTIONS[deviceIdx];
  const monthlyPrice = calcDataPrice(customGb);
  const totalPrice   = monthlyPrice * customMonths;

  function getPlanPayload() {
    if (planChoice === "custom") {
      return {
        plan: "custom",
        customDataLimitGB: customGb,
        customMonths,
        customDevices,
      };
    }
    return { plan: planChoice };
  }

  function getSubmitPrice(): string {
    if (planChoice === "plan_a") return formatMMK(UNLIMITED_PRICE);
    if (planChoice === "plan_b") return formatMMK(100 * MMK_PER_GB);
    return formatMMK(totalPrice);
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Name is required";
    if (!/^\d{6}$/.test(kpayRef.trim())) e.kpayRef = "Enter exactly 6 digits";
    if (!serverId) e.serverId = "Please select a server";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kpayRef: kpayRef.trim(), serverId, ...getPlanPayload() }),
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
    let attempt = 0;
    const maxAttempts = 100;
    const initialDelay = 2000;
    const maxDelay = 30000;
    const backoffMultiplier = 1.5;
    let timeoutId: NodeJS.Timeout;

    const poll = async () => {
      attempt++;
      if (attempt > maxAttempts) return;

      try {
        const res = await fetch(`/api/v1/orders/${id}/status`);
        const data = await res.json() as { status: string; accessUrl?: string };
        if (data.status === "approved") {
          setAccessUrl(data.accessUrl ?? null);
          setStep("approved");
          return;
        } else if (data.status === "rejected") {
          setStep("rejected");
          return;
        }
      } catch { /* keep polling */ }

      // Exponential backoff
      const delay = Math.min(
        initialDelay * Math.pow(backoffMultiplier, attempt - 1),
        maxDelay
      );
      timeoutId = setTimeout(poll, delay);
    };

    poll();

    // Cleanup on unmount
    return () => clearTimeout(timeoutId);
  }

  function resetForm() {
    setStep("form"); setName(""); setKpayRef("");
    setPlanChoice("plan_a"); setGbIdx(3); setMonthIdx(0);
    setDeviceIdx(0); setDataUnlimited(false);
    setOrderId(null); setAccessUrl(null); setErrors({});
    if (servers.length > 0) setServerId(servers[0].id);
  }

  // ── Approved ──────────────────────────────────────────────────────────────
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
        <Button variant="outline" size="sm" onClick={resetForm}>Place another order</Button>
      </div>
    );
  }

  // ── Rejected ──────────────────────────────────────────────────────────────
  if (step === "rejected") {
    return (
      <div className="space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10">
          <XCircle className="w-8 h-8 text-destructive" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Order Rejected</h2>
          <p className="text-sm text-muted-foreground mt-1">Payment could not be verified. Contact support.</p>
        </div>
        <Button variant="outline" onClick={() => { setStep("form"); setOrderId(null); }}>Try again</Button>
      </div>
    );
  }

  // ── Pending ───────────────────────────────────────────────────────────────
  if (step === "pending") {
    return (
      <div className="space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30">
          <Clock className="w-8 h-8 text-amber-500 animate-pulse" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Order Submitted!</h2>
          <p className="text-sm text-muted-foreground mt-1">Waiting for admin to verify your payment…</p>
        </div>
        <div className="rounded-xl border bg-muted/50 p-4 text-left space-y-2">
          <p className="text-xs text-muted-foreground">Order ID</p>
          <p className="text-xs font-mono text-foreground">{orderId}</p>
        </div>
        <p className="text-xs text-muted-foreground">This page updates automatically. Keep it open.</p>
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
        {/* KPay recipient info */}
        <KPayInfo />

        <Label htmlFor="kpay-ref">KPay Transaction Number</Label>
        <p className="text-xs text-muted-foreground">Enter the last 6 digits from your KPay slip</p>
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
          className={cn("font-mono tracking-widest text-center text-lg h-12", errors.kpayRef ? "border-destructive" : "")}
        />
        {errors.kpayRef && <p className="text-xs text-destructive">{errors.kpayRef}</p>}
      </div>

      {/* Server selection */}
      <div className="space-y-1.5">
        <Label>Select Server</Label>
        {serversLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            Loading servers...
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            No servers available. Please contact admin.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {servers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setServerId(s.id)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-all",
                  serverId === s.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                )}
              >
                <div className={cn(
                  "p-1.5 rounded-lg",
                  serverId === s.id ? "bg-primary/10" : "bg-muted"
                )}>
                  <Server className={cn("w-4 h-4", serverId === s.id ? "text-primary" : "text-muted-foreground")} />
                </div>
                <span className="font-medium text-sm">{s.name}</span>
                {serverId === s.id && (
                  <Check className="w-4 h-4 text-primary ml-auto" />
                )}
              </button>
            ))}
          </div>
        )}
        {errors.serverId && <p className="text-xs text-destructive">{errors.serverId}</p>}
      </div>

      {/* Plan selection */}
      <div className="space-y-2">
        <Label>Select Plan</Label>
        <div className="grid grid-cols-1 gap-3">

          {/* Fixed plans */}
          {FIXED_PLANS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlanChoice(p.id as PlanChoice)}
              className={cn(
                "rounded-xl border-2 p-4 text-left transition-all",
                planChoice === p.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <p.icon className="w-4 h-4 text-primary shrink-0" />
                  <div>
                    <p className="font-semibold text-sm">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-sm text-primary">{p.price}</p>
                  <p className="text-xs text-muted-foreground">/ month</p>
                </div>
              </div>
            </button>
          ))}

          {/* ── Custom plan ── */}
          <button
            type="button"
            onClick={() => setPlanChoice("custom")}
            className={cn(
              "rounded-xl border-2 p-4 text-left transition-all",
              planChoice === "custom" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            )}
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-primary shrink-0" />
                <div>
                  <p className="font-semibold text-sm">Custom Plan</p>
                  <p className="text-xs text-muted-foreground">Build your own</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold text-sm text-primary">
                  {planChoice === "custom" ? formatMMK(totalPrice) : `${MMK_PER_GB} MMK/GB`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {planChoice === "custom" && customMonths > 1 ? `${customMonths} months` : "/ month"}
                </p>
              </div>
            </div>

            {/* Sliders — only when selected */}
            {planChoice === "custom" && (
              <div className="mt-5 space-y-5" onClick={(e) => e.stopPropagation()}>

                {/* ── Data ── */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Database className="w-3.5 h-3.5" /> Data
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Unlimited toggle */}
                      <button
                        type="button"
                        onClick={() => setDataUnlimited((v) => !v)}
                        className={cn(
                          "flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors",
                          dataUnlimited
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/40"
                        )}
                      >
                        <Infinity className="w-3 h-3" />
                        Unlimited
                      </button>
                      {!dataUnlimited && (
                        <span className="text-sm font-bold text-foreground">{GB_OPTIONS[gbIdx]} GB</span>
                      )}
                      {dataUnlimited && (
                        <span className="text-sm font-bold text-primary">∞</span>
                      )}
                    </div>
                  </div>
                  {!dataUnlimited && (
                    <>
                      <input
                        type="range" min={0} max={GB_OPTIONS.length - 1}
                        value={gbIdx} onChange={(e) => setGbIdx(Number(e.target.value))}
                        className="w-full accent-primary cursor-pointer h-1.5"
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        {GB_OPTIONS.map((gb, i) => (
                          <span key={gb} className={cn(i === gbIdx ? "text-primary font-semibold" : "")}>
                            {gb >= 100 ? gb : gb}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* ── Devices ── */}
                <SliderRow
                  icon={Users}
                  label="Devices"
                  options={DEVICE_OPTIONS}
                  valueIdx={deviceIdx}
                  onChange={setDeviceIdx}
                  formatValue={(v) => v === "Unlimited" ? "∞" : `${v}`}
                />

                {/* ── Duration ── */}
                <SliderRow
                  icon={CalendarDays}
                  label="Duration"
                  options={MONTH_OPTIONS}
                  valueIdx={monthIdx}
                  onChange={setMonthIdx}
                  formatValue={(v) => `${v}mo`}
                />

                {/* ── Price breakdown ── */}
                <div className="rounded-lg bg-muted/60 px-3 py-3 space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {dataUnlimited ? "Unlimited data" : `${GB_OPTIONS[gbIdx]} GB`}
                      {" × "}{MMK_PER_GB} MMK
                      {dataUnlimited ? " (flat)" : "/GB"}
                    </span>
                    <span>{formatMMK(monthlyPrice)}/mo</span>
                  </div>
                  {customMonths > 1 && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>× {customMonths} months</span>
                      <span>{formatMMK(totalPrice)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-bold border-t pt-1.5 mt-1">
                    <span>Total</span>
                    <span className="text-primary">{formatMMK(totalPrice)}</span>
                  </div>
                </div>
              </div>
            )}
          </button>

        </div>
      </div>

      {errors.form && <p className="text-sm text-destructive">{errors.form}</p>}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Submitting…" : `Submit Order — ${getSubmitPrice()}`}
      </Button>

      <div className="text-center pt-1">
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
