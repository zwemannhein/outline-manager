"use client";

import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, XCircle, Clock, Copy, Check, AlertCircle, ShoppingBag } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<string>(servers[0]?.id ?? "");

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    // Get fresh auth token (stored by lib/sync.ts login function)
    const token = typeof window !== "undefined" ? sessionStorage.getItem("outline_admin_token") : null;
    if (!token) {
      setError("Not authenticated. Please log in again.");
      setLoading(false);
      return;
    }
    
    const headers = { Authorization: `Bearer ${token}` };
    console.log("[OrdersPanel] Loading orders with auth");
    
    try {
      const res = await fetch("/api/v1/orders", { 
        headers,
        cache: "no-store"
      });
      
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Authentication failed. Please log in again.");
        }
        throw new Error(`Failed to load orders: ${res.status}`);
      }
      
      const data = await res.json() as Order[];
      console.log(`[OrdersPanel] Loaded ${data.length} orders successfully`);
      setOrders(data);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to load orders";
      setError(errorMsg);
      console.error("[OrdersPanel] Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  async function handleApprove(orderId: string) {
    setProcessing(orderId);
    setError(null);
    
    // Get fresh auth token
    const token = typeof window !== "undefined" ? sessionStorage.getItem("outline_admin_token") : null;
    if (!token) {
      setError("Not authenticated. Please log in again.");
      setProcessing(null);
      return;
    }
    
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    console.log(`[OrdersPanel] Approving order: ${orderId}`);
    
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/approve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ serverId: selectedServer }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; accessUrl?: string };
      if (res.ok) {
        console.log(`[OrdersPanel] Order approved successfully: ${orderId}`);
        toast({ title: "Order approved", description: "Access key created and sent." });
        await loadOrders();
      } else {
        const errorMsg = data.error || `Approval failed: ${res.status}`;
        setError(errorMsg);
        toast({ variant: "destructive", title: "Approval failed", description: errorMsg });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Network error";
      setError(errorMsg);
      toast({ variant: "destructive", title: "Approval failed", description: errorMsg });
      console.error("[OrdersPanel] Approve error:", err);
    } finally {
      setProcessing(null);
    }
  }

  async function handleReject(orderId: string) {
    setProcessing(orderId);
    setError(null);
    
    // Get fresh auth token
    const token = typeof window !== "undefined" ? sessionStorage.getItem("outline_admin_token") : null;
    if (!token) {
      setError("Not authenticated. Please log in again.");
      setProcessing(null);
      return;
    }
    
    const headers = { Authorization: `Bearer ${token}` };
    console.log(`[OrdersPanel] Rejecting order: ${orderId}`);
    
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/reject`, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        console.log(`[OrdersPanel] Order rejected successfully: ${orderId}`);
        toast({ title: "Order rejected" });
        await loadOrders();
      } else {
        const errorMsg = `Rejection failed: ${res.status}`;
        setError(errorMsg);
        toast({ variant: "destructive", title: "Rejection failed", description: errorMsg });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Network error";
      setError(errorMsg);
      toast({ variant: "destructive", title: "Rejection failed", description: errorMsg });
      console.error("[OrdersPanel] Reject error:", err);
    } finally {
      setProcessing(null);
    }
  }

  const pending = orders.filter((o) => o.status === "pending");
  const processed = orders.filter((o) => o.status !== "pending");

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      {/* Fixed Header */}
      <div className="flex-shrink-0 p-3 sm:p-6 pb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">Key Orders</h1>
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-amber-600 dark:text-amber-400">{pending.length} pending</span> · {processed.length} processed
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {servers.length > 1 && (
              <select
                value={selectedServer}
                onChange={(e) => setSelectedServer(e.target.value)}
                className="text-xs border rounded-lg px-3 py-2 backdrop-blur-sm bg-white/80 dark:bg-gray-800/80 border-gray-200 dark:border-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              onClick={loadOrders} 
              disabled={loading}
              className="backdrop-blur-sm bg-white/50 dark:bg-gray-800/50 hover:bg-white dark:hover:bg-gray-800 border-gray-200 dark:border-gray-700"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable Orders List */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 pb-6 space-y-6">
        
        {/* Error Banner */}
        {error && (
          <div className="rounded-xl backdrop-blur-md bg-gradient-to-r from-red-50 to-pink-50 dark:from-red-950/50 dark:to-pink-950/50 border border-red-200/50 dark:border-red-900/50 px-4 py-4 shadow-lg animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/50">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-900 dark:text-red-200">Error Loading Orders</p>
                <p className="text-xs text-red-700 dark:text-red-300 mt-1">{error}</p>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={loadOrders}
                className="shrink-0 text-red-600 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-950/30"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Retry
              </Button>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="text-center py-20">
            <div className="relative inline-flex items-center justify-center">
              <div className="absolute w-20 h-20 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 opacity-20 animate-ping" />
              <div className="relative p-5 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-2xl">
                <RefreshCw className="w-10 h-10 text-white animate-spin" />
              </div>
            </div>
            <p className="text-sm text-muted-foreground font-medium mt-6">Loading orders...</p>
          </div>
        )}

      {/* Pending orders */}
      {!loading && pending.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 shadow-lg">
              <Clock className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-base font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">
              Pending Approval
            </h2>
            <Badge className="ml-auto bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900">
              {pending.length} {pending.length === 1 ? 'order' : 'orders'}
            </Badge>
          </div>
          {pending.map((order) => {
            const isCustom = order.plan === "custom";
            const planLabel = isCustom ? "Custom" : (DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.label ?? order.plan);
            const planDesc = isCustom
              ? `${order.customDataLimitGB ?? "?"} GB / ${(order.customDataLimitGB ?? 0) * 50} MMK`
              : DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.description ?? "";
            const isProcessing = processing === order.id;
            return (
              <div key={order.id} className="group rounded-2xl backdrop-blur-md bg-gradient-to-br from-white/90 to-blue-50/50 dark:from-gray-900/90 dark:to-blue-950/30 border-2 border-amber-200/50 dark:border-amber-900/50 shadow-lg hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 p-5 space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      <p className="font-bold text-lg truncate">{order.name}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">KPay:</span>
                      <code className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono text-foreground font-semibold">
                        {order.kpayRef}
                      </code>
                    </div>
                  </div>
                  <Badge className="shrink-0 bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0 shadow-lg px-3 py-1">
                    <Clock className="w-3 h-3 mr-1" />
                    Pending
                  </Badge>
                </div>

                {/* Plan Info */}
                <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/30 dark:to-purple-950/30 border border-blue-200/50 dark:border-blue-900/50">
                  <Badge className="bg-gradient-to-r from-blue-600 to-purple-600 text-white border-0 shadow-md text-xs font-semibold px-3 py-1">
                    {planLabel}
                  </Badge>
                  <span className="text-sm font-medium text-muted-foreground">{planDesc}</span>
                </div>

                {/* Timestamp */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className="w-1 h-1 rounded-full bg-muted-foreground/50" />
                  <span>Ordered {new Date(order.createdAt).toLocaleString()}</span>
                </div>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    size="sm" 
                    className="flex-1 bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-700 hover:to-green-700 text-white shadow-lg hover:shadow-xl transition-all duration-300 h-10 font-semibold"
                    onClick={() => handleApprove(order.id)}
                    disabled={isProcessing}
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        Approve & Create Key
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm" 
                    variant="outline" 
                    className="flex-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 backdrop-blur-sm bg-white/50 dark:bg-gray-800/50 hover:bg-red-50 dark:hover:bg-red-950/30 border-2 border-red-200 dark:border-red-900 hover:border-red-300 dark:hover:border-red-800 h-10 font-semibold transition-all duration-300"
                    onClick={() => handleReject(order.id)}
                    disabled={isProcessing}
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Processed orders */}
      {!loading && processed.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-gradient-to-br from-gray-400 to-gray-500 shadow-lg">
              <CheckCircle2 className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-base font-bold text-muted-foreground">Order History</h2>
            <Badge variant="secondary" className="ml-auto bg-gray-100 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700">
              {processed.length} {processed.length === 1 ? 'order' : 'orders'}
            </Badge>
          </div>
          {processed.map((order) => {
            const isCustom = order.plan === "custom";
            const planLabel = isCustom ? "Custom" : (DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.label ?? order.plan);
            const planDesc = isCustom
              ? `${order.customDataLimitGB ?? "?"} GB`
              : DEFAULT_PLANS.find((p: { id: string }) => p.id === order.plan)?.description ?? "";
            return (
              <div key={order.id} className="rounded-2xl backdrop-blur-md bg-white/60 dark:bg-gray-900/60 border border-gray-200/50 dark:border-gray-700/50 shadow-md hover:shadow-lg transition-all duration-300 p-4 space-y-3 opacity-90 hover:opacity-100">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-base truncate">{order.name}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <span className="font-medium">KPay:</span>
                      <code className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono">
                        {order.kpayRef}
                      </code>
                    </div>
                  </div>
                  <Badge 
                    className={`shrink-0 text-xs font-semibold px-3 py-1 ${
                      order.status === "approved" 
                        ? "bg-gradient-to-r from-emerald-500 to-green-500 text-white border-0 shadow-md" 
                        : "bg-gradient-to-r from-red-500 to-pink-500 text-white border-0 shadow-md"
                    }`}
                  >
                    {order.status === "approved" ? (
                      <>
                        <CheckCircle2 className="w-3 h-3 mr-1 inline" />
                        Approved
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3 h-3 mr-1 inline" />
                        Rejected
                      </>
                    )}
                  </Badge>
                </div>

                {/* Plan Info */}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="text-xs backdrop-blur-sm bg-gray-100 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 px-2 py-1">
                    {planLabel}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{planDesc}</span>
                </div>

                {/* Access URL */}
                {order.accessUrl && (
                  <div className="flex items-center gap-2 backdrop-blur-sm bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/30 dark:to-purple-950/30 rounded-lg px-3 py-2.5 border border-blue-200/50 dark:border-blue-900/50">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Access Key</p>
                      <p className="text-xs font-mono truncate text-foreground">{order.accessUrl}</p>
                    </div>
                    <CopyButton text={order.accessUrl} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center py-24">
          <div className="relative inline-flex items-center justify-center mb-6">
            <div className="absolute w-24 h-24 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 opacity-10 animate-pulse" />
            <div className="relative p-6 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-2xl">
              <ShoppingBag className="w-12 h-12 text-white" />
            </div>
          </div>
          <h3 className="text-lg font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent mb-2">
            No Orders Yet
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            When customers place orders, they'll appear here for your approval.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
