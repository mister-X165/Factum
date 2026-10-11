/**
 * GET /api/history/[id] — return the full AnalysisResult for a project id.
 */

import { NextResponse } from "next/server";
import { toAnalysisResult } from "@/lib/factcheck/orchestrator";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await toAnalysisResult(id);
  if (!result) {
    return NextResponse.json(
      { error: "Проект не найден." },
      { status: 404 }
    );
  }
  return NextResponse.json(result);
}
