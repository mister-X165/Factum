/**
 * Configuration layer for the medical fact-checker.
 *
 * The MASTER PROMPT requires:
 *  - a single configuration layer (no hard-coded model names scattered around)
 *  - the trusted-source list stored in config, NOT scattered in code
 *  - configurable resource limits
 *
 * LLM backend is chosen at runtime via the LLM_PROVIDER env var.
 * Two families are supported, all through the same OpenAI-compatible
 * /chat/completions protocol:
 *
 *   LOCAL (no API key needed, runs on the user's machine):
 *     - "lm-studio"   → LM Studio local server (http://127.0.0.1:1234/v1)
 *     - "llama-cpp"   → llama.cpp server   (http://127.0.0.1:8080/v1)
 *     - "ollama"      → Ollama             (http://127.0.0.1:11434/v1)
 *
 *   CLOUD (requires LLM_API_KEY + LLM_MODEL):
 *     - "openai"      → OpenAI     (https://api.openai.com/v1)
 *     - "zai"         → Z.ai GLM   (https://api.z.ai/api/paas/v4)
 *     - "mistral"     → Mistral    (https://api.mistral.ai/v1)
 *     - "deepseek"    → DeepSeek   (https://api.deepseek.com)
 *     - "groq"        → Groq       (https://api.groq.com/openai/v1)
 *     - "openrouter"  → OpenRouter (https://openrouter.ai/api/v1)
 *     - "gemini"      → Google Gemini OpenAI-compat (https://generativelanguage.googleapis.com/v1beta/openai)
 *     - "together"    → Together AI (https://api.together.xyz/v1)
 *     - "fireworks"   → Fireworks AI (https://api.fireworks.ai/inference/v1)
 *     - "perplexity"  → Perplexity  (https://api.perplexity.ai)
 *     - "xai"         → xAI Grok    (https://api.x.ai/v1)
 *     - "custom"      → any OpenAI-compatible endpoint; requires LLM_BASE_URL
 *
 * Every connection parameter is overridable via env so the user can adjust
 * manually without touching code:
 *   LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL,
 *   LLM_HEADERS_JSON, LLM_RESPONSE_FORMAT, LLM_TEMPERATURE,
 *   LLM_TIMEOUT_MS, LLM_IDLE_TIMEOUT_MS, LLM_MAX_TOKENS.
 */

import type { SourceType } from "./types";

export type LlmBackend =
  // local
  | "lm-studio"
  | "llama-cpp"
  | "ollama"
  // cloud (OpenAI-compatible)
  | "openai"
  | "zai"
  | "mistral"
  | "deepseek"
  | "groq"
  | "openrouter"
  | "gemini"
  | "together"
  | "fireworks"
  | "perplexity"
  | "xai"
  | "custom";

/** Aliases accepted by LLM_PROVIDER (normalized to the canonical backend id). */
const BACKEND_ALIASES: Record<string, LlmBackend> = {
  "lm-studio": "lm-studio",
  "lmstudio": "lm-studio",
  "llama-cpp": "llama-cpp",
  "llamacpp": "llama-cpp",
  "llama.cpp": "llama-cpp",
  "llama": "llama-cpp",
  "ollama": "ollama",
  // cloud
  openai: "openai",
  "open-ai": "openai",
  zai: "zai",
  "z.ai": "zai",
  glm: "zai",
  mistral: "mistral",
  "mistral.ai": "mistral",
  deepseek: "deepseek",
  "deep-seek": "deepseek",
  groq: "groq",
  openrouter: "openrouter",
  "open-router": "openrouter",
  gemini: "gemini",
  google: "gemini",
  together: "together",
  "together-ai": "together",
  fireworks: "fireworks",
  perplexity: "perplexity",
  xai: "xai",
  "x-ai": "xai",
  grok: "xai",
  custom: "custom",
  cloud: "custom",
  "openai-compatible": "custom",
};

function resolveBackend(): LlmBackend {
  const raw = (process.env.LLM_PROVIDER || "").toLowerCase().trim();
  if (!raw) return "lm-studio"; // unset / empty → default to local
  return BACKEND_ALIASES[raw] ?? "custom";
}

