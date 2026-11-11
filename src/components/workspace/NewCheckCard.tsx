"use client";

/**
 * «Новая проверка» — the single light card of the home workspace:
 * переключатель «Ссылка / Текст» + поле ввода + segmented mode control
 * (Контролируемый / Исследовательский) + «Проверить».
 *
 * Режим «Текст»: пользователь вставляет фрагмент текста (от 200 символов) —
 * конвейер проверяет его без загрузки URL (частый сценарий: посты из
 * мессенджеров, скриншоты, пересланные сообщения).
 */

import { useState } from "react";
import { Link2, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalysisMode } from "@/lib/factcheck/types";

interface NewCheckCardProps {
  running: boolean;
  defaultMode?: AnalysisMode;
  onSubmit: (input: { url?: string; text?: string }, mode: AnalysisMode) => void;
  onAbort: () => void;
}

const MODES: { id: AnalysisMode; title: string; description: string }[] = [
  {
    id: "CONTROLLED",
    title: "Контролируемый",
    description:
      "Только доверенные источники: WHO, CDC, FDA, PubMed, Cochrane и другие из реестра.",
  },
  {
    id: "RESEARCH",
    title: "Исследовательский",
    description:
      "Расширенный поиск источников и обязательная проверка контраргументов.",
  },
];

/** Минимальная длина фрагмента текста (синхронизировано с бэкендом). */
const MIN_TEXT_LENGTH = 200;

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

type InputKind = "url" | "text";

