/**
 * §25-§27 / §18: evidence extraction + adversarial evidence.
 *
 * For each IMPORTANT claim × each usable source, ask the LLM to extract a
 * concrete evidence fragment + direction + relevance + strength.
 *
 * The adversarial pass (§18) is implemented in research.ts; here we just
 * iterate over ALL sources (including adversarial ones already merged in).
 */

import { FACTCHECK_CONFIG } from "./config";
import { PROMPTS } from "./prompts";
import { runJsonPrompt } from "./llm";
import { truncate } from "./security";
import type { AnalysisMode, Claim, Evidence, Source } from "./types";

/** LLM-shaped response from evidenceExtractor. */
interface EvidenceResponse {
  text?: string;
  direction?: Evidence["direction"];
  relevance?: number;
  strength?: number;
  note?: string;
}

function isImportant(c: Claim): boolean {
  return c.importance >= 0.6 || c.check_required;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Extract evidence from (claims × sources). Returns a flat Evidence[].
 *
 * Cost is bounded to stay within the shared LLM endpoint rate budget:
 *  - only IMPORTANT claims are checked (importance >= 0.6 OR check_required);
 *  - at most MAX_CLAIMS_TO_CHECK most-important claims are checked;
 *  - for each claim only the top sources by quality are checked (MAX_SOURCES_PER_CLAIM);
 *  - LLM calls are serialised + throttled in llm.ts (429 backoff).
 */
const MAX_CLAIMS_TO_CHECK = 4;
const MAX_SOURCES_PER_CLAIM = 2;

export async function extractEvidence(
  claims: Claim[],
  sources: Source[],
  _mode: AnalysisMode
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  let idx = 0;
  const usableSources = sources.filter((s) => (s.excerpt ?? "").length > 0);
  if (usableSources.length === 0) return out;

  // Sort usable sources by overall quality desc so the best are checked first.
  const sortedSources = [...usableSources].sort(
    (a, b) => b.quality.overall - a.quality.overall
  );

  // Keep only the most important claims to bound the number of LLM calls.
  const importantClaims = claims
    .filter(isImportant)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_CLAIMS_TO_CHECK);

  for (const claim of importantClaims) {
    let perClaim = 0;
    for (const src of sortedSources) {
      if (perClaim >= MAX_SOURCES_PER_CLAIM) break;
      const sourceText = truncate(
        src.excerpt ?? "",
        FACTCHECK_CONFIG.limits.maxContextChars
      );
      let parsed: EvidenceResponse | undefined;
      try {
        parsed = await runJsonPrompt<EvidenceResponse>(
          PROMPTS.evidenceExtractor,
          {
            CLAIM: claim.text,
            SOURCE_TEXT: sourceText,
          }
        );
      } catch {
        continue;
      }
      if (!parsed) continue;
      const text = (parsed.text ?? "").trim();
      // skip "no relevant evidence"
      if (!text) continue;
      const direction = (parsed.direction ?? "NEUTRAL").toUpperCase();
      if (
        direction !== "SUPPORTS" &&
        direction !== "CONTRADICTS" &&
        direction !== "NEUTRAL"
      ) {
        continue;
      }
      idx += 1;
      out.push({
        id: `evidence_${String(idx).padStart(3, "0")}`,
        claim_id: claim.id,
        source_id: src.id,
        text,
        evidence_type: direction === "SUPPORTS" ? "SUPPORTING" : direction === "CONTRADICTS" ? "CONTRADICTING" : "NEUTRAL",
        direction,
        relevance: clamp01(Number(parsed.relevance ?? 0.5)),
        strength: clamp01(Number(parsed.strength ?? 0.5)),
      });
      perClaim += 1;
    }
  }
  return out;
}
