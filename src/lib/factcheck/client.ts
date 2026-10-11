/**
 * Pure client-side formatting helpers for the fact-checker UI.
 * Safe to import from "use client" components.
 * No server-only imports here (no z-ai-web-dev-sdk, no llm.ts, no security.ts).
 */
import type {
  Claim,
  Evidence,
  Source,
  Verdict,
  VerdictLabel,
  PipelineStage,
} from "./types";

/** 0..1 → integer percentage string, e.g. 0.873 → "87%". */
export function formatConfidence(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return `${Math.round(pct)}%`;
}

/** Map a verdict label to the matching gx-v-* text color class. */
export function verdictColorClass(label: VerdictLabel): string {
  switch (label) {
    case "VERIFIED":
      return "gx-v-verified";
    case "LIKELY_TRUE":
      return "gx-v-likely-true";
    case "PARTIALLY_TRUE":
      return "gx-v-partially-true";
    case "MISLEADING":
      return "gx-v-misleading";
    case "LIKELY_FALSE":
      return "gx-v-likely-false";
    case "FALSE":
      return "gx-v-false";
    case "INSUFFICIENT_EVIDENCE":
      return "gx-v-insufficient";
  }
}

/** Map a verdict label to the matching gx-bg-v-* background/border class. */
export function verdictBgClass(label: VerdictLabel): string {
  switch (label) {
    case "VERIFIED":
      return "gx-bg-v-verified";
    case "LIKELY_TRUE":
      return "gx-bg-v-likely-true";
    case "PARTIALLY_TRUE":
      return "gx-bg-v-partially-true";
    case "MISLEADING":
      return "gx-bg-v-misleading";
    case "LIKELY_FALSE":
      return "gx-bg-v-likely-false";
    case "FALSE":
      return "gx-bg-v-false";
    case "INSUFFICIENT_EVIDENCE":
      return "gx-bg-v-insufficient";
  }
}

/** Solid dot color (raw hex) for a verdict — used for history list markers. */
export function verdictDotColor(label: VerdictLabel): string {
  switch (label) {
    case "VERIFIED":
      return "#2ec4b6";
    case "LIKELY_TRUE":
      return "#7fd1c4";
    case "PARTIALLY_TRUE":
      return "#e9c46a";
    case "MISLEADING":
      return "#f4a261";
    case "LIKELY_FALSE":
      return "#ff8aad";
    case "FALSE":
      return "#ff5c8a";
    case "INSUFFICIENT_EVIDENCE":
      return "#8a9aa6";
  }
}

/** Extract a hostname from a URL string; falls back to the raw string. */
export function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Determine the stage order used by the progress panel. */
export const STAGE_ORDER: PipelineStage[] = [
  "queued",
  "validating_url",
  "fetching_material",
  "extracting_text",
  "extracting_claims",
  "planning_research",
  "searching_sources",
  "evaluating_sources",
  "extracting_evidence",
  "adversarial_search",
  "synthesising",
  "calculating_verdict",
  "generating_report",
  "done",
];

/** Count verdicts by label. */
export function countVerdicts(verdicts: Verdict[]): Record<VerdictLabel, number> {
  const out: Record<VerdictLabel, number> = {
    VERIFIED: 0,
    LIKELY_TRUE: 0,
    PARTIALLY_TRUE: 0,
    MISLEADING: 0,
    LIKELY_FALSE: 0,
    FALSE: 0,
    INSUFFICIENT_EVIDENCE: 0,
  };
  for (const v of verdicts) {
    out[v.label] = (out[v.label] ?? 0) + 1;
  }
  return out;
}

/** Map a claim id → its verdict (undefined if missing). */
export function verdictByClaim(verdicts: Verdict[]): Map<string, Verdict> {
  const m = new Map<string, Verdict>();
  for (const v of verdicts) m.set(v.claim_id, v);
  return m;
}

/** Map a source id → the source. */
export function sourceMap(sources: Source[]): Map<string, Source> {
  const m = new Map<string, Source>();
  for (const s of sources) m.set(s.id, s);
  return m;
}

/** Evidence items that relate to a given claim id. */
export function evidenceForClaim(evidence: Evidence[], claimId: string): Evidence[] {
  return evidence.filter((e) => e.claim_id === claimId);
}

/** Sources used by a specific claim (via verdict.source_ids or evidence.source_id). */
export function sourcesForClaim(
  claim: Claim,
  verdict: Verdict | undefined,
  evidence: Evidence[],
  sources: Source[],
): Source[] {
  const sMap = sourceMap(sources);
  const ids = new Set<string>(verdict?.source_ids ?? []);
  for (const ev of evidenceForClaim(evidence, claim.id)) ids.add(ev.source_id);
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const s = sMap.get(id);
    if (s) {
      seen.add(id);
      out.push(s);
    }
  }
  return out;
}

/** Truncate a string to N chars, adding an ellipsis if needed. */
export function truncate(text: string, n: number): string {
  const t = text.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).trimEnd()}…`;
}

/** Evidence-tier badge label (tier 1..8 → "Tier 1" etc.). */
export function tierLabel(level: number | undefined): string {
  if (!level) return "—";
  return `Tier ${level}`;
}

/** Source-type label (RU) — minimal local mapping to avoid contract churn. */
const SOURCE_TYPE_LABELS_RU: Record<string, string> = {
  SYSTEMATIC_REVIEW: "Систематический обзор",
  META_ANALYSIS: "Метаанализ",
  COCHRANE_REVIEW: "Обзор Cochrane",
  RCT: "РКИ",
  COHORT_STUDY: "Когортное исследование",
  CASE_CONTROL: "Исследование «случай–контроль»",
  OBSERVATIONAL: "Наблюдательное исследование",
  GUIDELINE: "Клиническое руководство",
  GOVERNMENT_AUTHORITY: "Государственный орган",
  REGULATOR: "Регулятор",
  NARRATIVE_REVIEW: "Обзор",
  EXPERT_REVIEW: "Экспертный обзор",
  SPECIALIZED_MEDICAL: "Специализированный медицинский источник",
  MAJOR_MEDIA: "Крупные СМИ",
  BLOG: "Блог",
  SOCIAL_MEDIA: "Социальные сети",
  COMMERCIAL: "Коммерческий сайт",
  ADVERTISEMENT: "Реклама",
  OTHER: "Другое",
};

export function sourceTypeLabel(t: string): string {
  return SOURCE_TYPE_LABELS_RU[t] ?? t;
}

/** Content-nature warning label (RU). */
export function contentNatureLabel(n: string | undefined): string | null {
  if (!n || n === "INFORMATION") return null;
  switch (n) {
    case "ADVERTISEMENT":
      return "Коммерческий контент / реклама";
    case "NATIVE_ADVERTISEMENT":
      return "Нативная реклама";
    case "SPONSORED_CONTENT":
      return "Спонсорский контент";
    case "AFFILIATE_CONTENT":
      return "Партнёрский контент";
    default:
      return "Коммерческий контент";
  }
}

/** Direction badge text (RU). */
export function directionLabel(d: string): string {
  switch (d) {
    case "SUPPORTS":
      return "ЗА";
    case "CONTRADICTS":
      return "ПРОТИВ";
    case "NEUTRAL":
      return "НЕЙТРАЛЬНО";
    default:
      return d;
  }
}
