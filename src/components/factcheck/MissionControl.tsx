"use client";

/**
 * «Mission Control» — инженерная панель хода проверки (SpaceX-стиль, светлая
 * карточка). 9 фаз конвейера, живая телеметрия, часы T+, журнал событий.
 *
 * Заменяет ProgressPanel. Показывает только названия стадий, статусы и
 * короткие строки прогресса — без внутренних промптов, JSON и идентификаторов.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { PipelineStage } from "@/lib/factcheck/types";
import {
  formatDuration,
  formatTplus,
  type StreamState,
} from "./useFactcheckStream";

interface MissionControlProps {
  state: StreamState;
  /** Показывается, пока идёт прогон (живой или демо). */
  onAbort?: () => void;
  /** «Повторить» — перезапуск с тем же URL/mode. Доступна после сбоя. */
  onRetry?: () => void;
  /** «На главную» — выйти на стартовый экран. Доступна после сбоя. */
  onHome?: () => void;
}

/** 9 фаз миссии — группы сырых стадий конвейера. */
const PHASES: { id: string; num: string; label: string; stages: PipelineStage[] }[] = [
  { id: "validation", num: "01", label: "Валидация запроса", stages: ["validating_url"] },
  {
    id: "material",
    num: "02",
    label: "Получение материала",
    stages: ["fetching_material", "extracting_text"],
  },
  { id: "claims", num: "03", label: "Извлечение утверждений", stages: ["extracting_claims"] },
  {
    id: "search",
    num: "04",
    label: "Поиск источников",
    stages: ["planning_research", "searching_sources"],
  },
  { id: "evaluation", num: "05", label: "Оценка источников", stages: ["evaluating_sources"] },
  { id: "adversarial", num: "06", label: "Поиск контраргументов", stages: ["adversarial_search"] },
  { id: "evidence", num: "07", label: "Извлечение доказательств", stages: ["extracting_evidence"] },
  {
    id: "synthesis",
    num: "08",
    label: "Синтез вердиктов",
    stages: ["synthesising", "calculating_verdict"],
  },
  { id: "report", num: "09", label: "Формирование отчёта", stages: ["generating_report"] },
];

type PhaseStatus = "pending" | "active" | "done" | "skipped" | "failed";

function phaseStatus(state: StreamState, stages: PipelineStage[]): PhaseStatus {
  const statuses = stages.map((s) => state.stages[s]);
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "active")) return "active";
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.every((s) => s === "skipped" || s === "done")) return "skipped";
  return "pending";
}

/** Последняя осмысленная строка детали среди стадий фазы. */
function phaseDetail(state: StreamState, stages: PipelineStage[]): string | undefined {
  for (const s of stages) {
    const d = state.stageDetails[s];
    if (d && d.trim().length > 0) return d;
  }
  return undefined;
}

/**
 * Fallback-строка для активной фазы без detail — чтобы панель «дышала»
 * и не показывала пустоту на длинных LLM-стадиях (40–120 сек).
 * Привязана к фазе, не к внутренней стадии.
 */
const ACTIVE_FALLBACK: Record<string, string> = {
  validation: "Проверка URL и доступности материала",
  material: "Загрузка и разбор материала",
  claims: "Модель выделяет проверяемые утверждения…",
  search: "Поиск научных источников по запросам",
  evaluation: "Оценка доверенности и релевантности",
  adversarial: "Поиск контраргументов и альтернативных данных",
  evidence: "Извлечение фрагментов доказательств из источников",
  synthesis: "Сопоставление утверждений с доказательствами",
  report: "Формирование итогового отчёта",
};

function fallbackForPhase(phaseId: string): string {
  return ACTIVE_FALLBACK[phaseId] ?? "Ожидание ответа модели…";
}

/**
 * Человекочитаемые сообщения по фазе сбоя — что именно пошло не так и что
 * делать пользователю. Заменяет общий текст «часть данных может отсутствовать».
 */
const FAILURE_HINTS: Record<string, { title: string; hint: string }> = {
  validation: {
    title: "Не удалось проверить URL",
    hint: "Ссылка недоступна, не является медицинской статьёй или отклонена фильтром безопасности. Проверьте URL и повторите.",
  },
  material: {
    title: "Не удалось получить материал",
    hint: "Сайт не ответил за отведённое время или заблокировал загрузку. Попробуйте другую ссылку или повторите через минуту.",
  },
  claims: {
    title: "Сбой при извлечении утверждений",
    hint: "Модель не смогла выделить проверяемые тезисы. Возможна нестандартная структура материала. Повторите попытку.",
  },
  search: {
    title: "Сбой поиска источников",
    hint: "Поисковый сервис не ответил или превысил лимит запросов. Повторите — обычно это временно.",
  },
  evaluation: {
    title: "Сбой оценки источников",
    hint: "Не удалось рассчитать оценки качества. Повторите попытку.",
  },
  adversarial: {
    title: "Сбой поиска контраргументов",
    hint: "Этап доступен только в исследовательском режиме. Повторите попытку.",
  },
  evidence: {
    title: "Сбой извлечения доказательств",
    hint: "Модель не сопоставила утверждения с источниками. Повторите попытку.",
  },
  synthesis: {
    title: "Сбой синтеза вердиктов",
    hint: "Не удалось сопоставить доказательства с утверждениями. Повторите попытку.",
  },
  report: {
    title: "Сбой формирования отчёта",
    hint: "Данные собраны, но итоговый отчёт не сформирован. Повторите попытку — обычно данные сохраняются в истории.",
  },
};

