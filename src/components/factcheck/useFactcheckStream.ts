"use client";

/**
 * Client-side hook that consumes the SSE stream from POST /api/analyze.
 *
 * The backend streams events of type PipelineEvent (see types.ts). We read
 * the response body with getReader(), decode UTF-8 chunks, split on `\n\n`
 * (SSE event boundary), and parse each `data: <json>` line.
 *
 * The pure module-level reducer `reduceStreamEvent` is shared by the live
 * SSE reader and the demo runner (see lib/factcheck/demo.ts) so a scripted
 * demo renders exactly like a real run.
 */

import { useCallback, useRef, useState } from "react";
import type {
  AnalysisMode,
  Claim,
  Evidence,
  PipelineEvent,
  PipelineStage,
  Report,
  Source,
  StageStatus,
  Verdict,
  ContentNature,
} from "@/lib/factcheck/types";

/** One line of the collapsible log feed (capped at LOG_FEED_CAP entries). */
export interface LogFeedEntry {
  level: "info" | "warn" | "error";
  message: string;
  /** ms timestamp — used for the T+ prefix. */
  at: number;
}

/** When a stage started / finished (ms timestamps). */
export interface StageTiming {
  startedAt?: number;
  endedAt?: number;
}

export const LOG_FEED_CAP = 40;

export interface StreamState {
  /** Whether a stream is currently active. */
  running: boolean;
  /** Stage statuses keyed by stage id. */
  stages: Record<PipelineStage, StageStatus>;
  /** Latest detail line per stage (e.g. «5 claims», «12 источников»). */
  stageDetails: Partial<Record<PipelineStage, string>>;
  /** Start/end timestamps per stage — powers durations and T+ read-outs. */
  stageTiming: Record<PipelineStage, StageTiming>;
  /** Rolling log feed (newest last, capped at LOG_FEED_CAP). */
  logFeed: LogFeedEntry[];
  /** Run start (ms) — the T+ zero point. */
  startedAt?: number;
  /** Run end (ms) — set by `done` or a fatal error. */
  finishedAt?: number;
  /** All claims streamed so far. */
  claims: Claim[];
  /** All sources streamed so far. */
  sources: Source[];
  /** All evidence items streamed so far. */
  evidence: Evidence[];
  /** Final report (set when the `report` event arrives). */
  report?: Report;
  /** Final verdicts (set with the report event). */
  verdicts: Verdict[];
  /** Document metadata. */
  document?: {
    url: string;
    title?: string;
    excerpt: string;
    contentNature: ContentNature;
  };
  /** ProjectId from the `done` event. */
  projectId?: string;
  /** Fatal error message, if any. */
  error?: string;
  /** Stage at which a fatal error occurred. */
  errorStage?: PipelineStage;
  /** True after `done` event arrives. */
  completed: boolean;
  /** Mode of the current/last analysis. */
  mode?: AnalysisMode;
  /** URL of the current/last analysis. */
  url?: string;
  /** True — проверяется вставленный фрагмент текста, а не URL. */
  textInput?: boolean;
  /** True when the current run is a scripted demo (no backend calls). */
  demo?: boolean;
  /** Demo scenario id (when demo === true). */
  demoId?: string;
}

const INITIAL_STAGES: Record<PipelineStage, StageStatus> = {
  queued: "pending",
  validating_url: "pending",
  fetching_material: "pending",
  extracting_text: "pending",
  extracting_claims: "pending",
  planning_research: "pending",
  searching_sources: "pending",
  evaluating_sources: "pending",
  extracting_evidence: "pending",
  adversarial_search: "pending",
  synthesising: "pending",
  calculating_verdict: "pending",
  generating_report: "pending",
  done: "pending",
  error: "pending",
};

const STAGE_KEYS = Object.keys(INITIAL_STAGES) as PipelineStage[];

function emptyDetails(): Record<PipelineStage, string | undefined> {
  return Object.fromEntries(
    STAGE_KEYS.map((k) => [k, undefined]),
  ) as Record<PipelineStage, string | undefined>;
}

function emptyTiming(): Record<PipelineStage, StageTiming> {
  return Object.fromEntries(
    STAGE_KEYS.map((k) => [k, {} as StageTiming]),
  ) as Record<PipelineStage, StageTiming>;
}

export const INITIAL_STATE: StreamState = {
  running: false,
  stages: { ...INITIAL_STAGES },
  stageDetails: emptyDetails(),
  stageTiming: emptyTiming(),
  logFeed: [],
  claims: [],
  sources: [],
  evidence: [],
  verdicts: [],
  completed: false,
};

const TERMINAL_STATUSES: StageStatus[] = ["done", "skipped", "failed"];

/**
 * Pure event reducer — the single source of truth for stream state.
 * Shared by the live SSE reader and the demo runner.
 * `now` is the ms timestamp applied to this event (Date.now() by default;
 * the demo runner passes its own clock so timings stay realistic).
 */
