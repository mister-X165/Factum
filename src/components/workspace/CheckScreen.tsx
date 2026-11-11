"use client";

/**
 * Экран проверки — PART of the workspace (not a separate landing).
 * Same shell, the workspace content swaps to: back link + material meta +
 * Mission Control (while running) or the Verdict Dashboard (when finished).
 */

import { ArrowLeft, Sparkles } from "lucide-react";
import { type SourceUpdateResult } from "@/lib/factcheck/types";
import { hostFromUrl, isInlineText, truncate } from "@/lib/factcheck/client";
import type { AnalysisResult } from "@/lib/factcheck/types";
import { MissionControl } from "@/components/factcheck/MissionControl";
import { VerdictDashboard } from "@/components/factcheck/VerdictDashboard";
import type { StreamState } from "@/components/factcheck/useFactcheckStream";

interface CheckScreenProps {
  /** Live SSE stream state (running / just finished / failed). */
  stream: StreamState;
  /** Full result loaded from history (takes priority over the stream). */
  loaded: AnalysisResult | null;
  onBack: () => void;
  onReset: () => void;
  onOpenChat: () => void;
  onSourceAdded: (payload: SourceUpdateResult) => void;
  /** Abort the in-flight run (live or demo). */
  onAbort: () => void;
}

/** Иконка вставленного текста (минимальная, без импорта lucide). */
function FileTextIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3 2h7l3 3v9H3V2z" strokeLinejoin="round" />
      <path d="M6 7h4M6 10h4" strokeLinecap="round" />
    </svg>
  );
}

export function CheckScreen({
  stream,
  loaded,
  onBack,
  onReset,
  onOpenChat,
  onSourceAdded,
  onAbort,
}: CheckScreenProps) {
  const running = !loaded && stream.running;
  const failed = !loaded && Boolean(stream.error) && !stream.report;

  // The analysis shown: history load > live report > (running/failed → none).
  const active: AnalysisResult | null = loaded
    ? loaded
    : stream.report
      ? {
          projectId: stream.projectId ?? "",
          url: stream.url ?? "",
          mode: stream.mode ?? "CONTROLLED",
          modelInfo: "",
          createdAt: "",
          status: "completed",
          revision: 0,
          document:
            stream.document ?? {
              url: stream.url ?? "",
              excerpt: "",
              contentNature: "INFORMATION",
            },
          claims: stream.claims,
          sources: stream.sources,
          evidence: stream.evidence,
          verdicts: stream.verdicts,
          report: stream.report,
        }
      : null;

  // When a history result is loaded, a background live stream must not
  // override it — the loaded report wins until the user starts a new check.
  const materialUrl = loaded?.url ?? stream.url ?? "";
  const materialTitle = active?.document.title;
  const mode = loaded?.mode ?? stream.mode;
  const projectId = active?.projectId || null;
  // Вставленный фрагмент текста: вместо ссылки показываем понятную подпись.
  const isText = stream.textInput === true || isInlineText(materialUrl);

  return (
    <div className="space-y-4 pb-2">
      {/* Back row + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-[#9ca3af] transition-colors hover:text-[#f4f5f7]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          К панели
        </button>

        <div className="flex items-center gap-2">
          {projectId && (
            <button
              type="button"
              onClick={onOpenChat}
              className="flex h-9 items-center gap-2 rounded-[4px] border border-[#2563EB]/45 bg-[#2563EB]/10 px-3.5 text-xs font-medium text-[#93c5fd] transition-colors hover:bg-[#2563EB]/20 hover:text-[#bfdbfe]"
            >
              <Sparkles className="size-3.5" aria-hidden />
              Спросить ИИ
            </button>
          )}
          {active && (
            <button
              type="button"
              onClick={onReset}
              className="flex h-9 items-center rounded-[4px] border border-white/15 px-3.5 text-xs text-[#c3c8cf] transition-colors hover:bg-white/[0.06] hover:text-[#f4f5f7]"
            >
              Новая проверка
            </button>
          )}
        </div>
      </div>

      {/* Material meta line — намеренно вторична: при finished не дублирует Hero. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#9ca3af]">
        {running && (
          <span className="flex items-center gap-2 font-medium text-[#c3c8cf]">
            <span className="gx-spinner" aria-hidden />
            Идёт проверка
            {stream.demo && (
              <span className="rounded-[3px] border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#fbbf24]">
                Демо
              </span>
            )}
          </span>
        )}
        {active && !running && (
          <span className="text-[#9ca3af]">Результат проверки</span>
        )}
        {failed && <span className="font-medium text-[#f87171]">Проверка не завершена</span>}
        {materialUrl && (
          <span className="min-w-0">
            {isText ? (
              <span className="flex items-center gap-1.5 text-[#c3c8cf]" title="Проверяется вставленный фрагмент текста">
                <FileTextIcon />
                Вставленный фрагмент текста
                {active?.document?.excerpt ? (
                  <span className="opacity-60">· «{truncate(active.document.excerpt, 48)}…»</span>
                ) : null}
              </span>
            ) : (
              <a
                href={materialUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c3c8cf] hover:text-[#f4f5f7] hover:underline"
                title={materialUrl}
              >
                {materialTitle ? `«${truncate(materialTitle, 64)}»` : hostFromUrl(materialUrl)}
              </a>
            )}
            {!isText && (
              <span className="ml-2 opacity-60">{hostFromUrl(materialUrl)}</span>
            )}
          </span>
        )}
        {mode && (
          <span className="opacity-60">
            · {mode === "RESEARCH" ? "исследовательский" : "контролируемый"}
          </span>
        )}
        {active && active.claims.length > 0 && (
          <span className="opacity-60">· {active.claims.length} утверждений</span>
        )}
        {loaded && loaded.revision > 0 && (
          <span className="opacity-60">· редакция {loaded.revision + 1}</span>
        )}
        {projectId && !projectId.startsWith("demo-") && (
          <span className="opacity-60" title="Идентификатор проекта">
            · #{truncate(projectId, 10)}
          </span>
        )}
      </div>

      {/* Content */}
      {running || (failed && !stream.report) ? (
        <MissionControl
          state={stream}
          onAbort={onAbort}
          onRetry={failed && stream.url ? () => onReset() : undefined}
          onHome={failed ? onBack : undefined}
        />
      ) : active ? (
        <VerdictDashboard
          result={active}
          demo={stream.demo}
          onSourceAdded={onSourceAdded}
        />
      ) : (
        <div className="gx-card p-6 text-center">
          <p className="text-sm text-[#6b7280]">
            Нет активной проверки. Запустите новую с главного экрана.
          </p>
          <button
            type="button"
            onClick={onBack}
            className="mt-3 inline-flex h-9 items-center rounded-[4px] border border-[#e3e5e9] bg-white px-4 text-xs font-medium text-[#121418] transition-colors hover:border-[#2563EB] hover:text-[#2563EB]"
          >
            На главный экран
          </button>
        </div>
      )}
    </div>
  );
}
