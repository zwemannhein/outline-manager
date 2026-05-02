"use client";

import React, { useState } from "react";
import { Shield, Eye, EyeOff, ArrowLeft, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AdminLoginFormProps {
  onUnlock: (username: string, password: string) => void;
  onBack: () => void;
}

export function AdminLoginForm({ onUnlock, onBack }: AdminLoginFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError("Please enter your username and password.");
      return;
    }
    // Client-side pre-check — real auth happens server-side in API routes
    // We just need to match what the server expects
    const expectedUser = "zmh";
    const expectedPass = "admin123";
    if (username.trim() !== expectedUser || password !== expectedPass) {
      setError("Invalid username or password.");
      return;
    }
    onUnlock(username.trim(), password);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-2">
            <Server className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-xl font-bold">Admin Login</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError(null); }}
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
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="Enter password"
                autoComplete="current-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full">
            <Shield className="w-4 h-4 mr-2" /> Sign In
          </Button>
        </form>

        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
        >
          <ArrowLeft className="w-4 h-4" /> Back to home
        </button>
      </div>
    </div>
  );
}