export function reduceStreamEvent(
  prev: StreamState,
  ev: PipelineEvent,
  now: number = Date.now(),
): StreamState {
  const next: StreamState = {
    ...prev,
    stages: { ...prev.stages },
    stageDetails: { ...prev.stageDetails },
    logFeed: prev.logFeed,
  };

  switch (ev.type) {
    case "stage": {
      next.stages[ev.stage] = ev.status;
      if (ev.detail !== undefined) {
        next.stageDetails[ev.stage] = ev.detail;
      }
      const timing = { ...prev.stageTiming[ev.stage] };
      if (ev.status === "active" && timing.startedAt === undefined) {
        timing.startedAt = now;
      }
      if (TERMINAL_STATUSES.includes(ev.status)) {
        timing.endedAt = now;
      }
      next.stageTiming = { ...prev.stageTiming, [ev.stage]: timing };
      if (ev.status === "failed" && ev.stage !== "error") {
        next.errorStage = ev.stage;
      }
      break;
    }
    case "log": {
      const entry: LogFeedEntry = { level: ev.level, message: ev.message, at: now };
      const feed = [...prev.logFeed, entry];
      next.logFeed = feed.length > LOG_FEED_CAP ? feed.slice(feed.length - LOG_FEED_CAP) : feed;
      break;
    }
    case "claims": {
      next.claims = ev.claims;
      break;
    }
    case "sources": {
      next.sources = ev.sources;
      break;
    }
    case "evidence": {
      next.evidence = ev.evidence;
      break;
    }
    case "report": {
      next.report = ev.report;
      next.claims = ev.claims;
      next.verdicts = ev.verdicts;
      next.sources = ev.sources;
      next.evidence = ev.evidence;
      next.document = ev.document;
      break;
    }
    case "error": {
      next.error = ev.message;
      next.errorStage = ev.stage;
      next.finishedAt = now;
      next.running = false;
      if (ev.stage) {
        next.stages[ev.stage] = "failed";
      }
      const entry: LogFeedEntry = { level: "error", message: ev.message, at: now };
      const feed = [...prev.logFeed, entry];
      next.logFeed = feed.length > LOG_FEED_CAP ? feed.slice(feed.length - LOG_FEED_CAP) : feed;
      break;
    }
    case "done": {
      next.projectId = ev.projectId;
      next.completed = true;
      next.running = false;
      next.finishedAt = now;
      next.stages.done = "done";
      break;
    }
  }
  return next;
}

/** ms → «T+01:23» / «T+00:04.5» style clock strings used across the UI. */
export function formatTplus(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const tenth = Math.floor((clamped % 1000) / 100);
  return `${mm}:${ss}.${tenth}`;
}

/** ms → short duration «3.2с» / «1м 04с». */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 100) return `${Math.round(clamped)}мс`;
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}с`;
  const totalSec = Math.round(clamped / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}м ${ss}с`;
}

