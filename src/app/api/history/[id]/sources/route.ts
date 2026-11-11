/**
 * POST /api/history/[id]/sources
 *
 * § "Альтернативные источники": the user submits a source URL for an already
 * completed analysis. The backend then:
 *
 *   1. validates the URL (SSRF gate — same rules as the pipeline);
 *   2. rejects duplicates (canonical URL match);
 *   3. fetches + evaluates the source with the SAME quality scoring as
 *      pipeline sources (marked submittedBy=USER);
 *   4. extracts evidence from the new source for the important claims;
 *   5. re-runs verdict synthesis with old + new evidence;
 *   6. stores the PREVIOUS verdict of every changed claim as a
 *      VerdictVersion row (version history is never lost);
 *   7. regenerates the report + bumps Project.revision.
 *
 * Response: SourceUpdateResult — the updated AnalysisResult plus a summary
 * of which verdicts changed (old → new label, version number).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validateUrl, truncate } from "@/lib/factcheck/security";
import { evaluateUserSource } from "@/lib/factcheck/sources";
import { extractEvidence } from "@/lib/factcheck/evidence";
import { synthesizeVerdicts, computeOverallVerdict } from "@/lib/factcheck/verdict";
import { generateReport } from "@/lib/factcheck/report";
import { toAnalysisResult, acquirePipelineLock, releasePipelineLock } from "@/lib/factcheck/orchestrator";
import { canonicalUrl } from "@/lib/factcheck/research";
import { hit, tooManyRequests } from "@/lib/ratelimit";
import { requireUser, AuthError } from "@/lib/auth";
import type {
  AnalysisMode,
  AnalysisResult,
  Claim,
  ContentNature,
  Evidence,
  FetchedDocument,
  Source,
  SourceUpdateResult,
  Verdict,
  VerdictLabel,
} from "@/lib/factcheck/types";

export const dynamic = "force-dynamic";
/** Verdict recalculation = several LLM calls on a slow model — allow 15 min. */
export const maxDuration = 900;