function failureHintForPhase(phaseId: string | undefined, errorStage: string | undefined, error: string | undefined): { title: string; hint: string } {
  // Случай «очередь»: глобальный лок пайплайна / сетевая ошибка до старта.
  // Сообщение от orchestrator (про занятость) показываем как основной текст,
  // а не прячем в «технических деталях».
  if (errorStage === "queued" && error) {
    return {
      title: "Проверка не запущена",
      hint: error,
    };
  }
  if (!phaseId) return { title: "Сбой конвейера", hint: "Повторите проверку или откройте отчёт из истории." };
  return FAILURE_HINTS[phaseId] ?? { title: "Сбой конвейера", hint: "Повторите проверку или откройте отчёт из истории." };
}

/**
 * Decide whether the actual backend error message is actionable enough to
 * replace the generic phase hint. If the error mentions HTTP status codes,
 * env var names (LLM_API_KEY, LLM_MODEL, etc.), or specific LLM failure
 * keywords (timeout, rate limit, auth), it carries real diagnostic info the
 * user needs to SEE — hiding it behind "Модель не смогла выделить проверяемые
 * тезисы" is misleading.
 *
 * Returns the actionable message (truncated) or null to keep the generic hint.
 */
function actionableErrorOrNull(error: string | undefined | null): string | null {
  if (!error || typeof error !== "string") return null;
  const e = error.toLowerCase();
  const isActionable =
    /http \d{3}/.test(e) ||                      // HTTP 401/403/404/429/5xx
    /llm_[a-z_]+/.test(e) ||                      // env var names like LLM_API_KEY
    /timeout|таймаут/.test(e) ||                  // timeouts
    /rate limit|лимит запросов|429/.test(e) ||     // rate limits
    /api[- ]?key|api-ключ/.test(e) ||             // API key problems
    /model.*not found|модель.*не найден|404/.test(e) || // model not found
    /connection|соединен|fetch failed/.test(e) ||  // connection errors
    /response_format|json_schema|json_object/.test(e); // response_format issues
  if (!isActionable) return null;
  // Keep the message but cap length so the error block doesn't grow huge.
  const cap = 400;
  return error.length > cap ? error.slice(0, cap).trim() + "…" : error.trim();
}

