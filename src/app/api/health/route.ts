/**
 * GET /api/health
 *
 * Reports LLM, DB, web function readiness + pipeline config + the current
 * authenticated user (if any).
 */

import { NextRequest, NextResponse } from "next/server";
import { llmHealth } from "@/lib/factcheck/llm";
import { webHealth } from "@/lib/factcheck/web";
import { FACTCHECK_CONFIG, TRUSTED_SOURCES } from "@/lib/factcheck/config";
import { db } from "@/lib/db";
import { getCurrentUser, stripHash, bootstrapAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const llm = await llmHealth();
  const web = await webHealth();

  let dbReady = true;
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbReady = false;
  }

  // Best-effort: ensure the admin user exists (no-op after first run).
  await bootstrapAdmin();

  // Report the current user (null if not authenticated). The client uses
  // this for the Topbar profile + admin nav visibility.
  let currentUser: ReturnType<typeof stripHash> | null = null;
  try {
    const result = await getCurrentUser(req);
    if (result) {
      currentUser = stripHash(result.user);
    }
  } catch {
    // AUTH_SECRET not configured → currentUser stays null.
  }

  return NextResponse.json({
    llm,
    db: { ready: dbReady },
    web,
    auth: {
      /** Always true now — the login/password gate is always active. */
      required: true,
      user: currentUser,
    },
    config: {
      trustedSourcesCount: TRUSTED_SOURCES.length,
      trustedSources: TRUSTED_SOURCES.map((t) => ({
        host: t.host,
        organization: t.organization,
        evidenceLevel: t.evidenceLevel,
        baseAuthority: t.baseAuthority,
      })),
      limits: FACTCHECK_CONFIG.limits,
    },
  });
}
