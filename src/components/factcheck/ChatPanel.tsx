"use client";

/**
 * Fullscreen chat (§ "Спросить нейросеть").
 *
 * Two modes:
 *  - context mode (projectId set): the analysis context (claims / sources /
 *    verdicts / audit trail) is injected automatically on the SERVER
 *    (/api/chat) — the client only sends the visible conversation.
 *  - general mode (projectId null): the assistant explains the system.
 *
 * The answer streams token-by-token over SSE. The panel stays mounted while
 * the page lives (hidden when closed) so the conversation survives closing
 * and reopening the chat. User bubbles are light (right), AI answers are
 * dark raised panels (left).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, Sparkles, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { ChatExchange, ChatStreamEvent } from "@/lib/factcheck/types";

const MAX_INPUT_CHARS = 4000;

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  /** null → general mode (no analysis context). */
  projectId: string | null;
  /** Short context header: what was checked. */
  title?: string;
  /** Russian overall verdict label for the suggested first question. */
  overallLabelRu?: string;
}

interface UIMessage extends ChatExchange {
  /** Streaming answer that has not finished yet. */
  streaming?: boolean;
}

export function ChatPanel({ open, onClose, projectId, title, overallLabelRu }: ChatPanelProps) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset the conversation when switching between projects / modes
  // (id → other id, id → null, null → id).
  const lastProjectRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastProjectRef.current === undefined) {
      lastProjectRef.current = projectId;
      return;
    }
    if (projectId !== lastProjectRef.current) {
      lastProjectRef.current = projectId;
      setMessages([]);
      setInput("");
    }
  }, [projectId]);

  // Escape closes the chat.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Auto-scroll while streaming (only when the user is at the bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Focus the input when opened.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [open]);

  const suggestions = buildSuggestions(projectId, overallLabelRu);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;
      stickToBottomRef.current = true;
      setInput("");
      const history: ChatExchange[] = [
        ...messages
          .filter((m) => m.content.trim().length > 0)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: question },
      ];
      setMessages((prev) => [
        ...prev,
        { role: "user", content: question },
        { role: "assistant", content: "", streaming: true },
      ]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            ...(projectId ? { projectId } : {}),
            messages: history,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let message = "Не удалось получить ответ. Повторите попытку через минуту.";
          try {
            const data = await res.json();
            if (data && typeof data.error === "string" && data.error.trim().length > 0) {
              message = data.error;
            } else if (res.status === 429) {
              message = "Слишком много запросов. Повторите попытку через 30–60 секунд.";
            } else if (res.status === 401) {
              message = "Сессия истекла. Обновите страницу и войдите заново.";
            }
          } catch {
            /* ignore */
          }
          throw new Error(message);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finished = false;

        const apply = (ev: ChatStreamEvent) => {
          if (ev.type === "delta") {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant") {
                next[next.length - 1] = { ...last, content: last.content + ev.text };
              }
              return next;
            });
          } else if (ev.type === "done") {
            finished = true;
          } else if (ev.type === "error") {
            finished = true;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "assistant" && last.content.trim() === "") {
                // no partial text — replace the empty bubble with an error
                next[next.length - 1] = {
                  role: "assistant",
                  content: `⚠ ${ev.message}`,
                  streaming: false,
                };
              } else {
                next.push({ role: "assistant", content: `⚠ ${ev.message}` });
              }
              return next;
            });
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLines = raw
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length > 0) {
              try {
                apply(JSON.parse(dataLines.join("\n")) as ChatStreamEvent);
              } catch {
                /* malformed event — skip */
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        }
        void finished;
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (!aborted) {
          const message = err instanceof Error ? err.message : "Ошибка запроса";
          toast({
            title: "Чат недоступен",
            description: message,
            variant: "destructive",
          });
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.content.trim() === "") {
              next.pop();
            }
            return next;
          });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        // mark the streaming bubble complete
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = { ...last, streaming: false };
          }
          return next;
        });
      }
    },
    [busy, messages, projectId, toast]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottomRef.current = nearBottom;
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          role="dialog"
          aria-modal="true"
          aria-label="Чат с нейросетью"
          className="fixed inset-0 z-50 flex flex-col bg-[#121418]/98 backdrop-blur-md"
        >
          {/* Header */}
          <header className="border-b border-white/[0.08] px-4 py-3 sm:px-6">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[#2563EB]/50 bg-[#2563EB]/10 text-[#60a5fa]">
                  <Sparkles className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="gx-display text-xs tracking-[0.14em] text-[#f4f5f7] sm:text-sm">
                    {projectId ? "Чат по проверке" : "Спросить нейросеть"}
                  </h2>
                  <p className="truncate text-[11px] text-[#9ca3af]">
                    {projectId
                      ? title || "Контекст отчёта подключён автоматически"
                      : "Общий режим · выберите проверку, чтобы подключить её контекст"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть чат"
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-white/15 text-[#c3c8cf] transition-colors hover:bg-white/[0.06] hover:text-[#f4f5f7]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </header>

          {/* Messages */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="gx-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6"
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-start gap-4 py-6">
                  <p className="max-w-md text-sm leading-relaxed text-[#9ca3af]">
                    {projectId
                      ? "Задайте вопрос об этой проверке — ассистент видит все утверждения, источники, вердикты и ход анализа. История версий вердиктов также доступна."
                      : "Задайте вопрос о том, как работает система: конвейер проверки, уровни доказательности, доверенные источники, режимы проверки."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        className="rounded-md border border-white/12 bg-white/[0.04] px-3 py-1.5 text-left text-xs text-[#c3c8cf] transition-colors hover:border-[#2563EB]/55 hover:text-[#93c5fd]"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg bg-[#f4f5f7] px-4 py-2.5 text-sm leading-relaxed text-[#121418] shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start gap-3">
                    <span
                      aria-hidden
                      className="gx-display mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[#2563EB]/45 bg-[#2563EB]/[0.08] text-[10px] text-[#60a5fa]"
                    >
                      Ф
                    </span>
                    <div className="max-w-[85%] rounded-lg border border-white/[0.1] bg-[#1b1e24] px-4 py-2.5 text-sm leading-relaxed text-[#c3c8cf] shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
                      <Markdownish text={m.content} />
                      {m.streaming && (
                        <span
                          aria-hidden
                          className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-[#60a5fa]"
                        />
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-white/[0.08] bg-[#0f1114]/80 px-4 py-3 sm:px-6">
            <form
              className="mx-auto flex max-w-3xl items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <div className="relative flex-1">
                <label htmlFor="chat-input" className="sr-only">
                  Вопрос
                </label>
                <textarea
                  ref={inputRef}
                  id="chat-input"
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_CHARS))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  placeholder={
                    projectId
                      ? "Спросите об утверждениях, источниках или вердиктах…"
                      : "Например: что означает уровень доказательности 1?"
                  }
                  className="gx-scroll max-h-32 min-h-[44px] w-full resize-none rounded-md border border-white/[0.12] bg-[#1b1e24] px-3 py-2.5 pr-14 text-sm text-[#f4f5f7] placeholder:text-[#566272] focus:border-[#2563EB]/60 focus:outline-none"
                />
                {input.length > 3200 && (
                  <span className="absolute bottom-2 right-3 text-[10px] text-[#566272]">
                    {input.length}/{MAX_INPUT_CHARS}
                  </span>
                )}
              </div>
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Остановить генерацию"
                  className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-md border border-[#ef4444]/45 bg-[#ef4444]/10 text-[#f87171] transition-colors hover:bg-[#ef4444]/20"
                >
                  <Square className="size-4" aria-hidden />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={input.trim().length === 0}
                  aria-label="Отправить вопрос"
                  className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-md bg-[#2563EB] text-white transition-colors hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="size-4" aria-hidden />
                </button>
              )}
            </form>
            <p className="mx-auto mt-2 max-w-3xl text-[10px] text-[#566272]">
              {projectId
                ? "Ассистент опирается только на данные этой проверки и не даёт медицинских рекомендаций."
                : "Ассистент не даёт медицинских рекомендаций. По личным вопросам о здоровье обращайтесь к врачу."}{" "}
              Enter — отправить, Shift+Enter — новая строка, Esc — закрыть.
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Suggested opening questions. */
function buildSuggestions(projectId: string | null, overallLabelRu?: string): string[] {
  if (!projectId) {
    return [
      "Как устроен конвейер проверки материала?",
      "Что означают уровни доказательности (1–8)?",
      "Какие источники считаются доверенными?",
      "Чем отличаются режимы проверки?",
    ];
  }
  const out: string[] = [];
  if (overallLabelRu) {
    out.push(`Почему материал получил вердикт «${overallLabelRu}»?`);
  }
  out.push("Какие утверждения вызывают больше всего сомнений и почему?");
  out.push("Насколько надёжны источники, использованные при проверке?");
  out.push("Что означают уровни доказательности в отчёте?");
  return out;
}

/**
 * Tiny markdown-ish renderer: **bold**, `code`, bullet/numbered lists and
 * paragraphs. Enough for the chat model's answers — no heavy dependency.
 */
function Markdownish({ text }: { text: string }) {
  if (!text) return null;
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const isBulletList = lines.every((l) => /^\s*[-•*]\s+/.test(l)) && lines.length > 0;
        const isNumberedList =
          lines.every((l) => /^\s*\d+[.)]\s+/.test(l)) && lines.length > 0;
        if (isBulletList || isNumberedList) {
          return (
            <ul key={bi} className="ml-1 flex flex-col gap-1">
              {lines.map((l, li) => (
                <li key={li} className="flex gap-2">
                  <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-[#10b981]" />
                  <span>{inline(l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, ""))}</span>
                </li>
              ))}
            </ul>
          );
        }
        // headings-like lines (### or ALL-CAPS short lines)
        return (
          <p key={bi} className={cn(lines.length === 1 && isHeading(lines[0]) && "gx-display text-xs tracking-wider text-[#93c5fd]")}>
            {lines.map((l, li) => (
              <span key={li}>
                {inline(l.replace(/^#{1,4}\s*/, ""))}
                {li < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("#")) return true;
  return t.length > 0 && t.length <= 60 && t === t.toUpperCase() && /[A-ZА-Я]/.test(t);
}

/** Inline formatting: **bold** and `code`. */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      parts.push(
        <strong key={key++} className="font-semibold text-[#f4f5f7]">
          {m[1]}
        </strong>
      );
    } else if (m[2]) {
      parts.push(
        <code
          key={key++}
          className="rounded border border-white/[0.15] bg-[#0f1114] px-1 py-0.5 text-[12px] text-[#93c5fd]"
        >
          {m[2]}
        </code>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
