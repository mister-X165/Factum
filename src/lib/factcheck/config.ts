/**
 * Configuration layer for the medical fact-checker.
 *
 * The MASTER PROMPT requires:
 *  - a single configuration layer (no hard-coded model names scattered around)
 *  - the trusted-source list stored in config, NOT scattered in code
 *  - configurable resource limits
 *
 * LLM backend is chosen at runtime via the LLM_PROVIDER env var:
 *   - "lm-studio"   → LM Studio local server (OpenAI-compatible, default port 1234)
 *   - "llama-cpp"   → llama.cpp server (OpenAI-compatible /v1 endpoint)
 *   - "ollama"      → Ollama (OpenAI-compatible /v1 endpoint, default port 11434)
 *
 * All three local backends expose an OpenAI-compatible /v1/chat/completions
 * endpoint, so a single OpenAiCompatibleProvider handles them.
 */

import type { SourceType } from "./types";

export type LlmBackend = "lm-studio" | "llama-cpp" | "ollama";

function resolveBackend(): LlmBackend {
  const raw = (process.env.LLM_PROVIDER || "lm-studio").toLowerCase();
  if (raw === "llama-cpp" || raw === "llamacpp" || raw === "llama.cpp") return "llama-cpp";
  if (raw === "ollama") return "ollama";
  return "lm-studio";
}

const BACKEND = resolveBackend();

/** Default OpenAI-compatible base URLs for each local backend. */
const DEFAULT_BASE_URL: Record<LlmBackend, string> = {
  "lm-studio": "http://127.0.0.1:1234/v1",
  "llama-cpp": "http://127.0.0.1:8080/v1",
  ollama: "http://127.0.0.1:11434/v1",
};

const BACKEND_LABEL: Record<LlmBackend, string> = {
  "lm-studio": "LM Studio (local)",
  "llama-cpp": "llama.cpp (local)",
  ollama: "Ollama (local)",
};

/** Resolve the OpenAI-compatible base URL for the active local backend. */
function resolveBaseUrl(): string {
  return (
    process.env.LLM_BASE_URL ||
    process.env[`${BACKEND.toUpperCase().replace("-", "_")}_BASE_URL`] ||
    DEFAULT_BASE_URL[BACKEND]
  );
}

export const FACTCHECK_CONFIG = {
  /** Backend / model identity (single source of truth). */
  llm: {
    backend: BACKEND,
    backendLabel: BACKEND_LABEL[BACKEND],
    /** Base URL of the OpenAI-compatible local server (empty for zai). */
    baseUrl: resolveBaseUrl(),
    /** API key for the local server (usually empty / "lm-studio" / unused). */
    apiKey: process.env.LLM_API_KEY || "lm-studio",
    /** Model name (optional for LM Studio which uses the loaded model;
     *  required for Ollama. Empty = let the server pick.) */
    model: process.env.LLM_MODEL || "",
    /** max retries for structured-output parsing. */
    retries: 3,
    /**
     * Hard overall ceiling for ONE LLM request. Streaming + idle timeout
     * make it safe to set this generously — a slow 5 tok/s model legitimately
     * needs 3–6 minutes for a 4 K-token prefill + 1 K-token JSON generation.
     * Default 10 minutes; override via LLM_TIMEOUT_MS in .env.
     */
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 600_000,
    /**
     * Idle timeout: if the stream produces no bytes for this long, the
     * request is aborted (model hung / crashed). Reset on EVERY chunk, so a
     * slow-but-alive model is NOT killed. Default 90 s.
     */
    idleTimeoutMs: Number(process.env.LLM_IDLE_TIMEOUT_MS) || 90_000,
    /**
     * Cap on generated tokens per request. Prevents a runaway model from
     * producing megabytes of prose. 4096 covers ~12 claim objects with
     * text + normalized_text + context fields.
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
     * (extract claims → plan research → evaluate sources → extract evidence
     * → synthesise verdicts → generate report) can legitimately take 10–20
     * minutes, so this must be >= the sum of LLM timeouts × number of stages.
     */
    totalAnalysisTimeoutMs: 1_800_000, // 30 min
    maxPdfPages: 20,
    /** Per-prompt context cap (chars). Claim extraction uses exactly this
     *  value (no longer ×2) to keep the prefill small enough for slow models. */
    maxContextChars: 6000,
  },
  /** Insufficient-evidence guardrails (§33/§34). */
  insufficient: {
    minRelevantSources: 2,
    warnRate: 0.6, // if >60% of claims are INSUFFICIENT, flag in report
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