const MAX_USER_SOURCES = 8; // per project

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth + ownership check.
  let authUser;
  try {
    authUser = (await requireUser(req)).user;
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Rate limit: 6 source submissions / hour / IP.
  const verdict = hit(req, { key: "user-source", max: 6, windowMs: 60 * 60_000 });
  if (!verdict.ok) return tooManyRequests(verdict);

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ожидается JSON-тело запроса." }, { status: 400 });
  }
  const url = (body as { url?: unknown })?.url;
  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "Параметр url обязателен." }, { status: 400 });
  }

  // 1. SSRF gate.
  const urlErr = validateUrl(url.trim());
  if (urlErr) {
    return NextResponse.json({ error: urlErr.message }, { status: 400 });
  }

  // 2. Load the project (must be a finished analysis).
  const project = await db.project.findUnique({
    where: { id },
    include: {
      document: true,
      claims: { orderBy: { claimId: "asc" } },
      sources: true,
      evidences: true,
      verdicts: { include: { versions: true } },
      report: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
  }
  // Ownership: only the project owner or an admin can add sources.
  if (project.userId !== authUser.id && authUser.role !== "admin") {
    return NextResponse.json(
      { error: "Нет прав на изменение этого проекта." },
      { status: 403 }
    );
  }
  if (project.status !== "completed") {
    return NextResponse.json(
      { error: "Источник можно добавить только к завершённой проверке." },
      { status: 409 }
    );
  }

  const userSourceCount = project.sources.filter((s) => s.submittedBy === "USER").length;
  if (userSourceCount >= MAX_USER_SOURCES) {
    return NextResponse.json(
      { error: `Достигнут лимит пользовательских источников (${MAX_USER_SOURCES}).` },
      { status: 409 }
    );
  }

  // 3. Duplicate check (canonical URL).
  const canon = canonicalUrl(url.trim());
  const dup = project.sources.find((s) => canonicalUrl(s.url) === canon);
  if (dup) {
    return NextResponse.json(
      { error: "Этот источник уже учтён в проверке." },
      { status: 409 }
    );
  }

  // One recalculation at a time (shared LLM endpoint).
  if (!acquirePipelineLock()) {
    return NextResponse.json(
      {
        error:
          "Уже выполняется другая проверка или пересчёт. Дождитесь завершения и повторите.",
      },
      { status: 429 }
    );
  }

  try {
    await db.auditEvent.create({
      data: {
        projectId: id,
        stage: "user_source",
        level: "INFO",
        message: `Пользователь добавил источник: ${truncate(url, 140)}`,
      },
    });

    // 4. Fetch + evaluate the user source.
    const newSource = await evaluateUserSource(url.trim(), project.sources.length);
    if ((newSource.excerpt ?? "").trim().length === 0) {
      await db.auditEvent.create({
        data: {
          projectId: id,
          stage: "user_source",
          level: "WARNING",
          message: `Не удалось загрузить текст источника: ${newSource.retrieval_error ?? "пустой ответ"}`,
        },
      });
      return NextResponse.json(
        {
          error:
            `Не удалось загрузить текст источника (${newSource.retrieval_error ?? "пустой ответ"}). ` +
            "Проверьте, что ссылка открывается и содержит текст.",
        },
        { status: 422 }
      );
    }

    const createdSource = await db.source.create({
      data: {
        projectId: id,
        sourceId: newSource.id,
        url: newSource.url,
        title: newSource.title ?? null,
        author: newSource.author ?? null,
        organization: newSource.organization ?? null,
        publicationDate: newSource.publication_date ?? null,
        sourceType: newSource.source_type,
        evidenceLevel: newSource.evidence_level,
        authorityScore: newSource.quality.authority,
        methodologyScore: newSource.quality.methodology,
        relevanceScore: newSource.quality.relevance,
        recencyScore: newSource.quality.recency,
        independenceScore: newSource.quality.independence,
        transparencyScore: newSource.quality.transparency,
        overallScore: newSource.quality.overall,
        excerpt: newSource.excerpt ?? null,
        trusted: newSource.trusted,
        submittedBy: "USER",
        retrievalError: newSource.retrieval_error ?? null,
      },
    });
    void createdSource;

    // 5. Rebuild in-memory pipeline objects from DB rows.
    const claims: Claim[] = project.claims.map((c) => ({
      id: c.claimId,
      text: c.text,
      normalized_text: c.normalizedText ?? c.text,
      type: c.claimType as Claim["type"],
      importance: c.importance,
      check_required: c.checkRequired,
      context: c.context ?? "",
    }));
    const sources: Source[] = [
      ...project.sources.map((s) => ({
        id: s.sourceId,
        url: s.url,
        title: s.title ?? "",
        organization: s.organization ?? undefined,
        publication_date: s.publicationDate ?? undefined,
        retrieved_at: s.retrievedAt.toISOString(),
        source_type: s.sourceType as Source["source_type"],
        evidence_level: s.evidenceLevel,
        trusted: s.trusted,
        quality: {
          authority: s.authorityScore,
          methodology: s.methodologyScore,
          recency: s.recencyScore,
          relevance: s.relevanceScore,
          independence: s.independenceScore,
          transparency: s.transparencyScore,
          overall: s.overallScore,
        },
        excerpt: s.excerpt ?? undefined,
        retrieval_error: s.retrievalError ?? undefined,
        submitted_by: (s.submittedBy === "USER" ? "USER" : "SYSTEM") as Source["submitted_by"],
      })),
      newSource,
    ];
    const claimIdMap = new Map(project.claims.map((c) => [c.claimId, c.id]));
    const sourceIdMap = new Map(project.sources.map((s) => [s.sourceId, s.id]));
    sourceIdMap.set(newSource.id, createdSource.id);

    const existingEvidence: Evidence[] = project.evidences.map((e) => ({
      id: e.evidenceId,
      claim_id: project.claims.find((c) => c.id === e.claimId)?.claimId ?? "",
      source_id: project.sources.find((s) => s.id === e.sourceId)?.sourceId ?? "",
      text: e.text,
      evidence_type: e.evidenceType,
      direction: e.direction as Evidence["direction"],
      relevance: e.relevance,
      strength: e.strength,
    }));

    // 6. Extract evidence from the NEW source only.
    await db.auditEvent.create({
      data: {
        projectId: id,
        stage: "user_source",
        level: "INFO",
        message: "Извлечение доказательств из нового источника…",
      },
    });
    const mode = project.mode as AnalysisMode;
    let newEvidence: Evidence[] = [];
    try {
      newEvidence = await extractEvidence(claims, [newSource], mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.auditEvent.create({
        data: {
          projectId: id,
          stage: "user_source",
          level: "WARNING",
          message: `Извлечение доказательств не удалось: ${truncate(msg, 160)}`,
        },
      });
    }

    // Re-key evidence ids so they never collide with existing ones.
    const existingMax = existingEvidence.reduce((acc, e) => {
      const m = e.id.match(/^evidence_(\d+)$/);
      return m ? Math.max(acc, Number(m[1])) : acc;
    }, 0);
    newEvidence = newEvidence.map((e, i) => ({
      ...e,
      id: `evidence_${String(existingMax + i + 1).padStart(3, "0")}`,
    }));

    // Persist the new evidence rows.
    for (const e of newEvidence) {
      const claimDbId = claimIdMap.get(e.claim_id);
      const sourceDbId = sourceIdMap.get(e.source_id);
      if (!claimDbId || !sourceDbId) continue;
      try {
        await db.evidence.create({
          data: {
            projectId: id,
            claimId: claimDbId,
            sourceId: sourceDbId,
            evidenceId: e.id,
            text: e.text,
            evidenceType: e.evidence_type,
            direction: e.direction,
            relevance: e.relevance,
            strength: e.strength,
          },
        });
      } catch {
        /* skip a single bad row */
      }
    }

    // 7. Re-run verdict synthesis with old + new evidence.
    await db.auditEvent.create({
      data: {
        projectId: id,
        stage: "user_source",
        level: "INFO",
        message: `Пересчёт вердиктов (${existingEvidence.length + newEvidence.length} доказательств)…`,
      },
    });
    const allEvidence = [...existingEvidence, ...newEvidence];
    const newVerdicts = await synthesizeVerdicts(claims, sources, allEvidence);

    // 8. Persist: archive OLD verdict state → VerdictVersion, update current.
    const oldByClaim = new Map<string, { rowId: string; v: Verdict; versionsCount: number }>();
    for (const row of project.verdicts) {
      const claimLogical = project.claims.find((c) => c.id === row.claimId)?.claimId ?? row.claimId;
      oldByClaim.set(claimLogical, {
        rowId: row.id,
        v: {
          claim_id: claimLogical,
          label: row.label as VerdictLabel,
          confidence: row.confidence,
          explanation: row.explanation,
          supporting_evidence_ids: safeParseArr(row.supportingEvidenceIds),
          contradicting_evidence_ids: safeParseArr(row.contradictingEvidenceIds),
          source_ids: safeParseArr(row.sourceIds),
        },
        versionsCount: row.versions.length,
      });
    }

    const changedVerdicts: SourceUpdateResult["changedVerdicts"] = [];
    const reason =
      `Добавлен источник пользователя: ${truncate(newSource.title || newSource.url, 100)}`;

    for (const nv of newVerdicts) {
      const old = oldByClaim.get(nv.claim_id);
      const claimDbId = claimIdMap.get(nv.claim_id);
      const claimRow = claims.find((c) => c.id === nv.claim_id);
      if (!claimDbId) continue;

      const changed =
        !old ||
        old.v.label !== nv.label ||
        Math.abs(old.v.confidence - nv.confidence) > 0.005;

      if (old && changed) {
        // Archive the previous state as the next version.
        const nextVersion = old.versionsCount + 1;
        await db.verdictVersion.create({
          data: {
            verdictId: old.rowId,
            projectId: id,
            version: nextVersion,
            label: old.v.label,
            confidence: old.v.confidence,
            explanation: old.v.explanation,
            supportingEvidenceIds: JSON.stringify(old.v.supporting_evidence_ids),
            contradictingEvidenceIds: JSON.stringify(old.v.contradicting_evidence_ids),
            sourceIds: JSON.stringify(old.v.source_ids),
            changeReason: reason,
          },
        });
        await db.verdict.update({
          where: { id: old.rowId },
          data: {
            label: nv.label,
            confidence: nv.confidence,
            explanation: nv.explanation,
            supportingEvidenceIds: JSON.stringify(nv.supporting_evidence_ids),
            contradictingEvidenceIds: JSON.stringify(nv.contradicting_evidence_ids),
            sourceIds: JSON.stringify(nv.source_ids),
          },
        });
        changedVerdicts.push({
          claim_id: nv.claim_id,
          claim_text: claimRow?.text ?? "",
          from_label: old.v.label,
          to_label: nv.label,
          from_confidence: old.v.confidence,
          to_confidence: nv.confidence,
          version: nextVersion + 1,
        });
      } else if (!old) {
        // A verdict for a claim that had none before.
        await db.verdict.create({
          data: {
            projectId: id,
            claimId: claimDbId,
            label: nv.label,
            confidence: nv.confidence,
            explanation: nv.explanation,
            supportingEvidenceIds: JSON.stringify(nv.supporting_evidence_ids),
            contradictingEvidenceIds: JSON.stringify(nv.contradicting_evidence_ids),
            sourceIds: JSON.stringify(nv.source_ids),
          },
        });
      }
      // unchanged verdicts are left as-is
    }

    // 9. Recompute overall + regenerate the report.
    const finalVerdicts: Verdict[] = (() => {
      // current state for every claim that has a verdict row
      const map = new Map<string, Verdict>();
      for (const nv of newVerdicts) map.set(nv.claim_id, nv);
      // keep old verdicts for claims not re-synthesised
      for (const [claimLogical, old] of oldByClaim) {
        if (!map.has(claimLogical)) map.set(claimLogical, old.v);
      }
      return Array.from(map.values());
    })();
    const overall = computeOverallVerdict(finalVerdicts, claims);

    const docStub: FetchedDocument = {
      url: project.document?.url ?? project.url,
      title: project.document?.title ?? undefined,
      author: project.document?.author ?? undefined,
      publishedAt: project.document?.publishedAt ?? undefined,
      text: project.document?.text ?? "",
      excerpt: project.document?.excerpt ?? "",
      contentHash: project.document?.contentHash ?? "",
      contentType: (project.document?.contentType as FetchedDocument["contentType"]) ?? "html",
      contentNature: "INFORMATION" as ContentNature,
    };

    const report = await generateReport(
      id,
      docStub,
      claims,
      sources,
      allEvidence,
      finalVerdicts,
      overall,
      project.modelInfo ?? ""
    );
    await db.report.upsert({
      where: { projectId: id },
      create: {
        projectId: id,
        overallVerdict: report.overall_verdict,
        overallConfidence: report.overall_confidence,
        summary: report.summary,
        methodology: report.methodology,
        limitations: report.limitations,
      },
      update: {
        overallVerdict: report.overall_verdict,
        overallConfidence: report.overall_confidence,
        summary: report.summary,
        methodology: report.methodology,
        limitations: report.limitations,
      },
    });

    // 10. Bump revision + audit the outcome.
    const revision = project.revision + 1;
    await db.project.update({ where: { id }, data: { revision } });
    await db.auditEvent.create({
      data: {
        projectId: id,
        stage: "user_source",
        level: "INFO",
        message:
          `Источник добавлен. Новых доказательств: ${newEvidence.length}. ` +
          `Вердиктов изменено: ${changedVerdicts.length}. Общий вердикт: ${overall.label}.`,
        detail: changedVerdicts
          .map((c) => `${c.claim_id}: ${c.from_label} → ${c.to_label}`)
          .join("; "),
      },
    });

    const result: AnalysisResult | null = await toAnalysisResult(id);
    if (!result) {
      return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
    }

    const payload: SourceUpdateResult = {
      result,
      addedSource: newSource,
      changedVerdicts,
    };
    return NextResponse.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.auditEvent
      .create({
        data: {
          projectId: id,
          stage: "user_source",
          level: "ERROR",
          message: `Пересчёт не удался: ${truncate(msg, 200)}`,
        },
      })
      .catch(() => undefined);
    return NextResponse.json(
      { error: `Пересчёт вердиктов не удался: ${msg}` },
      { status: 500 }
    );
  } finally {
    releasePipelineLock();
  }
}

function safeParseArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map(String);
  } catch {
    /* ignore */
  }
  return [];
}
