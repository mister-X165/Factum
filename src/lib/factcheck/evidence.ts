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
import { bestWindow, truncate } from "./security";
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
 *
 * Tuning history:
 *  - MAX_CLAIMS_TO_CHECK was 4, MAX_SOURCES_PER_CLAIM was 2 → at most 8 LLM
 *    calls per analysis. With short snippets many sources were skipped, so
 *    in practice only 2-3 evidence items survived and verdicts defaulted to
 *    INSUFFICIENT_EVIDENCE or got an overconfident label from one stray
 *    fragment. Raised to 6 × 3 = 18 calls — still bounded, but enough to
 *    actually cover the important claims × top sources.
 *  - The source text fed to the LLM is now selected with bestWindow() (the
 *    most content-dense window of maxContextChars chars) instead of
 *    head-truncation. Previously a source whose first 6 KB was nav/cookie
 *    boilerplate fed the LLM pure navigation junk, and the LLM correctly
 *    answered "no relevant evidence" even when the article body further down
 *    the page perfectly supported or refuted the claim.
 */
const MAX_CLAIMS_TO_CHECK = 6;
const MAX_SOURCES_PER_CLAIM = 3;

/**
 * Optional progress callback used by extractEvidence to report per-call
 * progress to the orchestrator's SSE stream. Without this the user sees the
 * "Извлечение доказательств" phase as active for many minutes (up to 18
 * serial LLM calls on a slow local model) with no visible activity — which
 * looks exactly like a freeze.
 *
 * The callback receives a short human-readable message (already localised).
 */
export type EvidenceProgress = (msg: string) => void;

export async function extractEvidence(
  claims: Claim[],
  sources: Source[],
  _mode: AnalysisMode,
  onProgress?: EvidenceProgress
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  let idx = 0;
  const usableSources = sources.filter((s) => (s.excerpt ?? "").length > 0);
  if (usableSources.length === 0) {
    onProgress?.("Нет источников с текстом для извлечения доказательств.");
    return out;
  }

  // Sort usable sources by overall quality desc so the best are checked first.
  const sortedSources = [...usableSources].sort(
    (a, b) => b.quality.overall - a.quality.overall
  );

  // Keep only the most important claims to bound the number of LLM calls.
  const importantClaims = claims
    .filter(isImportant)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_CLAIMS_TO_CHECK);

  onProgress?.(
    `Проверяем ${importantClaims.length} утверждений × до ${MAX_SOURCES_PER_CLAIM} источников ` +
      `(макс. ${importantClaims.length * MAX_SOURCES_PER_CLAIM} LLM-вызовов).`
  );

  for (const claim of importantClaims) {
    let perClaim = 0;
    for (const src of sortedSources) {
      if (perClaim >= MAX_SOURCES_PER_CLAIM) break;
      // Use bestWindow() to pick the most content-dense window of the source
      // text — head-truncation missed article bodies buried under nav chrome.
      const windowed = bestWindow(src.excerpt ?? "", FACTCHECK_CONFIG.limits.maxContextChars);
      const sourceText = truncate(windowed, FACTCHECK_CONFIG.limits.maxContextChars);
      const srcHost = (() => {
        try {
          return new URL(src.url).hostname.replace(/^www\./, "");
        } catch {
          return src.id;
        }
      })();
      let parsed: EvidenceResponse | undefined;
      try {
        parsed = await runJsonPrompt<EvidenceResponse>(
          PROMPTS.evidenceExtractor,
          {
            CLAIM: claim.text,
            SOURCE_TEXT: sourceText,
          }
        );
      } catch (e) {
        // Surface the failure instead of silently skipping — the user needs to
        // know the LLM is returning errors so they can adjust timeouts/model.
        const msg = e instanceof Error ? e.message : String(e);
        onProgress?.(`Доказательство ${claim.id} × ${srcHost} — сбой LLM: ${msg.slice(0, 120)}`);
        continue;
      }
      if (!parsed) {
        onProgress?.(`Доказательство ${claim.id} × ${srcHost} — пустой ответ LLM`);
        continue;
      }
      const text = (parsed.text ?? "").trim();
      // skip "no relevant evidence"
      if (!text) {
        onProgress?.(`Доказательство ${claim.id} × ${srcHost} — нет релевантных данных`);
        continue;
      }
      const direction = (parsed.direction ?? "NEUTRAL").toUpperCase();
      if (
        direction !== "SUPPORTS" &&
        direction !== "CONTRADICTS" &&
        direction !== "NEUTRAL"
      ) {
        onProgress?.(`Доказательство ${claim.id} × ${srcHost} — некорректная направленность`);
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
      onProgress?.(
        `Доказательство ${claim.id} × ${srcHost} — ${direction === "SUPPORTS" ? "поддерживает" : direction === "CONTRADICTS" ? "опровергает" : "нейтрально"}`
      );
    }
  }
  onProgress?.(`Извлечено доказательств: ${out.length}.`);
  return out;
}
