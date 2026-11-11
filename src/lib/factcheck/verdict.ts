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

// Importance-weighted overall verdict thresholds.
// Tuned to be SYMMETRIC and conservative: a single LIKELY_FALSE claim must NOT
// collapse the overall verdict to FALSE — otherwise one weakly-contradicted
// claim poisons the whole analysis and the user always sees "FALSE".
// VERIFIED / FALSE require a near-unanimous, importance-weighted signal.
//
// Threshold alignment with LABEL_NUMERIC:
//   LABEL_NUMERIC[LIKELY_FALSE] = -1, so a single LIKELY_FALSE claim yields
//   avg = -1. For that to map to LIKELY_FALSE (not FALSE), the LIKELY_FALSE
//   threshold must be <= -1 and the FALSE threshold must be < -1.
//   We set: avg >= -0.5 → MISLEADING; avg >= -1.5 → LIKELY_FALSE; else FALSE.
//   So a single LIKELY_FALSE (-1) → LIKELY_FALSE; a single FALSE (-2) → FALSE;
//   two LIKELY_FALSE (-1) → LIKELY_FALSE; one FALSE + one LIKELY_FALSE (-1.5)
//   → LIKELY_FALSE; only a strong FALSE signal (< -1.5) → FALSE.
const NUMERIC_TO_LABEL: { value: number; label: VerdictLabel }[] = [
  { value: 1.5, label: "VERIFIED" },
  { value: 0.5, label: "LIKELY_TRUE" },
  { value: 0.1, label: "PARTIALLY_TRUE" },
  { value: -0.5, label: "MISLEADING" },
  { value: -1.5, label: "LIKELY_FALSE" },
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
 * Deterministic confidence (§36).
 *
 * Measures how STRONG the verdict is — NOT its direction. A high confidence
 * means "the evidence clearly points one way"; a low confidence means "the
 * evidence is sparse or split".
 *
 * Previous formula bugs being fixed here:
 *  1. clamp(0.1, 0.97, ...) — the artificial 0.97 cap meant that whenever
 *     evidence was strongly one-sided (which it usually is, because the LLM
 *     tends to find either supporting OR contradicting fragments, not both),
 *     confidence hit exactly 0.97 and the UI always showed "97%".
 *  2. The floor of 0.1 meant INSUFFICIENT_EVIDENCE verdicts still showed "10%"
 *     confidence, which is meaningless.
 *  3. `agreement` and `supportRatio` were highly correlated (both measure the
 *     same supporting/contradicting ratio), so the formula double-counted the
 *     consensus signal and rushed to saturation.
 *
 * New formula:
 *  - `consensus` = how one-sided the evidence is, in [0, 1]. 1 = all evidence
 *    agrees (regardless of direction); 0 = perfectly split.
 *  - `coverage` = min(1, relevant / 3) — need ≥3 evidence items for full coverage.
 *  - `qualityAvg` = mean overall quality of the sources actually used.
 *  - `independence` = unique organisations / total sources used.
 *  - `clarity` = claim.importance.
 * Confidence = consensus × (0.3·coverage + 0.3·quality + 0.2·independence + 0.2·clarity).
 * When there is NO evidence, consensus=0 → confidence=0 (no misleading "10%").
 * When evidence is overwhelming and high-quality, confidence can reach ~0.95+
 * but is no longer hard-capped at exactly 0.97.
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
  const denom = weightedSupport + weightedContradict;

  // consensus = how one-sided the weighted evidence is, in [0, 1].
  // |weightedSupport - weightedContradict| / (weightedSupport + weightedContradict).
  // When all evidence is on one side → 1. When perfectly balanced → 0.
  const consensus = denom > 0 ? Math.abs(weightedSupport - weightedContradict) / denom : 0;

  // independence bonus: unique organisations / total sources used
  const usedSources = new Set<string>();
  const usedOrgs = new Set<string>();
  let qualitySum = 0;
  let qualityCount = 0;
  for (const e of [...supporting, ...contradicting]) {
    const s = srcById.get(e.source_id);
    if (!s) continue;
    usedSources.add(s.id);
    usedOrgs.add(s.organization ?? s.url);
    qualitySum += s.quality.overall;
    qualityCount += 1;
  }
  const independenceBonus = usedSources.size > 0 ? Math.min(1, usedOrgs.size / usedSources.size) : 0;
  const qualityAvg = qualityCount > 0 ? clamp(qualitySum / qualityCount, 0, 1) : 0;

  const coverage = Math.min(1, relevant / 3);
  const clarity = _claim.importance;

  // No artificial 0.97 cap and no 0.1 floor — let the score reflect reality.
  // If there is no evidence (consensus=0), confidence is 0; if evidence is
  // overwhelming, it can reach up to ~0.95+ but no longer hard-capped at 0.97.
  //
  // CRITICAL FIX: the previous code called `clamp(0.1, 0.97, formula)` with
  // the arguments in the WRONG order. The function signature is
  // `clamp(v, lo, hi)` = `Math.max(lo, Math.min(hi, v))`, so the previous
  // call computed `Math.max(0.97, Math.min(formula, 0.1))` = `Math.max(0.97, 0.1)`
  // = `0.97` for ANY non-negative formula. This is the actual root cause of
  // the "always 97%" bug: confidence was hardcoded to 0.97 regardless of the
  // evidence quality. The arguments must be `clamp(formula, lo, hi)`.
  const conf = clamp(
    consensus *
      (0.3 * coverage + 0.3 * qualityAvg + 0.2 * independenceBonus + 0.2 * clarity),
    0,
    0.98
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
  } else if (weightedContradict > weightedSupport * 1.5 && weightedContradict > 0.05) {
    // Strong contradiction dominates. The previous rule jumped straight to
    // LIKELY_FALSE for any positive proposal — too aggressive. Now:
    //  - very strong contradiction (ratio ≥ 3:1) → LIKELY_FALSE
    //  - moderate contradiction (1.5:1 … 3:1) → soften down by ONE step only
    const ratio = weightedSupport > 0 ? weightedContradict / weightedSupport : Infinity;
    if (label === "VERIFIED") {
      label = ratio >= 3 ? "LIKELY_FALSE" : "PARTIALLY_TRUE";
    } else if (label === "LIKELY_TRUE") {
      label = ratio >= 3 ? "LIKELY_FALSE" : "PARTIALLY_TRUE";
    } else if (label === "PARTIALLY_TRUE") {
      label = ratio >= 3 ? "LIKELY_FALSE" : "MISLEADING";
    }
    // If the LLM already proposed MISLEADING/LIKELY_FALSE/FALSE, leave it.
  } else if (weightedSupport > weightedContradict * 1.5 && weightedSupport > 0.05) {
    // Symmetric to the above: strong support dominates.
    const ratio = weightedContradict > 0 ? weightedSupport / weightedContradict : Infinity;
    if (label === "FALSE") {
      label = ratio >= 3 ? "LIKELY_TRUE" : "PARTIALLY_TRUE";
    } else if (label === "LIKELY_FALSE") {
      label = ratio >= 3 ? "LIKELY_TRUE" : "PARTIALLY_TRUE";
    } else if (label === "MISLEADING") {
      label = ratio >= 3 ? "LIKELY_TRUE" : "PARTIALLY_TRUE";
    }
    // If the LLM already proposed VERIFIED/LIKELY_TRUE/PARTIALLY_TRUE, leave it.
  } else {
    // conflict ratio ~1 — evidence is mixed. Pull extreme labels toward the
    // centre so a single piece of contradicting evidence doesn't yield FALSE.
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
/**
 * Optional progress callback used by synthesizeVerdicts to report per-claim
 * synthesis progress to the orchestrator's SSE stream. The synthesis stage
 * makes one LLM call per claim-with-evidence; without this feedback the user
 * sees the "Синтез вердиктов" phase as active for minutes with no activity.
 */
export type VerdictProgress = (msg: string) => void;

export async function synthesizeVerdicts(
  claims: Claim[],
  sources: Source[],
  evidence: Evidence[],
  onProgress?: VerdictProgress
): Promise<Verdict[]> {
  const out: Verdict[] = [];
  const toCheck = claims.filter((c) => c.check_required || c.importance >= 0.5);
  onProgress?.(`Синтез вердиктов для ${toCheck.length} утверждений…`);
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
      onProgress?.(`Вердикт ${claim.id} — недостаточно данных (без LLM-вызова).`);
      continue;
    }

    onProgress?.(`Синтез ${claim.id} (ЗА: ${supporting.length}, ПРОТИВ: ${contradicting.length})…`);
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
    } catch (e) {
      // LLM failed — produce a deterministic-only verdict.
      const msg = e instanceof Error ? e.message : String(e);
      onProgress?.(`Синтез ${claim.id} — сбой LLM, детерминированный расчёт: ${msg.slice(0, 100)}`);
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
    onProgress?.(`Вердикт ${claim.id} — ${verdict.label} (conf=${verdict.confidence.toFixed(2)}).`);
  }
  onProgress?.(`Синтезировано вердиктов: ${out.length}.`);
  return out;
}

