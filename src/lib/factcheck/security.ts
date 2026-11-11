/**
 * URL validation + SSRF protection (§31 of the MASTER PROMPT).
 *
 * The user-supplied URL is untrusted. Before anything is fetched we:
 *  - require an absolute http(s) URL
 *  - block localhost / private / loopback / link-local / reserved ranges
 *  - block internal hostnames and suspicious schemes (file://, ftp://, …)
 *  - block cloud-metadata endpoints
 *  - cap redirects at fetch time (see config.ts)
 */

const BLOCKED_SCHEMES = ["file:", "ftp:", "gopher:", "data:", "blob:", "javascript:", "vbscript:"];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal", // GCP metadata
  "metadata",
  "169.254.169.254", // AWS / OpenStack metadata (also handled by IP check)
  "metadata.azure.com",
]);

export interface UrlValidationError {
  code: string;
  message: string;
}

export function isPrivateIp(ip: string): boolean {
  // IPv4
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8 reserved
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 (very rough)
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80")) return true; // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique local
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return false;
}

/** Validate a user-supplied URL. Returns null when OK, an error otherwise. */
export function validateUrl(raw: string): UrlValidationError | null {
  if (!raw || typeof raw !== "string") {
    return { code: "empty", message: "URL пуст." };
  }
  const url = raw.trim();
  if (url.length > 2048) {
    return { code: "too_long", message: "URL слишком длинный." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { code: "invalid", message: "URL некорректен." };
  }

  if (BLOCKED_SCHEMES.some((s) => parsed.protocol === s)) {
    return {
      code: "blocked_scheme",
      message: `Схема «${parsed.protocol}» запрещена.`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      code: "unsupported_scheme",
      message: "Допускаются только http(s) URL.",
    };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { code: "blocked_host", message: "Внутренний хост запрещён." };
  }
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    return { code: "blocked_host", message: "Внутренний хост запрещён." };
  }
  if (isPrivateIp(host)) {
    return { code: "private_ip", message: "Частный/внутренний IP запрещён (SSRF protection)." };
  }
  // block userinfo (credentials) — common SSRF / phishing trick
  if (parsed.username || parsed.password) {
    return { code: "userinfo", message: "URL с учётными данными запрещён." };
  }
  // block default credentials-ish ports for metadata services
  if (parsed.port && (parsed.port === "80" || parsed.port === "443")) {
    // ok
  }
  return null;
}

/**
 * Strip HTML tags and decode common entities → plain text.
 *
 * Two-stage extraction:
 *  1. Isolate the MAIN CONTENT region when the HTML is semantic enough:
 *     <main>, <article>, [role=main] — whichever region is the largest.
 *     This skips site-wide navigation/cookie banners/footers that dominate
 *     JS-heavy pages (e.g. who.int renders a big nav shell before content).
 *  2. On the isolated region (or the whole document as fallback), remove
 *     noise blocks (<nav>/<header>/<footer>/<aside>/<form>/…) and strip tags.
 *
 * The fallback is fully backward-compatible: when no semantic region exists,
 * the result is the old behaviour minus noise blocks.
 */
export function htmlToText(html: string): string {
  const region = extractMainRegion(html);
  return stripTags(region ?? html);
}

/** Whole-tag noise blocks that never carry article text. */
const NOISE_BLOCK_RE =
  /<(nav|header|footer|aside|form|noscript|svg|iframe|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Find the largest semantic main-content region, if any. */
function extractMainRegion(html: string): string | null {
  const candidates: string[] = [];

  // <main …>…</main> / <article …>…</article> — all occurrences considered.
  for (const tag of ["main", "article"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[1] && m[1].length > 500) candidates.push(m[1]);
    }
  }

  if (candidates.length === 0) return null;
  // Prefer the largest candidate — on news/fact-sheet pages the article body
  // is the biggest semantic block; a tiny <main> wrapper would lose to it.
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Tag-strip + entity-decode a fragment of HTML. */
function stripTags(html: string): string {
  return html
    .replace(NOISE_BLOCK_RE, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n ?){10,}/g, "\n\n")
    .trim();
}

/** Very small non-cryptographic hash for content-cache keys. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(16).padStart(16, "0");
}

/** Truncate text to a max length, keeping a tail marker. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Content-dense window selection for LLM prompts.
 *
 * Naive head-truncation loses the article body on pages where site chrome
 * (nav, cookie banners, menus) precedes the content. Instead, slide a window
 * of `max` chars across the text and pick the window with the highest density
 * of "meaty" lines (long lines with sentence punctuation and numbers).
 * Keeps the article body even when it sits deep inside boilerplate.
 */
export function bestWindow(text: string, max: number): string {
  if (text.length <= max) return text;

  const lines = text.split("\n");
  const offsets: number[] = [];
  const meat: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1; // +1 for the "\n"
    const s = line.trim();
    let score = 0;
    if (s.length >= 80) score += 2;
    else if (s.length >= 40) score += 1;
    if (/[.!?]\s*$/.test(s)) score += 1; // sentence-like ending
    if (/\d/.test(s)) score += 0.5; // numbers = facts/statistics
    meat.push(score);
  }
  // prefix sums of meat for O(1) window scores
  const prefix = new Float64Array(meat.length + 1);
  for (let i = 0; i < meat.length; i++) prefix[i + 1] = prefix[i] + meat[i];

  const total = text.length;
  const step = Math.max(250, Math.floor(max / 8));
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start < total; start += step) {
    const s = Math.min(start, Math.max(0, total - max));
    if (s < bestStart && start > 0 && bestScore >= 0) {
      // already past the optimal start; nothing better can appear later
      // only when s was clamped — otherwise keep scanning
      if (start + max >= total) break;
    }
    // window covers chars [s, s+max) → line indexes via binary search on offsets
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const firstLine = lo;
    lo = firstLine;
    hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= s + max) lo = mid;
      else hi = mid - 1;
    }
    const lastLine = lo;
    const score = prefix[lastLine + 1] - prefix[firstLine];
    if (score > bestScore) {
      bestScore = score;
      bestStart = s;
    }
    if (start + max >= total) break;
  }
  return text.slice(bestStart, bestStart + max);
}
