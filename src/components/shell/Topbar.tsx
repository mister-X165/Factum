"use client";

/**
 * Фактум topbar — logo + "Спросить нейросеть…" trigger + user profile.
 * The ask-bar opens the fullscreen context chat (⌘K / Ctrl+K also works).
 */

import { useEffect, useRef, useState } from "react";
import { LogOut, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutAndReload } from "@/lib/auth-client";
import type { PublicUser } from "@/lib/factcheck/types";
import type { AppView } from "./AppShell";

interface TopbarProps {
  onNavigate: (v: AppView) => void;
  onOpenChat: () => void;
  currentUser: PublicUser | null;
  isAdmin?: boolean;
}

export function Topbar({ onNavigate, onOpenChat, currentUser, isAdmin }: TopbarProps) {
  // ⌘K / Ctrl+K opens the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChat]);

  return (
    <header className="z-20 flex h-16 shrink-0 items-center gap-3 border-b border-white/[0.07] bg-[#121418] px-4 sm:gap-4 sm:px-6">
      {/* Logo */}
      <button
        type="button"
        onClick={() => onNavigate("home")}
        className="flex shrink-0 items-center gap-2.5"
        aria-label="Фактум — на главный экран"
      >
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-[6px] border border-[#2563EB]/50 bg-[#2563EB]/10 text-[#60a5fa]"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M12 3l7 3v5c0 4.6-2.9 8.1-7 10-4.1-1.9-7-5.4-7-10V6l7-3z" strokeLinejoin="round" />
            <path d="M9 12l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="gx-display hidden text-sm tracking-[0.18em] text-[#f4f5f7] sm:block">
          Фактум
        </span>
      </button>

      {/* Ask-bar (opens the fullscreen chat) */}
      <div className="mx-auto flex min-w-0 flex-1 justify-center gap-2">
        <button
          type="button"
          onClick={onOpenChat}
          className="group hidden h-11 w-full max-w-2xl items-center gap-3 rounded-md border border-white/10 bg-white/[0.04] px-4 text-left text-sm text-[#9ca3af] transition-colors hover:border-[#2563EB]/50 hover:bg-white/[0.06] sm:flex"
          aria-label="Спросить нейросеть — открыть чат"
        >
          <Sparkles className="size-4 shrink-0 text-[#60a5fa]" aria-hidden />
          <span className="truncate">Спросить нейросеть…</span>
          <kbd className="ml-auto hidden shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-sans text-[10px] text-[#566272] lg:block">
            ⌘K
          </kbd>
        </button>
        {/* Compact chat button for narrow screens */}
        <button
          type="button"
          onClick={onOpenChat}
          aria-label="Спросить нейросеть"
          className="flex size-11 shrink-0 items-center justify-center rounded-md border border-white/10 text-[#9ca3af] transition-colors hover:border-[#2563EB]/50 hover:text-[#60a5fa] sm:hidden"
        >
          <Sparkles className="size-4" aria-hidden />
        </button>
      </div>

      {/* Profile */}
      <ProfileMenu onNavigate={onNavigate} currentUser={currentUser} isAdmin={isAdmin} />
    </header>
  );
}

function ProfileMenu({
  onNavigate,
  currentUser,
  isAdmin,
}: {
  onNavigate: (v: AppView) => void;
  currentUser: PublicUser | null;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await logoutAndReload();
  };

  // Determine the avatar letter + display name.
  const name = currentUser?.username ?? "…";
  const letter = name.charAt(0).toUpperCase() || "?";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Профиль пользователя"
        className={cn(
          "flex items-center gap-2.5 rounded-md border px-2 py-1.5 transition-colors",
          open
            ? "border-white/20 bg-white/[0.06]"
            : "border-transparent hover:border-white/10 hover:bg-white/[0.04]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-8 items-center justify-center rounded-full border text-xs font-medium",
            isAdmin
              ? "border-[#2563EB]/40 bg-[#2563EB]/10 text-[#60a5fa]"
              : "border-white/15 bg-white/[0.06] text-[#c3c8cf]",
          )}
        >
          {isAdmin ? <ShieldCheck className="size-4" /> : letter}
        </span>
        <span className="hidden max-w-28 truncate text-sm text-[#c3c8cf] lg:block">
          {name}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 overflow-hidden rounded-md border border-white/10 bg-[#171a1f] py-1 shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
        >
          <div className="border-b border-white/[0.07] px-3 py-2">
            <p className="text-sm text-[#f4f5f7]">{name}</p>
            <p className="text-[11px] text-[#9ca3af]">
              {isAdmin ? "Администратор" : "Пользователь"}
            </p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate("settings");
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#c3c8cf] transition-colors hover:bg-white/[0.05] hover:text-[#f4f5f7]"
          >
            <Settings className="size-4 text-[#9ca3af]" aria-hidden />
            Настройки
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate("admin");
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#c3c8cf] transition-colors hover:bg-white/[0.05] hover:text-[#f4f5f7]"
            >
              <ShieldCheck className="size-4 text-[#9ca3af]" aria-hidden />
              Администрирование
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            disabled={signingOut}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[#c3c8cf] transition-colors hover:bg-white/[0.05] hover:text-[#f4f5f7] disabled:opacity-50"
          >
            <LogOut className="size-4 text-[#9ca3af]" aria-hidden />
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}
