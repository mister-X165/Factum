"use client";

/**
 * «Настройки» — real settings only, no marketing placeholders:
 * default check mode (persisted), read-only system status, local data
 * management (clear history) and account info.
 */

import { useState } from "react";
import {
  Database,
  HardDrive,
  Loader2,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { logoutAndReload } from "@/lib/auth-client";
import type { AnalysisMode, HealthInfo, PublicUser } from "@/lib/factcheck/types";

interface SettingsViewProps {
  health: HealthInfo | null;
  defaultMode: AnalysisMode;
  onChangeDefaultMode: (m: AnalysisMode) => void;
  historyCount: number | null;
  onClearHistory: () => Promise<void> | void;
}

const MODES: { id: AnalysisMode; title: string; caption: string }[] = [
  {
    id: "CONTROLLED",
    title: "Контролируемый",
    caption: "Только доверенные источники из реестра",
  },
  {
    id: "RESEARCH",
    title: "Исследовательский",
    caption: "Расширенный поиск + adversarial-проверка",
  },
];

export function SettingsView({
  health,
  defaultMode,
  onChangeDefaultMode,
  historyCount,
  onClearHistory,
}: SettingsViewProps) {
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const currentUser: PublicUser | null = health?.auth?.user ?? null;

  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await onClearHistory();
      setConfirming(false);
    } finally {
      setClearing(false);
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logoutAndReload();
    } finally {
      setSigningOut(false);
    }
  };

  const llm = health?.llm;
  const db = health?.db;

  return (
    <div className="space-y-5 pb-2">
      <h1 className="gx-label text-sm">Настройки</h1>

      {/* Проверка */}
      <section className="gx-card p-5 sm:p-6" aria-labelledby="settings-check">
        <h2 id="settings-check" className="gx-label-card mb-4">
          Проверка
        </h2>
        <p className="mb-3 text-xs text-[#6b7280]">Режим по умолчанию для новых проверок</p>
        <div
          role="radiogroup"
          aria-label="Режим по умолчанию"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {MODES.map((m) => {
            const selected = defaultMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChangeDefaultMode(m.id)}
                className={cn(
                  "rounded-md border p-3 text-left transition-colors",
                  selected
                    ? "border-[#2563EB]/60 bg-[#2563EB]/[0.06]"
                    : "border-[#e3e5e9] bg-white hover:border-[#c3c8cf]",
                )}
              >
                <span
                  className={cn(
                    "block text-sm font-medium",
                    selected ? "text-[#2563EB]" : "text-[#121418]",
                  )}
                >
                  {m.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-[#6b7280]">
                  {m.caption}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Система */}
      <section className="gx-card p-5 sm:p-6" aria-labelledby="settings-system">
        <h2 id="settings-system" className="gx-label-card mb-4">
          Система
        </h2>
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3 border-b border-[#e3e5e9] pb-3">
            <dt className="flex items-center gap-2.5 text-[#374151]">
              <ShieldCheck className="size-4 text-[#6b7280]" aria-hidden />
              Языковая модель
            </dt>
            <dd className="text-right">
              {llm ? (
                <>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 font-medium text-[#121418]",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        llm.ready ? "bg-[#10b981]" : "bg-[#ef4444]",
                      )}
                    />
                    {llm.backendLabel || llm.backend}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-[#6b7280]">
                    {llm.model}
                    {!llm.ready && llm.error ? ` · ${llm.error}` : ""}
                  </span>
                </>
              ) : (
                <span className="text-[#6b7280]">…</span>
              )}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-[#e3e5e9] pb-3">
            <dt className="flex items-center gap-2.5 text-[#374151]">
              <Database className="size-4 text-[#6b7280]" aria-hidden />
              База данных
            </dt>
            <dd className="text-right">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#121418]">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    db ? (db.ready ? "bg-[#10b981]" : "bg-[#ef4444]") : "bg-[#9ca3af]",
                  )}
                />
                {db ? (db.ready ? "готова" : "недоступна") : "…"}
              </span>
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2.5 text-[#374151]">
              <HardDrive className="size-4 text-[#6b7280]" aria-hidden />
              Доверенные источники
            </dt>
            <dd className="font-medium text-[#121418]">
              {health ? health.config.trustedSourcesCount : "…"}
            </dd>
          </div>
        </dl>
      </section>

      {/* Данные */}
      <section className="gx-card p-5 sm:p-6" aria-labelledby="settings-data">
        <h2 id="settings-data" className="gx-label-card mb-4">
          Данные
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-relaxed text-[#6b7280]">
            История проверок хранится локально в базе данных этого экземпляра.
            {historyCount !== null && historyCount > 0 && (
              <> Сейчас записей: {historyCount}.</>
            )}
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-[#dc2626]">
                Удалить все записи?
              </span>
              <button
                type="button"
                onClick={() => void clear()}
                disabled={clearing}
                className="flex h-9 items-center gap-2 rounded-md border border-[#ef4444]/50 bg-[#ef4444]/10 px-4 text-xs font-medium text-[#dc2626] transition-colors hover:bg-[#ef4444]/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {clearing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {clearing ? "Удаление…" : "Да, удалить всё"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={clearing}
                className="flex h-9 items-center rounded-md border border-[#e3e5e9] px-4 text-xs font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Отмена
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!historyCount}
              className="flex h-9 items-center gap-2 rounded-md border border-[#ef4444]/40 px-4 text-xs font-medium text-[#dc2626] transition-colors hover:bg-[#ef4444]/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Очистить историю
            </button>
          )}
        </div>
      </section>

      {/* Аккаунт */}
      <section className="gx-card p-5 sm:p-6" aria-labelledby="settings-account">
        <h2 id="settings-account" className="gx-label-card mb-4">
          Аккаунт
        </h2>
        {currentUser ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm text-[#374151]">
              {currentUser.role === "admin" ? (
                <ShieldCheck className="size-4 text-[#2563EB]" aria-hidden />
              ) : (
                <UserRound className="size-4 text-[#6b7280]" aria-hidden />
              )}
              <div>
                <p className="font-medium text-[#121418]">{currentUser.username}</p>
                <p className="text-[11px] text-[#6b7280]">
                  {currentUser.role === "admin"
                    ? "Администратор — полный доступ ко всем проверкам и управлению пользователями"
                    : "Пользователь — доступ к своим проверкам"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              className="flex h-9 items-center gap-2 rounded-md border border-[#e3e5e9] px-4 text-xs font-medium text-[#374151] transition-colors hover:bg-[#f4f5f7] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {signingOut ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <LogOut className="size-3.5" aria-hidden />
              )}
              {signingOut ? "Выход…" : "Выйти"}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-[#6b7280]">
            <UserRound className="size-4" aria-hidden />
            <p>Не авторизован. Войдите через страницу /login.</p>
          </div>
        )}
      </section>
    </div>
  );
}
