"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Source } from "@/lib/factcheck/types";
import {
  formatConfidence,
  hostFromUrl,
  sourceTypeLabel,
  tierLabel,
  truncate,
} from "@/lib/factcheck/client";

interface SourceListProps {
  sources: Source[];
}

export function SourceList({ sources }: SourceListProps) {
  const sorted = [...sources].sort(
    (a, b) => (b.quality.overall ?? 0) - (a.quality.overall ?? 0),
  );

  if (sorted.length === 0) {
    return (
      <p className="rounded-sm border border-[rgba(218,222,225,0.12)] bg-[rgba(7,9,11,0.3)] p-4 text-xs text-[#8a9aa6]">
        Источники не найдены.
      </p>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto gx-scroll space-y-2 pr-1">
      {sorted.map((s) => {
        const overall = Math.round((s.quality.overall ?? 0) * 100);
        return (
          <div
            key={s.id}
            className="rounded-sm border border-[rgba(218,222,225,0.14)] bg-[rgba(7,9,11,0.4)] p-3"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-[#7fd1c4] hover:underline"
                title={s.title || s.url}
              >
                {s.title ? truncate(s.title, 90) : hostFromUrl(s.url)}
              </a>
              <div className="flex shrink-0 items-center gap-1.5">
                {s.trusted && (
                  <Badge
                    variant="outline"
                    className="rounded-sm border-[rgba(46,196,182,0.4)] bg-[rgba(46,196,182,0.12)] px-1.5 text-[10px] font-semibold text-[#2ec4b6]"
                  >
                    Доверенный
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className="rounded-sm border-[rgba(218,222,225,0.25)] bg-[rgba(7,9,11,0.5)] px-1.5 text-[10px] text-[#dadee1]"
                >
                  {tierLabel(s.evidence_level)}
                </Badge>
              </div>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#8a9aa6]">
              <span>{hostFromUrl(s.url)}</span>
              <span className="opacity-60">·</span>
              <span>{sourceTypeLabel(s.source_type)}</span>
              {s.organization && (
                <>
                  <span className="opacity-60">·</span>
                  <span className="truncate">{s.organization}</span>
                </>
              )}
            </div>

            {/* Overall quality bar */}
            <div className="mb-1.5 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[rgba(218,222,225,0.1)]">
                <div
                  className={cn(
                    "h-full rounded-full",
                    overall >= 70 ? "bg-[#2ec4b6]" : overall >= 45 ? "bg-[#e9c46a]" : "bg-[#ff8aad]",
                  )}
                  style={{ width: `${overall}%` }}
                />
              </div>
              <span className="text-[11px] text-[#dadee1]">{overall}%</span>
            </div>

            {s.excerpt && (
              <p className="mt-1.5 text-xs leading-snug text-[#8a9aa6]">
                {truncate(s.excerpt, 240)}
              </p>
            )}
            {s.retrieval_error && (
              <p className="mt-1.5 text-xs text-[#ff8aad]">
                Ошибка получения: {s.retrieval_error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
