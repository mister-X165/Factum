/**
 * GET /api/health
 *
 * Reports LLM, DB, web function readiness + pipeline config.
 */

import { NextResponse } from "next/server";
import { llmHealth } from "@/lib/factcheck/llm";
import { webHealth } from "@/lib/factcheck/web";
import { FACTCHECK_CONFIG, TRUSTED_SOURCES } from "@/lib/factcheck/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const llm = await llmHealth();
  const web = await webHealth();

  let dbReady = true;
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbReady = false;
  }

  return NextResponse.json({
    llm,
    db: { ready: dbReady },
    web,
    config: {
      trustedSourcesCount: TRUSTED_SOURCES.length,
      limits: FACTCHECK_CONFIG.limits,
    },
  });
}
