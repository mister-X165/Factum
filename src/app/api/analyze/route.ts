/**
 * POST /api/analyze
 *
 * Streams SSE events as the fact-checking pipeline runs.
 *
 * Body: { url: string; mode: "CONTROLLED" | "RESEARCH" }
 *    or: { text: string; mode: "CONTROLLED" | "RESEARCH" } — проверка
 *        вставленного фрагмента текста (от 200 символов) без загрузки URL.
 * Response: text/event-stream of PipelineEvent.
 *
 * ----------------------------------------------------------------------------
 * SSE keep-alive: while the pipeline is running (and a slow local LLM may
 * stay silent for minutes during one stage), we emit a `: heartbeat` comment
 * every 15 s. This prevents proxies / browsers / the Caddy gateway from
 * closing an apparently-idle connection, which previously caused the stream
 * to die mid-analysis on slow models.
 */

import { NextRequest } from "next/server";
import { runPipeline } from "@/lib/factcheck/orchestrator";
import { hit, tooManyRequests } from "@/lib/ratelimit";
import { requireUser, AuthError } from "@/lib/auth";
import type { PipelineEvent } from "@/lib/factcheck/types";

export const dynamic = "force-dynamic";
/** Generous ceiling for the whole pipeline (slow local models). */
export const maxDuration = 1800; // 30 min

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

function sseChunk(ev: PipelineEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

function heartbeatChunk(): Uint8Array {
  // SSE comment — ignored by EventSource / our parser, but keeps the bytes
  // flowing so the connection isn't reaped as idle.
  return encoder.encode(`: heartbeat\n\n`);
}

export async function POST(req: NextRequest) {
  // Auth: require a logged-in user. The user's id is attached to the project
  // so admins can see who ran what and users only see their own checks.
  let authUser: { id: string; username: string };
  try {
    const { user } = await requireUser(req);
    authUser = { id: user.id, username: user.username };
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw e;
  }

  // Rate limit: a full pipeline is expensive (many LLM calls), so cap it at
  // 4 runs / hour / IP. The global pipeline lock in the orchestrator still
  // enforces one concurrent run.
  const verdict = hit(req, { key: "analyze", max: 4, windowMs: 60 * 60_000 });
  if (!verdict.ok) return tooManyRequests(verdict);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Ожидается JSON-тело запроса." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = (body as { url?: unknown })?.url;
  const text = (body as { text?: unknown })?.text;
  const modeRaw = (body as { mode?: unknown })?.mode;

  // Либо URL, либо вставленный фрагмент текста (≥ 200 символов).
  const hasText = typeof text === "string" && text.trim().length >= 200;
  const hasUrl = typeof url === "string" && url.trim().length > 0;
  if (!hasText && !hasUrl) {
    return new Response(
      JSON.stringify({
        error: hasText === false && typeof text === "string"
          ? "Фрагмент текста слишком короткий: нужно не менее 200 символов, чтобы выделить проверяемые утверждения."
          : "Укажите URL материала или вставьте фрагмент текста (от 200 символов).",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const mode = modeRaw === "RESEARCH" ? "RESEARCH" : "CONTROLLED";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (ev: PipelineEvent) => {
        if (closed) return;
        try {
          controller.enqueue(sseChunk(ev));
        } catch {
          closed = true;
        }
      };

      // Heartbeat: a comment line every 15 s while the pipeline is busy.
      // Cleared in the finally block below once the pipeline ends.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeatChunk());
        } catch {
          closed = true;
        }
      }, HEARTBEAT_INTERVAL_MS);

      try {
        const { projectId, result } = await runPipeline(
          hasText
            ? { text: text as string, mode, userId: authUser.id }
            : { url: url as string, mode, userId: authUser.id },
          emit,
        );
        if (!result) {
          // runPipeline уже отправил событие error и пометил проект как failed
          // в БД — дополнительно закрывать поток не нужно.
        }
        // the runPipeline emits `done` itself — nothing more to do here.
        void projectId;
      } catch (e) {
        // Защита от неожиданных исключений внутри runPipeline (внутренняя ошибка
        // модуля, неперехваченный reject). Отправляем человекочитаемое сообщение
        // вместо технического stack-trace.
        const raw = e instanceof Error ? e.message : String(e);
        const msg = humanizeBackendError(raw);
        emit({ type: "error", message: msg });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        closed = true;
      }
    },
    cancel() {
      // client disconnected — ReadableStream will be closed automatically.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Преобразует технические ошибки backend-сервисов в понятные сообщения на
 * русском. Если сообщение уже на русском (например, от orchestrator) или
 * несёт не угадываемую техническую причину — возвращаем как есть.
 */
function humanizeBackendError(raw: string): string {
  if (!raw) return "Непредвиденная ошибка при выполнении проверки. Повторите запрос.";
  const e = raw.toLowerCase();
  // Уже переведённые orchestrator-сообщения возвращаем как есть.
  if (/[Ѐ-ӿ]/.test(raw) && raw.length > 20) return raw;
  if (/timeout|timed out|ETIMEDOUT/.test(e)) {
    return "Превышено время ожидания ответа от LLM-сервиса. Повторите запрос через минуту.";
  }
  if (/rate limit|429/.test(e)) {
    return "Превышен лимит запросов к LLM-сервису. Повторите попытку через 30–60 секунд.";
  }
  if (/econnreset|econnrefused|fetch failed|network/.test(e)) {
    return "Не удалось связаться с внешним сервисом (LLM или поиск). Проверьте сетевое подключение сервера.";
  }
  if (/api[- ]?key|unauthorized|401/.test(e)) {
    return "Ошибка авторизации LLM-сервиса. Обратитесь к администратору — возможно, неверно задан API-ключ.";
  }
  if (/model.*not found|404/.test(e)) {
    return "Указанная модель LLM недоступна. Обратитесь к администратору для проверки настроек.";
  }
  if (/database|prisma|sqlite/.test(e)) {
    return "Ошибка базы данных. Обратитесь к администратору — возможно, переполнен диск или недоступен каталог db/.";
  }
  return `Непредвиденная ошибка при выполнении проверки: ${raw}`;
}
