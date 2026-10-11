/**
 * GET /api/history  — list recent projects (most recent first, limit 50).
 * DELETE /api/history?id=<projectId> — delete a project.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const projects = await db.project.findMany({
    take: 50,
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { claims: true } },
      report: true,
    },
  });

  return NextResponse.json({
    projects: projects.map((p) => ({
      id: p.id,
      url: p.url,
      mode: p.mode,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      overallVerdict: p.report?.overallVerdict ?? null,
      overallConfidence: p.report?.overallConfidence ?? null,
      claimCount: p._count.claims,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "Параметр id обязателен." },
      { status: 400 }
    );
  }
  try {
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Проект не найден или уже удалён." },
      { status: 404 }
    );
  }
}
