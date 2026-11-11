"use client";

/**
 * Фактум — composition root of the single-route application.
 *
 * The app shell (topbar + sidebar + workspace) is constant; the workspace
 * content swaps between four views (home / check / history / settings) via
 * client state. The live SSE stream lives here so navigating between views
 * never interrupts a running analysis.
 */

import { useCallback, useEffect, useState } from "react";
import { AppShell, type AppView } from "@/components/shell/AppShell";
import { NewCheckCard } from "@/components/workspace/NewCheckCard";
import { SourcesEvidence } from "@/components/workspace/SourcesEvidence";
import { RecentChecks } from "@/components/workspace/RecentChecks";
import { CheckScreen } from "@/components/workspace/CheckScreen";
import { HistoryView } from "@/components/workspace/HistoryView";
import { SettingsView } from "@/components/workspace/SettingsView";
import { AdminView } from "@/components/workspace/AdminView";
import { ChatPanel } from "@/components/factcheck/ChatPanel";
import { useFactcheckStream } from "@/components/factcheck/useFactcheckStream";
import {
  VERDICT_LABELS_RU,
  type AnalysisMode,
  type AnalysisResult,
  type HealthInfo,
  type PublicUser,
  type SourceUpdateResult,
} from "@/lib/factcheck/types";
import { hostFromUrl } from "@/lib/factcheck/client";
import { fetchCurrentUser } from "@/lib/auth-client";

const LS_DEFAULT_MODE = "factum:default-mode";

