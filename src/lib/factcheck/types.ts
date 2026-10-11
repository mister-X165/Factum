/**
 * Core domain types for the medical fact-checking pipeline.
 * Shared between the backend pipeline and the frontend report UI.
 * These mirror the schemas required by the MASTER PROMPT
 * (Claim, Source, Evidence, Verdict, Report).
 */

export type AnalysisMode = "CONTROLLED" | "RESEARCH";

export type ClaimType =
  | "MEDICAL_FACT"
  | "STATISTICAL_CLAIM"
  | "CAUSAL_CLAIM"
  | "SAFETY_CLAIM"
  | "EFFICACY_CLAIM"
  | "DIAGNOSTIC_CLAIM"
  | "TREATMENT_CLAIM"
  | "PREVENTION_CLAIM"
  | "SCIENTIFIC_CLAIM"
  | "ADVERTISEMENT"
  | "OPINION"
  | "PREDICTION"
  | "QUOTE"
  | "ANALOGY";

export type VerdictLabel =
  | "VERIFIED"
  | "LIKELY_TRUE"
  | "PARTIALLY_TRUE"
  | "MISLEADING"
  | "LIKELY_FALSE"
  | "FALSE"
  | "INSUFFICIENT_EVIDENCE";

export type EvidenceDirection = "SUPPORTS" | "CONTRADICTS" | "NEUTRAL";

export type SourceType =
  | "SYSTEMATIC_REVIEW"
  | "META_ANALYSIS"
  | "COCHRANE_REVIEW"
  | "RCT"
  | "COHORT_STUDY"
  | "CASE_CONTROL"
  | "OBSERVATIONAL"
  | "GUIDELINE"
  | "GOVERNMENT_AUTHORITY"
  | "REGULATOR"
  | "NARRATIVE_REVIEW"
  | "EXPERT_REVIEW"
  | "SPECIALIZED_MEDICAL"
  | "MAJOR_MEDIA"
  | "BLOG"
  | "SOCIAL_MEDIA"
  | "COMMERCIAL"
  | "ADVERTISEMENT"
  | "OTHER";

export type ContentNature =
  | "INFORMATION"
  | "ADVERTISEMENT"
  | "NATIVE_ADVERTISEMENT"
  | "SPONSORED_CONTENT"
  | "AFFILIATE_CONTENT";

export interface Claim {
  id: string;
  text: string;
  normalized_text: string;
  type: ClaimType;
  importance: number; // 0..1
  check_required: boolean;
  context: string;
}

export interface SourceQuality {
  authority: number;
  methodology: number;
  recency: number;
  relevance: number;
  independence: number;
  transparency: number;
  overall: number;
}

export interface Source {
  id: string;
  url: string;
  title: string;
  author?: string;
  organization?: string;
  publication_date?: string;
  retrieved_at: string;
  source_type: SourceType;
  evidence_level: number; // tier 1..8
  trusted: boolean;
  quality: SourceQuality;
  excerpt?: string;
  retrieval_error?: string;
}

export interface Evidence {
  id: string;
  claim_id: string;
  source_id: string;
  text: string;
  evidence_type: string;
  direction: EvidenceDirection;
  relevance: number;
  strength: number;
}

export interface Verdict {
  claim_id: string;
  label: VerdictLabel;
  confidence: number;
  explanation: string;
  supporting_evidence_ids: string[];
  contradicting_evidence_ids: string[];
  source_ids: string[];
  insufficient_reason?: string;
}

export interface Report {
  project_id: string;
  overall_verdict: VerdictLabel;
  overall_confidence: number;
  summary: string;
  methodology: string;
  limitations: string;
  generated_at: string;
  model_info: string;
}

/** Document extracted from the input URL. */
export interface FetchedDocument {
  url: string;
  finalUrl?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  text: string;
  excerpt: string;
  contentHash: string;
  contentType: "html" | "pdf" | "text";
  contentNature: ContentNature;
}

/** A search query the research engine planned. */
export interface SearchQuery {
  query: string;
  purpose: "neutral" | "scientific" | "primary" | "systematic" | "guideline" | "contradiction";
  claim_ref?: string;
}

