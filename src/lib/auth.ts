/**
 * Authentication core (Node.js runtime only): password hashing, DB-backed
 * user lookup, admin bootstrap, and request helpers for API routes.
 *
 * Re-exports the Edge-safe primitives (session token sign/verify, base64url,
 * SESSION_COOKIE) from `./auth-edge` so consumers can import everything from
 * a single module.
 *
 * IMPORTANT: this file imports Node.js `crypto` (scryptSync, randomBytes,
 * timingSafeEqual) and Prisma (`@/lib/db`). It MUST NOT be imported from
 * `src/middleware.ts` (which runs in the Edge Runtime). The middleware
 * imports only from `./auth-edge`.
 */

import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";

// Re-export everything from the Edge-safe module so consumers can import
// from "@/lib/auth" and get both Edge-safe and Node.js-specific functions.
export {
  SESSION_COOKIE,
  TOKEN_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
  b64urlEncode,
  b64urlDecode,
  type SessionPayload,
  type UserRole,
} from "./auth-edge";

import {
  SESSION_COOKIE,
  createSessionToken,
  verifySessionToken,
  type SessionPayload,
  type UserRole,
} from "./auth-edge";

/** Public user info (no password hash) — returned to the client. */
export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  banned: boolean;
  bannedReason?: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Password hashing (Node.js runtime only — scryptSync is not in Edge Runtime)
// ---------------------------------------------------------------------------

/** Hash a password using scrypt. Returns "saltHex:hashHex". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a password against a stored "saltHex:hashHex" string.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const colonIdx = stored.indexOf(":");
  if (colonIdx < 0) return false;
  const saltHex = stored.slice(0, colonIdx);
  const hashHex = stored.slice(colonIdx + 1);
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expectedHash = Buffer.from(hashHex, "hex");
    const actualHash = scryptSync(password, salt, 64);
    if (expectedHash.length !== actualHash.length) return false;
    return timingSafeEqual(expectedHash, actualHash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request helpers (used by API route handlers in the Node.js runtime)
// ---------------------------------------------------------------------------

/** Extract the session token from a Request's cookie header. */
export function getTokenFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      return trimmed.slice(SESSION_COOKIE.length + 1);
    }
  }
  return null;
}

/**
 * Get the current authenticated user from a request, re-checking the DB for
 * the latest ban status. Returns null if not authenticated or banned.
 *
 * API routes call this to enforce auth + ownership. The middleware's
 * signature check is the fast path; this is the authoritative check.
 */
export async function getCurrentUser(req: Request): Promise<{
  user: PublicUser & { passwordHash?: string };
  payload: SessionPayload;
} | null> {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  // Re-read the user from the DB to get the CURRENT ban status AND the
  // current role (the token's role may be stale if the user was just
  // promoted/demoted by an admin). Banned users are treated as
  // unauthenticated — they get the same 401 as a logged-out visitor, which
  // the middleware's redirect to /login then surfaces.
  const dbUser = await db.user.findUnique({ where: { id: payload.uid } });
  if (!dbUser) return null;
  if (dbUser.banned) return null; // banned → treat as unauthenticated

  return {
    user: {
      id: dbUser.id,
      username: dbUser.username,
      role: dbUser.role as UserRole,
      banned: dbUser.banned,
      bannedReason: dbUser.bannedReason,
      createdAt: dbUser.createdAt.toISOString(),
      passwordHash: dbUser.passwordHash,
    },
    payload,
  };
}

/** Like getCurrentUser but throws AuthError(401) for unauthenticated requests. */
export async function requireUser(req: Request): Promise<{
  user: PublicUser;
  payload: SessionPayload;
}> {
  const result = await getCurrentUser(req);
  if (!result) {
    throw new AuthError(401, "Требуется авторизация. Войдите в систему.");
  }
  return { user: stripHash(result.user), payload: result.payload };
}

/** Like requireUser but also requires the admin role. Throws AuthError(403). */
export async function requireAdmin(req: Request): Promise<{
  user: PublicUser;
  payload: SessionPayload;
}> {
  const { user, payload } = await requireUser(req);
  if (user.role !== "admin") {
    throw new AuthError(403, "Доступ только для администратора.");
  }
  return { user, payload };
}

