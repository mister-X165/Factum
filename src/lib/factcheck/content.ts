/**
 * §8-§11 / §31: fetch the input URL and extract text + metadata.
 *
 * Pipeline step 1 — takes a user URL and returns a FetchedDocument.
 *
 * This is the SSRF gate (validateUrl runs first) and the only place we use
 * page_reader on user-controlled input. Everything downstream sees plain text.
 */

import { validateUrl, htmlToText, hashString, truncate } from "./security";
import { FACTCHECK_CONFIG } from "./config";
import { fetchUrl } from "./web";
import type { ContentNature, FetchedDocument } from "./types";

/** Typed error so the orchestrator can distinguish fetch failures. */
export class FetchDocumentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FetchDocumentError";
    this.code = code;
  }
}

const AD_KEYWORDS = [
  "купить",
  "скидка",
  "акция",
  "реклама",
  "спонсор",
  "по рекламе",
  "по промокоду",
  "affiliate",
  "sponsored",
  "advertising",
  "купите",
  "оформить заказ",
  "в корзину",
  "доставка",
  "промокод",
];

/** Cheap heuristic to detect commercial/advertising content. */
function detectNatureHeuristic(text: string, html: string): ContentNature {
  const t = text.toLowerCase();
  const h = html.toLowerCase();
  let score = 0;
  for (const kw of AD_KEYWORDS) {
    if (t.includes(kw)) score += 2;
    if (h.includes(`data-ad`)) score += 3;
    if (h.includes("google_ad") || h.includes("adsbygoogle")) score += 3;
    if (h.includes('rel="sponsored"') || h.includes('rel="nofollow"')) score += 1;
  }
  // affiliate patterns
  if (/\/(go|out|redirect|aff)\//i.test(h)) score += 1;
  if (/utm_source=affiliate|partner/i.test(h)) score += 2;
  if (score >= 6) return "AFFILIATE_CONTENT";
  if (score >= 4) return "ADVERTISEMENT";
  if (score >= 2) return "SPONSORED_CONTENT";
  return "INFORMATION";
}

/** Detect content nature via heuristic only (no LLM call — saves rate budget).
 *  The heuristic checks for strong commercial signals in the text/HTML. */
async function detectNature(
  text: string,
  html: string
): Promise<ContentNature> {
  return detectNatureHeuristic(text, html);
}

/**
 * Fetch + extract a FetchedDocument from the user-supplied URL.
 * Throws FetchDocumentError on any failure — the orchestrator must catch it.
 */
export async function fetchDocument(url: string): Promise<FetchedDocument> {
  const urlErr = validateUrl(url);
  if (urlErr) {
    throw new FetchDocumentError(urlErr.code, urlErr.message);
  }

  // Direct HTTP fetch + HTML→text extraction (no z-ai).
  const page = await fetchUrl(url);
  if (!page.ok) {
    throw new FetchDocumentError(
      "fetch_failed",
      `Не удалось загрузить страницу: ${page.error ?? "неизвестная ошибка"}`
    );
  }

  const text = truncate(page.text, FACTCHECK_CONFIG.limits.maxDownloadSize);
  if (!text || text.trim().length === 0) {
    throw new FetchDocumentError(
      "text_empty",
      "Не удалось извлечь текст из HTML."
    );
  }

  const excerpt = truncate(text, 600);
  const contentHash = hashString(text);
  // contentNature detection is heuristic-only (no LLM call).
  const contentNature = await detectNature(text, page.text);

  return {
    url,
    finalUrl: page.finalUrl || url,
    title: page.title && page.title.trim() ? page.title.trim() : undefined,
    text,
    excerpt,
    contentHash,
    contentType: page.contentType === "html" ? "html" : "text",
    contentNature,
  };
}
