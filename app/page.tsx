"use client";

import React, { useState, useEffect } from "react";
import { EntryGate } from "@/components/EntryGate";
import { AdminView } from "@/components/admin/AdminView";
import { UserView } from "@/components/user/UserView";
import { setAdminCreds } from "@/lib/sync";

type AppState =
  | { role: "none" }
  | { role: "admin" }
  | { role: "user"; ssUrl: string };

const SESSION_KEY = "outline_session";

function saveSession(state: AppState) {
  if (state.role === "none") {
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
  }

  function handleAdminUnlock(username: string, password: string) {
    // Cache credentials in memory so sync layer can authenticate KV requests
    setAdminCreds(username, password);
    transition({ role: "admin" });
  }

  if (!hydrated) return null;

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
    <EntryGate
      onAdminUnlock={handleAdminUnlock}
      onUserUnlock={(ssUrl) => transition({ role: "user", ssUrl })}
    />
  );
}
