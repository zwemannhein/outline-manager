"use client";

import React, { useState, useRef, useCallback } from "react";
import { Server, Plus, Trash2, Wifi, WifiOff, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OutlineServer } from "@/lib/types";

interface ServerSidebarProps {
  servers: OutlineServer[];
  activeId: string | null;
  onlineIds: Set<string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRename: (id: string, newName: string) => void;
}

export function ServerSidebar({
  servers,
  activeId,
  onlineIds,
  onSelect,
  onAdd,
  onRemove,
  onRename,
}: ServerSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Use a ref to track whether we're in the middle of committing
  // so onBlur doesn't double-fire after Enter
  const committingRef = useRef(false);

  const startEditing = useCallback(
    (e: React.MouseEvent, server: OutlineServer) => {
      e.stopPropagation();
      e.preventDefault();
      committingRef.current = false;
      setEditValue(server.name);
      setEditingId(server.id);
      // Use setTimeout to ensure the input is mounted before focusing
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 0);
    },
    []
  );

  const commitRename = useCallback(() => {
    if (committingRef.current) return;
    committingRef.current = true;

    const trimmed = editValue.trim();
    const original = servers.find((s) => s.id === editingId)?.name;
    if (trimmed && trimmed !== original && editingId) {
      onRename(editingId, trimmed);
    }
    setEditingId(null);
    setEditValue("");
    committingRef.current = false;
  }, [editValue, editingId, servers, onRename]);

  const cancelEditing = useCallback(() => {
    committingRef.current = false;
    setEditingId(null);
    setEditValue("");
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditing();
      }
    },
    [commitRename, cancelEditing]
  );

  return (
    <aside className="flex h-full w-[min(88vw,18rem)] shrink-0 flex-col border-r bg-white shadow-xl shadow-slate-900/5 dark:bg-slate-950 lg:w-64 lg:shadow-none">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Servers</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onAdd} title="Add server">
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Server list */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-0.5 px-2">
        {servers.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8 px-4">
            No servers yet. Add one with the + button.
          </p>
        )}
        {servers.map((server) => {
          const isOnline = onlineIds.has(server.id);
          const isActive = server.id === activeId;
          const isEditing = editingId === server.id;

          return (
            <div
              key={server.id}
              className={cn(
                "group flex min-h-11 items-center gap-2 rounded-xl px-3 py-2.5 transition-colors",
                isEditing
                  ? "bg-accent"
                  : isActive
                  ? "bg-primary/10 text-primary cursor-pointer"
                  : "hover:bg-accent text-foreground cursor-pointer"
              )}
              onClick={() => {
                if (!isEditing) onSelect(server.id);
              }}
            >
              {/* Status dot */}
              <span
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
                )}
              />

              {/* Name — inline input when editing, text otherwise */}
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleKeyDown}
                  // Prevent clicks inside the input from bubbling to the row
                  onClick={(e) => e.stopPropagation()}
                  // Prevent mousedown from stealing focus away
                  onMouseDown={(e) => e.stopPropagation()}
                  className={cn(
                    "flex-1 min-w-0 bg-transparent outline-none",
                    "text-sm font-medium text-foreground",
                    "border-b-2 border-primary",
                    "caret-primary"
                  )}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <span
                  className="flex-1 text-sm truncate font-medium select-none"
                  title="Double-click or click ✏ to rename"
                  onDoubleClick={(e) => startEditing(e, server)}
                >
                  {server.name}
                </span>
              )}

              {/* Online/offline icon — hidden while editing */}
              {!isEditing &&
                (isOnline ? (
                  <Wifi className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                ))}

              {/* Action buttons — shown on hover, hidden while editing */}
              {!isEditing && (
                <>
                  {/* Pencil: mousedown to avoid blur race */}
                  <button
                    onMouseDown={(e) => startEditing(e, server)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                    title="Rename server"
                    tabIndex={-1}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(server.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    title="Remove server"
                    tabIndex={-1}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t">
        <p className="text-xs text-muted-foreground">
          {servers.length} server{servers.length !== 1 ? "s" : ""} configured
        </p>
      </div>
    </aside>
  );
}