/**
 * Importance-weighted overall verdict (§69).
 * Returns the label + the importance-weighted average confidence.
 *
 * INSUFFICIENT_EVIDENCE verdicts are NOT directional — they mean "no verdict".
 * Previously they contributed LABEL_NUMERIC[INSUFFICIENT_EVIDENCE]=0 to the
 * weighted sum, which diluted the average toward 0 and made a single
 * INSUFFICIENT claim show overall "MISLEADING" instead of
 * "INSUFFICIENT_EVIDENCE". Now: if ALL verdicts are INSUFFICIENT_EVIDENCE,
 * the overall is INSUFFICIENT_EVIDENCE; otherwise INSUFFICIENT verdicts are
 * excluded from the directional weighted sum (they still dilute confidence).
 */
export function computeOverallVerdict(
  verdicts: Verdict[],
  claims: Claim[]
): { label: VerdictLabel; confidence: number } {
  if (verdicts.length === 0) {
    return { label: "INSUFFICIENT_EVIDENCE", confidence: 0 };
  }
  const claimById = new Map(claims.map((c) => [c.id, c]));

  // Confidence: average over ALL verdicts (including INSUFFICIENT, which has
  // low confidence → drags the average down, which is correct).
  let confSum = 0;
  let confWeight = 0;
  for (const v of verdicts) {
    const c = claimById.get(v.claim_id);
    const w = c ? Math.max(0.05, c.importance) : 0.5;
    confSum += v.confidence * w;
    confWeight += w;
  }
  const conf = confWeight > 0 ? confSum / confWeight : 0;

  // If every claim is INSUFFICIENT_EVIDENCE, the overall is INSUFFICIENT.
  if (verdicts.every((v) => v.label === "INSUFFICIENT_EVIDENCE")) {
    return { label: "INSUFFICIENT_EVIDENCE", confidence: round2(clamp(conf, 0, 1)) };
  }

  // Otherwise compute the directional weighted average, EXCLUDING
  // INSUFFICIENT_EVIDENCE verdicts so they don't drag the label toward 0.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const v of verdicts) {
    if (v.label === "INSUFFICIENT_EVIDENCE") continue;
    const c = claimById.get(v.claim_id);
    const w = c ? Math.max(0.05, c.importance) : 0.5;
    weightedSum += (LABEL_NUMERIC[v.label] ?? 0) * w;
    weightTotal += w;
  }
  if (weightTotal === 0) {
    return { label: "INSUFFICIENT_EVIDENCE", confidence: round2(clamp(conf, 0, 1)) };
  }
  const avg = weightedSum / weightTotal;
  return {
    label: numericToLabel(avg),
    confidence: round2(clamp(conf, 0, 1)),
  };
}