/** SSE progress events streamed from /api/analyze to the client. */
export type PipelineStage =
  | "queued"
  | "validating_url"
  | "fetching_material"
  | "extracting_text"
  | "extracting_claims"
  | "planning_research"
  | "searching_sources"
  | "evaluating_sources"
  | "extracting_evidence"
  | "adversarial_search"
  | "synthesising"
  | "calculating_verdict"
  | "generating_report"
  | "done"
  | "error";

export type StageStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface StageState {
  stage: PipelineStage;
  status: StageStatus;
  detail?: string;
}

/** A complete SSE event sent to the client. */
export type PipelineEvent =
  | { type: "stage"; stage: PipelineStage; status: StageStatus; detail?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "claims"; claims: Claim[] }
  | { type: "sources"; sources: Source[] }
  | { type: "evidence"; evidence: Evidence[] }
  | { type: "report"; report: Report; claims: Claim[]; verdicts: Verdict[]; sources: Source[]; evidence: Evidence[]; document: { url: string; title?: string; excerpt: string; contentNature: ContentNature } }
  | { type: "error"; message: string; stage?: PipelineStage }
  | { type: "done"; projectId: string };

/** Full analysis result (also stored in DB / returned by /api/history/[id]). */
export interface AnalysisResult {
  projectId: string;
  url: string;
  mode: AnalysisMode;
  modelInfo: string;
  createdAt: string;
  status: string;
  document: {
    url: string;
    title?: string;
    excerpt: string;
    contentNature: ContentNature;
  };
  claims: Claim[];
  sources: Source[];
  evidence: Evidence[];
  verdicts: Verdict[];
  report: Report;
}

export const VERDICT_LABELS_RU: Record<VerdictLabel, string> = {
  VERIFIED: "Подтверждено",
  LIKELY_TRUE: "Скорее правда",
  PARTIALLY_TRUE: "Частично правда",
  MISLEADING: "Вводит в заблуждение",
  LIKELY_FALSE: "Скорее ложь",
  FALSE: "Недостоверно",
  INSUFFICIENT_EVIDENCE: "Недостаточно данных",
};

export const VERDICT_ORDER: VerdictLabel[] = [
  "VERIFIED",
  "LIKELY_TRUE",
  "PARTIALLY_TRUE",
  "MISLEADING",
  "LIKELY_FALSE",
  "FALSE",
  "INSUFFICIENT_EVIDENCE",
];

export const STAGE_LABELS_RU: Record<PipelineStage, string> = {
  queued: "В очереди",
  validating_url: "Проверка URL",
  fetching_material: "Получение материала",
  extracting_text: "Извлечение текста",
  extracting_claims: "Выделение утверждений",
  planning_research: "Планирование исследования",
  searching_sources: "Поиск научных источников",
  evaluating_sources: "Оценка источников",
  extracting_evidence: "Извлечение доказательств",
  adversarial_search: "Поиск контраргументов",
  synthesising: "Синтез доказательств",
  calculating_verdict: "Расчёт вердикта",
  generating_report: "Формирование отчёта",
  done: "Готово",
  error: "Ошибка",
};

export const CLAIM_TYPE_LABELS_RU: Record<ClaimType, string> = {
  MEDICAL_FACT: "Медицинский факт",
  STATISTICAL_CLAIM: "Статистическое утверждение",
  CAUSAL_CLAIM: "Причинно-следственная связь",
  SAFETY_CLAIM: "Заявление о безопасности",
  EFFICACY_CLAIM: "Заявление об эффективности",
  DIAGNOSTIC_CLAIM: "Диагностическое утверждение",
  TREATMENT_CLAIM: "Заявление о лечении",
  PREVENTION_CLAIM: "Заявление о профилактике",
  SCIENTIFIC_CLAIM: "Научное утверждение",
  ADVERTISEMENT: "Реклама",
  OPINION: "Мнение",
  PREDICTION: "Прогноз",
  QUOTE: "Цитата",
  ANALOGY: "Аналогия",
};
