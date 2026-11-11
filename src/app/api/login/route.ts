/**
 * POST /api/login
 *
 * Body: { username: string, password: string }
 *
 * Verifies the username/password against the User table (scrypt), then
 * creates a signed session token and sets it as an httpOnly cookie.
 *
 * Banned users receive a 403 with a clear message.
 *
 * The optional ?next=<path> query param is echoed back so the browser client
 * can navigate there after a successful login.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hit, tooManyRequests } from "@/lib/ratelimit";
import {
  SESSION_COOKIE,
  TOKEN_TTL_SECONDS,
  createSessionToken,
  verifyPassword,
  hashPassword,
  bootstrapAdmin,
  stripHash,
  type PublicUser,
  type UserRole,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

function toPublicUser(u: {
  id: string;
  username: string;
  role: string;
  banned: boolean;
  bannedReason: string | null;
  createdAt: Date;
}): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role as UserRole,
    banned: u.banned,
    bannedReason: u.bannedReason,
    createdAt: u.createdAt.toISOString(),
  };
}

/**
 * Keep the post-login redirect target strictly internal (same-origin).
 *
 * The ?next=<path> query param is echoed back to the client, which does
 * router.replace(data.next). Without this check, /login?next=https://evil.com
 * (or ?next=//evil.com) would bounce a freshly-logged-in user to an external
 * site — a classic open-redirect / phishing vector.
 *
 * Allowed: "/", "/history", "/history/abc?tab=2" — anything that starts
 * with a single "/" and contains no scheme.
 * Rejected: "//evil.com", "https://evil.com", "javascript:alert(1)".
 */
function safeInternalPath(raw: string | null): string {
  const value = (raw || "").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/"; // protocol-relative external URL
  if (value.includes("://")) return "/"; // absolute URL with scheme
  return value;
}

export async function POST(req: NextRequest) {
  // Brute-force protection: cap login attempts per client IP. 10 attempts
  // per 15 minutes is far above what a human typing credentials needs, but
  // stops an online password-guessing run. (The limiter is in-memory —
  // restarting the server resets the counter; when deploying behind a
  // reverse proxy like Caddy, the client IP in X-Forwarded-For is the
  // real one.)
  const verdict = hit(req, { key: "login", max: 10, windowMs: 15 * 60_000 });
  if (!verdict.ok) return tooManyRequests(verdict);

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
  if (typeof username !== "string" || !username.trim()) {
    return NextResponse.json(
      { error: "Введите имя пользователя." },
      { status: 400 }
    );
  }
  if (typeof password !== "string" || !password) {
    return NextResponse.json(
      { error: "Введите пароль." },
      { status: 400 }
    );
  }

  // Make sure the admin exists before attempting login. bootstrapAdmin()
  // returns a cached promise that ALWAYS resolves (never rejects) — so this
  // await is safe even if the underlying DB write failed. On a fresh DB the
  // await actually waits for the admin row to commit before we query it,
  // fixing the previous "first login after cold start returns 401" race.
  await bootstrapAdmin();

  const user = await db.user.findUnique({
    where: { username: username.trim() },
  });
  // Use the same error message for "user not found" and "wrong password"
  // to avoid username enumeration.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json(
      { error: "Неверное имя пользователя или пароль." },
      { status: 401 }
    );
  }
  if (user.banned) {
    return NextResponse.json(
      {
        error:
          user.bannedReason
            ? `Доступ ограничен: ${user.bannedReason}`
            : "Доступ ограничен администратором.",
        banned: true,
      },
      { status: 403 }
    );
  }

  // Success — create the signed session token. createSessionToken() throws
  // if AUTH_SECRET is unset; surface a helpful 500 instead of a stack trace.
  const next = safeInternalPath(req.nextUrl.searchParams.get("next"));
  let token: string;
  try {
    token = await createSessionToken({
      id: user.id,
      username: user.username,
      role: user.role as UserRole,
      banned: user.banned,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        error:
          `Сбой генерации session-токена: ${msg}. ` +
          `Проверьте, что в .env задан AUTH_SECRET (случайная строка ≥ 32 симв.).`,
      },
      { status: 500 }
    );
  }
  const res = NextResponse.json({
    ok: true,
    next,
    user: toPublicUser(user),
  });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TOKEN_TTL_SECONDS,
  });
  return res;
}

// Exported for potential use by the admin "reset password" flow.
export { hashPassword, stripHash };
