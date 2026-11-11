/**
 * §42-§45 / §60 / §97: final human-readable report.
 *
 * The LLM writes summary / methodology / limitations. We attach the
 * DETERMINISTIC overall verdict + confidence and ensure methodology/limitations
 * are non-empty even when the LLM omits them.
 */

import { PROMPTS } from "./prompts";
import { runJsonPrompt } from "./llm";
import { FACTCHECK_CONFIG } from "./config";
import { truncate } from "./security";
import type {
  Claim,
  Evidence,
  FetchedDocument,
  Report,
  Source,
  Verdict,
  VerdictLabel,
} from "./types";

interface ReportLLMResponse {
  summary?: string;
  methodology?: string;
  limitations?: string;
}

function compactAnalysis(
  doc: FetchedDocument,
  claims: Claim[],
  sources: Source[],
  evidence: Evidence[],
  verdicts: Verdict[],
  overall: { label: VerdictLabel; confidence: number }
): string {
  const data = {
    document: {
      url: doc.url,
      title: doc.title,
      nature: doc.contentNature,
      excerpt: truncate(doc.excerpt, 400),
    },
    overall: {
      label: overall.label,
      confidence: Number(overall.confidence.toFixed(2)),
    },
    claims: claims.slice(0, 8).map((c) => ({
      id: c.id,
      text: truncate(c.text, 200),
      type: c.type,
      importance: Number(c.importance.toFixed(2)),
    })),
    sources: sources.slice(0, 10).map((s) => ({
      id: s.id,
      url: s.url,
      organization: s.organization,
      tier: s.evidence_level,
      trusted: s.trusted,
      overall_quality: Number(s.quality.overall.toFixed(2)),
      retrieval_error: s.retrieval_error,
    })),
    evidence_count: evidence.length,
    evidence_supports: evidence.filter((e) => e.direction === "SUPPORTS").length,
    evidence_contradicts: evidence.filter((e) => e.direction === "CONTRADICTS").length,
    verdicts: verdicts.slice(0, 8).map((v) => ({
      claim_id: v.claim_id,
      label: v.label,
      confidence: Number(v.confidence.toFixed(2)),
      explanation: truncate(v.explanation, 240),
      insufficient_reason: v.insufficient_reason,
    })),
    config: {
      min_relevant_sources: FACTCHECK_CONFIG.insufficient.minRelevantSources,
      max_sources_total: FACTCHECK_CONFIG.web.maxSourcesTotal,
    },
  };
  return JSON.stringify(data, null, 2);
}

function buildDefaultMethodology(
  claims: Claim[],
  sources: Source[],
  evidence: Evidence[]
): string {
  const trustedCount = sources.filter((s) => s.trusted).length;
  const externalCount = sources.length - trustedCount;
  return (
    `Проверка выполнена в два этапа: (1) декомпозиция материала на ${claims.length} проверяемых утверждений, ` +
    `(2) поиск научных источников и извлечение доказательств. ` +
    `Использовано ${sources.length} источников (${trustedCount} доверенных из реестра, ${externalCount} внешних). ` +
    `Извлечено ${evidence.length} фрагментов доказательств. ` +
    `Каждый источник оценён по шести осям (authority, methodology, recency, relevance, independence, transparency). ` +
    `Вердикт рассчитан детерминированно на основе качества и независимости источников — LLM не является источником истины.`
  );
}

function buildDefaultLimitations(
  sources: Source[],
  evidence: Evidence[],
  claims: Claim[]
): string {
  const failed = sources.filter((s) => s.retrieval_error).length;
  const parts: string[] = [];
  if (sources.length < FACTCHECK_CONFIG.insufficient.minRelevantSources) {
    parts.push(
      `Найдено лишь ${sources.length} источников (меньше порога ${FACTCHECK_CONFIG.insufficient.minRelevantSources}).`
    );
  }
  if (failed > 0) {
    parts.push(`${failed} из ${sources.length} источников не удалось загрузить — использованы только сниппеты.`);
  }
  const insufficient = claims.length > 0 ? 0 : 0; // verdicts may flag insufficient
  if (insufficient > 0) {
    parts.push(`${insufficient} утверждений не удалось проверить из-за недостатка данных.`);
  }
  if (evidence.length === 0) {
    parts.push("Не удалось извлечь ни одного содержательного доказательства.");
  }
  if (parts.length === 0) return "";
  return parts.join(" ");
}

/**
 * Generate the final report.
 * `modelInfo` is the backend / model name from the LLM provider.
 */
export async function generateReport(
  projectId: string,
  doc: FetchedDocument,
  claims: Claim[],
  sources: Source[],
  evidence: Evidence[],
  verdicts: Verdict[],
  overall: { label: VerdictLabel; confidence: number },
  modelInfo: string
): Promise<Report> {
  const analysis = compactAnalysis(doc, claims, sources, evidence, verdicts, overall);

  let summary = "";
  let methodology = "";
  let limitations = "";

  try {
    const res = await runJsonPrompt<ReportLLMResponse>(PROMPTS.reportGenerator, {
      ANALYSIS: analysis,
    });
    summary = (res.summary ?? "").trim();
    methodology = (res.methodology ?? "").trim();
    limitations = (res.limitations ?? "").trim();
  } catch {
    // fall through to defaults
  }

  if (!summary) {
    summary =
      `Материал проверен: выделено ${claims.length} утверждений, найдено ${sources.length} источников ` +
      `(${evidence.filter((e) => e.direction === "SUPPORTS").length} поддерживающих, ` +
      `${evidence.filter((e) => e.direction === "CONTRADICTS").length} опровергающих). ` +
      `Итоговый вердикт: ${overall.label}.`;
  }
  if (!methodology) methodology = buildDefaultMethodology(claims, sources, evidence);
  if (!limitations) limitations = buildDefaultLimitations(sources, evidence, claims);

  return {
    project_id: projectId,
    overall_verdict: overall.label,
    overall_confidence: Number(overall.confidence.toFixed(2)),
    summary,
    methodology,
    limitations,
    generated_at: new Date().toISOString(),
    model_info: modelInfo,
  };
}
