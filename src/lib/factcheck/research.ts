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

/** One raw web_search result (mirrors a web_search result shape). */
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

/**
 * Optional progress callback used by searchSources / adversarialSearch to
 * report per-query progress to the orchestrator's SSE stream. Without this
 * the user sees the "Поиск источников" phase as active for minutes with no
 * visible activity when many queries are planned.
 */
export type SearchProgress = (msg: string) => void;

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
 * Web search uses DuckDuckGo (no API key) — mirrors a classic Python
 * duckduckgo-search approach. If DuckDuckGo is unreachable (offline / network
 * blocked), returns [] and the pipeline continues; claims without evidence
 * get INSUFFICIENT_EVIDENCE verdicts (§33 — honest outcome, no fabrication).
 *
 * When `onProgress` is provided, emits a message per query with the result
 * count (or failure reason) so the UI log feed stays alive.
 */
export async function searchSources(
  queries: SearchQuery[],
  mode: AnalysisMode,
  onProgress?: SearchProgress
): Promise<RawSearchResult[]> {
  if (queries.length === 0) return [];

  onProgress?.(`Поиск по ${queries.length} запросам (режим: ${mode === "CONTROLLED" ? "контролируемый" : "исследовательский"})…`);

  const all: RawSearchResult[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const results = await runOneSearch(q.query);
    let added = 0;
    for (const r of results) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);

      const trusted = !!findTrustedSource(r.host_name);
      if (mode === "CONTROLLED" && !trusted) continue;
      all.push({ ...r, trusted });
      added++;
      if (all.length >= FACTCHECK_CONFIG.web.maxSourcesTotal) {
        onProgress?.(`Поиск «${q.query.slice(0, 60)}» → ${added} новых (достигнут лимит ${FACTCHECK_CONFIG.web.maxSourcesTotal}).`);
        return all;
      }
    }
    if (results.length === 0) {
      onProgress?.(`Поиск «${q.query.slice(0, 60)}» → 0 результатов.`);
    } else {
      onProgress?.(`Поиск «${q.query.slice(0, 60)}» → ${results.length} найдено, ${added} добавлено (всего ${all.length}).`);
    }
  }
  onProgress?.(`Собрано уникальных источников: ${all.length}.`);
  return all;
}

/**
 * Adversarial search (§18, RESEARCH mode only): for each important claim
 * run a contradiction-focused web_search and return extra raw results.
 * CONTROLLED mode returns [].
 *
 * When `onProgress` is provided, emits a message per claim search.
 */
export async function adversarialSearch(
  claims: Claim[],
  mode: AnalysisMode,
  onProgress?: SearchProgress
): Promise<RawSearchResult[]> {
  if (mode !== "RESEARCH") return [];
  const important = claims.filter((c) => c.importance >= 0.6 || c.check_required);
  if (important.length === 0) return [];
  onProgress?.(`Adversarial-поиск по ${important.length} утверждениям…`);
  const out: RawSearchResult[] = [];
  const seen = new Set<string>();
  for (const c of important) {
    const phrase = c.normalized_text.slice(0, 100);
    const query = `"${phrase}" criticism OR debunked OR refuted OR myth`;
    const results = await runOneSearch(query);
    let added = 0;
    for (const r of results) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const trusted = !!findTrustedSource(r.host_name);
      out.push({ ...r, trusted });
      added++;
      if (out.length >= FACTCHECK_CONFIG.web.maxSourcesTotal) {
        onProgress?.(`Adversarial: ${out.length} результатов (достигнут лимит).`);
        return out;
      }
    }
    onProgress?.(`Adversarial «${phrase.slice(0, 50)}…» → ${results.length} найдено, ${added} новых.`);
  }
  onProgress?.(`Adversarial: собрано ${out.length} результатов.`);
  return out;
}
