/**
 * Session-based auth middleware.
 *
 * Verifies the signed session token (HMAC-SHA256 via Web Crypto API) on every
 * request. Public paths (/login, /api/login, /api/logout, static assets) are
 * exempt. All other paths require a valid, non-expired token.
 *
 * Banned users: if the token's `banned` flag is true, the user is redirected
 * to /login?banned=1 (pages) or gets 403 JSON (API). The ban flag is set at
 * token-creation time; API routes re-check the DB for the current ban status
 * as a backstop (a user banned after token issuance is blocked on their next
 * API call even if the token still says banned:false).
 *
 * The middleware runs in the Edge Runtime — it uses ONLY Web Crypto API
 * (crypto.subtle) and btoa/atob. No Node.js modules (crypto, fs, etc.) and
 * no Prisma access.
 */

import { NextRequest, NextResponse } from "next/server";
// IMPORTANT: import ONLY from auth-edge (Edge-safe). Do NOT import from
// @/lib/auth — it pulls Node.js `crypto` + Prisma, which crash the Edge
// Runtime. The middleware only needs SESSION_COOKIE + verifySessionToken.
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth-edge";

/** Public paths that bypass auth (login flow + static assets). */
const PUBLIC_PATHS = new Set<string>(["/login", "/api/login", "/api/logout"]);

/** Path prefixes that are always public (Next internals + brand assets). */
const PUBLIC_PREFIXES = [
  "/_next/",
  "/brand/",
  "/logo.svg",
  "/robots.txt",
  "/favicon.ico",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths (login flow).
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  // Public prefixes (static assets, Next internals).
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Read the session cookie.
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const payload = token ? await verifySessionToken(token) : null;

  // Valid token → allow.
  if (payload) {
    // If the token says the user is banned, redirect to login.
    // (API routes re-check the DB for the current ban status as a backstop.)
    if (payload.banned) {
      return bannedResponse(req);
    }
    return NextResponse.next();
  }

  // No valid token → redirect to login (pages) or 401 JSON (API).
  return unauthenticatedResponse(req);
}

function bannedResponse(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    return NextResponse.json(
      { error: "Ваш доступ к сервису ограничен администратором.", banned: true },
      { status: 403 }
    );
  }
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "banned=1";
  return NextResponse.redirect(loginUrl);
}

function unauthenticatedResponse(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    return NextResponse.json(
      {
        error: "Требуется авторизация. Войдите в систему.",
        authRequired: true,
      },
      { status: 401 }
    );
  }
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + (req.nextUrl.search || ""));
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Run on everything except Next internals and static asset files. The
   * middleware itself short-circuits public paths, so the matcher only needs
   * to keep it off the hot path for large static files.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg|brand/).*)",
  ],
};
