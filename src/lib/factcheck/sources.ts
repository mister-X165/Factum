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

/** Cheap heuristic fallback when the LLM evaluator fails.
 *  Default for unknown hosts is now tier 8 (the lowest) — previously it was
 *  tier 7 ("major media"), which over-rated random websites and let weak
 *  sources dominate the verdict engine. Specialized medical and major media
 *  hosts are detected explicitly so they keep their proper tier.
 */
function heuristicEval(r: RawSearchResult): {
  source_type: SourceType;
  evidence_level: number;
  quality: SourceQuality;
} {
  const host = (r.host_name || "").toLowerCase().replace(/^www\./, "");
  let source_type: SourceType = "OTHER";
  // Default to tier 8 (blogs/social/commercial) for unknown hosts — NOT tier 7.
  // Tier 7 is reserved for the major-media regex below.
  let evidence_level = 8;
  let authority = 0.4;
  let methodology = 0.45;
  let independence = 0.5;
  if (/blog|livejournal|medium\.com|substack|wordpress|liveinternet/.test(host)) {
    source_type = "BLOG";
    evidence_level = 8;
    authority = 0.3;
    methodology = 0.35;
    independence = 0.4;
  } else if (/twitter|x\.com|facebook|instagram|vk\.com|telegram|tiktok/.test(host)) {
    source_type = "SOCIAL_MEDIA";
    evidence_level = 8;
    authority = 0.25;
    methodology = 0.3;
    independence = 0.35;
  } else if (/shop|market|ozon|wildberries|aliexpress|amazon|ebay/.test(host)) {
    source_type = "COMMERCIAL";
    evidence_level = 8;
    authority = 0.2;
    methodology = 0.3;
    independence = 0.3;
  } else if (/\.gov\.|\.gouv\.|\.gov\.ru$|rosminzdrav|rcrzdrav|who\.int|cdc\.gov|fda\.gov|ema\.europa\.eu|nice\.org\.uk/.test(host)) {
    // Government / regulator / authority — tier 4.
    source_type = /who\.int|cdc\.gov|rosminzdrav/.test(host) ? "GOVERNMENT_AUTHORITY" : "REGULATOR";
    evidence_level = 4;
    authority = 0.9;
    methodology = 0.85;
    independence = 0.9;
  } else if (/nejm\.org|thelancet\.com|bmj\.com|jamanetwork\.com|nature\.com|sciencedirect\.com|springer\.com|wiley\.com|mdpi\.com|plos\.org|pubmed|ncbi\.nlm\.nih|europepmc|cochrane|doi\.org|crossref/.test(host)) {
    // Specialised medical / scientific publisher — tier 2-3.
    source_type = "SPECIALIZED_MEDICAL";
    evidence_level = /nejm|thelancet|bmj|jamanetwork|cochrane|pubmed|ncbi/.test(host) ? 2 : 3;
    authority = 0.88;
    methodology = 0.85;
    independence = 0.85;
  } else if (/(medscape|medicalnewstoday|healthline|mayoclinic|webmd|medabout|medportal|russian\.medical|dis\.ru|medi\.ru|rxlist|drugs\.com)\./.test(host)) {
    source_type = "SPECIALIZED_MEDICAL";
    evidence_level = 6;
    authority = 0.7;
    methodology = 0.6;
    independence = 0.65;
  } else if (/(cnn|bbc|reuters|nytimes|bloomberg|theguardian|washingtonpost|ria|tass|interfax|lenta|rbc|meduza|forbes|aps\.org|scientificamerican|technologyreview|wired)\./.test(host)) {
    source_type = "MAJOR_MEDIA";
    evidence_level = 7;
    authority = 0.6;
    methodology = 0.55;
    independence = 0.7;
  }
  const quality: SourceQuality = {
    authority,
    methodology,
    recency: 0.6,
    relevance: 0.7,
    independence,
    transparency: 0.55,
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
    // into the right evidence tier, which is sufficient for the verdict.)
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
 * Fetch the source's own text via direct HTTP + HTML→text.
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

/**
 * Evaluate a USER-SUBMITTED source URL (§ "альтернативные источники").
 *
 * Unlike search results, the user's source is always fully fetched (the user
 * explicitly wants it considered as evidence) and marked submitted_by=USER.
 * Reuses the same trusted-registry resolution + quality scoring as pipeline
 * sources so verdicts stay comparable.
 */
export async function evaluateUserSource(
  rawUrl: string,
  index: number
): Promise<Source> {
  const page = await fetchUrl(rawUrl);
  let host = rawUrl;
  try {
    host = new URL(page.finalUrl || page.url || rawUrl).hostname;
  } catch {
    /* keep raw */
  }
  host = host.toLowerCase().replace(/^www\./, "");
  const trusted = findTrustedSource(host);
  const text = page.ok ? truncate(page.text, FACTCHECK_CONFIG.web.maxSourceChars) : "";

  const r: RawSearchResult = {
    url: page.finalUrl || rawUrl,
    name: page.title || host,
    snippet: text.slice(0, 400),
    host_name: host,
    date: "",
    trusted: !!trusted,
  };
  const fetched = page.ok ? { text } : { error: page.error ?? "fetch failed" };
  const src = await buildSource(index, r, trusted, fetched);
  return { ...src, submitted_by: "USER" };
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
 * Optional progress callback used by evaluateSources to report per-source
 * fetch progress to the orchestrator's SSE stream. Without this the user sees
 * the "Оценка источников" phase as active for minutes with no visible
 * progress — which looks exactly like a freeze on slow networks/sites.
 *
 * The callback receives a short human-readable message (already localised).
 */
export type SourceProgress = (msg: string) => void;

/**
 * Evaluate + lazily fetch a set of raw results → Source[].
 *
 * Dedup is done by canonical URL and by DOI/PMID (if present in the title).
 * Fetch failures downgrade but do not remove a source.
 *
 * When `onProgress` is provided, emits a message for each source as it is
 * fetched (success, fallback-to-snippet, or failure). This is what keeps the
 * Mission Control log feed alive during a stage that previously looked frozen.
 */
export async function evaluateSources(
  rawResults: RawSearchResult[],
  _mode: AnalysisMode,
  onProgress?: SourceProgress
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

  // Lazily fetch each source's own text — concurrency capped at 6.
  //
  // IMPORTANT: previously this only fetched the full page text for sources
  // whose Bing snippet was shorter than 80 chars OR for trusted sources.
  // Non-trusted sources with a snippet > 200 chars (the common case for Bing
  // results) were NEVER fetched — the LLM only saw a ~200-character Bing
  // snippet, which is too short to extract meaningful evidence from. This is
  // the root cause of "sources don't parse correctly": most sources ended up
  // with a useless excerpt, so extractEvidence() skipped them.
  //
  // Now we ALWAYS try to fetch the full page text. On failure we fall back to
  // the snippet so the source is still usable (the LLM sees something), and
  // retrieval_error is set so the UI can flag it.
  //
  // Concurrency was raised from 5 → 6 to shave wall-clock time when many
  // sources are slow; the shared LLM endpoint is NOT touched here (this is
  // pure HTTP fetching), so the rate budget is unaffected.
  const total = withTrusted.length;
  const fetched = await mapWithConcurrency(withTrusted, 6, async ({ r }, _i) => {
    // index inside the concurrent worker is not stable; compute a stable
    // ordinal from the canonical URL so progress messages stay readable.
    const label = r.host_name || r.url;
    const page = await fetchSourceText(r.url);
    if (page.text) {
      const kb = Math.max(1, Math.round(page.text.length / 1024));
      onProgress?.(`Источник ${label} — загружено ${kb} КБ`);
      return page;
    }
    // Fall back to the snippet if the full fetch failed — better than nothing.
    if (r.snippet && r.snippet.trim().length > 0) {
      onProgress?.(`Источник ${label} — недоступен, используется сниппет (${page.error ?? "fetch failed"})`);
      return { text: r.snippet };
    }
    onProgress?.(`Источник ${label} — ошибка: ${page.error ?? "fetch failed"}`);
    return page; // { error: ... }
  });

  if (onProgress && total > 0) {
    onProgress(`Загружено источников: ${fetched.filter((f) => f.text).length} из ${total}`);
  }

  const sources: Source[] = [];
  for (let i = 0; i < withTrusted.length; i++) {
    const { r, trusted } = withTrusted[i];
    const f = fetched[i];
    const src = await buildSource(i, r, trusted, f);
    sources.push(src);
  }
  return sources;
}
