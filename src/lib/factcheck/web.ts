/**
 * Web acquisition module.
 *
 *   - webSearch():   free, key-less web search via Bing HTML scraping.
 *                    Returns {title, url, snippet, host_name} rows compatible
 *                    with RawSearchResult. (DuckDuckGo blocks server-side
 *                    fetch with a 202 challenge, so we use Bing's HTML
 *                    endpoint which still works without an API key.)
 *   - fetchUrl():    direct HTTP GET (with SSRF-safe redirect handling) +
 *                    HTML→text extraction via htmlToText().
 *
 * The app runs 100% locally (configured LLM + Bing search + direct HTTP);
 * when LLM_PROVIDER is set to a local backend (lm-studio / llama-cpp /
 * ollama), no external credentials are required.
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

/** Parse Bing HTML results page into WebSearchResult[].
 *
 *  Strategy: find each `<li class="b_algo">` opening tag, scan forward to
 *  the matching `</li>` (depth-aware for nested `<li>`), extract the block,
 *  then find the `<h2><a href="...">` link inside it.
 *
 *  CRITICAL FIX: the previous version used a lazy regex
 *    `/<(?:li|div)...b_algo...>([\s\S]*?)<\/(?:li|div)>/`
 *  which stopped at the FIRST `</div>` inside the b_algo block. Bing's result
 *  blocks contain nested `<div>`s (b_caption, b_attribution, …) that appear
 *  BEFORE the `<h2><a href>` link — so the regex truncated the block before
 *  reaching the link, and 0 results were extracted even though Bing returned
 *  a full page of 10 real results. This was the root cause of the "0 sources"
 *  bug that produced all-INSUFFICIENT_EVIDENCE verdicts.
 */
function parseBingHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Strategy: find each <li class="b_algo" ...> opening tag, extract the block
  // up to the matching </li>, then find the <h2><a href> link inside the block.
  //
  // CRITICAL FIX: the previous version used a lazy regex
  //   /<(?:li|div)...b_algo...>([\s\S]*?)<\/(?:li|div)>/
  // which stops at the FIRST </div> inside the b_algo block. Bing's result
  // blocks contain nested <div>s (b_caption, b_attribution, …) that appear
  // BEFORE the <h2><a href> link — so the regex truncated the block before
  // reaching the link, and 0 results were extracted even though Bing
  // returned a full page of real results.
  //
  // The new version finds the <li class="b_algo"> opening tag and scans
  // forward to the matching </li> using simple indexOf (Bing doesn't nest
  // <li> tags inside b_algo blocks, so the first </li> after the opening
  // tag is the correct closing tag). This reliably captures the full block
  // including the <h2><a href> link.
  const openRe = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>/gi;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openRe.exec(html)) !== null) {
    const blockStart = openMatch.index! + openMatch[0].length;
    // Find the matching </li> — track depth for nested <li> (rare but possible).
    let pos = blockStart;
    let depth = 1;
    let blockEnd = -1;
    while (depth > 0 && pos < html.length) {
      const nextOpen = html.indexOf("<li", pos);
      const nextClose = html.indexOf("</li", pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        pos = nextOpen + 3;
      } else {
        depth--;
        pos = nextClose + 4;
        if (depth === 0) {
          blockEnd = nextClose;
          break;
        }
      }
    }
    if (blockEnd < 0) continue; // malformed — skip
    const block = html.slice(blockStart, blockEnd);
    // Find the first <a href="..."> inside an <h2> in this block.
    const h2Match = block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!h2Match) continue;
    const rawHref = h2Match[1].replace(/&amp;/g, "&");
    const url = decodeBingUrl(rawHref);
    const title = stripTags(h2Match[2]);
    if (!title || !url) continue;
    if (url.includes("bing.com/ck/a")) continue; // decode failed
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    // Snippet: first <p> in the block after the <h2>.
    const afterH2Idx = block.indexOf(h2Match[0]) + h2Match[0].length;
    const afterH2 = block.slice(afterH2Idx, afterH2Idx + 2000);
    const snipMatch = afterH2.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = url;
    }
    results.push({ title, url, snippet, host_name: host, date: "" });
    if (results.length >= 20) break;
  }
  return results;
}

