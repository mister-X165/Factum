/**
 * §28 / §50 / §103: the pipeline orchestrator.
 *
 * Ties every module together and emits SSE events to the caller.
 *
 * Critical stages (fetching_material, extracting_claims) failing aborts the
 * run; non-critical failures (one source fetch, evidence extraction for one
 * claim) are logged as warnings and the pipeline continues.
 *
 * Every stage transition is persisted as an AuditEvent row in the database.
 */

import { db } from "@/lib/db";
import { FACTCHECK_CONFIG } from "./config";
import { validateUrl } from "./security";
import { fetchDocument, FetchDocumentError } from "./content";
import { extractClaims } from "./claims";
import { planResearch, searchSources, adversarialSearch } from "./research";
import { evaluateSources } from "./sources";
import { extractEvidence } from "./evidence";
import { synthesizeVerdicts, computeOverallVerdict } from "./verdict";
import { generateReport } from "./report";
import { LLMTimeoutError } from "./llm";
import type {
  AnalysisMode,
  AnalysisResult,
  Claim,
  ContentNature,
  Evidence,
  PipelineEvent,
  PipelineStage,
  Source,
  Verdict,
  VerdictLabel,
  Report,
  SearchQuery,
} from "./types";
import type { RawSearchResult } from "./research";

const MODEL_INFO = `${FACTCHECK_CONFIG.llm.backendLabel || FACTCHECK_CONFIG.llm.model || FACTCHECK_CONFIG.llm.backend}`;

/**
 * Global pipeline lock: only ONE analysis may run at a time.
 * The shared z-ai LLM endpoint is heavily rate-limited, so two concurrent
 * pipelines would double the request rate and immediately hit 429s. This
 * lock rejects a new run while another is in flight (the caller surfaces a
 * "busy" error to the user, who can retry shortly after).
 */
let _pipelineRunning = false;

/** Mark any stale "running" projects as failed (e.g. after a server restart). */
async function reapStaleProjects(): Promise<void> {
  try {
    await db.project.updateMany({
      where: { status: "running" },
      data: { status: "failed" },
    });
  } catch {
    /* ignore */
  }
}
// Run once on module load.
void reapStaleProjects();

/** Emit helper. */
type Emit = (ev: PipelineEvent) => void;

async function audit(
  projectId: string,
  stage: string,
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL",
  message: string,
  detail?: string
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: { projectId, stage, level, message, detail },
    });
  } catch {
    // never let audit failure break the pipeline
  }
}

function emitStage(
  emit: Emit,
  stage: PipelineStage,
  status: "active" | "done" | "failed" | "skipped",
  detail?: string
): void {
  emit({ type: "stage", stage, status, detail });
}

function buildDocSummary(d: {
  url: string;
  title?: string;
  excerpt: string;
  contentNature: ContentNature;
}): AnalysisResult["document"] {
  return {
    url: d.url,
    title: d.title,
    excerpt: d.excerpt,
    contentNature: d.contentNature,
  };
}

/**
 * Run the full pipeline. Emits SSE events as it goes.
 * On hard failure emits { type: "error" } and returns the projectId (DB rows
 * are still persisted with status 'failed').
 */