export function NewCheckCard({
  running,
  defaultMode = "RESEARCH",
  onSubmit,
  onAbort,
}: NewCheckCardProps) {
  const [kind, setKind] = useState<InputKind>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<AnalysisMode>(defaultMode);
  const [touched, setTouched] = useState(false);

  const trimmed = kind === "url" ? url.trim() : text.trim();
  const urlInvalid = kind === "url" && touched && trimmed.length > 0 && !isValidUrl(trimmed);
  const textTooShort = kind === "text" && touched && trimmed.length > 0 && trimmed.length < MIN_TEXT_LENGTH;
  const canSubmit =
    !running &&
    ((kind === "url" && trimmed.length > 0 && !urlInvalid) ||
      (kind === "text" && trimmed.length >= MIN_TEXT_LENGTH));

  const submit = () => {
    setTouched(true);
    if (!canSubmit) return;
    if (kind === "url") onSubmit({ url: trimmed }, mode);
    else onSubmit({ text: trimmed }, mode);
  };

  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[1];
  const textChars = kind === "text" ? text.trim().length : 0;

  return (
    <section className="gx-card p-4 sm:p-5" aria-labelledby="new-check-title">
      <h2 id="new-check-title" className="gx-label-card mb-3">
        Новая проверка
      </h2>

      {/* Вид ввода: Ссылка | Текст */}
      <div
        role="radiogroup"
        aria-label="Тип материала"
        className="mb-2.5 inline-flex items-center gap-0.5 rounded-md border border-[#e3e5e9] bg-[#f3f4f6] p-1"
      >
        <button
          type="button"
          role="radio"
          aria-checked={kind === "url"}
          disabled={running}
          onClick={() => setKind("url")}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-[5px] px-3.5 text-sm transition-all",
            kind === "url"
              ? "bg-white font-medium text-[#121418] shadow-sm"
              : "text-[#6b7280] hover:text-[#374151]",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <Link2 className="size-3.5" aria-hidden />
          Ссылка
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "text"}
          disabled={running}
          onClick={() => setKind("text")}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-[5px] px-3.5 text-sm transition-all",
            kind === "text"
              ? "bg-white font-medium text-[#121418] shadow-sm"
              : "text-[#6b7280] hover:text-[#374151]",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <Type className="size-3.5" aria-hidden />
          Фрагмент текста
        </button>
      </div>

      {/* Input + mode + submit */}
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-stretch">
        {/* URL / textarea */}
        <div className="min-w-0 flex-1">
          {kind === "url" ? (
            <>
              <label htmlFor="factcheck-url" className="sr-only">
                URL материала
              </label>
              <div className="relative">
                <Link2
                  aria-hidden
                  className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#9ca3af]"
                />
                <input
                  id="factcheck-url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Вставьте URL материала о здоровье…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setTouched(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) submit();
                  }}
                  aria-invalid={urlInvalid}
                  aria-describedby={urlInvalid ? "factcheck-url-error" : undefined}
                  disabled={running}
                  className={cn(
                    "h-11 w-full rounded-md border bg-white pl-10 pr-3 text-sm text-[#121418] outline-none transition-colors placeholder:text-[#9ca3af]",
                    urlInvalid
                      ? "border-[#ef4444] focus:border-[#ef4444]"
                      : "border-[#e3e5e9] focus:border-[#2563EB]",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                />
              </div>
            </>
          ) : (
            <>
              <label htmlFor="factcheck-text" className="sr-only">
                Фрагмент текста для проверки
              </label>
              <div className="relative">
                <Type
                  aria-hidden
                  className="pointer-events-none absolute left-3.5 top-3 size-4 text-[#9ca3af]"
                />
                <textarea
                  id="factcheck-text"
                  rows={3}
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, 20_000))}
                  onBlur={() => setTouched(true)}
                  placeholder="Вставьте фрагмент текста — пост, пересланное сообщение, абзац статьи…"
                  aria-invalid={textTooShort}
                  aria-describedby={
                    textTooShort ? "factcheck-text-error" : "factcheck-text-hint"
                  }
                  disabled={running}
                  className={cn(
                    "gx-scroll min-h-[86px] w-full rounded-md border bg-white py-2.5 pl-10 pr-3 text-sm leading-relaxed text-[#121418] outline-none transition-colors placeholder:text-[#9ca3af]",
                    textTooShort
                      ? "border-[#ef4444] focus:border-[#ef4444]"
                      : "border-[#e3e5e9] focus:border-[#2563EB]",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                />
              </div>
            </>
          )}
        </div>

        {/* Mode — segmented control */}
        <div
          role="radiogroup"
          aria-label="Режим проверки"
          className="flex h-11 shrink-0 items-center gap-0.5 rounded-md border border-[#e3e5e9] bg-[#f3f4f6] p-1"
        >
          {MODES.map((m) => {
            const selected = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={running}
                onClick={() => setMode(m.id)}
                className={cn(
                  "h-9 flex-1 rounded-[5px] px-4 text-sm transition-all lg:flex-none",
                  selected
                    ? "bg-white text-[#121418] font-medium shadow-sm"
                    : "text-[#6b7280] hover:text-[#374151]",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {m.title}
              </button>
            );
          })}
        </div>

        {/* Submit */}
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="gx-btn-primary h-11 shrink-0 self-start rounded-md px-6 text-sm font-semibold tracking-wide text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:saturate-50 lg:self-auto"
        >
          {running ? (
            <span className="flex items-center justify-center gap-2">
              <span className="gx-spinner !border-white/30 !border-t-white" aria-hidden />
              Анализ…
            </span>
          ) : kind === "text" ? (
            "Проверить текст"
          ) : (
            "Проверить"
          )}
        </button>
      </div>

      {/* Mode description */}
      <p className="mt-2.5 text-xs leading-snug text-[#6b7280]" aria-live="polite">
        {activeMode.description}
      </p>

      {urlInvalid && (
        <p id="factcheck-url-error" className="mt-2 text-xs text-[#dc2626]">
          Проверьте адрес — это должен быть полный URL, начинающийся с http:// или https://
        </p>
      )}
      {textTooShort && (
        <p id="factcheck-text-error" className="mt-2 text-xs text-[#dc2626]">
          Фрагмент слишком короткий: нужно не менее {MIN_TEXT_LENGTH} символов, чтобы выделить
          проверяемые утверждения.
        </p>
      )}
      {kind === "text" && !textTooShort && (
        <p id="factcheck-text-hint" className="mt-2 text-xs text-[#9ca3af]" aria-live="polite">
          {textChars > 0
            ? `Символов: ${textChars.toLocaleString("ru-RU")} — конвейер проверит утверждения без загрузки страницы.`
            : "Текст проверяется так же, как статья по ссылке: выделение утверждений, поиск источников, вердикты."}
        </p>
      )}

      {/* Abort */}
      {running && (
        <div className="mt-3 flex items-center gap-3 border-t border-[#e3e5e9] pt-3">
          <button
            type="button"
            onClick={onAbort}
            className="h-8 rounded-md border border-[#ef4444]/40 px-3.5 text-xs font-medium text-[#dc2626] transition-colors hover:bg-[#ef4444]/10"
          >
            Остановить проверку
          </button>
          <span className="text-[11px] text-[#9ca3af]">
            Прогресс отображается на экране проверки
          </span>
        </div>
      )}
    </section>
  );
}