/** Remove passwordHash before sending to the client. */
export function stripHash<T extends { passwordHash?: string }>(user: T): Omit<T, "passwordHash"> {
  const { passwordHash, ...rest } = user;
  void passwordHash;
  return rest;
}

/** Error class that carries an HTTP status + message for API routes. */
export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Admin bootstrap (runs once on cold start if the User table is empty)
// ---------------------------------------------------------------------------

/**
 * In-flight / completed bootstrap promise (singleton).
 *
 * CRITICAL HISTORY: previously this module used a plain `_bootstrapDone:
 * boolean` flag that was set to `true` SYNCHRONOUSLY at the start of
 * `bootstrapAdmin()`, BEFORE the async DB work ran. That caused two real,
 * observed bugs:
 *
 *   1. Race on cold start: the module-level `void bootstrapAdmin();` kick-off
 *      flipped the flag immediately, but the actual `db.user.create()` was
 *      still in flight. The first `POST /api/login` then called
 *      `await bootstrapAdmin();` — which returned INSTANTLY because the flag
 *      was already `true` — and proceeded to `db.user.findUnique({ username })`
 *      BEFORE the admin row had been written. Result: the very first login
 *      attempt on a fresh DB returned 401 "Неверное имя пользователя или
 *      пароль", even though the admin was created milliseconds later. The
 *      user could only log in on the SECOND attempt.
 *
 *   2. No retry on failure: if the bootstrap DB call ever failed (transient
 *      SQLite lock, missing schema, etc.), the flag was already `true`, so
 *      every subsequent call returned immediately and the admin was NEVER
 *      created — the server was permanently un-login-able until a restart.
 *
 * THE FIX: hold a `Promise<void>` instead. The first caller kicks off the
 * DB work, every concurrent and subsequent caller awaits the SAME in-flight
 * promise (so they actually wait for the admin row to commit). On rejection
 * the cache is cleared so the next call retries. The cached promise NEVER
 * rejects — callers don't need to handle a bootstrap failure; they just
 * proceed and let `db.user.findUnique` return null → 401, which is the truth.
 */
let _bootstrapPromise: Promise<void> | null = null;

/** Internal: actual bootstrap logic. Throws on failure (caller swallows). */
async function doBootstrap(): Promise<void> {
  const count = await db.user.count();
  if (count > 0) return;
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = (process.env.ADMIN_PASSWORD || "admin").trim();
  try {
    await db.user.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        role: "admin",
      },
    });
  } catch (e: unknown) {
    // P2002 = unique-constraint violation — another concurrent request
    // (or a parallel cold-start worker) created the admin first. Treat as
    // success: the admin row exists, which is what we wanted.
    const code = (e as { code?: string } | null)?.code;
    if (code !== "P2002") throw e;
  }
  if (password === "admin") {
    console.warn(
      `[factum] Создан admin-пользователь "${username}" с паролем по умолчанию "admin". ` +
        `Срочно смените пароль через создание нового пользователя в Администрировании.`
    );
  } else {
    console.log(`[factum] Создан admin-пользователь "${username}".`);
  }
}

/**
 * Create the initial admin user from env vars if the User table is empty.
 * Idempotent, concurrency-safe and retried on transient DB failures.
 *
 * Returns a promise that ALWAYS resolves (never rejects). The first call
 * kicks off the DB work; concurrent and subsequent calls await the SAME
 * cached promise — so they actually wait for the admin row to land in the
 * DB rather than returning early on a stale "done" flag. On DB failure the
 * cache is cleared and the next call retries.
 *
 * Env vars:
 *   ADMIN_USERNAME — default "admin"
 *   ADMIN_PASSWORD — default "admin" (with a console warning to change it)
 */
export function bootstrapAdmin(): Promise<void> {
  if (_bootstrapPromise) return _bootstrapPromise;
  const p = doBootstrap().catch((e) => {
    // Clear the cache so the next call can retry — a transient DB error on
    // cold start must NOT permanently block admin creation.
    _bootstrapPromise = null;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[factum] Не удалось создать admin-пользователя: ${msg}`);
  });
  _bootstrapPromise = p;
  return p;
}

// Trigger bootstrap on module load (non-blocking, fire-and-forget). The
// first /api/login call will `await bootstrapAdmin()` and properly wait for
// the same in-flight promise to resolve before querying the User table.
void bootstrapAdmin();
