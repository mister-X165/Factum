"use client";

/**
 * «Источники и доказательства» — sources of the active / current / last check.
 *
 * - No check yet → a quiet empty state prompting to run a check.
 * - Check running but no sources streamed yet → a "searching" hint.
 * - Check finished with zero sources → a muted "not found" note.
 * - Otherwise → a compact grid of source cards sorted by overall quality.
 *
 * The static trusted-source registry is intentionally NOT shown here anymore.
 */

import { ExternalLink, FileSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Source } from "@/lib/factcheck/types";
import { hostFromUrl, truncate } from "@/lib/factcheck/client";

interface SourcesEvidenceProps {
  /** Sources of the active/last check (null when no check has happened yet). */
  sources: Source[] | null;
  /** Whether a check exists on screen (live, completed, or loaded from history). */
  hasCheck: boolean;
  /** True while the analysis stream is running (drives the "searching" hint). */
  isRunning?: boolean;
  /** Host label of the active check (for the section context tag). */
  resultHost?: string | null;
}

export function SourcesEvidence({
  sources,
  hasCheck,
  isRunning,
  resultHost,
}: SourcesEvidenceProps) {
  const contextTag =
    hasCheck && resultHost
      ? `проверка · ${resultHost}`
      : hasCheck
        ? "последняя проверка"
        : null;

  const sorted =
    sources && sources.length > 0
      ? [...sources].sort(
          (a, b) => (b.quality.overall ?? 0) - (a.quality.overall ?? 0),
        )
      : [];
  const shown = sorted.slice(0, 9);
  const overflow = sorted.length - shown.length;

  return (
    <section aria-labelledby="sources-evidence-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id="sources-evidence-title" className="gx-label">
            Источники и доказательства
          </h2>
          {contextTag && (
            <span className="truncate text-[11px] text-[#566272]">{contextTag}</span>
          )}
        </div>
        {overflow > 0 && (
          <span className="shrink-0 text-[11px] text-[#566272]">+{overflow} ещё</span>
        )}
      </div>

      {!hasCheck ? (
        <EmptyState />
      ) : shown.length === 0 ? (
        <div className="gx-card flex items-center gap-3 px-4 py-3.5">
          {isRunning && <span className="gx-spinner" aria-hidden />}
          <p className="text-xs text-[#6b7280]">
            {isRunning
              ? "Ищем источники и доказательства…"
              : "В этой проверке источники не найдены."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((s, i) => (
            <SourceCard key={`${s.id}-${i}`} source={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="gx-card flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center sm:py-9">
      <span
        className="flex size-9 items-center justify-center rounded-full bg-[#f3f4f6] text-[#9ca3af]"
        aria-hidden
      >
        <FileSearch className="size-4" />
      </span>
      <p className="max-w-sm text-xs leading-snug text-[#6b7280]">
        Запустите проверку, чтобы увидеть найденные источники и доказательства
      </p>
    </div>
  );
}

function SourceCard({ source }: { source: Source }) {
  const pct = Math.round(Math.max(0, Math.min(1, source.quality.overall ?? 0)) * 100);
  const host = hostFromUrl(source.url);
  const org = source.organization ?? source.title ?? "";

  return (
    <article className="gx-card flex flex-col gap-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-[13px] font-semibold text-[#121418] hover:text-[#2563EB]"
          title={source.url}
        >
          {host}
        </a>
        <span className="shrink-0 rounded border border-[#e3e5e9] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#6b7280]" title="Уровень доказательности источника">
          Ур. {source.evidence_level}
        </span>
      </div>

      {org && (
        <p className="truncate text-[11px] leading-snug text-[#6b7280]">
          {truncate(org, 48)}
        </p>
      )}

      {source.excerpt && (
        <p className="line-clamp-2 text-[11px] leading-snug text-[#374151]">
          {truncate(source.excerpt, 140)}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#e3e5e9]">
          <div
            className={cn(
              "h-full rounded-full",
              pct >= 70 ? "bg-[#10b981]" : pct >= 45 ? "bg-[#f59e0b]" : "bg-[#ef4444]",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-[10px] font-medium text-[#6b7280]">{pct}</span>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Открыть ${host}`}
          className="flex size-5 shrink-0 items-center justify-center rounded text-[#9ca3af] transition-colors hover:text-[#2563EB]"
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </article>
  );
}
