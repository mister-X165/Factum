/**
 * POST /api/analyze
 *
 * Streams SSE events as the fact-checking pipeline runs.
 *
 * Body: { url: string; mode: "CONTROLLED" | "RESEARCH" }
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
  const modeRaw = (body as { mode?: unknown })?.mode;
  if (typeof url !== "string" || !url.trim()) {
    return new Response(
      JSON.stringify({ error: "Параметр url обязателен." }),
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
        const { projectId, result } = await runPipeline({ url, mode }, emit);
        if (!result) {
          // runPipeline already emitted an `error` event; close the stream.
        }
        // the runPipeline emits `done` itself — nothing more to do here.
        void projectId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
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
