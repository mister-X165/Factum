/**
 * LLM provider abstraction (§5/§6 of the MASTER PROMPT).
 *
 * The architecture must not be hard-wired to a single model. We expose an
 * `LLMProvider` interface with a single implementation:
 *
 *   - OpenAiCompatibleProvider — talks to any OpenAI-compatible local server
 *     (LM Studio on :1234, llama.cpp server on :8080, Ollama on :11434).
 *     This is the recommended backend per the MASTER PROMPT (§5: "Основным
 *     backend считать llama.cpp").
 *
 * The active provider is chosen at runtime from the LLM_PROVIDER env var
 * (see config.ts). The pipeline never imports a concrete provider directly —
 * it calls getLLM() which returns the configured one.
 *
 * ----------------------------------------------------------------------------
 * STREAMING + IDLE-TIMEOUT DESIGN (fix for the 120s-timeout abort issue).
 *
 * Previously complete() used `stream: false` and a single hard timeout. On a
 * slow local model (~5 tok/s) a large prompt (4 K tokens prefill + 1 K tokens
 * of generated JSON) can legitimately take 3–5 minutes, so the request was
 * cancelled mid-generation by the timeout, completeJson retried from scratch
 * three times, each one was cancelled the same way, and extractClaims()
 * swallowed the error → the user saw the misleading "Не удалось выделить
 * проверяемые утверждения из материала" message.
 *
 * Now complete() streams the response (stream: true). Two timers guard it:
 *   - idleTimeoutMs  — reset on EVERY received chunk. If no bytes arrive for
 *                      this long, the request is aborted (model hung / crashed).
 *   - timeoutMs      — hard overall ceiling for one request (10 min default).
 *
 * Streaming also lets us set a generous overall timeout without risking an
 * infinitely-hung connection: as long as tokens keep flowing, the request is
 * considered alive. max_tokens caps the generation length so the model can't
 * run away.
 */

import { FACTCHECK_CONFIG } from "./config";
import { fillPrompt } from "./prompts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  /** Run a chat completion and return the assistant text. */
  complete(messages: ChatMessage[]): Promise<string>;
  /** Run a prompt that must return strict JSON, with retry + repair. */
  completeJson<T>(
    systemPrompt: string,
    userPrompt: string,
    opts?: { retries?: number }
  ): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Raised when the streaming connection produced no bytes for
 * `idleTimeoutMs` in a row, or when the overall `timeoutMs` was hit.
 * Carries a user-actionable hint so the orchestrator can surface a clear
 * message instead of a generic "extraction failed".
 */
