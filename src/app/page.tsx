"use client";

import { useCallback, useEffect, useState } from "react";
import { HeroSection } from "@/components/factcheck/HeroSection";
import { InputPanel, type HealthInfo } from "@/components/factcheck/InputPanel";
import { ProgressPanel } from "@/components/factcheck/ProgressPanel";
import { ReportPanel } from "@/components/factcheck/ReportPanel";
import { HistoryPanel } from "@/components/factcheck/HistoryPanel";
import {
  useFactcheckStream,
  type StreamState,
} from "@/components/factcheck/useFactcheckStream";
import type { AnalysisResult } from "@/lib/factcheck/types";

/**
 * Single-page composition root for the medical fact-checker.
 * Root wrapper uses `min-h-screen flex flex-col` so the footer sticks to
 * the bottom on short content and is pushed down naturally on long content.
 */
export default function Home() {
  const { state, start, abort, reset } = useFactcheckStream();
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  /** When non-null, we're displaying a history-loaded result rather than a live stream. */
  const [loadedFromHistory, setLoadedFromHistory] = useState<AnalysisResult | null>(null);

  // Fetch /api/health once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthInfo) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (url: string, mode: "CONTROLLED" | "RESEARCH") => {
      setLoadedFromHistory(null);
      // start() resolves when the SSE stream ends (success, error, or abort).
      // After it resolves, refresh the history list once.
      await start(url, mode);
      setHistoryRefreshKey((k) => k + 1);
    },
    [start],
  );

  const handleReset = useCallback(() => {
    setLoadedFromHistory(null);
    reset();
  }, [reset]);

  const handleSelectFromHistory = useCallback((item: AnalysisResult) => {
    setLoadedFromHistory(item);
    reset();
    // Smooth-scroll to the workspace so the user sees the loaded report.
    const el = document.getElementById("workspace");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reset]);

  // Decide what to render on the right panel.
  const rightPanel = loadedFromHistory ? (
    <ReportPanel
      report={loadedFromHistory.report}
      claims={loadedFromHistory.claims}
      verdicts={loadedFromHistory.verdicts}
      sources={loadedFromHistory.sources}
      evidence={loadedFromHistory.evidence}
      document={loadedFromHistory.document}
      projectId={loadedFromHistory.projectId}
      onReset={handleReset}
    />
  ) : state.running || state.completed || state.error || state.report ? (
    <RightPanelFromStream state={state} onReset={handleReset} />
  ) : (
    <IdlePanel />
  );

  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Background layers */}
      <div className="gx-kv" aria-hidden />
      <div className="gx-kv-veil" aria-hidden />

      {/* Hero */}
      <HeroSection />

      {/* Workspace */}
      <main
        id="workspace"
        className="relative z-10 mx-auto w-full max-w-6xl flex-1 scroll-mt-4 px-4 pb-16 sm:px-8"
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:items-start">
          {/* Left input panel — sticky on desktop */}
          <div className="lg:sticky lg:top-6">
            <InputPanel
              running={state.running}
              onSubmit={handleSubmit}
              onAbort={abort}
            />
          </div>

          {/* Right results panel */}
          <div className="min-w-0">{rightPanel}</div>
        </div>

        {/* History panel (full width below) */}
        <div className="mt-5">
          <HistoryPanel
            onSelect={handleSelectFromHistory}
            refreshKey={historyRefreshKey}
          />
        </div>
      </main>

      {/* Sticky footer */}
      <Footer health={health} />
    </div>
  );
}

/** Right panel rendering logic when we're showing the live stream (no history load). */
function RightPanelFromStream({
  state,
  onReset,
}: {
  state: StreamState;
  onReset: () => void;
}) {
  // Error takes priority.
  if (state.error && !state.report) {
    return (
      <section className="gx-panel relative z-10 p-5 sm:p-6">
        <header className="mb-4 flex items-center gap-3">
          <h2 className="gx-display text-sm tracking-wider text-[#f4f6f7] sm:text-base">
            Не удалось проверить
          </h2>
        </header>
        <p className="text-sm leading-relaxed text-[#dadee1]">{state.error}</p>
        <button
          type="button"
          onClick={onReset}
          className="mt-4 inline-flex h-9 items-center rounded-sm border border-[rgba(218,222,225,0.25)] px-4 text-xs text-[#dadee1] hover:bg-[rgba(218,222,225,0.08)]"
        >
          Новая проверка
        </button>
      </section>
    );
  }

  // Final report.
  if (state.report) {
    return (
      <ReportPanel
        report={state.report}
        claims={state.claims}
        verdicts={state.verdicts}
        sources={state.sources}
        evidence={state.evidence}
        document={state.document}
        projectId={state.projectId}
        onReset={onReset}
      />
    );
  }

  // Running.
  return <ProgressPanel state={state} />;
}

function IdlePanel() {
  return (
    <section className="gx-panel gx-rise-delay relative z-10 flex min-h-[320px] flex-col items-center justify-center p-8 text-center sm:p-12">
      <h2 className="gx-display mb-2 text-sm tracking-wider text-[#8a9aa6]">
        Готов к проверке
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-[#8a9aa6]">
        Вставьте URL материала о здоровье и запустите проверку. Система выделит
        утверждения, найдёт научные источники и сформирует отчёт по каждому из них.
      </p>
    </section>
  );
}

function Footer({ health }: { health: HealthInfo | null }) {
  return (
    <footer className="relative z-10 mt-auto border-t border-[rgba(218,222,225,0.1)] bg-[rgba(7,9,11,0.7)] px-4 py-5 backdrop-blur-md sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <p className="max-w-xl text-[11px] leading-snug text-[#8a9aa6]">
            Система верификации информации, а не диагностический инструмент. Не ставит
            диагнозов и не назначает лечение.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[#4e6676]">
          {health && (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={
                  "inline-block size-1.5 rounded-full " +
                  (health.llm.ready ? "bg-[#2ec4b6]" : "bg-[#8a9aa6]")
                }
              />
              {health.llm.backendLabel || health.llm.backend}
            </span>
          )}
          <span>Фактум · {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}
