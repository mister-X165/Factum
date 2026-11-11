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
      <p className="rounded-md border border-[#e3e5e9] bg-white/60 p-4 text-xs text-[#6b7280]">
        Источники не найдены.
      </p>
    );
  }

  return (
    <div className="gx-scroll-light max-h-96 space-y-2 overflow-y-auto pr-1">
      {sorted.map((s, i) => {
        const overall = Math.round((s.quality.overall ?? 0) * 100);
        return (
          <div
            key={`${s.id}-${i}`}
            className="rounded-md border border-[#e3e5e9] bg-white p-3"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-sm font-medium text-[#2563EB] hover:underline"
                title={s.title || s.url}
              >
                {s.title ? truncate(s.title, 90) : hostFromUrl(s.url)}
              </a>
              <div className="flex shrink-0 items-center gap-1.5">
                {s.submitted_by === "USER" && (
                  <Badge
                    variant="outline"
                    className="rounded border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 text-[10px] font-semibold text-[#2563EB]"
                  >
                    Добавлен вами
                  </Badge>
                )}
                {s.trusted && (
                  <Badge
                    variant="outline"
                    className="rounded border-[#10b981]/40 bg-[#10b981]/10 px-1.5 text-[10px] font-semibold text-[#047857]"
                  >
                    Доверенный
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className="rounded border-[#e3e5e9] bg-[#f4f5f7] px-1.5 text-[10px] text-[#6b7280]"
                >
                  {tierLabel(s.evidence_level)}
                </Badge>
              </div>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#6b7280]">
              <span className="font-medium text-[#374151]">{hostFromUrl(s.url)}</span>
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
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#e3e5e9]">
                <div
                  className={cn(
                    "h-full rounded-full",
                    overall >= 70 ? "bg-[#10b981]" : overall >= 45 ? "bg-[#f59e0b]" : "bg-[#ef4444]",
                  )}
                  style={{ width: `${overall}%` }}
                />
              </div>
              <span className="text-[11px] font-medium text-[#6b7280]">{overall}%</span>
            </div>

            {s.excerpt && (
              <p className="mt-1.5 text-xs leading-snug text-[#6b7280]">
                {truncate(s.excerpt, 240)}
              </p>
            )}
            {s.retrieval_error && (
              <p className="mt-1.5 text-xs text-[#dc2626]">
                Ошибка получения: {s.retrieval_error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