export default function Home() {
  const { state, start, abort, reset } = useFactcheckStream();

  const [view, setView] = useState<AppView>("home");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  /** Current authenticated user (null while loading or not logged in). */
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  /** When non-null, we're displaying a history-loaded result rather than the live stream. */
  const [loadedFromHistory, setLoadedFromHistory] = useState<AnalysisResult | null>(null);
  /** Fullscreen chat (stays mounted; conversation survives closing). */
  const [chatOpen, setChatOpen] = useState(false);
  /** Default check mode (persisted, controlled from Settings). */
  const [defaultMode, setDefaultMode] = useState<AnalysisMode>("RESEARCH");
  /** Total history rows (for the Settings "Данные" block). */
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  /** Full result of the most recent past check — the home "Источники и
   *  доказательства" fallback when nothing is active in this session. */
  const [lastHistoryResult, setLastHistoryResult] = useState<AnalysisResult | null>(null);

  // Restore the default mode preference.
  useEffect(() => {
    try {
      const v = localStorage.getItem(LS_DEFAULT_MODE);
      if (v === "CONTROLLED" || v === "RESEARCH") setDefaultMode(v);
    } catch {
      /* private mode — keep RESEARCH */
    }
  }, []);

  // Fetch /api/health once on mount — also gives us the current user.
  // Handles non-200 responses gracefully — without this, parsing a 401 JSON
  // error body as HealthInfo would set bogus state.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<HealthInfo>;
      })
      .then((data: HealthInfo | null) => {
        if (cancelled) return;
        if (data) {
          setHealth(data);
          setCurrentUser(data.auth?.user ?? null);
        }
      })
      .catch(() => {
        // ignore — the sidebar status degrades to "…"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Also fetch /api/me as a backup (in case /api/health was called before
  // login completed). This runs on every historyRefreshKey change.
  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser().then((u) => {
      if (!cancelled && u) setCurrentUser(u);
    });
    return () => {
      cancelled = true;
    };
  }, [historyRefreshKey]);

  // Track the total history size (for Settings).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/history")
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ projects?: unknown[] } | unknown[]>;
      })
      .then((data: ({ projects?: unknown[] } | unknown[]) | null) => {
        if (cancelled || !data) return;
        const count = Array.isArray(data) ? data.length : (data?.projects?.length ?? 0);
        setHistoryCount(count);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, [historyRefreshKey]);

  // Fetch the full result of the most recent past check — used as the home
  // "Источники и доказательства" fallback when no check is active in-session.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/history")
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{ projects?: { id: string }[] } | { id: string }[]>;
      })
      .then(async (data: ({ projects?: { id: string }[] } | { id: string }[]) | null) => {
        if (cancelled || !data) return;
        const list = Array.isArray(data) ? data : (data?.projects ?? []);
        if (list.length === 0) {
          setLastHistoryResult(null);
          return;
        }
        try {
          const full = await fetch(`/api/history/${list[0].id}`).then((r) => r.json());
          if (!cancelled) setLastHistoryResult(full as AnalysisResult);
        } catch {
          /* keep previous */
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [historyRefreshKey]);

  /** The analysis currently on screen (drives the chat header + suggestions). */
  const activeResult: AnalysisResult | null = loadedFromHistory
    ? loadedFromHistory
    : state.report
      ? {
          projectId: state.projectId ?? "",
          url: state.url ?? "",
          mode: state.mode ?? "CONTROLLED",
          modelInfo: "",
          createdAt: "",
          status: "completed",
          revision: 0,
          document:
            state.document ?? { url: state.url ?? "", excerpt: "", contentNature: "INFORMATION" },
          claims: state.claims,
          sources: state.sources,
          evidence: state.evidence,
          verdicts: state.verdicts,
          report: state.report,
        }
      : null;

  const handleSubmit = useCallback(
    async (input: { url?: string; text?: string }, mode: AnalysisMode) => {
      setLoadedFromHistory(null);
      setView("check");
      // start() resolves when the SSE stream ends (success, error, or abort).
      await start(input, mode);
      setHistoryRefreshKey((k) => k + 1);
    },
    [start],
  );

  /** "Новая проверка" — back to the home card with a clean state. */
  const handleReset = useCallback(() => {
    setLoadedFromHistory(null);
    reset();
    setView("home");
  }, [reset]);

  /** "К панели" — back home; a running stream keeps going in the background. */
  const handleBack = useCallback(() => {
    setView("home");
  }, []);

  const selectFromHistory = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/history/${id}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: AnalysisResult = await r.json();
        setLoadedFromHistory(data);
        reset();
        setView("check");
      } catch {
        // The row stays; the user can retry.
      }
    },
    [reset],
  );

  const openChat = useCallback(() => {
    setChatOpen(true);
  }, []);

  /** After a user-submitted source recalculated the verdicts — swap in the fresh result. */
  const handleSourceAdded = useCallback(
    (payload: SourceUpdateResult) => {
      setLoadedFromHistory(payload.result);
      // keep the stale live-stream report from re-rendering
      reset();
      setHistoryRefreshKey((k) => k + 1);
    },
    [reset],
  );

  const changeDefaultMode = useCallback((m: AnalysisMode) => {
    setDefaultMode(m);
    try {
      localStorage.setItem(LS_DEFAULT_MODE, m);
    } catch {
      /* ignore */
    }
  }, []);

  /** Settings → clear ALL local history (single bulk DELETE on /api/history). */
  const clearHistory = useCallback(async () => {
    try {
      // Single bulk endpoint — replaces the previous N-parallel-DELETEs loop.
      // Server-side transaction + cascade deletes clean every child table
      // (Document, Claim, Source, Evidence, Verdict, VerdictVersion, Report,
      // AuditEvent) in one round-trip. Running projects are protected.
      await fetch("/api/history", { method: "DELETE" });
    } catch {
      // Best effort — a reload reconciles whatever remains.
    } finally {
      setHistoryRefreshKey((k) => k + 1);
    }
  }, []);

  return (
    <AppShell
      view={view}
      onNavigate={setView}
      health={health}
      currentUser={currentUser}
      onOpenChat={openChat}
    >
      {view === "home" && (
        <div className="space-y-6 pb-2">
          {/* Live strip — visible when a check runs in the background */}
          {state.running && (
            <button
              type="button"
              onClick={() => setView("check")}
              className="flex w-full items-center gap-3 rounded-md border border-[#2563EB]/40 bg-[#2563EB]/[0.08] px-4 py-3 text-left transition-colors hover:bg-[#2563EB]/[0.14]"
            >
              <span className="gx-spinner" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-[#c3c8cf]">
                Идёт проверка
                {state.url ? ` · ${hostFromUrl(state.url)}` : ""}
              </span>
              <span className="shrink-0 text-xs font-medium text-[#93c5fd]">открыть →</span>
            </button>
          )}

          <NewCheckCard
            running={state.running}
            defaultMode={defaultMode}
            onSubmit={handleSubmit}
            onAbort={abort}
          />

          <SourcesEvidence
            sources={
              activeResult?.sources
                ?? (state.running ? state.sources : null)
                ?? lastHistoryResult?.sources
                ?? null
            }
            hasCheck={!!activeResult || state.running || !!lastHistoryResult}
            isRunning={state.running}
            resultHost={
              activeResult
                ? hostFromUrl(activeResult.url)
                : state.url
                  ? hostFromUrl(state.url)
                  : lastHistoryResult
                    ? hostFromUrl(lastHistoryResult.url)
                    : null
            }
          />

          <RecentChecks
            refreshKey={historyRefreshKey}
            onSelect={(id) => void selectFromHistory(id)}
            onViewAll={() => setView("history")}
          />
        </div>
      )}

      {view === "check" && (
        <CheckScreen
          stream={state}
          loaded={loadedFromHistory}
          onBack={handleBack}
          onReset={handleReset}
          onOpenChat={openChat}
          onSourceAdded={handleSourceAdded}
          onAbort={abort}
        />
      )}

      {view === "history" && (
        <HistoryView refreshKey={historyRefreshKey} onSelect={(id) => void selectFromHistory(id)} />
      )}

      {view === "settings" && (
        <SettingsView
          health={health}
          defaultMode={defaultMode}
          onChangeDefaultMode={changeDefaultMode}
          historyCount={historyCount}
          onClearHistory={clearHistory}
        />
      )}

      {view === "admin" && currentUser?.role === "admin" && <AdminView />}

      {/* Fullscreen chat — context mode when an analysis is active, general otherwise */}
      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        projectId={activeResult?.projectId || null}
        title={activeResult?.document.title || activeResult?.url}
        overallLabelRu={
          activeResult?.report
            ? VERDICT_LABELS_RU[activeResult.report.overall_verdict]
            : undefined
        }
      />
    </AppShell>
  );
}
