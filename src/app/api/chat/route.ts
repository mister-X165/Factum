/**
 * POST /api/chat
 *
 * Fullscreen context chat. Two modes:
 *  - { projectId, messages[] } — chat about a finished fact-check project;
 *    the analysis context (claims / sources / verdicts / audit trail) is
 *    injected AUTOMATICALLY on the server.
 *  - { messages[] } — general mode: the assistant explains how the system
 *    works, without any project context.
 *
 * Response: text/event-stream of ChatStreamEvent:
 *   data: {"type":"delta","text":"…"}   — incremental answer text
 *   data: {"type":"done"}
 *   data: {"type":"error","message":"…"}
 *
 * Prompt-injection hardening: user messages are sanitised + capped; the
 * context is framed as untrusted data in the system prompt (see chat.ts).
 */

import { NextRequest } from "next/server";
import {
  buildChatContextBlock,
  CHAT_LIMITS,
  sanitizeChatInput,
  streamChatAnswer,
} from "@/lib/factcheck/chat";
import { hit, tooManyRequests } from "@/lib/ratelimit";
import { requireUser, AuthError } from "@/lib/auth";
import { db } from "@/lib/db";
import type { ChatExchange, ChatStreamEvent } from "@/lib/factcheck/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min for one chat answer

const encoder = new TextEncoder();

function sse(ev: ChatStreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

export async function POST(req: NextRequest) {
  // Auth: require a logged-in user.
  let authUser;
  try {
    authUser = (await requireUser(req)).user;
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw e;
  }

  // Rate limit: 40 chat turns / hour / IP (cheap single LLM call each).
  const verdict = hit(req, { key: "chat", max: 40, windowMs: 60 * 60_000 });
  if (!verdict.ok) return tooManyRequests(verdict);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Ожидается JSON-тело запроса." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const projectIdRaw = (body as { projectId?: unknown })?.projectId;
  const projectId =
    typeof projectIdRaw === "string" && projectIdRaw.trim().length > 0
      ? projectIdRaw.trim()
      : null;
  const rawMessages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages[] обязателен." }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // Ownership check: if a projectId is supplied, the caller must own that
  // project OR be an admin. Without this, ANY logged-in user could chat
  // about ANY project id they guessed — leaking other users' private
  // fact-check results (claims, sources, verdicts, audit trail).
  if (projectId) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });
    if (!project) {
      return new Response(
        JSON.stringify({ error: "Проект не найден." }),
        { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }
    if (project.userId !== authUser.id && authUser.role !== "admin") {
      return new Response(
        JSON.stringify({ error: "Нет прав на обращение к этому проекту." }),
        { status: 403, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }
  }

  // Sanitise + cap the chat history the client is allowed to send.
  const history: ChatExchange[] = [];
  for (const m of rawMessages.slice(-CHAT_LIMITS.maxMessages)) {
    const role = (m as { role?: unknown })?.role;
    const content = sanitizeChatInput(String((m as { content?: unknown })?.content ?? ""));
    if (!content) continue;
    if (role !== "user" && role !== "assistant") continue;
    history.push({ role, content });
  }
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return new Response(
      JSON.stringify({ error: "Последним сообщением должен быть вопрос пользователя." }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // Build the analysis context server-side (never trusted from the client).
  // General mode (no projectId) → empty context block.
  let contextBlock = "";
  if (projectId) {
    try {
      contextBlock = await buildChatContextBlock(projectId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("PROJECT_NOT_FOUND")) {
        return new Response(
          JSON.stringify({ error: "Проект не найден." }),
          { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }
      return new Response(
        JSON.stringify({ error: `Не удалось собрать контекст: ${msg}` }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const push = (ev: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(sse(ev));
        } catch {
          closed = true;
        }
      };
      // Keep the connection alive while the model thinks.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          closed = true;
        }
      }, 10_000);

      try {
        const gen = streamChatAnswer(projectId, contextBlock, history);
        for await (const piece of gen) {
          push({ type: "delta", text: piece });
        }
        push({ type: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        push({ type: "error", message: `Ошибка модели: ${msg}` });
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