/** Local backends (no API key required, runs on the user's machine).
 *  Defined BEFORE BACKEND_FROM_PROVIDER because the auto-detection logic
 *  below needs to check whether the declared provider is local. */
const LOCAL_BACKENDS: ReadonlySet<LlmBackend> = new Set<LlmBackend>([
  "lm-studio",
  "llama-cpp",
  "ollama",
]);

const BACKEND_FROM_PROVIDER = resolveBackend();

/**
 * Detect the cloud backend from the LLM_BASE_URL hostname.
 * Used when the user sets LLM_PROVIDER to a local backend (lm-studio, etc.)
 * but points LLM_BASE_URL at a cloud provider — a common misconfiguration
 * (e.g. "LLM_PROVIDER=lm-studio + LLM_BASE_URL=https://api.groq.com/openai/v1").
 *
 * Returns the detected cloud backend id, or null if the URL doesn't match
 * any known cloud provider.
 */
function detectCloudBackendFromUrl(url: string): LlmBackend | null {
  const u = (url || "").toLowerCase().trim();
  if (!u) return null;
  // Check each cloud backend's default URL host against the provided URL.
  const cloudHosts: Array<[LlmBackend, string]> = [
    ["groq", "api.groq.com"],
    ["openai", "api.openai.com"],
    ["zai", "api.z.ai"],
    ["mistral", "api.mistral.ai"],
    ["deepseek", "api.deepseek.com"],
    ["openrouter", "openrouter.ai"],
    ["gemini", "generativelanguage.googleapis.com"],
    ["together", "api.together.xyz"],
    ["fireworks", "api.fireworks.ai"],
    ["perplexity", "api.perplexity.ai"],
    ["xai", "api.x.ai"],
  ];
  for (const [backend, host] of cloudHosts) {
    if (u.includes(host)) return backend;
  }
  // If the URL is an https URL that isn't localhost/127.0.0.1 and isn't any
  // of the known cloud hosts, treat it as a custom cloud backend.
  if (u.startsWith("https://") && !u.includes("127.0.0.1") && !u.includes("localhost")) {
    return "custom";
  }
  return null;
}

/**
 * The effective backend, after auto-detection.
 *
 * If the user set LLM_PROVIDER to a LOCAL backend (lm-studio, llama-cpp,
 * ollama) but LLM_BASE_URL points at a known cloud provider, we auto-switch
 * to that cloud backend. This fixes the common misconfiguration where the
 * user copies a cloud URL but forgets to update LLM_PROVIDER — without this,
 * response_format defaults to json_schema (local default) which breaks on
 * cloud providers that don't support streaming + json_schema together
 * (notably Groq).
 */
function resolveEffectiveBackend(): LlmBackend {
  if (!LOCAL_BACKENDS.has(BACKEND_FROM_PROVIDER)) {
    return BACKEND_FROM_PROVIDER; // already cloud — no detection needed
  }
  // Local provider declared — check if LLM_BASE_URL actually points to cloud.
  const url = (process.env.LLM_BASE_URL || "").trim();
  if (url) {
    const detected = detectCloudBackendFromUrl(url);
    if (detected) {
      // Log a hint so the user notices the auto-correction. (Next.js logs
      // this to the server console — visible in dev.log / server.log.)
      const currentLabel = BACKEND_LABEL[BACKEND_FROM_PROVIDER];
      const newLabel = BACKEND_LABEL[detected];
      console.warn(
        `[factum] LLM_PROVIDER="${BACKEND_FROM_PROVIDER}" but LLM_BASE_URL ` +
          `points to ${detected === "custom" ? "a cloud endpoint" : newLabel}. ` +
          `Auto-switching backend to "${detected}" so cloud defaults apply ` +
          `(json_object response format, shorter timeouts). ` +
          `To silence this warning, set LLM_PROVIDER=${detected} in .env.`
      );
      return detected;
    }
  }
  return BACKEND_FROM_PROVIDER;
}

const BACKEND = resolveEffectiveBackend();

/** Default OpenAI-compatible base URLs for each backend. */
const DEFAULT_BASE_URL: Record<LlmBackend, string> = {
  // local
  "lm-studio": "http://127.0.0.1:1234/v1",
  "llama-cpp": "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434/v1",
  // cloud
  openai: "https://api.openai.com/v1",
  zai: "https://api.z.ai/api/paas/v4",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
  custom: "", // must be set via LLM_BASE_URL
};

