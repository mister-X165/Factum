/**
 * §12-§15: claim extraction (decomposition + classification + importance).
 *
 * The LLM does the heavy lifting (decomposition, type, importance), but we
 * validate and normalise its output. We never trust LLM-provided ids — we
 * re-issue stable claim_001/claim_002… ids.
 */

import { FACTCHECK_CONFIG } from "./config";
import { PROMPTS } from "./prompts";
import { runJsonPrompt, LLMTimeoutError } from "./llm";
import { truncate } from "./security";
import type { Claim, ClaimType, FetchedDocument } from "./types";

const ALLOWED_TYPES: ClaimType[] = [
  "MEDICAL_FACT",
  "STATISTICAL_CLAIM",
  "CAUSAL_CLAIM",
  "SAFETY_CLAIM",
  "EFFICACY_CLAIM",
  "DIAGNOSTIC_CLAIM",
  "TREATMENT_CLAIM",
  "PREVENTION_CLAIM",
  "SCIENTIFIC_CLAIM",
  "ADVERTISEMENT",
  "OPINION",
  "PREDICTION",
  "QUOTE",
  "ANALOGY",
];

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** Normalise the LLM-shaped claim into a strict Claim. */
function normaliseClaim(raw: Partial<Claim>, index: number): Claim {
  const text = (raw.text ?? "").toString().trim();
  const normalized = (raw.normalized_text ?? text).toString().trim();
  const type: ClaimType = ALLOWED_TYPES.includes(raw.type as ClaimType)
    ? (raw.type as ClaimType)
    : "MEDICAL_FACT";
  const importance = clamp(Number(raw.importance ?? 0.5), 0, 1);
  return {
    id: `claim_${String(index + 1).padStart(3, "0")}`,
    text,
    normalized_text: normalized,
    type,
    importance,
    check_required: typeof raw.check_required === "boolean" ? raw.check_required : true,
    context: (raw.context ?? "").toString().trim(),
  };
}

/**
 * Extract claims from a fetched document.
 *
 * On a hard LLM failure (timeout, connection error, HTTP error) the error is
 * RE-THROWN so the orchestrator can surface a clear, actionable message to
 * the user — previously it was swallowed and the user saw the misleading
 * "Не удалось выделить проверяемые утверждения из материала." text.
 *
 * Returns [] only when the LLM answered successfully but produced no usable
 * claims (e.g. the article is pure advertising with no checkable statements).
 */
export async function extractClaims(doc: FetchedDocument): Promise<Claim[]> {
  // Use maxContextChars (NOT ×2). A 12 K-char prefill on a 5 tok/s model
  // blows the timeout budget; 6 K chars is enough to extract the top claims
  // and keeps the prefill under ~1.5 K tokens.
  const article = truncate(doc.text, FACTCHECK_CONFIG.limits.maxContextChars);
  let parsed: { claims?: Partial<Claim>[] } | undefined;
  try {
    parsed = await runJsonPrompt<{ claims: Partial<Claim>[] }>(
      PROMPTS.claimExtractor,
      { ARTICLE: article }
    );
  } catch (e) {
    // Propagate the real cause (timeout / connection / HTTP). The orchestrator
    // catches it and shows the user what actually went wrong.
    if (e instanceof LLMTimeoutError) throw e;
    if (e instanceof Error) {
      throw new Error(`LLM-вызов извлечения утверждений завершился ошибкой: ${e.message}`);
    }
    throw new Error("LLM-вызов извлечения утверждений завершился неизвестной ошибкой.");
  }
  const rawList = Array.isArray(parsed?.claims) ? parsed!.claims : [];
  if (rawList.length === 0) return [];

  // keep only claims with non-empty text
  const cleaned = rawList
    .map((c) => ({ ...c, text: (c?.text ?? "").toString().trim() }))
    .filter((c) => c.text.length > 0)
    .sort((a, b) => Number(b.importance ?? 0.5) - Number(a.importance ?? 0.5))
    .slice(0, FACTCHECK_CONFIG.limits.maxClaims)
    .map((c, i) => normaliseClaim(c, i));

  return cleaned;
}