export function MissionControl({ state, onAbort, onRetry, onHome }: MissionControlProps) {
  const { running, error, startedAt, finishedAt, demo } = state;

  // Живые часы T+: тикаем, пока идёт прогон.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  const now = running ? Date.now() : (finishedAt ?? Date.now());
  const elapsed = startedAt ? now - startedAt : 0;

  const failedPhase = state.errorStage
    ? PHASES.find((p) => p.stages.includes(state.errorStage as PipelineStage))
    : undefined;

  // Журнал: авто-открыт, пока идёт прогон (последние строки видны сразу).
  // Пользователь может закрыть вручную — тогда не открываем принудительно.
  const [logOpen, setLogOpen] = useState(false);
  const [logUserTouched, setLogUserTouched] = useState(false);
  useEffect(() => {
    if (running && !logUserTouched) setLogOpen(true);
    if (!running && !logUserTouched) setLogOpen(false);
  }, [running, logUserTouched]);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el && logOpen) el.scrollTop = el.scrollHeight;
  }, [state.logFeed, logOpen, tick]);

  return (
    <section className="gx-card gx-mc p-5 sm:p-6" aria-labelledby="mc-title">
      {/* ── Заголовок: статус · T+ · режим ─────────────────────────── */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={cn(
              "inline-block size-2 rounded-full",
              running
                ? "bg-[#2563EB] gx-beacon-blue"
                : error
                  ? "bg-[#ef4444]"
                  : "bg-[#10b981]",
            )}
          />
          <h2
            id="mc-title"
            className={cn(
              "gx-display text-sm tracking-[0.12em]",
              running ? "text-[#2563EB]" : error ? "text-[#dc2626]" : "text-[#047857]",
            )}
          >
            {running ? "Выполняется" : error ? "Прервано" : "Завершено"}
          </h2>
          {demo && (
            <span className="rounded-[3px] border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#b45309]">
              Демо
            </span>
          )}
          {state.mode && (
            <span className="hidden rounded-[3px] border border-[#e3e5e9] bg-white px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.14em] text-[#6b7280] sm:inline-block">
              {state.mode === "RESEARCH" ? "Исследовательский режим" : "Контролируемый режим"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {running && onAbort && (
            <button
              type="button"
              onClick={onAbort}
              className="flex h-7 items-center gap-1.5 rounded-[4px] border border-[#ef4444]/40 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[#dc2626] transition-colors hover:bg-[#ef4444]/10"
            >
              <OctagonX className="size-3" aria-hidden />
              Стоп
            </button>
          )}
          <span
            className="font-mono text-xl font-semibold tabular-nums tracking-tight text-[#121418]"
            aria-live="off"
          >
            T+{formatTplus(elapsed)}
          </span>
        </div>
      </header>

      {/* ── Телеметрия ─────────────────────────────────────────────── */}
      <div className="gx-mc-telemetry mb-4 grid grid-cols-4">
        <TelemetryCell label="Утверждения" value={state.claims.length} active={running} />
        <TelemetryCell label="Источники" value={state.sources.length} active={running} />
        <TelemetryCell label="Доказательства" value={state.evidence.length} active={running} />
        <TelemetryCell
          label="Вердикты"
          value={state.verdicts.length > 0 ? state.verdicts.length : null}
          active={running}
        />
      </div>

      {/* ── Таймлайн фаз 01–09 ─────────────────────────────────────── */}
      <ol className="gx-mc-timeline">
        {PHASES.map((phase) => {
          const status = phaseStatus(state, phase.stages);
          const detail = phaseDetail(state, phase.stages);
          const timing = phaseTiming(state, phase.stages);
          const duration = phaseDuration(state, phase.stages, now);
          // Активная фаза без detail показывает fallback, а не пустоту.
          const displayDetail =
            detail ?? (status === "active" ? fallbackForPhase(phase.id) : "");
          return (
            <li
              key={phase.id}
              className={cn(
                "gx-mc-phase",
                status === "active" && "is-active",
                status === "failed" && "is-failed",
                status === "done" && "is-done",
                status === "skipped" && "is-skipped",
              )}
            >
              <span className="gx-mc-num font-mono">{phase.num}</span>
              <PhaseGlyph status={status} />
              <span className="gx-mc-label">
                {phase.label}
                {status === "skipped" && (
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ca3af]">
                    N/A · контролируемый режим
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "gx-mc-detail",
                  status === "active" && !detail && "gx-mc-detail-fallback",
                )}
              >
                {displayDetail}
              </span>
              <span className="gx-mc-dur font-mono tabular-nums">
                {duration !== null ? formatDuration(duration) : "—"}
              </span>
              <span className="gx-mc-tplus font-mono tabular-nums">
                {timing?.startedAt !== undefined && startedAt
                  ? `T+${formatTplus(timing.startedAt - startedAt)}`
                  : ""}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ── Ошибка ─────────────────────────────────────────────────── */}
      {error && (() => {
        const fallback = failureHintForPhase(failedPhase?.id, state.errorStage, error);
        const actionable = actionableErrorOrNull(error);
        // Когда сообщение от backend несёт реальную диагностическую информацию
        // (HTTP 4xx, подсказки про env-переменные, timeout и т. п.), показываем
        // ЕГО как основной текст — общий «Модель не смогла выделить проверяемые
        // тезисы» в этом случае вводит в заблуждение.
        const isQueuedBusy = state.errorStage === "queued";
        // Для queued-ошибок само сообщение уже человекочитаемо — не дублируем
        // его как «технические детали».
        const mainHint = isQueuedBusy ? fallback.hint : (actionable ?? fallback.hint);
        return (
        <div
          role="alert"
          className="mt-4 rounded-[4px] border border-[#ef4444]/45 bg-[#ef4444]/[0.08] px-4 py-3.5"
        >
          <p className="font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-[#dc2626]">
            {fallback.title}
            {failedPhase && (
              <span className="ml-2 font-normal text-[#9ca3af]">
                · фаза {failedPhase.num} {failedPhase.label.toLowerCase()}
              </span>
            )}
          </p>
          <p className="mt-1.5 text-[13px] font-medium leading-snug text-[#1f2937]">
            {mainHint}
          </p>
          {/* Показываем сырой текст ошибки только если он ещё не стал основной
              подсказкой (избегаем дублирования). */}
          {!actionable && !isQueuedBusy && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#6b7280]">
              <span className="text-[#9ca3af]">Технические детали: </span>
              {error}
            </p>
          )}
          {/* Кнопки всегда на виду — даже если сбой произошёл на середине */}
          {(onRetry || onHome) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex h-8 items-center gap-1.5 rounded-[4px] bg-[#2563EB] px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-[#1d4ed8]"
                >
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v3.5H6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Повторить проверку
                </button>
              )}
              {onHome && (
                <button
                  type="button"
                  onClick={onHome}
                  className="flex h-8 items-center rounded-[4px] border border-[#e3e5e9] bg-white px-3.5 text-[12px] font-medium text-[#374151] transition-colors hover:border-[#2563EB] hover:text-[#2563EB]"
                >
                  На главную
                </button>
              )}
            </div>
          )}
        </div>
        );
      })()}

      {/* ── Журнал ─────────────────────────────────────────────────── */}
      <Collapsible
        open={logOpen}
        onOpenChange={(o) => {
          setLogUserTouched(true);
          setLogOpen(o);
        }}
        className="mt-4 border-t border-[#e3e5e9] pt-3"
      >
        <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
          <ChevronDown
            aria-hidden
            className="size-3.5 text-[#6b7280] transition-transform group-data-[state=open]:rotate-180"
          />
          <span className="gx-label-card">Журнал конвейера</span>
          {running && !logUserTouched && (
            <span className="rounded-[3px] border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#2563EB]">
              авто
            </span>
          )}
          <span className="ml-auto font-mono text-[11px] text-[#9ca3af]">
            {state.logFeed.length} записей
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            ref={logRef}
            className="gx-scroll-light mt-2 max-h-44 overflow-y-auto rounded-[4px] border border-[#e3e5e9] bg-white px-3 py-2"
          >
            {state.logFeed.length === 0 ? (
              <p className="font-mono text-[11px] text-[#9ca3af]">— пусто —</p>
            ) : (
              state.logFeed.map((entry, i) => (
                <p key={i} className="font-mono text-[12px] leading-relaxed">
                  <span className="text-[#c3c8cf]">
                    {startedAt ? formatTplus(entry.at - startedAt) : "--:--"}
                  </span>{" "}
                  <span
                    className={cn(
                      entry.level === "error"
                        ? "text-[#dc2626]"
                        : entry.level === "warn"
                          ? "text-[#b45309]"
                          : "text-[#6b7280]",
                    )}
                  >
                    {entry.message}
                  </span>
                </p>
              ))
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Вспомогательные компоненты и функции                                */
/* ------------------------------------------------------------------ */

function TelemetryCell({
  label,
  value,
  active,
}: {
  label: string;
  value: number | null;
  active: boolean;
}) {
  return (
    <div className="gx-mc-cell">
      <span
        className={cn(
          "font-mono text-2xl font-semibold tabular-nums leading-none",
          value === null ? "text-[#c3c8cf]" : "text-[#121418]",
        )}
        aria-live="polite"
      >
        {value === null ? "··" : value}
      </span>
      <span
        className={cn(
          "font-mono text-[11px] uppercase tracking-[0.14em]",
          active && value === 0 ? "text-[#2563EB]" : "text-[#9ca3af]",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function PhaseGlyph({ status }: { status: PhaseStatus }) {
  if (status === "done") {
    return (
      <span aria-hidden className="gx-mc-glyph text-[#10b981]">
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return <span aria-hidden className="gx-mc-glyph"><span className="gx-spinner !size-3" /></span>;
  }
  if (status === "failed") {
    return (
      <span aria-hidden className="gx-mc-glyph text-[#ef4444]">
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span aria-hidden className="gx-mc-glyph text-[#c3c8cf]">
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M4 8h8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <span aria-hidden className="gx-mc-glyph"><span className="gx-mc-dot" /></span>;
}

function phaseTiming(state: StreamState, stages: PipelineStage[]) {
  const starts = stages
    .map((s) => state.stageTiming[s]?.startedAt)
    .filter((x): x is number => x !== undefined);
  const ends = stages
    .map((s) => state.stageTiming[s]?.endedAt)
    .filter((x): x is number => x !== undefined);
  if (starts.length === 0) return null;
  return {
    startedAt: Math.min(...starts),
    endedAt: ends.length > 0 ? Math.max(...ends) : undefined,
  };
}

/** Длительность фазы: завершённая, текущая (тикающая) или null. */
function phaseDuration(
  state: StreamState,
  stages: PipelineStage[],
  now: number,
): number | null {
  const t = phaseTiming(state, stages);
  if (!t) return null;
  const statuses = stages.map((s) => state.stages[s]);
  const isActive = statuses.some((s) => s === "active");
  if (isActive) return now - t.startedAt;
  if (t.endedAt !== undefined) return t.endedAt - t.startedAt;
  return null;
}
