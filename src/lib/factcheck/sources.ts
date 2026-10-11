/**
 * §20-§24 / §67: source evaluation + deduplication.
 *
 * For each raw web_search result we:
 *  - resolve the trusted-source entry (if any) → tier & authority from registry;
 *  - otherwise ask the LLM to classify source_type / evidence_level / quality;
 *  - lazily fetch the source's own text via page_reader so evidence can be
 *    extracted from real content (with graceful degradation);
 *  - dedup by canonical URL + by DOI/PMID if present in the title.
 */

import { FACTCHECK_CONFIG, findTrustedSource, type TrustedSourceEntry } from "./config";
import { truncate, validateUrl } from "./security";
import { fetchUrl } from "./web";
import { canonicalUrl, type RawSearchResult } from "./research";
import type {
  AnalysisMode,
  Source,
  SourceQuality,
  SourceType,
} from "./types";

const ALLOWED_SOURCE_TYPES: SourceType[] = [
  "SYSTEMATIC_REVIEW",
  "META_ANALYSIS",
  "COCHRANE_REVIEW",
  "RCT",
  "COHORT_STUDY",
  "CASE_CONTROL",
  "OBSERVATIONAL",
  "GUIDELINE",
  "GOVERNMENT_AUTHORITY",
  "REGULATOR",
  "NARRATIVE_REVIEW",
  "EXPERT_REVIEW",
  "SPECIALIZED_MEDICAL",
  "MAJOR_MEDIA",
  "BLOG",
  "SOCIAL_MEDIA",
  "COMMERCIAL",
  "ADVERTISEMENT",
  "OTHER",
];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Weighted mean of the six quality axes (per §67 weights). */
function weightedOverall(q: Partial<SourceQuality>): number {
  const o = {
    authority: Number(q.authority ?? 0),
    methodology: Number(q.methodology ?? 0),
    recency: Number(q.recency ?? 0),
    relevance: Number(q.relevance ?? 0),
    independence: Number(q.independence ?? 0),
    transparency: Number(q.transparency ?? 0),
  };
  return clamp01(
    o.authority * 0.25 +
      o.methodology * 0.2 +
      o.recency * 0.1 +
      o.relevance * 0.2 +
      o.independence * 0.15 +
      o.transparency * 0.1
  );
}

/** Cheap heuristic fallback when the LLM evaluator fails. */
function heuristicEval(r: RawSearchResult): {
  source_type: SourceType;
  evidence_level: number;
  quality: SourceQuality;
} {
  const host = (r.host_name || "").toLowerCase().replace(/^www\./, "");
  let source_type: SourceType = "OTHER";
  let evidence_level = 7;
  let authority = 0.45;
  if (/blog|livejournal|medium\.com|substack|wordpress|liveinternet/.test(host)) {
    source_type = "BLOG";
    evidence_level = 8;
    authority = 0.3;
  } else if (/twitter|x\.com|facebook|instagram|vk\.com|telegram|tiktok/.test(host)) {
    source_type = "SOCIAL_MEDIA";
    evidence_level = 8;
    authority = 0.25;
  } else if (/shop|market|ozon|wildberries|aliexpress|amazon|ebay/.test(host)) {
    source_type = "COMMERCIAL";
    evidence_level = 8;
    authority = 0.2;
  } else if (/(cnn|bbc|reuters|nytimes|bloomberg|theguardian|washingtonpost|ria|tass|interfax|lenta|rbc|meduza)\./.test(host)) {
    source_type = "MAJOR_MEDIA";
    evidence_level = 7;
    authority = 0.6;
  } else if (/(medscape|medicalnewstoday|healthline|mayoclinic|webmd|medabout|medportal|russian\.medical|dis\.ru|medi\.ru)\./.test(host)) {
    source_type = "SPECIALIZED_MEDICAL";
    evidence_level = 6;
    authority = 0.7;
  }
  const quality: SourceQuality = {
    authority,
    methodology: 0.5,
    recency: 0.6,
    relevance: 0.7,
    independence: 0.5,
    transparency: 0.5,
    overall: 0,
  };
  quality.overall = weightedOverall(quality);
  return { source_type, evidence_level, quality };
}