export class LLMTimeoutError extends Error {
  readonly kind: "idle" | "overall";
  constructor(kind: "idle" | "overall", ms: number) {
    const which = kind === "idle" ? "без данных (idle)" : "общий";
    super(
      `Локальная LLM не ответила за ${Math.round(ms / 1000)} с (таймаут: ${which}). ` +
        `Скорее всего модель слишком медленная для текущего объёма контекста. ` +
        `Увеличьте LLM_TIMEOUT_MS / LLM_IDLE_TIMEOUT_MS в .env либо используйте более быструю или сильнее квантованную модель.`
    );
    this.name = "LLMTimeoutError";
    this.kind = kind;
  }
}

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with:
 *   - LM Studio (Local Server on http://127.0.0.1:1234/v1)
 *   - llama.cpp server (./server -m model.gguf --host 0.0.0.0 --port 8080)
 *   - Ollama (http://127.0.0.1:11434/v1)
 *
 * All three expose the standard OpenAI POST /chat/completions endpoint and
 * support `stream: true` with `data: {"choices":[{"delta":{"content":"..."}}]}`
 * SSE chunks terminated by `data: [DONE]`.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private idleTimeoutMs: number;
  private maxTokens: number;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxTokens?: number;
  }) {
    // strip a trailing slash so `${baseUrl}/chat/completions` always works
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey || "lm-studio";
    this.model = opts.model || "";
    this.timeoutMs = opts.timeoutMs ?? FACTCHECK_CONFIG.llm.timeoutMs;
    this.idleTimeoutMs =
      opts.idleTimeoutMs ?? FACTCHECK_CONFIG.llm.idleTimeoutMs;
    this.maxTokens = opts.maxTokens ?? FACTCHECK_CONFIG.llm.maxTokens;
  }

  /**
   * Run a chat completion with streaming + dual timeout (idle / overall).
   * Returns the full concatenated assistant text once the stream ends.
   */
  async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Set iff one of our timers fired (so the catch can translate AbortError). */
    let timedOut: "idle" | "overall" | null = null;

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = "idle";
        controller.abort();
      }, this.idleTimeoutMs);
    };

    overallTimer = setTimeout(() => {
      timedOut = "overall";
      controller.abort();
    }, this.timeoutMs);
    armIdle();

    const body: Record<string, unknown> = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.3,
      stream: true,
      max_tokens: this.maxTokens,
    };
    if (this.model) body.model = this.model;

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `${this.baseUrl}/chat/completions → HTTP ${res.status}${
            errText ? `: ${errText.slice(0, 200)}` : ""
          }`
        );
      }
      if (!res.body) {
        throw new Error("Локальный LLM вернул пустой поток ответа (no body).");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let acc = "";

      // Read SSE chunks. Each chunk resets the idle timer — as long as bytes
      // keep flowing, the request is considered alive.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line; each event may have one
        // or more `data:` lines.
        let sepIndex = buffer.indexOf("\n\n");
        while (sepIndex !== -1) {
          const raw = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const lines = raw.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trimStart();
            if (payload === "[DONE]") {
              if (acc.trim().length === 0) {
                throw new Error("Локальный LLM вернул пустой ответ");
              }
              return acc;
            }
            try {
              const chunk = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const piece = chunk.choices?.[0]?.delta?.content ?? "";
              if (piece) acc += piece;
            } catch {
              // ignore a single malformed chunk — keep going
            }
          }
          sepIndex = buffer.indexOf("\n\n");
        }
      }
      // Stream ended without an explicit [DONE] marker — still return what we
      // accumulated (some servers omit the marker).
      if (acc.trim().length === 0) {
        throw new Error("Локальный LLM вернул пустой ответ");
      }
      return acc;
    } catch (e) {
      // If one of OUR timers fired, surface a clear, actionable error instead
      // of a raw AbortError ("The operation was aborted").
      if (timedOut) {
        throw new LLMTimeoutError(timedOut, timedOut === "idle" ? this.idleTimeoutMs : this.timeoutMs);
      }
      // A genuine abort (e.g. caller cancelled) — rethrow as-is.
      throw e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (overallTimer) clearTimeout(overallTimer);
    }
  }

  async completeJson<T>(
    systemPrompt: string,
    userPrompt: string,
    opts?: { retries?: number }
  ): Promise<T> {
    const retries = opts?.retries ?? FACTCHECK_CONFIG.llm.retries;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const raw = await this.complete([
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ]);
        const parsed = parseJsonLoose<T>(raw);
        if (parsed !== undefined) return parsed;
        // repair attempt
        if (attempt < retries) {
          const repaired = await this.complete([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
            { role: "assistant", content: raw },
            {
              role: "user",
              content:
                "Твой предыдущий ответ не является валидным JSON. Верни ТОЛЬКО валидный JSON той же структуры, без markdown и пояснений.",
            },
          ]);
          const reparsed = parseJsonLoose<T>(repaired);
          if (reparsed !== undefined) return reparsed;
        }
      } catch (e) {
        lastError = e;
        // If the error is a timeout, do NOT retry blindly — a slow model will
        // just time out the same way again and burn another `timeoutMs`.
        // Instead, propagate immediately so the orchestrator can surface it.
        if (e instanceof LLMTimeoutError) {
          throw e;
        }
        if (attempt < retries) await sleep(500 * attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("LLM JSON parsing failed");
  }
}

/** Singleton provider selected from FACTCHECK_CONFIG.llm.backend. */
let _provider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (_provider) return _provider;
  const { baseUrl, apiKey, model } = FACTCHECK_CONFIG.llm;
  // lm-studio | llama-cpp | ollama — all OpenAI-compatible
  _provider = new OpenAiCompatibleProvider({ baseUrl, apiKey, model });
  return _provider;
}

/** Best-effort health check used by /api/health. */
export async function llmHealth(): Promise<{
  ready: boolean;
  backend: string;
  backendLabel: string;
  model: string;
  baseUrl?: string;
  error?: string;
}> {
  const { backend, backendLabel, baseUrl, model } = FACTCHECK_CONFIG.llm;
  try {
    // For local OpenAI-compatible backends, probe /models (cheap, no tokens).
    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        ready: false,
        backend,
        backendLabel,
        model: model || "(загруженная модель)",
        baseUrl,
        error: `Локальный сервер ответил HTTP ${res.status}. Запустите сервер (${backendLabel}) и проверьте порт.`,
      };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const loaded = data.data?.map((m) => m.id).filter(Boolean) ?? [];
    return {
      ready: true,
      backend,
      backendLabel,
      model: model || loaded[0] || "(загруженная модель)",
      baseUrl,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = `Не удалось подключиться к ${backendLabel} по адресу ${baseUrl}. Проверьте, что локальный сервер запущен. (${msg})`;
    return {
      ready: false,
      backend,
      backendLabel,
      model: model || "",
      baseUrl,
      error: hint,
    };
  }
}

/** Parse JSON even if the model wrapped it in markdown / extra prose. */
export function parseJsonLoose<T>(raw: string): T | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* keep trying */
  }
  // strip ```json ... ``` fences
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* keep trying */
    }
  }
  // grab the outermost {...} or [...]
  const startBrace = trimmed.search(/[[{]/);
  if (startBrace === -1) return undefined;
  const open = trimmed[startBrace];
  const close = open === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(close);
  if (end > startBrace) {
    const slice = trimmed.slice(startBrace, end + 1);
    try {
      return JSON.parse(slice) as T;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Convenience: render a prompt template and ask the LLM for JSON. */
export async function runJsonPrompt<T>(
  template: string,
  vars: Record<string, string>
): Promise<T> {
  const system = fillPrompt(template, vars);
  return getLLM().completeJson<T>("Ты строго следуешь инструкциям пользователя.", system);
}
