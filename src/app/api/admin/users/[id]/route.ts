/**
 * DELETE /api/admin/users/[id] — delete a user (cascade deletes their
 *                                projects + sessions).
 * PATCH  /api/admin/users/[id] — ban/unban a user, change password, or
 *                                change role (admin ⇄ user).
 *
 * Body for PATCH: {
 *   banned?: boolean,
 *   bannedReason?: string,
 *   password?: string,
 *   role?: "admin" | "user",      // promote / demote
 * }
 *
 * Admin-only. An admin cannot delete, ban, demote or change the password of
 * their OWN account (safety — prevents the last admin from locking
 * themselves out).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  requireAdmin,
  AuthError,
  type UserRole,
} from "@/lib/auth";

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
        { error: "Нельзя удалить свою учётную запись." },
        { status: 400 }
      );
    }

    const target = await db.user.findUnique({ where: { id } });
    if (!target) {
      return NextResponse.json(
        { error: "Пользователь не найден." },
        { status: 404 }
      );
    }

    // Safety: refuse to delete the LAST admin (would leave the system
    // without any administrator — a footgun we want to prevent).
    if (target.role === "admin") {
      const adminCount = await db.user.count({ where: { role: "admin" } });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: "Нельзя удалить последнего администратора. Сначала назначьте другого." },
          { status: 400 }
        );
      }
    }

    // Cascade: deleting the user deletes their projects (onDelete: Cascade
    // in the Project→User relation), which in turn cascades to Document,
    // Claim, Source, Evidence, etc.
    await db.user.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user: admin } = await requireAdmin(req);
    const { id } = await params;

    if (id === admin.id) {
      return NextResponse.json(
        { error: "Нельзя забанить, сменить пароль или роль своей учётной записи." },
        { status: 400 }
      );
    }

    const target = await db.user.findUnique({ where: { id } });
    if (!target) {
      return NextResponse.json(
        { error: "Пользователь не найден." },
        { status: 404 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Ожидается JSON-тело запроса." },
        { status: 400 }
      );
    }

    const data: {
      banned?: boolean;
      bannedReason?: string | null;
      passwordHash?: string;
      role?: string;
    } = {};

    if (typeof (body as { banned?: unknown })?.banned === "boolean") {
      data.banned = (body as { banned: boolean }).banned;
      data.bannedReason = data.banned
        ? (typeof (body as { bannedReason?: unknown })?.bannedReason === "string"
            ? (body as { bannedReason: string }).bannedReason.slice(0, 300)
            : "Доступ ограничен администратором.")
        : null;
    }

    const newPassword = (body as { password?: unknown })?.password;
    if (typeof newPassword === "string" && newPassword.length > 0) {
      if (newPassword.length < 6) {
        return NextResponse.json(
          { error: "Пароль должен быть не короче 6 символов." },
          { status: 400 }
        );
      }
      if (newPassword.length > 1024) {
        return NextResponse.json(
          { error: "Пароль слишком длинный (макс. 1024 символа)." },
          { status: 400 }
        );
      }
      data.passwordHash = hashPassword(newPassword);
    }

    // Role change (promote to admin / demote to user). The role value is
    // canonicalised — any non-"admin" value is treated as "user".
    const roleRaw = (body as { role?: unknown })?.role;
    if (typeof roleRaw === "string") {
      const newRole: UserRole = roleRaw === "admin" ? "admin" : "user";
      if (newRole !== target.role) {
        // Refuse to demote the LAST admin — otherwise an admin could
        // accidentally remove admin rights from every account and lock
        // the system out of the admin panel.
        if (target.role === "admin" && newRole === "user") {
          const adminCount = await db.user.count({ where: { role: "admin" } });
          if (adminCount <= 1) {
            return NextResponse.json(
              {
                error:
                  "Нельзя понизить роль последнего администратора. Сначала назначьте другого админа.",
              },
              { status: 400 }
            );
          }
        }
        data.role = newRole;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "Нет полей для обновления. Используйте banned, bannedReason, password или role." },
        { status: 400 }
      );
    }

    const updated = await db.user.update({
      where: { id },
      data,
    });
    return NextResponse.json({
      ok: true,
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role as UserRole,
        banned: updated.banned,
        bannedReason: updated.bannedReason,
        createdAt: updated.createdAt.toISOString(),
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