/** Build a Source from a raw result + (optionally) a trusted entry + fetched text. */
async function buildSource(
  index: number,
  r: RawSearchResult,
  trusted: TrustedSourceEntry | null,
  fetched: { text?: string; error?: string } | null
): Promise<Source> {
  let source_type: SourceType;
  let evidence_level: number;
  let quality: SourceQuality;

  if (trusted) {
    source_type = trusted.sourceType;
    evidence_level = trusted.evidenceLevel;
    quality = {
      authority: trusted.baseAuthority,
      methodology: 0.7,
      recency: 0.7,
      relevance: 0.75,
      independence: 0.85,
      transparency: 0.85,
      overall: 0,
    };
    quality.overall = weightedOverall(quality);
  } else {
    // Heuristic-only classification for non-trusted sources.
    // (The LLM sourceEvaluator is intentionally NOT called here: under the
    // shared LLM endpoint's tight rate budget, a per-source LLM call for
    // ~20 sources would exhaust it before evidence extraction even starts.
    // The host-pattern heuristic below already separates major media,
    // specialised medical publishers, blogs, social and commercial sites
    // into the right evidence tier, which is sufficient for the MVP verdict.)
    const heur = heuristicEval(r);
    source_type = heur.source_type;
    evidence_level = heur.evidence_level;
    quality = heur.quality;
  }

  const excerpt = fetched?.text
    ? truncate(fetched.text, FACTCHECK_CONFIG.web.maxSourceChars)
    : r.snippet
      ? truncate(r.snippet, FACTCHECK_CONFIG.web.maxSourceChars)
      : "";

  return {
    id: `source_${String(index + 1).padStart(3, "0")}`,
    url: r.url,
    title: r.name || r.host_name,
    organization: trusted?.organization ?? r.host_name,
    publication_date: r.date || undefined,
    retrieved_at: new Date().toISOString(),
    source_type,
    evidence_level,
    trusted: !!trusted,
    quality,
    excerpt,
    retrieval_error: fetched?.error,
  };
}

/**
 * Fetch the source's own text via direct HTTP + HTML→text (no z-ai).
 * Returns either { text } or { error } — never throws.
 */
export async function fetchSourceText(
  url: string
): Promise<{ text?: string; error?: string }> {
  const err = validateUrl(url);
  if (err) return { error: `URL blocked: ${err.message}` };
  const page = await fetchUrl(url);
  if (!page.ok) {
    return { error: page.error ?? "fetch failed" };
  }
  const text = truncate(page.text, FACTCHECK_CONFIG.web.maxSourceChars);
  if (!text || text.trim().length === 0) {
    return { error: "extracted text was empty" };
  }
  return { text };
}

/** Tiny concurrency-limited async mapper. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/** Extract a DOI or PMID hint from a title (very rough). */
function doiOrPmid(s: string): string | null {
  const m = s.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (m) return m[0].toLowerCase();
  const pm = s.match(/PMID[:\s]?(\d{6,9})/i);
  if (pm) return `pmid:${pm[1]}`;
  return null;
}

/**
 * Evaluate + lazily fetch a set of raw results → Source[].
 *
 * Dedup is done by canonical URL and by DOI/PMID (if present in the title).
 * Fetch failures downgrade but do not remove a source.
 */
export async function evaluateSources(
  rawResults: RawSearchResult[],
  _mode: AnalysisMode
): Promise<Source[]> {
  // dedup by canonical URL
  const seenUrl = new Set<string>();
  const seenDoi = new Set<string>();
  const unique: RawSearchResult[] = [];
  for (const r of rawResults) {
    if (!r.url) continue;
    const canon = canonicalUrl(r.url);
    if (seenUrl.has(canon)) continue;
    const doi = doiOrPmid(`${r.name} ${r.snippet}`);
    if (doi) {
      if (seenDoi.has(doi)) continue;
      seenDoi.add(doi);
    }
    seenUrl.add(canon);
    unique.push(r);
  }

  // Resolve trusted entries (cheap, synchronous).
  const withTrusted = unique.map((r) => ({
    r,
    trusted: findTrustedSource(r.host_name),
  }));

  // Lazily fetch each source's own text — concurrency capped at 3 (§50).
  const fetched = await mapWithConcurrency(withTrusted, 3, async ({ r }, i) => {
    // skip fetching if we already have a decent snippet — saves latency
    if (r.snippet && r.snippet.length > 200 && !r.trusted) {
      // still try trusted sources (they're worth it); others rely on snippet
      return null;
    }
    // We do not fetch every result — only trusted or those with a thin snippet.
    if (r.trusted || r.snippet.length < 80) {
      return await fetchSourceText(r.url);
    }
    return null;
  });

  const sources: Source[] = [];
  for (let i = 0; i < withTrusted.length; i++) {
    const { r, trusted } = withTrusted[i];
    const f = fetched[i];
    const src = await buildSource(i, r, trusted, f);
    sources.push(src);
  }
  return sources;
}