/** Decode a DuckDuckGo HTML redirect URL.
 *  DDG wraps result URLs as: //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
 *  We extract and decode the uddg parameter to get the real target. */
function decodeDdgUrl(href: string): string {
  try {
    // DDG sometimes uses protocol-relative URLs (//duckduckgo.com/...).
    const full = href.startsWith("//") ? "https:" + href : href;
    const u = new URL(full);
    if (u.pathname.includes("/l/") || u.hostname.includes("duckduckgo.com")) {
      const uddg = u.searchParams.get("uddg");
      if (uddg) {
        try {
          return decodeURIComponent(uddg);
        } catch {
          return uddg;
        }
      }
    }
    return full;
  } catch {
    // Not a valid URL — might already be the decoded target.
    return href;
  }
}

/** Parse DuckDuckGo HTML results page into WebSearchResult[].
 *  DDG's html.duckduckgo.com/html/ endpoint returns a simple HTML page
 *  with results in <a class="result__a" href="..."> and
 *  <a class="result__snippet" href="..."> elements. No JS required. */
function parseDdgHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // DDG result links: <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=...">title</a>
  const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawHref = m[1].replace(/&amp;/g, "&");
    const url = decodeDdgUrl(rawHref);
    const title = stripTags(m[2]);
    if (!title || !url) continue;
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    if (url.includes("duckduckgo.com")) continue; // skip DDG-internal links
    // Find the snippet: DDG puts it in a nearby <a class="result__snippet">.
    const after = html.slice(m.index! + m[0].length, m.index! + m[0].length + 1500);
    const snipMatch = after.match(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = url;
    }
    results.push({ title, url, snippet, host_name: host, date: "" });
    if (results.length >= 20) break;
  }
  return results;
}

/** Resolve which search provider(s) to use, in priority order.
 *  - "bing"       → Bing only.
 *  - "duckduckgo" → DuckDuckGo HTML only.
 *  - "auto"       → try DuckDuckGo first, fall back to Bing if DDG returns 0.
 *  Default: "auto". DDG-first because its HTML endpoint is simpler and more
 *  stable (no JS challenge, no nested-div parsing issues), and in live tests
 *  it returned more relevant medical results. Bing is kept as a fallback for
 *  when DDG is unavailable or rate-limited. */
function resolveSearchProviders(): Array<"bing" | "duckduckgo"> {
  const raw = (process.env.SEARCH_PROVIDER || "auto").toLowerCase().trim();
  if (raw === "bing") return ["bing"];
  if (raw === "duckduckgo" || raw === "ddg") return ["duckduckgo"];
  // auto: DDG first (better relevance + simpler HTML), Bing as fallback.
  return ["duckduckgo", "bing"];
}

