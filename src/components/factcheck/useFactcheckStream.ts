"use client";

/**
 * Client-side hook that consumes the SSE stream from POST /api/analyze.
 *
 * The backend streams events of type PipelineEvent (see types.ts). We read
 * the response body with getReader(), decode UTF-8 chunks, split on `\n\n`
 * (SSE event boundary), and parse each `data: <json>` line.
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

export interface StreamState {
  /** Whether a stream is currently active. */
  running: boolean;
  /** Stage statuses keyed by stage id. */
  stages: Record<PipelineStage, StageStatus>;
  /** Optional detail text for the currently active stage. */
  activeDetail?: string;
  /** Latest log message (kept for surface display). */
  lastLog?: { level: "info" | "warn" | "error"; message: string };
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

const INITIAL_STATE: StreamState = {
  running: false,
  stages: { ...INITIAL_STAGES },
  claims: [],
  sources: [],
  evidence: [],
  verdicts: [],
  completed: false,
};

export interface UseFactcheckStreamResult {
  state: StreamState;
  /** Start streaming an analysis. Returns when stream ends (or aborts). */
  start: (url: string, mode: AnalysisMode) => Promise<void>;
  /** Abort an in-flight stream (best-effort). */
  abort: () => void;
  /** Reset state to initial (used by the "Новая проверка" button). */
  reset: () => void;
}

export function useFactcheckStream(): UseFactcheckStreamResult {
  const [state, setState] = useState<StreamState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const reset = useCallback(() => {
    if (runningRef.current) return; // can't reset while running
    setState({ ...INITIAL_STATE, stages: { ...INITIAL_STAGES } });
  }, []);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    runningRef.current = false;
    setState((s) => ({ ...s, running: false }));
  }, []);

  const start = useCallback(async (url: string, mode: AnalysisMode) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    setState({
      ...INITIAL_STATE,
      stages: { ...INITIAL_STAGES },
      running: true,
      mode,
      url,
    });

    let resp: Response;
    try {
      resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ url, mode }),
        signal: controller.signal,
      });
    } catch (err) {
      runningRef.current = false;
      abortRef.current = null;
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setState((s) => ({
          ...s,
          running: false,
          error: err instanceof Error ? err.message : "Сетевая ошибка запроса",
          errorStage: "queued",
          stages: { ...s.stages, queued: "failed" },
        }));
      } else {
        setState((s) => ({ ...s, running: false }));
      }
      return;
    }

    if (!resp.ok || !resp.body) {
      runningRef.current = false;
      abortRef.current = null;
      let message = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data && typeof data.error === "string") message = data.error;
        else if (data && typeof data.message === "string") message = data.message;
      } catch {
        // ignore — non-JSON error body
      }
      setState((s) => ({
        ...s,
        running: false,
        error: message,
        errorStage: "queued",
        stages: { ...s.stages, queued: "failed" },
      }));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const applyEvent = (ev: PipelineEvent) => {
      setState((prev) => {
        const next: StreamState = { ...prev, stages: { ...prev.stages } };
        switch (ev.type) {
          case "stage": {
            next.stages[ev.stage] = ev.status;
            if (ev.status === "active") {
              next.activeDetail = ev.detail;
            } else if (prev.activeDetail && ev.status === "done") {
              next.activeDetail = undefined;
            }
            if (ev.status === "failed" && ev.stage !== "error") {
              next.errorStage = ev.stage;
            }
            break;
          }
          case "log": {
            next.lastLog = { level: ev.level, message: ev.message };
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
            if (ev.stage) {
              next.stages[ev.stage] = "failed";
            }
            break;
          }
          case "done": {
            next.projectId = ev.projectId;
            next.completed = true;
            next.running = false;
            next.stages.done = "done";
            break;
          }
        }
        return next;
      });
    };

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
            applyEvent(ev);
          } catch {
            // ignore malformed event (could be a partial keep-alive)
          }
          sepIndex = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setState((s) => ({
          ...s,
          running: false,
          error: err instanceof Error ? err.message : "Ошибка чтения потока",
          errorStage: s.errorStage ?? "queued",
        }));
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setState((s) => ({ ...s, running: false }));
    }
  }, []);

  return { state, start, abort, reset };
}
