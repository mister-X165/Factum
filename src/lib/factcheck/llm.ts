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

import { FACTCHECK_CONFIG, isLocalBackend, type ResponseFormatMode } from "./config";
import { fillPrompt } from "./prompts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMProvider {
  /** Run a chat completion and return the assistant text. */
  complete(messages: ChatMessage[], opts?: { jsonMode?: boolean }): Promise<string>;
  /** Run a chat completion, YIELDING text deltas as they arrive. */
  completeStream(
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number }
  ): AsyncGenerator<string>;
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
      `LLM не ответила за ${Math.round(ms / 1000)} с (таймаут: ${which}). ` +
        `Для локальной модели — увеличьте LLM_TIMEOUT_MS / LLM_IDLE_TIMEOUT_MS в .env либо используйте более быструю модель. ` +
        `Для облачной модели — проверьте интернет-соединение и статус провайдера.`
    );
    this.name = "LLMTimeoutError";
    this.kind = kind;
  }
}

/**
 * Raised when the cloud LLM rejects the request with an HTTP error that
 * retrying cannot fix — 401 (invalid API key), 403 (forbidden), 404 (wrong
 * model name / wrong base URL), 451 (legal block). The caller must NOT retry
 * these; the user has to fix .env.
 */
export class LLMAuthError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    const hints: Record<number, string> = {
      401: "Неверный API-ключ. Проверьте LLM_API_KEY в .env.",
      403: "API-ключ действителен, но нет доступа к модели. Проверьте LLM_MODEL и тарифный план провайдера.",
      404: "Модель или эндпоинт не найден. Проверьте LLM_MODEL и LLM_BASE_URL в .env.",
      451: "Запрос заблокирован по юридическим причинам (региональное ограничение провайдера).",
    };
    const hint = hints[status] || "Проверьте конфигурацию LLM в .env.";
    super(`LLM HTTP ${status}: ${detail}. ${hint}`);
    this.name = "LLMAuthError";
    this.status = status;
  }
}

/**
 * Raised when the cloud LLM returns 429 Too Many Requests. Retryable after a
 * backoff, but if it keeps happening the user needs to upgrade their rate
 * limit or switch provider.
 */
