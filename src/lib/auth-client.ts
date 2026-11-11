"use client";

/**
 * Client-side auth helpers.
 *
 * The real session cookie (`factum-session`) is httpOnly and therefore not
 * readable from JavaScript. We use /api/health (which reports the current
 * user) and /api/me as the source of truth for "who is logged in" on the
 * client side.
 */

import type { PublicUser } from "@/lib/factcheck/types";

/** Fetch the current user from /api/me. Returns null if not authenticated. */
export async function fetchCurrentUser(): Promise<PublicUser | null> {
  try {
    const r = await fetch("/api/me", { cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json()) as { user?: PublicUser };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** Logout: POST /api/logout then reload to /login. */
export async function logoutAndReload(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* network error — proceed to navigate anyway */
  }
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
}
