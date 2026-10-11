/**
 * §33-§40 / §69 / §38 / §99: DETERMINISTIC verdict engine.
 *
 * The LLM is allowed to PROPOSE a label + explanation (§36 synthesiser
 * prompt). The final confidence and any label adjustment are computed
 * DETERMINISTICALLY here — the LLM can never upgrade "may" → "proven"
 * (§38/§99).
 *
 * The overall verdict is importance-weighted (§69): never a simple average.
 */

import { FACTCHECK_CONFIG, tierWeight } from "./config";
import { PROMPTS } from "./prompts";
import { runJsonPrompt } from "./llm";
import { truncate } from "./security";
import type { Claim, Evidence, Source, Verdict, VerdictLabel } from "./types";

interface VerdictProposal {
  label: VerdictLabel;
  confidence: number;
  explanation: string;
  insufficient_reason?: string;
}

const LABEL_NUMERIC: Record<VerdictLabel, number> = {
  VERIFIED: 2,
  LIKELY_TRUE: 1,
  PARTIALLY_TRUE: 0.5,
  MISLEADING: -0.5,
  LIKELY_FALSE: -1,
  FALSE: -2,
  INSUFFICIENT_EVIDENCE: 0,
};

const NUMERIC_TO_LABEL: { value: number; label: VerdictLabel }[] = [
  { value: 1.5, label: "VERIFIED" },
  { value: 0.8, label: "LIKELY_TRUE" },
  { value: 0.2, label: "PARTIALLY_TRUE" },
  { value: -0.2, label: "MISLEADING" },
  { value: -0.8, label: "LIKELY_FALSE" },
  { value: -1.5, label: "FALSE" },
];

function numericToLabel(v: number): VerdictLabel {
  for (const { value, label } of NUMERIC_TO_LABEL) {
    if (v >= value) return label;
  }
  return "FALSE";
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Detect exaggeration: claim says "proven/causes/prevents" but evidence says "may/associated/mice". */
function detectExaggeration(claim: Claim, supporting: Evidence[]): boolean {
  const strong = /(доказано|proven|вылечивает|cures|предотвращает|prevents|причин(яет|яет)|causes|гарантирует|guarantees|100%|полностью)/i;
  const weak = /(\bmay\b|может|associated|связан|in mice|у животных|correlates|коррелир|risk|риск|preliminary|предварительн)/i;
  const claimStrong = strong.test(claim.text);
  const evidenceWeak = supporting.some((e) => weak.test(e.text));
  return claimStrong && evidenceWeak;
}

/**
 * Deterministic confidence (§36):
 *  weightedSupport, weightedContradict, agreement, independence, coverage, clarity
 */
function computeConfidence(
  _claim: Claim,
  supporting: Evidence[],
  contradicting: Evidence[],
  sources: Source[]
): number {
  const srcById = new Map(sources.map((s) => [s.id, s]));

  let weightedSupport = 0;
  for (const e of supporting) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    weightedSupport += e.strength * tierWeight(s.evidence_level) * s.quality.overall;
  }
  let weightedContradict = 0;
  for (const e of contradicting) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    weightedContradict += e.strength * tierWeight(s.evidence_level) * s.quality.overall;
  }

  const relevant = supporting.length + contradicting.length;
  const agreement = supporting.length / Math.max(1, relevant);
  const denom = weightedSupport + weightedContradict;
  const supportRatio = denom > 0 ? weightedSupport / denom : 0;

  // independence bonus: unique organisations / total sources used
  const usedSources = new Set<string>();
  const usedOrgs = new Set<string>();
  for (const e of [...supporting, ...contradicting]) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    usedSources.add(s.id);
    usedOrgs.add(s.organization ?? s.url);
  }
  const independenceBonus = usedSources.size > 0 ? Math.min(1, usedOrgs.size / usedSources.size) : 0;

  const coverage = Math.min(1, relevant / 3);
  const clarity = _claim.importance;

  const conf = clamp(
    0.1,
    0.97,
    0.35 * agreement +
      0.25 * supportRatio +
      0.15 * independenceBonus +
      0.15 * coverage +
      0.1 * clarity
  );
  return round2(conf);
}