export class LLMRateLimitError extends Error {
  readonly retryAfterMs?: number;
  constructor(detail: string, retryAfterMs?: number) {
    super(
      `Превышен лимит запросов к LLM (429). ${detail}. ` +
        `Подождите немного или уменьшите частоту вызовов конвейера. ` +
        (retryAfterMs ? `Сервер просил подождать ${Math.round(retryAfterMs / 1000)} с. ` : "") +
        `Если это повторяется часто — увеличьте тариф провайдера или используйте другой LLM_PROVIDER.`
    );
    this.name = "LLMRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with ANY server that exposes the standard OpenAI
 * POST /chat/completions endpoint — local OR cloud:
 *
 *   LOCAL (no API key needed):
 *     - LM Studio       (http://127.0.0.1:1234/v1)
 *     - llama.cpp server(http://127.0.0.1:8080/v1)
 *     - Ollama          (http://127.0.0.1:11434/v1)
 *
 *   CLOUD (requires API key + model):
 *     - OpenAI, Z.ai GLM, Mistral, DeepSeek, Groq, OpenRouter,
 *       Google Gemini (OpenAI-compat), Together, Fireworks, Perplexity, xAI.
 *
 * All of them support `stream: true` with
 * `data: {"choices":[{"delta":{"content":"..."}}]}` SSE chunks
 * terminated by `data: [DONE]`.
 *
 * Provider options come entirely from FACTCHECK_CONFIG.llm which reads them
 * from env vars (see config.ts) — the user can switch between local and cloud
 * purely via .env, without touching code.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private idleTimeoutMs: number;
  private maxTokens: number;
  private customHeaders: Record<string, string>;
  private responseFormat: ResponseFormatMode;
  private temperature: number;
  private isCloud: boolean;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxTokens?: number;
    customHeaders?: Record<string, string>;
    responseFormat?: ResponseFormatMode;
    temperature?: number;
    isCloud?: boolean;
  }) {
    // strip a trailing slash so `${baseUrl}/chat/completions` always works
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey || (isLocalBackend() ? "lm-studio" : "");
    this.model = opts.model || "";
    this.timeoutMs = opts.timeoutMs ?? FACTCHECK_CONFIG.llm.timeoutMs;
    this.idleTimeoutMs =
      opts.idleTimeoutMs ?? FACTCHECK_CONFIG.llm.idleTimeoutMs;
    this.maxTokens = opts.maxTokens ?? FACTCHECK_CONFIG.llm.maxTokens;
    this.customHeaders = opts.customHeaders ?? {};
    this.responseFormat = opts.responseFormat ?? FACTCHECK_CONFIG.llm.responseFormat;
    this.temperature = opts.temperature ?? FACTCHECK_CONFIG.llm.temperature;
    this.isCloud = opts.isCloud ?? FACTCHECK_CONFIG.llm.isCloud;
  }

  /**
   * Run a chat completion with streaming + dual timeout (idle / overall).
   * Returns the full concatenated assistant text once the stream ends.
   *
   * When `jsonMode` is true, adds `response_format: { type: "json_object" }`
   * to the request body. Supported by llama.cpp / LM Studio / Ollama — it
   * constrains the output to valid JSON via grammar-based sampling, which
   * eliminates the #1 cause of "LLM JSON parsing failed" (prose-wrapped or
   * structurally invalid JSON from smaller models). Servers that don't
   * recognise the field silently ignore it (per OpenAI API convention).
   */
  async complete(
    messages: ChatMessage[],
    opts?: { jsonMode?: boolean }
  ): Promise<string> {
    let acc = "";
    for await (const piece of this.completeStream(messages, { jsonMode: opts?.jsonMode })) {
      acc += piece;
    }
    return acc;
  }

  /**
   * Streaming variant of complete(): yields assistant text deltas as they
   * arrive from the OpenAI-compatible SSE endpoint. Used by the fullscreen
   * context chat so the answer appears token-by-token instead of after a
   * long silent wait.
   *
   * Same dual-timeout protection as complete(): idle timer reset on every
   * chunk, hard overall ceiling.
   *
   * HTTP error handling: 401/403/404/451 → LLMAuthError (no retry);
   * 429 → LLMRateLimitError (retryable); 5xx → generic Error (retryable).
   */
  async *completeStream(
    messages: ChatMessage[],
    opts?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }
  ): AsyncGenerator<string> {
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
      temperature: opts?.temperature ?? this.temperature,
      stream: true,
      max_tokens: opts?.maxTokens ?? this.maxTokens,
    };
    if (this.model) body.model = this.model;
    // Constrain output to valid JSON when jsonMode is requested.
    // Mode is configurable via LLM_RESPONSE_FORMAT env var because cloud
    // providers vary in their support:
    //   - json_schema: OpenAI gpt-4o+, LM Studio (via grammar). Most strict.
    //   - json_object: universal default for cloud — constrains output to a
    //     valid JSON object but doesn't enforce a specific schema.
    //   - none: don't send response_format at all (some older / smaller servers).
    //
    // CRITICAL: some cloud providers (notably Groq) do NOT support
    // `response_format: json_schema` (Structured Outputs) together with
    // `stream: true`. From Groq's Structured Outputs docs:
    //   "Streaming and tool use are not currently supported with Structured Outputs."
    // Since this provider ALWAYS streams (for the idle-timeout design), we
    // automatically downgrade json_schema → json_object on cloud backends.
    // json_object works with streaming on every OpenAI-compatible server.
    // Local backends (LM Studio, llama.cpp, Ollama) DO support streaming +
    // json_schema (via grammar-based sampling), so we keep json_schema there.
    let effectiveFormat = this.responseFormat;
    if (opts?.jsonMode && this.responseFormat === "json_schema" && this.isCloud) {
      effectiveFormat = "json_object";
    }
    if (opts?.jsonMode && effectiveFormat !== "none") {
      if (effectiveFormat === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "json_output",
            schema: { type: "object" }, // universal schema accepting any JSON object
          },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    // Build headers: Content-Type + Authorization (if API key) + custom.
    // Cloud providers like OpenRouter require extra headers (HTTP-Referer,
    // X-Title) which the user supplies via LLM_HEADERS_JSON in .env.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey
        ? { Authorization: `Bearer ${this.apiKey}` }
        : {}),
      ...this.customHeaders,
    };

