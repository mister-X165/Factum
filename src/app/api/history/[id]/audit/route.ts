/**
 * GET /api/history/[id]/audit — журнал аудита проекта (AuditEvent).
 * Каждое событие: стадия, уровень, сообщение, деталь, время. Порядок —
 * хронологический, лимит 300 записей (для длинных перепроверок).
 *
 * Ownership: project owner or admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { STAGE_LABELS_RU, type PipelineStage } from "@/lib/factcheck/types";
import { requireUser, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    ({ user } = await requireUser(req));
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const { id } = await params;

  const project = await db.project.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
  }
  if (project.userId !== user.id && user.role !== "admin") {
    return NextResponse.json(
      { error: "Нет прав на просмотр аудита этого проекта." },
      { status: 403 }
    );
  }

  const events = await db.auditEvent.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "asc" },
    take: 300,
  });

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      stage: e.stage,
      stageLabelRu: STAGE_LABELS_RU[e.stage as PipelineStage] ?? e.stage,
      level: e.level,
      message: e.message,
      detail: e.detail ?? undefined,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
