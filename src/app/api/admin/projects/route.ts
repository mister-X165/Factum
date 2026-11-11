/**
 * GET /api/admin/projects — список последних проектов для админ-панели.
 * Поддерживает управление пометкой «для показа» (showcase).
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    const projects = await db.project.findMany({
      take: 20,
      orderBy: [{ showcase: "desc" }, { createdAt: "desc" }],
      include: {
        user: { select: { username: true } },
        _count: { select: { claims: true } },
        report: { select: { overallVerdict: true, overallConfidence: true } },
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
        username: p.user?.username ?? null,
        claimCount: p._count.claims,
        overallVerdict: p.report?.overallVerdict ?? null,
        overallConfidence: p.report?.overallConfidence ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
