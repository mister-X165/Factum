/**
 * GET /api/me — returns the currently authenticated user's public info.
 *
 * Used by the client to know who is logged in (for the Topbar profile,
 * admin nav visibility, etc.) without parsing the httpOnly session cookie.
 *
 * Returns 401 if not authenticated.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser, AuthError } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireUser(req);
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
