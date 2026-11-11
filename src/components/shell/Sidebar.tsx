"use client";

/**
 * Фактум sidebar — narrow vertical navigation (Главная / История / Настройки),
 * collapsible to icons-only. The very bottom carries the compact system
 * status (LLM / БД / доверенные источники) in small print.
 */

import { useCallback, useSyncExternalStore } from "react";
import { History, Home, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HealthInfo } from "@/lib/factcheck/types";
import type { AppView } from "./AppShell";

const LS_COLLAPSED = "factum:sidebar-collapsed";

/**
 * localStorage-backed boolean flag via useSyncExternalStore — SSR-safe
 * (server snapshot = false → no hydration mismatch) and lint-clean.
 */
function useLocalStorageFlag(key: string): [boolean, () => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      window.addEventListener("storage", onChange);
      return () => window.removeEventListener("storage", onChange);
    },
    [],
  );
  const getSnapshot = useCallback(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }, [key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const toggle = useCallback(() => {
    try {
      localStorage.setItem(key, value ? "0" : "1");
      // The native `storage` event only fires in OTHER tabs — dispatch it
      // locally so this tab's subscribers re-read the snapshot.
      window.dispatchEvent(new Event("storage"));
    } catch {
      /* private mode — keep current state */
    }
  }, [key, value]);

  return [value, toggle];
}

interface SidebarProps {
  view: AppView;
  onNavigate: (v: AppView) => void;
  health: HealthInfo | null;
  isAdmin?: boolean;
}

const BASE_NAV_ITEMS: { id: AppView; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Главная", icon: Home },
  { id: "history", label: "История", icon: History },
  { id: "settings", label: "Настройки", icon: Settings },
];

const ADMIN_NAV_ITEM = { id: "admin" as AppView, label: "Администрирование", icon: ShieldCheck };

export function Sidebar({ view, onNavigate, health, isAdmin }: SidebarProps) {
  const [collapsed, toggleCollapsed] = useLocalStorageFlag(LS_COLLAPSED);
  const navItems = isAdmin ? [...BASE_NAV_ITEMS, ADMIN_NAV_ITEM] : BASE_NAV_ITEMS;

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-white/[0.07] bg-[#0f1114] transition-[width] duration-200 md:flex",
        collapsed ? "w-16" : "w-[232px]",
      )}
      aria-label="Основная навигация"
    >
      {/* Nav */}
      <nav className="flex flex-col gap-1 p-2.5">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
              className={cn(
                "relative flex h-10 items-center rounded-md text-sm transition-colors",
                collapsed ? "justify-center" : "gap-3 px-3",
                active
                  ? "bg-white/[0.06] text-[#f4f5f7]"
                  : "text-[#9ca3af] hover:bg-white/[0.03] hover:text-[#c3c8cf]",
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-[#2563EB]"
                />
              )}
              <Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{label}</span>}
              {collapsed && <span className="sr-only">{label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Bottom: system status + collapse toggle */}
      <div className="mt-auto flex flex-col gap-2 border-t border-white/[0.07] p-2.5">
        <SystemStatus health={health} collapsed={collapsed} />
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Развернуть панель" : "Свернуть панель"}
          className={cn(
            "flex h-9 items-center rounded-md text-[#566272] transition-colors hover:bg-white/[0.03] hover:text-[#9ca3af]",
            collapsed ? "justify-center" : "gap-3 px-3",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <>
              <PanelLeftClose className="size-4" aria-hidden />
              <span className="text-xs">Свернуть</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

/** Compact system status — the ONLY place status is surfaced.
 *  Kept visually quiet: a single dimmed line per indicator, state carried
 *  by a small dot. Only a failure tints the value (muted red). */
function SystemStatus({ health, collapsed }: { health: HealthInfo | null; collapsed: boolean }) {
  const llm = health?.llm.ready ?? null;
  const db = health?.db.ready ?? null;
  const sources = health?.config.trustedSourcesCount;

  const rows = [
    { label: "LLM", state: llm, value: llm === null ? "…" : llm ? "готов" : "ошибка" },
    { label: "БД", state: db, value: db === null ? "…" : db ? "ок" : "ошибка" },
    {
      label: "Источники",
      state: null,
      value: sources === undefined ? "…" : String(sources),
    },
  ];

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-0.5" aria-label="Состояние системы">
        {rows.map((r) => (
          <span
            key={r.label}
            title={`${r.label}: ${r.value}`}
            className={cn(
              "inline-block size-1.5 rounded-full",
              r.state === true
                ? "bg-[#10b981] gx-beacon"
                : r.state === false
                  ? "bg-[#ef4444]"
                  : "bg-[#3a4250]",
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-2 py-1" aria-label="Состояние системы">
      {rows.map((r) => (
        <span
          key={r.label}
          className="flex items-center gap-2 text-[10px] leading-none"
          title={`${r.label}: ${r.value}`}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block size-1.5 shrink-0 rounded-full",
              r.state === true
                ? "bg-[#10b981] gx-beacon"
                : r.state === false
                  ? "bg-[#ef4444]"
                  : "bg-[#3a4250]",
            )}
          />
          <span className="w-14 shrink-0 text-[#566272]">{r.label}</span>
          <span
            className={cn(
              "truncate",
              r.state === false ? "text-[#f87171]/80" : "text-[#566272]",
            )}
          >
            {r.value}
          </span>
        </span>
      ))}
    </div>
  );
}
