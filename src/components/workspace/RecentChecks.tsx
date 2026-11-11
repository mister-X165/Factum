"use client";

/**
 * «Последние проверки» — compact list of the 5 most recent checks.
 * Clicking a row loads the full result and opens the check screen.
 */

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { VERDICT_LABELS_RU, type HistoryItem } from "@/lib/factcheck/types";
import { hostFromUrl, materialLabel, verdictDotColor } from "@/lib/factcheck/client";
import { useHistory } from "@/hooks/use-history";
interface RecentChecksProps {
  refreshKey: number;
  /** Load the full analysis for a project and open the check screen. */
  onSelect: (id: string) => void;
  onViewAll: () => void;
}

export function RecentChecks({ refreshKey, onSelect, onViewAll }: RecentChecksProps) {
  const { items, error, loading } = useHistory(refreshKey);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const shown = items?.slice(0, 5) ?? [];

  return (
    <section aria-labelledby="recent-checks-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="recent-checks-title" className="gx-label">
          Последние проверки
        </h2>
        <button
          type="button"
          onClick={onViewAll}
          className="shrink-0 text-xs text-[#9ca3af] transition-colors hover:text-[#f4f5f7]"
        >
          все →
        </button>
      </div>

      <div className="gx-card overflow-hidden">
        {loading && !items ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md bg-[#e3e5e9]" />
            ))}
          </div>
        ) : error ? (
          <p className="px-4 py-6 text-center text-xs text-[#dc2626]">
            Не удалось загрузить историю: {error}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-[#6b7280]">
            Проверок пока нет — вставьте URL выше и запустите первую.
          </p>
        ) : (
          <ul className="gx-scroll-light max-h-96 divide-y divide-[#e3e5e9] overflow-y-auto">
            {shown.map((item) => (
              <RecentRow
                key={item.id}
                item={item}
                busy={loadingId === item.id}
                onClick={() => {
                  setLoadingId(item.id);
                  onSelect(item.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RecentRow({ item, busy, onClick }: { item: HistoryItem; busy: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[#eaecf0] disabled:cursor-wait disabled:opacity-60"
        aria-label={`Открыть проверку: ${materialLabel(item.url)}`}
      >
        {item.overallVerdict ? (
          <span
            aria-hidden
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ background: verdictDotColor(item.overallVerdict) }}
          />
        ) : (
          <span aria-hidden className="inline-block size-2 shrink-0 rounded-full border border-[#c3c8cf]" />
        )}

        <span
          className={cn(
            "w-[104px] shrink-0 truncate text-[11px] font-medium",
            item.overallVerdict ? "" : "text-[#6b7280]",
          )}
          style={item.overallVerdict ? { color: verdictDotColor(item.overallVerdict) } : undefined}
        >
          {item.overallVerdict ? VERDICT_LABELS_RU[item.overallVerdict] : "без вердикта"}
        </span>

        {item.showcase && (
          <span
            className="hidden shrink-0 rounded border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-0 text-[10px] font-semibold text-[#2563EB] sm:inline-block"
            title="Проект помечен администратором для показа"
          >
            Для показа
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-sm text-[#121418]" title={item.url}>
          {materialLabel(item.url)}
        </span>

        <span className="hidden shrink-0 text-[11px] text-[#6b7280] sm:block">
          {item.mode === "RESEARCH" ? "иссл." : "контр."}
        </span>
        <span className="shrink-0 text-[11px] text-[#6b7280]">
          {relativeTime(item.createdAt)}
        </span>
        {item.claimCount > 0 && (
          <span className="hidden shrink-0 text-[11px] text-[#6b7280] md:block">
            {item.claimCount} утв.
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 text-[#9ca3af]" aria-hidden />
      </button>
    </li>
  );
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru });
  } catch {
    return "—";
  }
}
