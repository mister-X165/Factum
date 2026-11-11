/**
 * GET /api/admin/users  — list all users with statistics (project count,
 *                         last activity, banned status).
 * POST /api/admin/users — create a new user (username, password, role).
 *
 * Admin-only: returns 403 for non-admin users.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  requireAdmin,
  AuthError,
  type PublicUser,
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

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const users = await db.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { projects: true } },
        projects: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    const result = users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role as UserRole,
      banned: u.banned,
      bannedReason: u.bannedReason,
      createdAt: u.createdAt.toISOString(),
      projectCount: u._count.projects,
      lastActivity: u.projects[0]?.createdAt.toISOString() ?? null,
    }));
    return NextResponse.json({ users: result });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Ожидается JSON-тело запроса." },
        { status: 400 }
      );
    }
    const username = (body as { username?: unknown })?.username;
    const password = (body as { password?: unknown })?.password;
    const roleRaw = (body as { role?: unknown })?.role;

    if (typeof username !== "string" || username.trim().length < 3) {
      return NextResponse.json(
        { error: "Имя пользователя должно быть не короче 3 символов." },
        { status: 400 }
      );
    }
    if (typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "Пароль должен быть не короче 6 символов." },
        { status: 400 }
      );
    }
    if (password.length > 1024) {
      return NextResponse.json(
        { error: "Пароль слишком длинный (макс. 1024 символа)." },
        { status: 400 }
      );
    }
    // Username: 3–64 chars, letters/digits/_-. — prevent weird/empty names
    // and accidental whitespace-only entries that look like real accounts.
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 64) {
      return NextResponse.json(
        { error: "Имя пользователя должно быть от 3 до 64 символов." },
        { status: 400 }
      );
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(trimmedUsername)) {
      return NextResponse.json(
        { error: "Имя пользователя может содержать только латинские буквы, цифры, _ . -" },
        { status: 400 }
      );
    }
    const role: UserRole = roleRaw === "admin" ? "admin" : "user";

    // Check for existing username.
    const existing = await db.user.findUnique({
      where: { username: trimmedUsername },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Пользователь с таким именем уже существует." },
        { status: 409 }
      );
    }

    const created = await db.user.create({
      data: {
        username: trimmedUsername,
        passwordHash: hashPassword(password),
        role,
      },
    });
    const publicUser: PublicUser = {
      id: created.id,
      username: created.username,
      role: created.role as UserRole,
      banned: created.banned,
      bannedReason: created.bannedReason,
      createdAt: created.createdAt.toISOString(),
    };
    return NextResponse.json({ user: publicUser }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