export interface UseFactcheckStreamResult {
  state: StreamState;
  /** Start streaming a real analysis (URL или вставленный текст). Resolves when stream ends (or aborts). */
  start: (input: { url?: string; text?: string }, mode: AnalysisMode) => Promise<void>;
  /** Play a scripted demo scenario through the same reducer (no backend). */
  startDemo: (scenarioId: string) => Promise<void>;
  /** Abort an in-flight stream or demo (best-effort). */
  abort: () => void;
  /** Reset state to initial (used by the "Новая проверка" button). */
  reset: () => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function useFactcheckStream(): UseFactcheckStreamResult {
  const [state, setState] = useState<StreamState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const reset = useCallback(() => {
    if (runningRef.current) return; // can't reset while running
    setState({
      ...INITIAL_STATE,
      stages: { ...INITIAL_STAGES },
      stageDetails: emptyDetails(),
      stageTiming: emptyTiming(),
      logFeed: [],
    });
  }, []);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    runningRef.current = false;
    setState((s) => ({ ...s, running: false }));
  }, []);

  /** Scripted demo — replays a fixed timeline through reduceStreamEvent. */
  const startDemo = useCallback(async (scenarioId: string) => {
    const { getDemoScenario } = await import("@/lib/factcheck/demo");
    const scenario = getDemoScenario(scenarioId);
    if (!scenario || runningRef.current) return;

    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    setState({
      ...INITIAL_STATE,
      stages: { ...INITIAL_STAGES },
      stageDetails: emptyDetails(),
      stageTiming: emptyTiming(),
      logFeed: [],
      running: true,
      mode: scenario.result.mode,
      url: scenario.result.url,
      demo: true,
      demoId: scenario.id,
      startedAt: Date.now(),
    });

    try {
      for (const step of scenario.timeline) {
        if (controller.signal.aborted) break;
        await sleep(step.delayMs, controller.signal);
        if (controller.signal.aborted) break;
        setState((prev) => reduceStreamEvent(prev, step.event, Date.now()));
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setState((s) => ({ ...s, running: false }));
    }
  }, []);

  const start = useCallback(async (input: { url?: string; text?: string }, mode: AnalysisMode) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const isText = Boolean(input.text);

    setState({
      ...INITIAL_STATE,
      stages: { ...INITIAL_STAGES },
      stageDetails: emptyDetails(),
      stageTiming: emptyTiming(),
      logFeed: [],
      running: true,
      mode,
      url: input.url ?? "",
      textInput: isText,
      demo: false,
      startedAt: Date.now(),
    });

    let resp: Response;
    try {
      resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(isText ? { text: input.text, mode } : { url: input.url, mode }),
        signal: controller.signal,
      });
    } catch (err) {
      runningRef.current = false;
      abortRef.current = null;
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setState((s) =>
          reduceStreamEvent(
            {
              ...s,
              running: false,
            },
            {
              type: "error",
              message: humanizeNetworkError(err),
              stage: "queued",
            },
          ),
        );
      } else {
        setState((s) => ({ ...s, running: false }));
      }
      return;
    }

    if (!resp.ok || !resp.body) {
      runningRef.current = false;
      abortRef.current = null;
      const message = await extractHttpErrorMessage(resp);
      setState((s) =>
        reduceStreamEvent(
          { ...s, running: false },
          { type: "error", message, stage: "queued" },
        ),
      );
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line. Each event may have one
        // or more `data:` lines.
        let sepIndex = buffer.indexOf("\n\n");
        while (sepIndex !== -1) {
          const raw = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const lines = raw.split("\n");
          const dataLines = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) {
            sepIndex = buffer.indexOf("\n\n");
            continue;
          }
          const payload = dataLines.join("\n");
          try {
            const ev = JSON.parse(payload) as PipelineEvent;
            setState((prev) => reduceStreamEvent(prev, ev, Date.now()));
          } catch {
            // ignore malformed event (could be a partial keep-alive)
          }
          sepIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setState((s) =>
          reduceStreamEvent(
            { ...s },
            {
              type: "error",
              message: humanizeNetworkError(err),
              stage: s.errorStage ?? "queued",
            },
          ),
        );
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setState((s) => ({ ...s, running: false }));
    }
  }, []);

  return { state, start, startDemo, abort, reset };
}

/* ------------------------------------------------------------------ */
/* Человекочитаемые сообщения об ошибках                                */
/* ------------------------------------------------------------------ */

/**
 * Преобразует сетевые ошибки fetch (TypeError: Failed to fetch, DNS, offline,
 * CORS, разрыв соединения) в понятные сообщения на русском. Если это
 * AbortError — возвращает «Проверка остановлена» (спокойный тон).
 */
function humanizeNetworkError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "Проверка остановлена пользователем.";
  }
  const raw = err instanceof Error ? err.message : String(err);
  const e = raw.toLowerCase();
  if (/failed to fetch|networkerror|network request failed/.test(e)) {
    return "Не удалось подключиться к серверу. Проверьте интернет-соединение и повторите попытку.";
  }
  if (/aborted/.test(e)) {
    return "Проверка остановлена пользователем.";
  }
  if (/timeout|timed out/.test(e)) {
    return "Превышено время ожидания ответа сервера. Повторите запрос через минуту.";
  }
  return `Сбой соединения с сервером: ${raw}`;
}

/**
 * Извлекает человекочитаемое сообщение из HTTP-ответа об ошибке.
 * Если сервер вернул JSON с полем error/message — используем его.
 * Если нет — переводим HTTP-статус в спокойное русское сообщение.
 */
async function extractHttpErrorMessage(resp: Response): Promise<string> {
  let serverMsg: string | null = null;
  try {
    const data = await resp.json();
    if (data && typeof data.error === "string" && data.error.trim().length > 0) {
      serverMsg = data.error;
    } else if (data && typeof data.message === "string" && data.message.trim().length > 0) {
      serverMsg = data.message;
    }
  } catch {
    // не JSON — используем статус
  }
  if (serverMsg) return serverMsg;
  switch (resp.status) {
    case 400:
      return "Некорректный запрос. Проверьте URL материала и повторите отправку.";
    case 401:
      return "Сессия истекла. Обновите страницу и войдите в систему заново.";
    case 403:
      return "Доступ запрещён. Обратитесь к администратору, если считаете это ошибкой.";
    case 404:
      return "Запрашиваемый ресурс не найден на сервере.";
    case 429:
      return "Слишком много запросов. Повторите попытку через 30–60 секунд — предыдущая проверка ещё может выполняться.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "Сервер временно недоступен. Повторите запрос через минуту — обычно это кратковременный сбой.";
    default:
      return `Сервер сообщил об ошибке (HTTP ${resp.status}). Повторите запрос.`;
  }
}