/** Apply the deterministic label rules (§38/§99) on top of an LLM proposal. */
function adjustLabel(
  proposal: VerdictProposal,
  claim: Claim,
  supporting: Evidence[],
  contradicting: Evidence[],
  sources: Source[],
  confidence: number
): Verdict {
  const srcById = new Map(sources.map((s) => [s.id, s]));
  let weightedSupport = 0;
  for (const e of supporting) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    weightedSupport += e.strength * tierWeight(s.evidence_level) * s.quality.overall;
  }
  let weightedContradict = 0;
  for (const e of contradicting) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    weightedContradict += e.strength * tierWeight(s.evidence_level) * s.quality.overall;
  }
  const relevantCount = supporting.length + contradicting.length;

  let label = proposal.label;
  let insufficient_reason: string | undefined = proposal.insufficient_reason;

  // §33/§34: insufficient guardrail
  if (relevantCount < FACTCHECK_CONFIG.insufficient.minRelevantSources) {
    label = "INSUFFICIENT_EVIDENCE";
    insufficient_reason =
      insufficient_reason ||
      `Меньше ${FACTCHECK_CONFIG.insufficient.minRelevantSources} релевантных источников (${relevantCount}).`;
  } else if (weightedContradict > weightedSupport * 1.5) {
    // strong contradiction → bump toward FALSE
    if (label === "VERIFIED" || label === "LIKELY_TRUE" || label === "PARTIALLY_TRUE") {
      label = "LIKELY_FALSE";
    }
  } else if (weightedSupport > weightedContradict * 1.5) {
    const agreement = supporting.length / Math.max(1, relevantCount);
    if (agreement >= 0.7 && (label === "LIKELY_FALSE" || label === "FALSE")) {
      // conflict with the evidence — soften
      label = "LIKELY_TRUE";
    }
  } else {
    // conflict ratio ~1
    if (label === "VERIFIED" || label === "FALSE") {
      if (detectExaggeration(claim, supporting)) {
        label = "MISLEADING";
      } else {
        label = "PARTIALLY_TRUE";
      }
    }
  }

  // §38/§99: never let the LLM upgrade "may" → "proven".
  if (label === "VERIFIED" && confidence < 0.6) {
    label = "LIKELY_TRUE";
  }
  // If insufficient reason but label was set otherwise, force INSUFFICIENT.
  if (label === "INSUFFICIENT_EVIDENCE" && !insufficient_reason) {
    insufficient_reason = "Недостаточно данных для проверки.";
  }

  return {
    claim_id: claim.id,
    label,
    confidence,
    explanation: proposal.explanation,
    supporting_evidence_ids: supporting.map((e) => e.id),
    contradicting_evidence_ids: contradicting.map((e) => e.id),
    source_ids: Array.from(
      new Set([...supporting, ...contradicting].map((e) => e.source_id))
    ),
    insufficient_reason,
  };
}

/** Build a compact evidence summary for the synthesiser prompt. */
function evidenceSummary(
  claim: Claim,
  supporting: Evidence[],
  contradicting: Evidence[],
  sources: Source[]
): string {
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const fmt = (e: Evidence) => {
    const s = srcById.get(e.source_id);
    return `• [${e.direction}] ${truncate(e.text, 240)} (source: ${
      s?.organization ?? s?.url ?? "—"
    }, tier ${s?.evidence_level ?? "?"}, strength ${e.strength.toFixed(2)})`;
  };
  return JSON.stringify(
    {
      claim: { id: claim.id, text: claim.text, type: claim.type, importance: claim.importance },
      supporting: supporting.map(fmt),
      contradicting: contradicting.map(fmt),
      min_relevant_sources: FACTCHECK_CONFIG.insufficient.minRelevantSources,
    },
    null,
    2
  );
}

