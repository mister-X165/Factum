/**
 * Web acquisition WITHOUT z-ai — mirrors the original Grafix approach.
 *
 *   - webSearch():   free, key-less web search via Bing HTML scraping.
 *                    Returns {title, url, snippet, host_name} rows compatible
 *                    with RawSearchResult. (Original Grafix used the Python
 *                    ddgs/duckduckgo-search library; DuckDuckGo now blocks
 *                    server-side fetch with a 202 challenge, so we use Bing's
 *                    HTML endpoint which still works without an API key.)
 *   - fetchUrl():    direct HTTP GET (with SSRF-safe redirect handling) +
 *                    HTML→text extraction via htmlToText(). Replaces the
 *                    z-ai page_reader function.
 *
 * This module replaces all z-ai-web-dev-sdk usage for web operations, so the
 * app runs 100% locally (local LLM + Bing search + direct HTTP) when the user
 * sets LLM_PROVIDER to lm-studio / llama-cpp / ollama. No z-ai credentials
 * are required.
 *
 * SSRF: every outgoing URL is validated by validateUrl() first (see security.ts).
 */

import { validateUrl, htmlToText, truncate } from "./security";
import { FACTCHECK_CONFIG } from "./config";
import type { RawSearchResult } from "./research";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  host_name: string;
  date: string;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title?: string;
  text: string;
  contentType: string;
  ok: boolean;
  error?: string;
}

const FETCH_TIMEOUT_MS = FACTCHECK_CONFIG.web.requestTimeoutMs;
const MAX_REDIRECTS = FACTCHECK_CONFIG.limits.maxRedirects;

/** Decode Bing's "ck/a" redirect wrapper to the real URL.
 *  Bing encodes the target as base64url in the "u" param, prefixed with "a1". */
function decodeBingUrl(href: string): string {
  try {
    const u = new URL(href);
    if (!u.pathname.includes("/ck/a")) return href;
    const uParam = u.searchParams.get("u");
    if (uParam && uParam.startsWith("a1")) {
      const b64 = uParam.slice(2);
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64url").toString("utf-8");
      if (decoded.startsWith("http")) return decoded;
    }
    return href;
  } catch {
    return href;
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0183;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse Bing HTML results page into WebSearchResult[]. */
function parseBingHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Bing organic results: <li class="b_algo">...<h2><a href="...">title</a></h2>
  // ...<p class="..."> or <div class="b_caption"><p>snippet</p>...
  const blockRe =
    /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const linkMatch = block.match(
      /<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i
    );
    if (!linkMatch) continue;
    const rawHref = linkMatch[1].replace(/&amp;/g, "&");
    const url = decodeBingUrl(rawHref);
    const title = stripTags(linkMatch[2]);
    if (!title || !url || url.includes("bing.com/ck/a")) {
      // couldn't decode — skip bing-internal links
      continue;
    }
    // snippet: first <p> in the block
    const snipMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = url;
    }
    results.push({
      title,
      url,
      snippet,
      host_name: host,
      date: "",
    });
    if (results.length >= 20) break;
  }
  return results;
}

/**
 * Free, key-less web search via Bing HTML scraping.
 *
 * Bing's www.bing.com/search endpoint returns an HTML page we parse for
 * <li class="b_algo"> result blocks. No API key needed. Bing wraps result
 * URLs in a ck/a redirect which we decode to the real target.
 *
 * Never throws — returns {results, error} so the pipeline can degrade
 * gracefully (§50).
 */
export async function webSearch(
  query: string,
  maxResults = 5
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const q = (query || "").trim();
  if (!q) return { results: [], error: "Пустой поисковый запрос" };

  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(q) +
    "&setlang=en&count=20";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return { results: [], error: `Bing HTTP ${res.status}` };
    }
    const html = await res.text();
    const parsed = parseBingHtml(html).slice(0, maxResults);
    if (parsed.length === 0) {
      return {
        results: [],
        error: "Bing вернул 0 результатов (возможно, анти-бот защита).",
      };
    }
    return { results: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      results: [],
      error: `Веб-поиск недоступен: ${msg}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL and extract its text content (replaces z-ai page_reader).
 *
 * SSRF-safe: validateUrl() runs first. Redirects are capped at
 * MAX_REDIRECTS and re-validated on each hop.
 *
 * Never throws — returns {ok:false, error} so callers can degrade gracefully.
 */
export async function fetchUrl(
  rawUrl: string
): Promise<FetchedPage> {
  const err = validateUrl(rawUrl);
  if (err) {
    return {
      url: rawUrl,
      finalUrl: rawUrl,
      text: "",
      contentType: "",
      ok: false,
      error: `URL заблокирован: ${err.message}`,
    };
  }

  let currentUrl = rawUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 " +
            "Firefox/124.0",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
        signal: controller.signal,
        redirect: "manual", // handle redirects ourselves so we can re-validate
      });

      // 3xx redirect
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return {
            url: rawUrl,
            finalUrl: currentUrl,
            text: "",
            contentType: "",
            ok: false,
            error: `Сервер вернул редирект без Location (HTTP ${res.status}).`,
          };
        }
        const nextUrl = new URL(loc, currentUrl).toString();
        const redirErr = validateUrl(nextUrl);
        if (redirErr) {
          return {
            url: rawUrl,
            finalUrl: currentUrl,
            text: "",
            contentType: "",
            ok: false,
            error: `Редирект на заблокированный URL: ${redirErr.message}`,
          };
        }
        currentUrl = nextUrl;
        continue;
      }
      // final response
      break;
    }

    if (!res) {
      return {
        url: rawUrl,
        finalUrl: currentUrl,
        text: "",
        contentType: "",
        ok: false,
        error: "Нет ответа от сервера.",
      };
    }
    if (!res.ok) {
      return {
        url: rawUrl,
        finalUrl: currentUrl,
        text: "",
        contentType: res.headers.get("content-type") ?? "",
        ok: false,
        error: `HTTP ${res.status}`,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const isHtml =
      /html/i.test(contentType) || /^\s*<!doctype html|<html/i.test(raw);

    let text: string;
    let title: string | undefined;
    if (isHtml) {
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? stripTags(titleMatch[1]).trim() : undefined;
      text = htmlToText(raw);
    } else {
      // plain text / JSON / etc.
      text = raw;
    }
    text = truncate(text, FACTCHECK_CONFIG.limits.maxDownloadSize);
    if (!text || text.trim().length === 0) {
      return {
        url: rawUrl,
        finalUrl: currentUrl,
        text: "",
        contentType,
        ok: false,
        error: "Не удалось извлечь текст из ответа.",
      };
    }

    return {
      url: rawUrl,
      finalUrl: currentUrl,
      title,
      text,
      contentType: isHtml ? "html" : contentType || "text",
      ok: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      url: rawUrl,
      finalUrl: currentUrl,
      text: "",
      contentType: "",
      ok: false,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort health check for the web layer (no z-ai). */
export async function webHealth(): Promise<{
  ready: boolean;
  backend: string;
  error?: string;
}> {
  try {
    const { results } = await webSearch("test", 1);
    return {
      ready: true,
      backend: "Bing (no API key) + direct HTTP",
      error: results.length === 0 ? "поиск вернул 0 результатов" : undefined,
    };
  } catch {
    return { ready: false, backend: "Bing", error: "недоступен" };
  }
}

/** Convert a WebSearchResult to the RawSearchResult shape used by research.ts. */
export function toRawSearchResult(r: WebSearchResult): RawSearchResult {
  return {
    url: r.url,
    name: r.title,
    snippet: r.snippet,
    host_name: r.host_name,
    date: r.date,
    trusted: false,
  };
}