    let acc = "";
    let res: Response | null = null;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // Trim long error bodies — some cloud providers return a multi-KB
        // HTML error page for 5xx which is useless to the user.
        const detail = errText.slice(0, 300).replace(/\s+/g, " ").trim();
        // Classify the HTTP error so the caller can decide whether to retry.
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 451) {
          throw new LLMAuthError(res.status, detail || "без тела ответа");
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
          throw new LLMRateLimitError(detail || "без тела ответа", retryAfterMs);
        }
        // 5xx and other errors — generic, retryable.
        throw new Error(
          `${this.baseUrl}/chat/completions → HTTP ${res.status}${detail ? `: ${detail}` : ""}`
        );
      }
      if (!res.body) {
        throw new Error("LLM вернул пустой поток ответа (no body).");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Read SSE chunks. Each chunk resets the idle timer — as long as bytes
      // keep flowing, the request is considered alive.
      let done = false;
      while (!done) {
        const read = await reader.read();
        done = read.done;
        if (done) break;
        armIdle();
        buffer += decoder.decode(read.value, { stream: true });

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
              done = true;
              continue;
            }
            try {
              const chunk = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const piece = chunk.choices?.[0]?.delta?.content ?? "";
              if (piece) {
                acc += piece;
                yield piece;
              }
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
        throw new Error("LLM вернул пустой ответ");
      }
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
      // Best-effort: drain the response body so the connection can be reused.
      if (res && res.body) {
        try {
          // ReadableStream.cancel() may not exist on all runtimes.
          const body = res.body as ReadableStream<Uint8Array> & {
            cancel?: () => Promise<void>;
          };
          await body.cancel?.();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async completeJson<T>(
    systemPrompt: string,
    userPrompt: string,
    opts?: { retries?: number }
  ): Promise<T> {
    const retries = opts?.retries ?? FACTCHECK_CONFIG.llm.retries;
    let lastError: unknown = null;
    /** Track the last raw response so we can include a snippet in the error. */
    let lastRawResponse = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const raw = await this.complete(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          { jsonMode: true }
        );
        lastRawResponse = raw;
        const parsed = parseJsonLoose<T>(raw);
        if (parsed !== undefined) return parsed;
        // repair attempt — also use jsonMode so the model is constrained
        if (attempt < retries) {
          const repaired = await this.complete(
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
              { role: "assistant", content: raw },
              {
                role: "user",
                content:
                  "Твой предыдущий ответ не является валидным JSON. Верни ТОЛЬКО валидный JSON той же структуры, без markdown и пояснений.",
              },
            ],
            { jsonMode: true }
          );
          lastRawResponse = repaired;
          const reparsed = parseJsonLoose<T>(repaired);
          if (reparsed !== undefined) return reparsed;
        }
      } catch (e) {
        lastError = e;
        // Auth errors (401/403/404) — DON'T retry. Retrying a bad API key
        // just wastes time and burns the user's rate-limit budget.
        if (e instanceof LLMAuthError) {
          throw e;
        }
        // Timeouts — DON'T retry blindly. A slow local model will time out
        // the same way again; a cloud 5xx might be worth one retry.
        if (e instanceof LLMTimeoutError) {
          throw e;
        }
        // Rate limits — honor retry-after if present, otherwise backoff.
        if (e instanceof LLMRateLimitError) {
          if (attempt >= retries) throw e;
          const wait = e.retryAfterMs ?? 1000 * attempt;
          await sleep(Math.min(wait, 30_000));
          continue;
        }
        // Other errors (5xx, network) — retry with backoff.
        if (attempt < retries) await sleep(500 * attempt);
      }
    }
    // If we have a real error (timeout/connection/HTTP), throw it.
    if (lastError instanceof Error) throw lastError;
    // Otherwise the LLM responded but we couldn't parse JSON — include a
    // snippet of the last raw response so the user can diagnose what the
    // model actually returned.
    const snippet = lastRawResponse
      ? lastRawResponse.slice(0, 300).replace(/\s+/g, " ").trim()
      : "(пустой ответ)";
    throw new Error(
      `LLM вернула ответ, который не удалось разобрать как JSON после ${retries} попыток. ` +
        `Возможно модель слишком слабая для структурированного вывода, либо ответ обрезан по max_tokens. ` +
        `Начало последнего ответа: "${snippet}". ` +
        `Попробуйте увеличить LLM_MAX_TOKENS, использовать более мощную модель, или проверить, что промпт требует JSON.`
    );
  }
}

/** Singleton provider selected from FACTCHECK_CONFIG.llm. */
let _provider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (_provider) return _provider;
  const { baseUrl, apiKey, model, customHeaders, responseFormat, temperature, isCloud } =
    FACTCHECK_CONFIG.llm;
  _provider = new OpenAiCompatibleProvider({
    baseUrl,
    apiKey,
    model,
    customHeaders,
    responseFormat,
    temperature,
    isCloud,
  });
  return _provider;
}

