/**
 * GET /api/history/[id] — return the full AnalysisResult for a project id.
 *
 * Ownership: the project's userId must match the current user's id, OR the
 * current user must be an admin. Legacy projects (null userId) are admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { toAnalysisResult } from "@/lib/factcheck/orchestrator";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  // Ownership check: load the project row first.
  const project = await db.project.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!project) {
    return NextResponse.json(
      { error: "Проект не найден." },
      { status: 404 }
    );
  }
  if (project.userId !== user.id && user.role !== "admin") {
    return NextResponse.json(
      { error: "Нет прав на просмотр этого проекта." },
      { status: 403 }
    );
  }

  const result = await toAnalysisResult(id);
  if (!result) {
    return NextResponse.json(
      { error: "Проект не найден." },
      { status: 404 }
    );
  }
  return NextResponse.json(result);
}
