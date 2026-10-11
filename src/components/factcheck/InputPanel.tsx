"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AnalysisMode } from "@/lib/factcheck/types";

export interface HealthInfo {
  llm: {
    ready: boolean;
    backend: string;
    backendLabel?: string;
    model: string;
    baseUrl?: string;
    error?: string;
  };
  db: { ready: boolean };
  config: { trustedSourcesCount: number };
}

interface InputPanelProps {
  /** Currently-running flag (disables submit while true). */
  running: boolean;
  /** Trigger a new analysis. */
  onSubmit: (url: string, mode: AnalysisMode) => void;
  /** Abort the in-flight analysis. */
  onAbort: () => void;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function InputPanel({ running, onSubmit, onAbort }: InputPanelProps) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<AnalysisMode>("RESEARCH");
  const [touched, setTouched] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthInfo) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        // ignore — UI degrades to "—"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = url.trim();
  const showError = touched && trimmed.length > 0 && !isValidUrl(trimmed);
  const canSubmit = !running && trimmed.length > 0 && !showError;

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    onSubmit(trimmed, mode);
  };

  return (
    <section className="gx-panel gx-rise-delay relative z-10 p-5 sm:p-6">
      <header className="mb-5 flex items-center gap-3">
        <h2 className="gx-display text-sm tracking-wider text-[#f4f6f7] sm:text-base">
          Проверка материала
        </h2>
      </header>

      <div className="space-y-5">
        {/* URL input */}
        <div className="space-y-2">
          <Label htmlFor="factcheck-url" className="text-xs uppercase tracking-wider text-[#8a9aa6]">
            URL материала
          </Label>
          <Input
            id="factcheck-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/article-about-health"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) submit();
            }}
            aria-invalid={showError}
            className="h-11 rounded-sm bg-[rgba(7,9,11,0.55)] text-sm text-[#f4f6f7]"
          />
          {showError && (
            <p className="text-xs text-[#ff8aad]">
              Проверьте адрес — это должен быть полный URL, начинающийся с http:// или https://
            </p>
          )}
        </div>

        {/* Mode selector */}
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-[#8a9aa6]">
            Режим проверки
          </Label>
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as AnalysisMode)}
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
          >
            <ModeChip
              value="CONTROLLED"
              title="Контролируемый"
              caption="Только доверенные источники: WHO, CDC, FDA, PubMed, Cochrane…"
              selected={mode === "CONTROLLED"}
            />
            <ModeChip
              value="RESEARCH"
              title="Исследовательский"
              caption="Расширенный поиск + обязательная adversarial-проверка"
              selected={mode === "RESEARCH"}
            />
          </RadioGroup>
        </div>

        {/* Primary actions */}
        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={submit}
            disabled={!canSubmit}
            size="lg"
            className={cn(
              "gx-btn-primary h-11 min-w-44 flex-1 rounded-sm border px-5 text-sm font-semibold tracking-wide text-white",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {running ? (
              <>
                <span className="gx-spinner" aria-hidden />
                Анализ…
              </>
            ) : (
              <>Проверить</>
            )}
          </Button>
          {running && (
            <Button
              onClick={onAbort}
              variant="outline"
              size="lg"
              className="h-11 rounded-sm border-[rgba(255,92,138,0.4)] px-4 text-sm text-[#ff8aad] hover:bg-[rgba(255,92,138,0.1)]"
            >
              Остановить
            </Button>
          )}
        </div>

        {/* Trust line */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[rgba(218,222,225,0.12)] pt-3 text-[11px] text-[#8a9aa6]">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                health?.llm.ready ? "bg-[#2ec4b6]" : "bg-[#8a9aa6]",
              )}
              aria-hidden
            />
            {health ? (
              <>
                {health.llm.backendLabel || health.llm.backend}
                {health.llm.model ? <span className="opacity-60"> · {health.llm.model}</span> : null}
                {!health.llm.ready && health.llm.error ? (
                  <span className="text-[#ff8aad]"> · {health.llm.error}</span>
                ) : null}
              </>
            ) : (
              "Проверка готовности бэкенда…"
            )}
          </span>
          {health && (
            <span>
              Доверенных источников:{" "}
              <span className="text-[#dadee1]">{health.config.trustedSourcesCount}</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

interface ModeChipProps {
  value: string;
  title: string;
  caption: string;
  selected: boolean;
}

function ModeChip({ value, title, caption, selected }: ModeChipProps) {
  return (
    <Label
      htmlFor={`mode-${value}`}
      className={cn(
        "group relative flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition-colors",
        selected
          ? "border-[rgba(46,196,182,0.55)] bg-[rgba(46,196,182,0.07)]"
          : "border-[rgba(218,222,225,0.18)] bg-[rgba(7,9,11,0.4)] hover:border-[rgba(218,222,225,0.32)]",
      )}
    >
      <RadioGroupItem
        id={`mode-${value}`}
        value={value}
        className="mt-0.5 border-[rgba(218,222,225,0.45)] text-[#2ec4b6]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-[#f4f6f7]">{title}</span>
        <span className="text-[11px] leading-snug text-[#8a9aa6]">{caption}</span>
      </span>
    </Label>
  );
}