const BACKEND_LABEL: Record<LlmBackend, string> = {
  "lm-studio": "LM Studio (local)",
  "llama-cpp": "llama.cpp (local)",
  ollama: "Ollama (local)",
  openai: "OpenAI (cloud)",
  zai: "Z.ai GLM (cloud)",
  mistral: "Mistral AI (cloud)",
  deepseek: "DeepSeek (cloud)",
  groq: "Groq (cloud)",
  openrouter: "OpenRouter (cloud)",
  gemini: "Google Gemini (cloud)",
  together: "Together AI (cloud)",
  fireworks: "Fireworks AI (cloud)",
  perplexity: "Perplexity (cloud)",
  xai: "xAI Grok (cloud)",
  custom: "Custom OpenAI-compatible (cloud)",
};

/** Whether the active backend is a LOCAL one (no API key needed). */
export function isLocalBackend(b: LlmBackend = BACKEND): boolean {
  return LOCAL_BACKENDS.has(b);
}

/** Whether the active backend is a CLOUD one (requires API key + model). */
export function isCloudBackend(b: LlmBackend = BACKEND): boolean {
  return !LOCAL_BACKENDS.has(b);
}

/** Resolve the OpenAI-compatible base URL. */
function resolveBaseUrl(): string {
  // 1. Explicit LLM_BASE_URL always wins.
  if (process.env.LLM_BASE_URL && process.env.LLM_BASE_URL.trim()) {
    return process.env.LLM_BASE_URL.trim();
  }
  // 2. Per-backend override via e.g. OPENAI_BASE_URL, ZAI_BASE_URL, etc.
  const envKey = `${BACKEND.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
  if (process.env[envKey] && process.env[envKey]!.trim()) {
    return process.env[envKey]!.trim();
  }
  // 3. Built-in default.
  return DEFAULT_BASE_URL[BACKEND];
}

/** Response-format strategy for the JSON-mode requests.
 *  - "json_schema" : full structured-output mode (LM Studio / OpenAI gpt-4o+).
 *  - "json_object" : simpler mode — constrains output to valid JSON object.
 *                   Widely supported by cloud providers (Mistral, DeepSeek,
 *                   Groq, OpenRouter, Gemini-compat). Default for cloud.
 *  - "none"        : don't send response_format at all (some older servers).
 */
export type ResponseFormatMode = "json_schema" | "json_object" | "none";

function resolveResponseFormat(): ResponseFormatMode {
  const raw = (process.env.LLM_RESPONSE_FORMAT || "").toLowerCase().trim();
  if (raw === "json_schema" || raw === "schema") return "json_schema";
  if (raw === "none" || raw === "off" || raw === "disabled") return "none";
  if (raw === "json_object" || raw === "object") return "json_object";
  // Default: json_schema for local (LM Studio supports it via grammar),
  // json_object for cloud (universally supported, safer).
  return isLocalBackend() ? "json_schema" : "json_object";
}

/** Parse LLM_HEADERS_JSON env var into a headers record.
 *  Allows the user to inject arbitrary headers — useful for OpenRouter
 *  (HTTP-Referer, X-Title), Anthropic-via-proxy (anthropic-version), etc. */
function resolveCustomHeaders(): Record<string, string> {
  const raw = (process.env.LLM_HEADERS_JSON || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" || typeof v === "number") out[k] = String(v);
      }
      return out;
    }
  } catch {
    // fall through — try the simpler "Key: Value\nKey2: Value2" format
    const lines = raw.split(/\r?\n/);
    const out: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return {};
}

/** Validate cloud-backend config at module load time so a missing API key
 *  surfaces as a clear error instead of a cryptic HTTP 401 mid-pipeline. */
function validateCloudConfig(): void {
  if (isLocalBackend()) return;
  const missing: string[] = [];
  if (!process.env.LLM_API_KEY || !process.env.LLM_API_KEY.trim()) {
    missing.push("LLM_API_KEY");
  }
  if (!process.env.LLM_MODEL || !process.env.LLM_MODEL.trim()) {
    missing.push("LLM_MODEL");
  }
  if (BACKEND === "custom" && !resolveBaseUrl()) {
    missing.push("LLM_BASE_URL");
  }
  if (missing.length > 0) {
    throw new Error(
      `Конфигурация LLM неполна для облачного провайдера "${BACKEND}". ` +
        `Укажите в .env: ${missing.join(", ")}. ` +
        `См. комментарии в .env для примеров по каждому провайдеру.`
    );
  }
}

// Run validation eagerly so the error surfaces at server-start time, not
// only when the first LLM call happens.
validateCloudConfig();

export const FACTCHECK_CONFIG = {
  /** Backend / model identity (single source of truth). */
  llm: {
    backend: BACKEND,
    backendLabel: BACKEND_LABEL[BACKEND],
    isCloud: isCloudBackend(),
    /** Base URL of the OpenAI-compatible server (no trailing slash). */
    baseUrl: resolveBaseUrl(),
    /** API key. For local backends defaults to "lm-studio" (any string works).
     *  For cloud backends this MUST be set (validated above). */
    apiKey: process.env.LLM_API_KEY || (isLocalBackend() ? "lm-studio" : ""),
    /** Model name. Required for cloud; optional for local (server picks). */
    model: process.env.LLM_MODEL || "",
    /** Response-format strategy for jsonMode requests. */
    responseFormat: resolveResponseFormat(),
    /** Extra HTTP headers merged into every request (OpenRouter, Anthropic, …). */
    customHeaders: resolveCustomHeaders(),
    /** Sampling temperature (0 = greedy, 1 = creative). Default 0.3 = balanced. */
    temperature: Number(process.env.LLM_TEMPERATURE) || 0.3,
    /** max retries for structured-output parsing. Cloud backends retry less
     *  because they're fast and deterministic. */
    retries: isCloudBackend() ? 2 : 3,
    /**
     * Hard overall ceiling for ONE LLM request. Streaming + idle timeout
     * make it safe to set this generously.
     *  - local slow model (5 tok/s): 600 s (10 min) default.
     *  - cloud fast model (50+ tok/s): 120 s is plenty.
     * Override via LLM_TIMEOUT_MS in .env.
     */
    timeoutMs:
      Number(process.env.LLM_TIMEOUT_MS) ||
      (isCloudBackend() ? 120_000 : 600_000),
    /**
     * Idle timeout: if the stream produces no bytes for this long, the
     * request is aborted. Reset on EVERY chunk, so a slow-but-alive model
     * is NOT killed.
     *  - local: 90 s default (slow models can stall between tokens).
     *  - cloud: 30 s default (cloud should stream smoothly). */
    idleTimeoutMs:
      Number(process.env.LLM_IDLE_TIMEOUT_MS) ||
      (isCloudBackend() ? 30_000 : 90_000),
    /**
     * Cap on generated tokens per request. 4096 covers ~12 claim objects
     * with text + normalized_text + context fields.
     */
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || 4096,
  },
  web: {
    backend: "Bing (no API key) + direct HTTP",
    maxSourcesPerClaim: 5,
    maxSourcesTotal: 12,
    maxSourceChars: 6000,
    requestTimeoutMs: 30_000,
  },
  /** Configurable resource limits (§32 of the MASTER PROMPT). */
  limits: {
    maxDownloadSize: 2_000_000, // 2 MB of extracted text
    maxClaims: 12,
    maxRedirects: 3,
    maxRequests: 20,
    requestTimeoutMs: 30_000,
    /**
     * Global pipeline ceiling. With a slow local model the full pipeline
     * can legitimately take 10–20 minutes; with a cloud model it's <2 min.
     */
    totalAnalysisTimeoutMs: 1_800_000, // 30 min
    maxPdfPages: 20,
    /** Per-prompt context cap (chars). */
    maxContextChars: 6000,
  },
  /** Insufficient-evidence guardrails (§33/§34). */
  insufficient: {
    minRelevantSources: 2,
    warnRate: 0.6,
  },
} as const;

/** Trusted-source registry for CONTROLLED mode (§7.1). */
export interface TrustedSourceEntry {
  /** host fragment matched against the source hostname. */
  host: string;
  organization: string;
  sourceType: SourceType;
  evidenceLevel: number; // tier 1..8
  baseAuthority: number; // 0..1 baseline authority score
}

export const TRUSTED_SOURCES: TrustedSourceEntry[] = [
  // Tier 1 — systematic reviews / meta-analyses
  { host: "cochranelibrary.com", organization: "Cochrane", sourceType: "COCHRANE_REVIEW", evidenceLevel: 1, baseAuthority: 0.98 },
  { host: "cochrane.org", organization: "Cochrane", sourceType: "COCHRANE_REVIEW", evidenceLevel: 1, baseAuthority: 0.98 },
  // Tier 2 — primary studies
  { host: "pubmed.ncbi.nlm.nih.gov", organization: "PubMed (NLM)", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.95 },
  { host: "ncbi.nlm.nih.gov", organization: "NCBI (NLM)", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.95 },
  { host: "europepmc.org", organization: "Europe PMC", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.94 },
  // Tier 4 — guidelines / regulators / authorities
  { host: "who.int", organization: "World Health Organization", sourceType: "GOVERNMENT_AUTHORITY", evidenceLevel: 4, baseAuthority: 0.97 },
  { host: "cdc.gov", organization: "Centers for Disease Control and Prevention", sourceType: "GOVERNMENT_AUTHORITY", evidenceLevel: 4, baseAuthority: 0.95 },
  { host: "fda.gov", organization: "U.S. Food and Drug Administration", sourceType: "REGULATOR", evidenceLevel: 4, baseAuthority: 0.95 },
  { host: "ema.europa.eu", organization: "European Medicines Agency", sourceType: "REGULATOR", evidenceLevel: 4, baseAuthority: 0.95 },
  { host: "nice.org.uk", organization: "NICE", sourceType: "GUIDELINE", evidenceLevel: 4, baseAuthority: 0.94 },
  // Crossref / DOI metadata
  { host: "crossref.org", organization: "Crossref", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 5, baseAuthority: 0.85 },
  { host: "doi.org", organization: "DOI Foundation", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 5, baseAuthority: 0.85 },
  // Government / official RU medical
  { host: "rosminzdrav.ru", organization: "Минздрав РФ", sourceType: "GOVERNMENT_AUTHORITY", evidenceLevel: 4, baseAuthority: 0.9 },
  { host: "rcrzdrav.ru", organization: "ФГБУ ЦАРКЗ Минздрава России", sourceType: "GUIDELINE", evidenceLevel: 4, baseAuthority: 0.88 },
  // major specialized medical publishers
  { host: "nejm.org", organization: "New England Journal of Medicine", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.95 },
  { host: "thelancet.com", organization: "The Lancet", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.95 },
  { host: "bmj.com", organization: "BMJ", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.93 },
  { host: "jamanetwork.com", organization: "JAMA Network", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 2, baseAuthority: 0.93 },
  { host: "nature.com", organization: "Nature", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.9 },
  { host: "sciencedirect.com", organization: "ScienceDirect (Elsevier)", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.88 },
  { host: "springer.com", organization: "Springer", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.88 },
  { host: "wiley.com", organization: "Wiley", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.86 },
  { host: "mdpi.com", organization: "MDPI", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.78 },
  { host: "plos.org", organization: "PLOS", sourceType: "SPECIALIZED_MEDICAL", evidenceLevel: 3, baseAuthority: 0.84 },
];

/** Map a hostname to its trusted-source entry (if any). */
export function findTrustedSource(hostname: string): TrustedSourceEntry | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return (
    TRUSTED_SOURCES.find((t) => host === t.host || host.endsWith(`.${t.host}`)) ??
    null
  );
}

/** Evidence-tier → numeric weight used by the deterministic verdict engine. */
export const TIER_WEIGHTS: Record<number, number> = {
  1: 1.0,
  2: 0.92,
  3: 0.8,
  4: 0.78,
  5: 0.6,
  6: 0.5,
  7: 0.35,
  8: 0.2,
};

export function tierWeight(level: number): number {
  return TIER_WEIGHTS[level] ?? 0.4;
}
