/**
 * GET /api/admin/stats — overall statistics for the admin dashboard.
 *
 * Returns:
 *   - totalUsers (by role)
 *   - bannedUsers count
 *   - totalProjects (by status)
 *   - projectsThisWeek
 *   - mostActiveUsers (top 5 by project count)
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError, type UserRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

    const [
      totalUsers,
      adminCount,
      bannedCount,
      totalProjects,
      runningProjects,
      completedProjects,
      failedProjects,
      projectsThisWeek,
      topUsersRaw,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: "admin" } }),
      db.user.count({ where: { banned: true } }),
      db.project.count(),
      db.project.count({ where: { status: "running" } }),
      db.project.count({ where: { status: "completed" } }),
      db.project.count({ where: { status: "failed" } }),
      db.project.count({ where: { createdAt: { gte: oneWeekAgo } } }),
      db.user.findMany({
        take: 5,
        orderBy: { projects: { _count: "desc" } },
        select: {
          id: true,
          username: true,
          role: true,
          banned: true,
          _count: { select: { projects: true } },
          projects: {
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
    ]);

    const topUsers = topUsersRaw.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role as UserRole,
      banned: u.banned,
      projectCount: u._count.projects,
      lastActivity: u.projects[0]?.createdAt.toISOString() ?? null,
    }));

    return NextResponse.json({
      users: {
        total: totalUsers,
        admins: adminCount,
        regular: totalUsers - adminCount,
        banned: bannedCount,
      },
      projects: {
        total: totalProjects,
        running: runningProjects,
        completed: completedProjects,
        failed: failedProjects,
        thisWeek: projectsThisWeek,
      },
      topUsers,
    });
  } catch (e) {
    return handleError(e);
  }
}
