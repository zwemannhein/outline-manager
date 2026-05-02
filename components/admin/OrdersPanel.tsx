"use client";

import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, XCircle, Clock, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_PLANS } from "@/lib/types";
import type { Order } from "@/lib/types";

interface OrdersPanelProps {
  authHeader: string;
  servers: Array<{ id: string; name: string }>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      })}
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy access URL"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function OrdersPanel({ authHeader, servers }: OrdersPanelProps) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<string>(servers[0]?.id ?? "");

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/orders", { headers: { Authorization: authHeader } });
      if (res.ok) setOrders(await res.json() as Order[]);
    } finally {
      setLoading(false);
    }
  }, [authHeader]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  async function handleApprove(orderId: string) {
    setProcessing(orderId);
    try {
      const res = await fetch(`/api/orders/${orderId}/approve`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; accessUrl?: string };
      if (res.ok) {
        toast({ title: "Order approved", description: "Access key created and sent." });
        await loadOrders();
      } else {
        toast({ variant: "destructive", title: "Approval failed", description: data.error });
      }
    } finally {
      setProcessing(null);
    }
  }

  async function handleReject(orderId: string) {
    setProcessing(orderId);
    try {
      const res = await fetch(`/api/orders/${orderId}/reject`, {
        method: "POST",
        headers: { Authorization: authHeader },
      });
      if (res.ok) {
        toast({ title: "Order rejected" });
        await loadOrders();
      }
    } finally {
      setProcessing(null);
    }
  }

  const pending = orders.filter((o) => o.status === "pending");
  const processed = orders.filter((o) => o.status !== "pending");

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Key Orders</h1>
          <p className="text-sm text-muted-foreground">
            {pending.length} pending · {processed.length} processed
          </p>
        </div>
        <div className="flex items-center gap-2">
          {servers.length > 1 && (
            <select
              value={selectedServer}
              onChange={(e) => setSelectedServer(e.target.value)}
              className="text-xs border rounded-md px-2 py-1.5 bg-background"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          <Button variant="outline" size="sm" onClick={loadOrders} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Pending orders */}
      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
            <Clock className="w-4 h-4" /> Pending Approval
          </h2>
          {pending.map((order) => {
            const isCustom = order.plan === "custom";
            const planLabel = isCustom ? "Custom" : (DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.label ?? order.plan);
            const planDesc = isCustom
              ? `${order.customDataLimitGB ?? "?"} GB / ${(order.customDataLimitGB ?? 0) * 50} MMK`
              : DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.description ?? "";
            const isProcessing = processing === order.id;
            return (
              <div key={order.id} className="rounded-xl border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{order.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      KPay: <span className="font-mono font-medium text-foreground">{order.kpayRef}</span>
                    </p>
                  </div>
                  <Badge variant="warning" className="shrink-0">Pending</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">{planLabel}</Badge>
                  <span className="text-xs text-muted-foreground">{planDesc}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(order.createdAt).toLocaleString()}
                </p>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm" className="flex-1"
                    onClick={() => handleApprove(order.id)}
                    disabled={isProcessing}
                  >
                    {isProcessing ? <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
                    Approve
                  </Button>
                  <Button
                    size="sm" variant="outline" className="flex-1 text-destructive hover:text-destructive"
                    onClick={() => handleReject(order.id)}
                    disabled={isProcessing}
                  >
                    <XCircle className="w-3.5 h-3.5 mr-1.5" />
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Processed orders */}
      {processed.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">History</h2>
          {processed.map((order) => {
            const isCustom = order.plan === "custom";
            const planLabel = isCustom ? "Custom" : (DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.label ?? order.plan);
            const planDesc = isCustom
              ? `${order.customDataLimitGB ?? "?"} GB`
              : DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.description ?? "";
            return (
              <div key={order.id} className="rounded-xl border bg-card p-4 space-y-2 opacity-80">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-sm">{order.name}</p>
                    <p className="text-xs text-muted-foreground">
                      KPay: <span className="font-mono">{order.kpayRef}</span>
                    </p>
                  </div>
                  <Badge variant={order.status === "approved" ? "success" : "destructive"} className="shrink-0 text-xs">
                    {order.status === "approved" ? "Approved" : "Rejected"}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">{planLabel}</Badge>
                  <span className="text-xs text-muted-foreground">{planDesc}</span>
                </div>
                {order.accessUrl && (
                  <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
                    <p className="text-xs font-mono truncate flex-1">{order.accessUrl}</p>
                    <CopyButton text={order.accessUrl} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No orders yet.</p>
        </div>
      )}
    </div>
  );
}
