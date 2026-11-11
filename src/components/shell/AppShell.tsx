"use client";

/**
 * Фактум app shell — topbar + narrow sidebar + scrollable workspace with a
 * sticky disclaimer footer. On mobile (<md) the sidebar is replaced by a
 * fixed bottom tab bar.
 */

import type { ReactNode } from "react";
import { History, Home, Settings, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HealthInfo, PublicUser } from "@/lib/factcheck/types";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export type AppView = "home" | "check" | "history" | "settings" | "admin";

interface AppShellProps {
  view: AppView;
  onNavigate: (v: AppView) => void;
  health: HealthInfo | null;
  currentUser: PublicUser | null;
  onOpenChat: () => void;
  children: ReactNode;
}

const MOBILE_TABS: { id: AppView; label: string; icon: typeof Home; adminOnly?: boolean }[] = [
  { id: "home", label: "Главная", icon: Home },
  { id: "history", label: "История", icon: History },
  { id: "settings", label: "Настройки", icon: Settings },
];

export function AppShell({ view, onNavigate, health, currentUser, onOpenChat, children }: AppShellProps) {
  const isAdmin = currentUser?.role === "admin";
  const mobileTabs = isAdmin
    ? [...MOBILE_TABS, { id: "admin" as AppView, label: "Админ", icon: ShieldCheck }]
    : MOBILE_TABS;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#121418]">
      <Topbar
        onNavigate={onNavigate}
        onOpenChat={onOpenChat}
        currentUser={currentUser}
        isAdmin={isAdmin}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onNavigate={onNavigate}
          health={health}
          isAdmin={isAdmin}
        />

        <main className="gx-scroll flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* Workspace — max 1200px, centered, lots of air */}
          <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-6 sm:px-6 lg:px-8">
            {children}
          </div>

          {/* Disclaimer footer — sticks to the viewport bottom on short
              content, pushed down naturally on long content. */}
          <footer className="mt-8 shrink-0 border-t border-white/[0.07] px-4 py-3 pb-[calc(4.75rem+env(safe-area-inset-bottom))] sm:px-6 md:pb-4 lg:px-8">
            <div className="mx-auto flex max-w-[1200px] flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-[11px] leading-snug text-[#566272]">
                Система верификации информации, а не диагностический инструмент.
                Не ставит диагнозов и не назначает лечение.
              </p>
              <span className="shrink-0 text-[11px] text-[#566272]">
                Фактум · {new Date().getFullYear()}
              </span>
            </div>
          </footer>
        </main>
      </div>

      {/* Mobile bottom tabs */}
      <nav
        aria-label="Основная навигация"
        className="fixed inset-x-0 bottom-0 z-30 grid border-t border-white/[0.07] bg-[#0f1114]/95 backdrop-blur-md md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)", gridTemplateColumns: `repeat(${mobileTabs.length}, 1fr)` }}
      >
        {mobileTabs.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] transition-colors",
                active ? "text-[#f4f5f7]" : "text-[#9ca3af]",
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-1/2 top-0 h-[2px] w-8 -translate-x-1/2 rounded-full bg-[#2563EB]"
                />
              )}
              <Icon className="size-5" aria-hidden />
              {label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