export async function runPipeline(
  opts: { url: string; mode: AnalysisMode },
  emit: Emit
): Promise<{ projectId: string; result: AnalysisResult | null }> {
  const { url, mode } = opts;

  // Acquire the global pipeline lock — only one analysis at a time.
  if (_pipelineRunning) {
    const busy =
      "Анализ уже выполняется. Дождитесь завершения текущей проверки или остановите её, затем повторите.";
    emit({ type: "error", message: busy, stage: "queued" });
    return { projectId: "", result: null };
  }
  _pipelineRunning = true;
  try {
  // 1. validate URL
  emitStage(emit, "validating_url", "active");
  const urlErr = validateUrl(url);
  if (urlErr) {
    emitStage(emit, "validating_url", "failed", urlErr.message);
    emit({ type: "error", message: urlErr.message, stage: "validating_url" });
    return { projectId: "", result: null };
  }
  emitStage(emit, "validating_url", "done");

  // 2. create Project row
  const project = await db.project.create({
    data: { url, mode, status: "running", modelInfo: MODEL_INFO },
  });
  const projectId = project.id;
  await audit(projectId, "validating_url", "INFO", "URL прошёл валидацию (SSRF-проверка).", url);

  // 3. fetch document
  emitStage(emit, "fetching_material", "active");
  await audit(projectId, "fetching_material", "INFO", "Загрузка материала через page_reader.");
  let doc;
  try {
    doc = await fetchDocument(url);
  } catch (e) {
    const msg =
      e instanceof FetchDocumentError ? e.message : `Не удалось загрузить URL: ${String(e)}`;
    emitStage(emit, "fetching_material", "failed", msg);
    emit({ type: "error", message: msg, stage: "fetching_material" });
    await audit(projectId, "fetching_material", "ERROR", msg);
    await db.project.update({ where: { id: projectId }, data: { status: "failed" } });
    return { projectId, result: null };
  }
  emitStage(emit, "fetching_material", "done");
  emitStage(emit, "extracting_text", "active");
  await db.document.create({
    data: {
      projectId,
      url: doc.url,
      title: doc.title ?? null,
      author: doc.author ?? null,
      publishedAt: doc.publishedAt ?? null,
      contentHash: doc.contentHash,
      text: doc.text,
      excerpt: doc.excerpt,
      contentType: doc.contentType,
    },
  });
  await audit(
    projectId,
    "extracting_text",
    "INFO",
    `Извлечено ${doc.text.length} символов. Тип контента: ${doc.contentNature}.`,
    doc.title
  );
  emitStage(emit, "extracting_text", "done", `${doc.text.length} символов`);

  // 4. extract claims
  emitStage(emit, "extracting_claims", "active");
  await audit(projectId, "extracting_claims", "INFO", "Декомпозиция утверждений через LLM.");
  let claims: Claim[] = [];
  try {
    claims = await extractClaims(doc);
  } catch (e) {
    // Distinguish a real LLM failure (timeout / connection / HTTP) from an
    // empty answer — previously both produced the misleading "Не удалось
    // выделить проверяемые утверждения из материала." message.
    const isTimeout = e instanceof LLMTimeoutError;
    const rawMsg = e instanceof Error ? e.message : String(e);
    const msg = isTimeout
      ? rawMsg
      : `Не удалось связаться с локальной LLM при извлечении утверждений: ${rawMsg}`;
    emitStage(emit, "extracting_claims", "failed", msg);
    emit({ type: "error", message: msg, stage: "extracting_claims" });
    await audit(projectId, "extracting_claims", "ERROR", msg);
    await db.project.update({ where: { id: projectId }, data: { status: "failed" } });
    return { projectId, result: null };
  }
  if (claims.length === 0) {
    // The LLM answered successfully but found nothing checkable in the article
    // (e.g. pure advertisement / opinion / navigation boilerplate). This is
    // an honest "nothing to check" outcome, NOT an error.
    const msg =
      "В материале не найдено проверяемых утверждений (медицинских фактов, статистики, заявлений об эффективности). " +
      "Возможно, это рекламная или навигационная страница без содержательных тезисов для фактчекинга.";
    emitStage(emit, "extracting_claims", "failed", msg);
    emit({ type: "error", message: msg, stage: "extracting_claims" });
    await audit(projectId, "extracting_claims", "WARNING", msg);
    await db.project.update({ where: { id: projectId }, data: { status: "failed" } });
    return { projectId, result: null };
  }
  // persist claims
  for (const c of claims) {
    await db.claim.create({
      data: {
        projectId,
        claimId: c.id,
        text: c.text,
        normalizedText: c.normalized_text,
        claimType: c.type,
        importance: c.importance,
        checkRequired: c.check_required,
        context: c.context,
      },
    });
  }
  await audit(projectId, "extracting_claims", "INFO", `Выделено утверждений: ${claims.length}.`);
  emitStage(emit, "extracting_claims", "done", `${claims.length} claims`);
  emit({ type: "claims", claims });

  // 5. plan research
  emitStage(emit, "planning_research", "active");
  await audit(projectId, "planning_research", "INFO", "Планирование поисковых запросов.");
  let queries: SearchQuery[] = [];
  try {
    queries = await planResearch(claims);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `planResearch упал: ${msg}` });
    await audit(projectId, "planning_research", "WARNING", `planResearch failed: ${msg}`);
  }
  for (const q of queries) {
    await db.searchQuery.create({
      data: {
        projectId,
        query: q.query,
        purpose: q.purpose,
        claimRef: q.claim_ref ?? null,
      },
    });
  }
  await audit(projectId, "planning_research", "INFO", `Запланировано запросов: ${queries.length}.`);
  emitStage(emit, "planning_research", "done", `${queries.length} queries`);

  // 6. search sources
  emitStage(emit, "searching_sources", "active");
  await audit(
    projectId,
    "searching_sources",
    "INFO",
    `Поиск через web_search (mode=${mode}).`
  );
  let rawResults: RawSearchResult[] = [];
  try {
    rawResults = await searchSources(queries, mode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `searchSources failed: ${msg}` });
    await audit(projectId, "searching_sources", "WARNING", `searchSources failed: ${msg}`);
  }
  await audit(
    projectId,
    "searching_sources",
    "INFO",
    `Найдено сырых результатов: ${rawResults.length}.`
  );
  emitStage(emit, "searching_sources", "done", `${rawResults.length} raw results`);

  // 7. evaluate sources (lazily fetches each source's text)
  emitStage(emit, "evaluating_sources", "active");
  await audit(projectId, "evaluating_sources", "INFO", "Оценка качества источников.");
  let sources: Source[] = [];
  try {
    sources = await evaluateSources(rawResults, mode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `evaluateSources failed: ${msg}` });
    await audit(projectId, "evaluating_sources", "WARNING", `evaluateSources failed: ${msg}`);
  }
  for (const s of sources) {
    await db.source.create({
      data: {
        projectId,
        sourceId: s.id,
        url: s.url,
        title: s.title ?? null,
        author: s.author ?? null,
        organization: s.organization ?? null,
        publicationDate: s.publication_date ?? null,
        sourceType: s.source_type,
        evidenceLevel: s.evidence_level,
        authorityScore: s.quality.authority,
        methodologyScore: s.quality.methodology,
        relevanceScore: s.quality.relevance,
        recencyScore: s.quality.recency,
        independenceScore: s.quality.independence,
        transparencyScore: s.quality.transparency,
        overallScore: s.quality.overall,
        excerpt: s.excerpt ?? null,
        trusted: s.trusted,
        retrievalError: s.retrieval_error ?? null,
      },
    });
  }
  await audit(
    projectId,
    "evaluating_sources",
    "INFO",
    `Сохранено источников: ${sources.length}.`
  );
  emitStage(emit, "evaluating_sources", "done", `${sources.length} sources`);
  emit({ type: "sources", sources });

  // 8. adversarial search (RESEARCH mode)
  if (mode === "RESEARCH") {
    emitStage(emit, "adversarial_search", "active");
    await audit(
      projectId,
      "adversarial_search",
      "INFO",
      "Adversarial-поиск контраргументов."
    );
    let adversarial: RawSearchResult[] = [];
    try {
      adversarial = await adversarialSearch(claims, mode);
      // merge with existing sources — re-evaluate only the new ones.
      const existingUrls = new Set(sources.map((s) => s.url));
      const fresh = adversarial.filter((r) => !existingUrls.has(r.url));
      if (fresh.length > 0) {
        const extra = await evaluateSources(fresh, mode);
        for (const s of extra) {
          await db.source.create({
            data: {
              projectId,
              sourceId: s.id,
              url: s.url,
              title: s.title ?? null,
              organization: s.organization ?? null,
              publicationDate: s.publication_date ?? null,
              sourceType: s.source_type,
              evidenceLevel: s.evidence_level,
              authorityScore: s.quality.authority,
              methodologyScore: s.quality.methodology,
              relevanceScore: s.quality.relevance,
              recencyScore: s.quality.recency,
              independenceScore: s.quality.independence,
              transparencyScore: s.quality.transparency,
              overallScore: s.quality.overall,
              excerpt: s.excerpt ?? null,
              trusted: s.trusted,
              retrievalError: s.retrieval_error ?? null,
            },
          });
          sources.push(s);
        }
        emit({ type: "sources", sources });
      }
      await audit(
        projectId,
        "adversarial_search",
        "INFO",
        `Найдено контраргументов: ${adversarial.length}, новых: ${fresh.length}.`
      );
      emit({ type: "log", level: "info", message: `Adversarial: ${adversarial.length} результатов.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ type: "log", level: "warn", message: `adversarialSearch failed: ${msg}` });
      await audit(projectId, "adversarial_search", "WARNING", `adversarialSearch failed: ${msg}`);
    }
    emitStage(emit, "adversarial_search", "done");
  } else {
    emitStage(emit, "adversarial_search", "skipped", "CONTROLLED mode");
  }

  // 9. extract evidence
  emitStage(emit, "extracting_evidence", "active");
  await audit(projectId, "extracting_evidence", "INFO", "Извлечение доказательств из источников.");
  let evidence: Evidence[] = [];
  try {
    evidence = await extractEvidence(claims, sources, mode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `extractEvidence failed: ${msg}` });
    await audit(projectId, "extracting_evidence", "WARNING", `extractEvidence failed: ${msg}`);
  }
  // persist evidence — need claim.id (cuid) and source.id (cuid) from DB.
  const claimIdMap = new Map<string, string>(); // claim_001 -> cuid
  const sourceIdMap = new Map<string, string>(); // source_001 -> cuid
  const dbClaims = await db.claim.findMany({ where: { projectId }, select: { id: true, claimId: true } });
  for (const c of dbClaims) claimIdMap.set(c.claimId, c.id);
  const dbSources = await db.source.findMany({ where: { projectId }, select: { id: true, sourceId: true } });
  for (const s of dbSources) sourceIdMap.set(s.sourceId, s.id);
  for (const e of evidence) {
    const claimDbId = claimIdMap.get(e.claim_id);
    const sourceDbId = sourceIdMap.get(e.source_id);
    if (!claimDbId || !sourceDbId) continue;
    try {
      await db.evidence.create({
        data: {
          projectId,
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
    } catch (err) {
      // skip a single bad evidence row, keep going
    }
  }
  await audit(
    projectId,
    "extracting_evidence",
    "INFO",
    `Извлечено доказательств: ${evidence.length}.`
  );
  emitStage(emit, "extracting_evidence", "done", `${evidence.length} items`);
  emit({ type: "evidence", evidence });

  // 10. synthesise verdicts + compute overall
  emitStage(emit, "synthesising", "active");
  await audit(projectId, "synthesising", "INFO", "Синтез вердиктов (LLM + детерминированный расчёт).");
  let verdicts: Verdict[] = [];
  try {
    verdicts = await synthesizeVerdicts(claims, sources, evidence);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `synthesizeVerdicts failed: ${msg}` });
    await audit(projectId, "synthesising", "WARNING", `synthesizeVerdicts failed: ${msg}`);
  }
  emitStage(emit, "synthesising", "done", `${verdicts.length} verdicts`);

  emitStage(emit, "calculating_verdict", "active");
  const overall = computeOverallVerdict(verdicts, claims);
  await audit(
    projectId,
    "calculating_verdict",
    "INFO",
    `Overall: ${overall.label} (conf=${overall.confidence.toFixed(2)}).`
  );
  // persist verdicts
  for (const v of verdicts) {
    const claimDbId = claimIdMap.get(v.claim_id);
    if (!claimDbId) continue;
    try {
      await db.verdict.create({
        data: {
          projectId,
          claimId: claimDbId,
          label: v.label,
          confidence: v.confidence,
          explanation: v.explanation,
          supportingEvidenceIds: JSON.stringify(v.supporting_evidence_ids),
          contradictingEvidenceIds: JSON.stringify(v.contradicting_evidence_ids),
          sourceIds: JSON.stringify(v.source_ids),
        },
      });
    } catch {
      // skip a single bad verdict row
    }
  }
  emitStage(emit, "calculating_verdict", "done", overall.label);

  // 11. generate report
  emitStage(emit, "generating_report", "active");
  await audit(projectId, "generating_report", "INFO", "Формирование финального отчёта.");
  let report: Report | null = null;
  try {
    report = await generateReport(
      projectId,
      doc,
      claims,
      sources,
      evidence,
      verdicts,
      overall,
      MODEL_INFO
    );
    await db.report.create({
      data: {
        projectId,
        overallVerdict: report.overall_verdict,
        overallConfidence: report.overall_confidence,
        summary: report.summary,
        methodology: report.methodology,
        limitations: report.limitations,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "log", level: "warn", message: `generateReport failed: ${msg}` });
    await audit(projectId, "generating_report", "WARNING", `generateReport failed: ${msg}`);
  }
  emitStage(emit, "generating_report", "done");

  // 12. mark project completed + emit final report
  await db.project.update({ where: { id: projectId }, data: { status: "completed" } });
  await audit(projectId, "done", "INFO", "Pipeline завершён.");

  const result: AnalysisResult = {
    projectId,
    url: doc.url,
    mode,
    modelInfo: MODEL_INFO,
    createdAt: project.createdAt.toISOString(),
    status: "completed",
    document: buildDocSummary(doc),
    claims,
    sources,
    evidence,
    verdicts,
    report: report ?? {
      project_id: projectId,
      overall_verdict: overall.label,
      overall_confidence: Number(overall.confidence.toFixed(2)),
      summary: "Отчёт недоступен.",
      methodology: "",
      limitations: "Формирование отчёта не удалось.",
      generated_at: new Date().toISOString(),
      model_info: MODEL_INFO,
    },
  };
  emit({
    type: "report",
    report: result.report,
    claims,
    verdicts,
    sources,
    evidence,
    document: {
      url: result.document.url,
      title: result.document.title,
      excerpt: result.document.excerpt,
      contentNature: result.document.contentNature,
    },
  });
  emit({ type: "done", projectId });

  return { projectId, result };
  } finally {
    _pipelineRunning = false;
  }
}

/**
 * Reconstruct the full AnalysisResult from DB rows (used by /api/history/[id]).
 */
export async function toAnalysisResult(
  projectId: string
): Promise<AnalysisResult | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      document: true,
      claims: { orderBy: { claimId: "asc" } },
      sources: { orderBy: { sourceId: "asc" } },
      evidences: { orderBy: { evidenceId: "asc" } },
      verdicts: true,
      report: true,
    },
  });
  if (!project) return null;

  const claims: Claim[] = project.claims.map((c) => ({
    id: c.claimId,
    text: c.text,
    normalized_text: c.normalizedText ?? c.text,
    type: c.claimType as Claim["type"],
    importance: c.importance,
    check_required: c.checkRequired,
    context: c.context ?? "",
  }));

  const sources: Source[] = project.sources.map((s) => ({
    id: s.sourceId,
    url: s.url,
    title: s.title ?? "",
    author: s.author ?? undefined,
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
  }));

  const evidence: Evidence[] = project.evidences.map((e) => ({
    id: e.evidenceId,
    claim_id: project.claims.find((c) => c.id === e.claimId)?.claimId ?? "",
    source_id: project.sources.find((s) => s.id === e.sourceId)?.sourceId ?? "",
    text: e.text,
    evidence_type: e.evidenceType,
    direction: e.direction as Evidence["direction"],
    relevance: e.relevance,
    strength: e.strength,
  }));

  const verdicts: Verdict[] = project.verdicts.map((v) => {
    const claim = project.claims.find((c) => c.id === v.claimId);
    return {
      claim_id: claim?.claimId ?? v.claimId,
      label: v.label as VerdictLabel,
      confidence: v.confidence,
      explanation: v.explanation,
      supporting_evidence_ids: parseStrArray(v.supportingEvidenceIds),
      contradicting_evidence_ids: parseStrArray(v.contradictingEvidenceIds),
      source_ids: parseStrArray(v.sourceIds),
    };
  });

  const report: Report | null = project.report
    ? {
        project_id: project.id,
        overall_verdict: project.report.overallVerdict as VerdictLabel,
        overall_confidence: project.report.overallConfidence,
        summary: project.report.summary,
        methodology: project.report.methodology,
        limitations: project.report.limitations,
        generated_at: project.report.generatedAt.toISOString(),
        model_info: project.modelInfo ?? MODEL_INFO,
      }
    : null;

  return {
    projectId: project.id,
    url: project.url,
    mode: project.mode as AnalysisMode,
    modelInfo: project.modelInfo ?? MODEL_INFO,
    createdAt: project.createdAt.toISOString(),
    status: project.status,
    document: {
      url: project.document?.url ?? project.url,
      title: project.document?.title ?? undefined,
      excerpt: project.document?.excerpt ?? "",
      contentNature: (project.document?.contentType === "pdf" ? "INFORMATION" : "INFORMATION") as ContentNature,
    },
    claims,
    sources,
    evidence,
    verdicts,
    report: report ?? ({
      project_id: project.id,
      overall_verdict: "INSUFFICIENT_EVIDENCE" as VerdictLabel,
      overall_confidence: 0,
      summary: "Отчёт недоступен.",
      methodology: "",
      limitations: "",
      generated_at: new Date().toISOString(),
      model_info: project.modelInfo ?? MODEL_INFO,
    } as Report),
  };
}

function parseStrArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map(String);
  } catch {
    /* ignore */
  }
  return [];
}
