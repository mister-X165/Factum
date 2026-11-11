/**
 * GET /api/history  — list recent projects.
 *   - Regular users see only their own projects.
 *   - Admins see ALL projects (including legacy ones with null userId).
 *
 * DELETE /api/history?id=<projectId> — delete a single project (owner or admin).
 * DELETE /api/history                — delete ALL of the current user's
 *                                      projects (bulk clear). Admin clearing
 *                                      all-system history uses the admin
 *                                      endpoints instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: 500 });
}

export async function GET(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser(req));
  } catch (e) {
    return handleError(e);
  }

  // Regular users see only their own projects. Admins see all.
  // Showcase-проекты (пометка «для показа» из админки) поднимаются наверх.
  const where = user.role === "admin" ? {} : { userId: user.id };

  const projects = await db.project.findMany({
    where,
    take: 50,
    orderBy: [{ showcase: "desc" }, { createdAt: "desc" }],
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
      showcase: p.showcase,
      createdAt: p.createdAt.toISOString(),
      overallVerdict: p.report?.overallVerdict ?? null,
      overallConfidence: p.report?.overallConfidence ?? null,
      claimCount: p._count.claims,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    ({ user } = await requireUser(req));
  } catch (e) {
    return handleError(e);
  }

  const id = req.nextUrl.searchParams.get("id");

  // Bulk clear: no id param → delete all of the current user's projects.
  if (!id) {
    try {
      const where =
        user.role === "admin"
          ? { status: { not: "running" } }
          : { userId: user.id, status: { not: "running" } };
      const result = await db.$transaction(async (tx) => {
        const deleted = await tx.project.deleteMany({ where });
        return deleted.count;
      });
      return NextResponse.json({ ok: true, deleted: result });
    } catch (e) {
      return handleError(e);
    }
  }

  // Single-project delete — owner or admin only.
  try {
    const project = await db.project.findUnique({
      where: { id },
      select: { userId: true, status: true },
    });
    if (!project) {
      return NextResponse.json(
        { error: "Проект не найден или уже удалён." },
        { status: 404 }
      );
    }
    if (project.userId !== user.id && user.role !== "admin") {
      return NextResponse.json(
        { error: "Нет прав на удаление этого проекта." },
        { status: 403 }
      );
    }
    await db.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