/** Search via Bing HTML endpoint. */
async function searchBing(
  query: string,
  maxResults: number
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(query) +
    "&setlang=en&count=20";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { results: [], error: `Bing HTTP ${res.status}` };
    const html = await res.text();
    const parsed = parseBingHtml(html).slice(0, maxResults);
    if (parsed.length === 0) {
      return { results: [], error: "Bing: 0 результатов распознано (возможно, изменилась HTML-структура)." };
    }
    return { results: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], error: `Bing недоступен: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Search via DuckDuckGo HTML endpoint (no JS, no API key). */
async function searchDdg(
  query: string,
  maxResults: number
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return { results: [], error: `DuckDuckGo HTTP ${res.status}` };
    const html = await res.text();
    const parsed = parseDdgHtml(html).slice(0, maxResults);
    if (parsed.length === 0) {
      return { results: [], error: "DuckDuckGo: 0 результатов распознано." };
    }
    return { results: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], error: `DuckDuckGo недоступен: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Free, key-less web search via Bing + DuckDuckGo HTML scraping.
 *
 * Tries each configured provider in order (default: Bing → DuckDuckGo) and
 * returns the first non-empty result set. If all providers return 0 results,
 * returns the last error so the pipeline can surface it.
 *
 * Never throws — returns {results, error} so the pipeline can degrade
 * gracefully (§50). The orchestrator then produces honest
 * INSUFFICIENT_EVIDENCE verdicts instead of fabricating sources.
 */
export async function webSearch(
  query: string,
  maxResults = 5
): Promise<{ results: WebSearchResult[]; error?: string }> {
  const q = (query || "").trim();
  if (!q) return { results: [], error: "Пустой поисковый запрос" };

  const providers = resolveSearchProviders();
  let lastError: string | undefined;
  for (const provider of providers) {
    const attempt =
      provider === "bing"
        ? await searchBing(q, maxResults)
        : await searchDdg(q, maxResults);
    if (attempt.results.length > 0) {
      return attempt;
    }
    lastError = attempt.error;
  }
  return {
    results: [],
    error: lastError || "Все поисковые провайдеры вернули 0 результатов.",
  };
}

/**
 * Fetch a URL and extract its text content.
 *
 * SSRF-safe: validateUrl() runs first. Redirects are capped at
 * MAX_REDIRECTS and re-validated on each hop.
 *
 * Browser-like headers: many publishers (BBC, Nature, WHO, …) block the
 * previous minimal Firefox UA or return a paywall/interstitial stub to
 * unknown clients. We now send the same Chrome-on-Windows UA + Accept
 * headers a real browser would, plus a Referer derived from the target
 * host (some sites reject requests with no Referer as anti-scraping).
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

  // A real Chrome-on-Windows UA + full browser Accept/Accept-Language/Accept-Encoding
  // headers. Many sites block bare Firefox/Chrome UAs without the rest of the
  // header set, returning a 403 or an empty body.
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  let referer = "";
  try {
    const u = new URL(rawUrl);
    referer = `${u.protocol}//${u.hostname}/`;
  } catch {
    /* keep empty */
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
          "User-Agent": UA,
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,application/pdf;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          ...(referer ? { "Referer": referer } : {}),
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

/**
 * Best-effort health check for the web layer.
 *
 * IMPORTANT: this is called from /api/health which the UI fetches on EVERY
 * page load. The previous version called webSearch("test", 1) which goes
 * through the full search pipeline with a 30-second timeout PER provider —
 * in "auto" mode (DDG + Bing) that's up to 60 seconds. The health endpoint
 * took 10+ seconds in practice, making the UI appear frozen.
 *
 * Now we do a lightweight connectivity probe: one HTTP GET to the first
 * configured provider's HTML endpoint with a 5-second timeout. If it
 * returns ANY HTTP response (even a 202 challenge from DDG), the web layer
 * is considered reachable — full search parsing is the pipeline's job, not
 * the health check's.
 */
export async function webHealth(): Promise<{
  ready: boolean;
  backend: string;
  error?: string;
}> {
  const providers = resolveSearchProviders();
  const backendLabel = providers.join(" → ") + " (no API key)";
  const HEALTH_TIMEOUT_MS = 5_000;

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  for (const provider of providers) {
    const url =
      provider === "bing"
        ? "https://www.bing.com/search?q=test&setlang=en&count=1"
        : "https://html.duckduckgo.com/html/?q=test";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      // Any HTTP response (200, 202, 403, …) means the endpoint is reachable.
      // A 0-result search during the real pipeline is a separate concern
      // (HTML structure change) — not a connectivity failure.
      if (res.status < 500) {
        return { ready: true, backend: backendLabel };
      }
      // 5xx — try the next provider.
    } catch {
      clearTimeout(timer);
      // Network error or timeout — try the next provider.
    }
  }
  return {
    ready: false,
    backend: backendLabel,
    error: "Поисковые провайдеры недоступны (сетевая ошибка или таймаут).",
  };
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
