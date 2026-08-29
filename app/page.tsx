"use client";

import React, { useState, useEffect } from "react";
import { OrderForm } from "@/components/OrderForm";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { AdminView } from "@/components/admin/AdminView";
import { UserView } from "@/components/user/UserView";
import { clearAuthToken } from "@/lib/sync";
import { Server, Sparkles } from "lucide-react";

type AppState =
  | { role: "none" }
  | { role: "admin-login" }
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
    if (next.role === "none" || next.role === "admin-login") {
      clearAuthToken();
    }
  }

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
        <div className="text-center space-y-4">
          <div className="relative">
            <Server className="w-12 h-12 mx-auto text-blue-600 dark:text-blue-400 animate-pulse" />
            <Sparkles className="w-6 h-6 absolute -top-1 -right-1 text-purple-500 animate-bounce" />
          </div>
          <p className="text-sm text-muted-foreground font-medium">Loading your experience...</p>
        </div>
      </div>
    );
  }

  if (state.role === "admin-login") {
    return (
      <AdminLoginForm
        onUnlock={() => transition({ role: "admin" })}
        onBack={() => transition({ role: "none" })}
      />
    );
  }

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
      {/* Animated background elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-blue-400/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-purple-400/10 rounded-full blur-3xl animate-pulse delay-1000" />
      </div>

      {/* Header */}
      <header className="relative border-b bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg px-4 sm:px-6 py-4 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Server className="w-6 h-6 sm:w-7 sm:h-7 text-blue-600 dark:text-blue-400" />
              <Sparkles className="w-3 h-3 absolute -top-1 -right-1 text-purple-500" />
            </div>
            <div>
              <h1 className="font-bold text-lg sm:text-xl bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                Outline VPN
              </h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Secure & Fast</p>
            </div>
          </div>
          <button
            onClick={() => transition({ role: "admin-login" })}
            className="text-xs sm:text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            Admin
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative flex flex-col items-center px-4 sm:px-6 py-8 sm:py-12">
        <div className="w-full max-w-2xl space-y-6 sm:space-y-8">
          {/* Hero Section */}
          <div className="text-center space-y-3 sm:space-y-4">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 bg-clip-text text-transparent leading-tight">
              Get VPN Access
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Pay via KPay and get your secure VPN key instantly after approval. Fast, reliable, and easy to use.
            </p>
          </div>

          {/* Access Key Checker Card */}
          <div className="bg-gradient-to-br from-blue-500/10 to-purple-500/10 backdrop-blur-lg rounded-2xl sm:rounded-3xl shadow-xl border border-blue-200/50 dark:border-blue-700/50 p-6 sm:p-8">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
                  <Server className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-lg bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                    Check Your Access Key
                  </h3>
                  <p className="text-xs text-muted-foreground">Already have a key? Check your usage and status</p>
                </div>
              </div>
              
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = (e.target as HTMLFormElement).elements.namedItem("ssUrl") as HTMLInputElement;
                  const url = input.value.trim();
                  if (url) {
                    transition({ role: "user", ssUrl: url });
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label htmlFor="ssUrl" className="block text-sm font-medium mb-2">
                    Paste your access key (ss:// or ssconf://)
                  </label>
                  <textarea
                    id="ssUrl"
                    name="ssUrl"
                    rows={3}
                    placeholder="ss://..."
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm px-4 py-3 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all"
                    spellCheck={false}
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold py-3 px-6 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5"
                >
                  Check Key Status
                </button>
              </form>
            </div>
          </div>

          {/* Divider */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300 dark:border-gray-700"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 text-muted-foreground font-medium">
                Or order a new key
              </span>
            </div>
          </div>

          {/* Order Form Card */}
          <div className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-lg rounded-2xl sm:rounded-3xl shadow-xl border border-gray-200/50 dark:border-gray-700/50 p-6 sm:p-8">
            <OrderForm onAdminClick={() => transition({ role: "admin-login" })} />
          </div>

          {/* Features */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 pt-4">
            {[
              { icon: "🔒", title: "Secure", desc: "End-to-end encryption" },
              { icon: "⚡", title: "Fast", desc: "High-speed servers" },
              { icon: "🌍", title: "Global", desc: "Worldwide access" },
            ].map((feature, i) => (
              <div
                key={i}
                className="bg-white/60 dark:bg-gray-900/60 backdrop-blur-sm rounded-xl sm:rounded-2xl p-4 sm:p-6 text-center border border-gray-200/50 dark:border-gray-700/50 hover:shadow-lg transition-all duration-300 hover:-translate-y-1"
              >
                <div className="text-3xl sm:text-4xl mb-2 sm:mb-3">{feature.icon}</div>
                <h3 className="font-semibold text-sm sm:text-base mb-1">{feature.title}</h3>
                <p className="text-xs sm:text-sm text-muted-foreground">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative text-center py-6 sm:py-8 text-xs sm:text-sm text-muted-foreground">
        <p>© 2024 Outline VPN Manager. Secure & Private.</p>
      </footer>
    </div>
  );
}