/**
 * For each claim: gather its evidence, ask the LLM for a proposal, then
 * compute the DETERMINISTIC confidence and adjust the label.
 */
export async function synthesizeVerdicts(
  claims: Claim[],
  sources: Source[],
  evidence: Evidence[]
): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const claim of claims) {
    if (!claim.check_required && claim.importance < 0.5) {
      // skip claims the LLM flagged as not needing a check
      continue;
    }
    const supporting = evidence.filter(
      (e) => e.claim_id === claim.id && e.direction === "SUPPORTS"
    );
    const contradicting = evidence.filter(
      (e) => e.claim_id === claim.id && e.direction === "CONTRADICTS"
    );

    // No evidence at all → deterministic INSUFFICIENT_EVIDENCE, no LLM call.
    // This bounds the number of LLM synthesiser calls to the claims that
    // actually have evidence (≤ MAX_CLAIMS_TO_CHECK in evidence.ts).
    if (supporting.length === 0 && contradicting.length === 0) {
      const confidence = computeConfidence(claim, supporting, contradicting, sources);
      out.push({
        claim_id: claim.id,
        label: "INSUFFICIENT_EVIDENCE",
        confidence,
        explanation:
          "Не найдено релевантных доказательств по этому утверждению в доступных источниках.",
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        source_ids: [],
        insufficient_reason:
          "В найденных источниках нет фрагментов, которые бы подтверждали или опровергали это утверждение.",
      });
      continue;
    }

    const summary = evidenceSummary(claim, supporting, contradicting, sources);
    let proposal: VerdictProposal;
    try {
      const res = await runJsonPrompt<{
        label: VerdictLabel;
        confidence: number;
        explanation: string;
        insufficient_reason?: string;
      }>(PROMPTS.verdictSynthesizer, { EVIDENCE: summary, CLAIM: claim.text });
      proposal = {
        label: res.label,
        confidence: Number(res.confidence ?? 0.5),
        explanation: res.explanation ?? "",
        insufficient_reason: res.insufficient_reason,
      };
    } catch {
      // LLM failed — produce a deterministic-only verdict.
      const confidence = computeConfidence(claim, supporting, contradicting, sources);
      proposal = {
        label: "INSUFFICIENT_EVIDENCE",
        confidence,
        explanation:
          "Синтез вердикта не удался — вердикт рассчитан детерминированно на основе собранных доказательств.",
      };
    }

    const confidence = computeConfidence(claim, supporting, contradicting, sources);
    const verdict = adjustLabel(
      proposal,
      claim,
      supporting,
      contradicting,
      sources,
      confidence
    );
    out.push(verdict);
  }
  return out;
}

/**
 * Importance-weighted overall verdict (§69).
 * Returns the label + the importance-weighted average confidence.
 */
export function computeOverallVerdict(
  verdicts: Verdict[],
  claims: Claim[]
): { label: VerdictLabel; confidence: number } {
  const claimById = new Map(claims.map((c) => [c.id, c]));
  let weightedSum = 0;
  let weightTotal = 0;
  let confSum = 0;
  let confWeight = 0;
  for (const v of verdicts) {
    const c = claimById.get(v.claim_id);
    const w = c ? Math.max(0.05, c.importance) : 0.5;
    weightedSum += (LABEL_NUMERIC[v.label] ?? 0) * w;
    weightTotal += w;
    confSum += v.confidence * w;
    confWeight += w;
  }
  if (weightTotal === 0) {
    return { label: "INSUFFICIENT_EVIDENCE", confidence: 0 };
  }
  const avg = weightedSum / weightTotal;
  const conf = confWeight > 0 ? confSum / confWeight : 0;
  return {
    label: numericToLabel(avg),
    confidence: round2(clamp(conf, 0, 1)),
  };
}
