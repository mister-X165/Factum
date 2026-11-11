/**
 * DELETE /api/admin/users/[id]/history — delete ALL projects for a user.
 *
 * Runs in a transaction. Running projects (status="running") are protected
 * from deletion so a clear mid-analysis doesn't corrupt the live pipeline.
 * Cascade deletes clean all child tables (Document, Claim, Source, Evidence,
 * Verdict, VerdictVersion, Report, AuditEvent) per the Prisma schema.
 *
 * Admin-only. An admin cannot clear their own history through this endpoint
 * (they should use the regular Settings → Очистить историю for that).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: 500 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user: admin } = await requireAdmin(req);
    const { id } = await params;

    if (id === admin.id) {
      return NextResponse.json(
        {
          error:
            "Используйте Настройки → Очистить историю для своей учётной записи.",
        },
        { status: 400 }
      );
    }

    const target = await db.user.findUnique({
      where: { id },
      select: { id: true, username: true },
    });
    if (!target) {
      return NextResponse.json(
        { error: "Пользователь не найден." },
        { status: 404 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      const deleted = await tx.project.deleteMany({
        where: {
          userId: id,
          status: { not: "running" },
        },
      });
      return deleted.count;
    });

    return NextResponse.json({ ok: true, deleted: result, username: target.username });
  } catch (e) {
    return handleError(e);
  }
}
