/**
 * §16-§19 / §62-§67: research planner + source search.
 *
 * planResearch()  — asks the LLM to build a neutral query plan per claim.
 * searchSources() — runs web_search for every planned query, dedupes by
 *                   canonical URL and (in CONTROLLED mode) keeps only
 *                   results from TRUSTED_SOURCES.
 */

import { FACTCHECK_CONFIG, findTrustedSource } from "./config";
import { PROMPTS } from "./prompts";
import { runJsonPrompt } from "./llm";
import { webSearch, toRawSearchResult } from "./web";
import type { AnalysisMode, Claim, SearchQuery } from "./types";

/** One raw web_search result (mirrors z-ai-web-dev-sdk shape). */
export interface RawSearchResult {
  url: string;
  name: string;
  snippet: string;
  host_name: string;
  date: string;
  trusted: boolean;
}

/** Canonicalise a URL: lowercase host, strip query+fragment. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Ask the LLM to plan neutral search queries for every important claim.
 * Dedups identical queries.
 */
export async function planResearch(claims: Claim[]): Promise<SearchQuery[]> {
  if (claims.length === 0) return [];
  const payload = JSON.stringify(
    claims.map((c) => ({
      id: c.id,
      text: c.text,
      normalized_text: c.normalized_text,
      type: c.type,
      importance: c.importance,
      check_required: c.check_required,
    }))
  );

  let parsed: { queries?: Partial<SearchQuery>[] } | undefined;
  try {
    parsed = await runJsonPrompt<{ queries: Partial<SearchQuery>[] }>(
      PROMPTS.researchPlanner,
      { CLAIMS: payload }
    );
  } catch {
    // Fallback: one neutral query per important claim.
    return claims
      .filter((c) => c.check_required && c.importance >= 0.5)
      .map((c) => ({
        query: c.normalized_text.slice(0, 120),
        purpose: "neutral" as const,
        claim_ref: c.id,
      }));
  }

  const rawList = Array.isArray(parsed?.queries) ? parsed!.queries : [];
  const seen = new Set<string>();
  const out: SearchQuery[] = [];
  for (const q of rawList) {
    const query = (q.query ?? "").toString().trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      query,
      purpose: (q.purpose as SearchQuery["purpose"]) ?? "neutral",
      claim_ref: q.claim_ref,
    });
  }
  return out;
}

async function runOneSearch(query: string): Promise<RawSearchResult[]> {
  const { results, error } = await webSearch(
    query,
    FACTCHECK_CONFIG.web.maxSourcesPerClaim
  );
  if (error || results.length === 0) return [];
  return results.map((r) => toRawSearchResult(r));
}

/**
 * Run all planned searches and return deduped raw results.
 * In CONTROLLED mode only trusted hosts are kept.
 *
 * Web search uses DuckDuckGo (no API key) — mirrors the original Grafix
 * websearch.py approach. If DuckDuckGo is unreachable (offline / network
 * blocked), returns [] and the pipeline continues; claims without evidence
 * get INSUFFICIENT_EVIDENCE verdicts (§33 — honest outcome, no fabrication).
 */
export async function searchSources(
  queries: SearchQuery[],
  mode: AnalysisMode
): Promise<RawSearchResult[]> {
  if (queries.length === 0) return [];

  const all: RawSearchResult[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const results = await runOneSearch(q.query);
    for (const r of results) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);

      const trusted = !!findTrustedSource(r.host_name);
      if (mode === "CONTROLLED" && !trusted) continue;
      all.push({ ...r, trusted });
      if (all.length >= FACTCHECK_CONFIG.web.maxSourcesTotal) {
        return all;
      }
    }
  }
  return all;
}

/**
 * Adversarial search (§18, RESEARCH mode only): for each important claim
 * run a contradiction-focused web_search and return extra raw results.
 * CONTROLLED mode returns [].
 */
export async function adversarialSearch(
  claims: Claim[],
  mode: AnalysisMode
): Promise<RawSearchResult[]> {
  if (mode !== "RESEARCH") return [];
  const important = claims.filter((c) => c.importance >= 0.6 || c.check_required);
  const out: RawSearchResult[] = [];
  const seen = new Set<string>();
  for (const c of important) {
    const phrase = c.normalized_text.slice(0, 100);
    const query = `"${phrase}" criticism OR debunked OR refuted OR myth`;
    const results = await runOneSearch(query);
    for (const r of results) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const trusted = !!findTrustedSource(r.host_name);
      out.push({ ...r, trusted });
      if (out.length >= FACTCHECK_CONFIG.web.maxSourcesTotal) return out;
    }
  }
  return out;
}