/** Reset the cached provider — used by tests / hot-reload of env vars. */
export function resetLLM(): void {
  _provider = null;
}

/** Best-effort health check used by /api/health.
 *
 * For LOCAL backends: probe GET /models (cheap, no tokens).
 * For CLOUD backends: probe GET /models with the API key — most cloud
 * providers expose this endpoint and return the list of models the key has
 * access to. If the endpoint is not supported (e.g. some Gemini OpenAI-compat
 * deployments), a 404 is reported as "health endpoint not supported, but the
 * chat endpoint may still work" rather than a hard failure.
 */
export async function llmHealth(): Promise<{
  ready: boolean;
  backend: string;
  backendLabel: string;
  model: string;
  baseUrl?: string;
  error?: string;
}> {
  const { backend, backendLabel, baseUrl, model, apiKey, customHeaders, isCloud } =
    FACTCHECK_CONFIG.llm;

  // No baseUrl → can't probe anything.
  if (!baseUrl) {
    return {
      ready: false,
      backend,
      backendLabel,
      model: model || "",
      baseUrl,
      error: isCloud
        ? `Не задан LLM_BASE_URL для провайдера "${backend}". Укажите его в .env.`
        : "Не задан адрес локального сервера.",
    };
  }

  const headers: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...customHeaders,
  };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    // 401/403 → API key problem (cloud).
    if (res.status === 401 || res.status === 403) {
      return {
        ready: false,
        backend,
        backendLabel,
        model: model || "",
        baseUrl,
        error: `HTTP ${res.status} — неверный или недействительный API-ключ. Проверьте LLM_API_KEY в .env.`,
      };
    }
    // 404 → /models endpoint not supported. Some OpenAI-compatible servers
    // (e.g. certain Gemini-compat deployments) don't expose /models. The chat
    // endpoint may still work — report as ready:true with a caveat.
    if (res.status === 404) {
      return {
        ready: true,
        backend,
        backendLabel,
        model: model || "(неизвестно)",
        baseUrl,
        error: undefined,
      };
    }
    if (!res.ok) {
      return {
        ready: false,
        backend,
        backendLabel,
        model: model || "",
        baseUrl,
        error: `Сервер ответил HTTP ${res.status}. ${
          isCloud
            ? "Проверьте LLM_BASE_URL, LLM_API_KEY и статус провайдера."
            : `Запустите сервер (${backendLabel}) и проверьте порт.`
        }`,
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
    const hint = isCloud
      ? `Не удалось подключиться к ${backendLabel} по адресу ${baseUrl}. Проверьте интернет-соединение, LLM_API_KEY и статус провайдера. (${msg})`
      : `Не удалось подключиться к ${backendLabel} по адресу ${baseUrl}. Проверьте, что локальный сервер запущен. (${msg})`;
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

/**
 * Repair truncated JSON by closing unclosed strings, arrays, and objects.
 *
 * When a local model hits `max_tokens` mid-generation, the output is cut off
 * mid-string or mid-object. This function scans the string tracking nesting
 * depth and string state, then appends the necessary closing characters.
 */
function repairTruncatedJson(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }

  let result = s;
  // If we're inside an unclosed string, close it.
  if (inString) {
    result += '"';
  }
  // Remove a trailing comma if present (would be invalid after closing).
  result = result.replace(/,\s*$/, "");
  // Close all unclosed braces/brackets in reverse order.
  while (stack.length > 0) {
    const opener = stack.pop();
    result += opener === "{" ? "}" : "]";
  }
  return result;
}

/** Parse JSON even if the model wrapped it in markdown / extra prose. */
export function parseJsonLoose<T>(raw: string): T | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();

  // 1. Direct parse.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* keep trying */
  }

  // 2. Strip ```json ... ``` fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* keep trying */
    }
  }

  // 3. Grab the outermost {...} or [...] and try to parse.
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
      /* keep trying — maybe truncated, try repair below */
    }
  }

  // 4. Truncation repair: the response may be cut off mid-generation by
  //    max_tokens. Extract from the first brace/bracket to the end, close
  //    any unclosed structures, and try to parse.
  const fromFirstBrace = trimmed.slice(startBrace);
  const repaired = repairTruncatedJson(fromFirstBrace);
  try {
    return JSON.parse(repaired) as T;
  } catch {
    /* give up */
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
