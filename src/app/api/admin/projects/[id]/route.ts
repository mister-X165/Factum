/**
 * PATCH /api/admin/projects/[id] — toggle the "showcase" flag on a project.
 * Body: { showcase?: boolean } — without a body, toggles the current value.
 *
 * Showcased projects appear at the top of history lists.
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(req);
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
    select: { id: true, showcase: true },
  });
  if (!project) {
    return NextResponse.json(
      { error: "Проект не найден или уже удалён." },
      { status: 404 }
    );
  }

  // Явное значение из тела либо переключение текущего.
  let target: boolean | null = null;
  try {
    const body = (await req.json()) as { showcase?: unknown };
    if (typeof body?.showcase === "boolean") target = body.showcase;
  } catch {
    // пустое тело — переключаем
  }
  const showcase = target ?? !project.showcase;

  const updated = await db.project.update({
    where: { id },
    data: { showcase },
    select: { id: true, showcase: true },
  });

  return NextResponse.json({ ok: true, id: updated.id, showcase: updated.showcase });
}
