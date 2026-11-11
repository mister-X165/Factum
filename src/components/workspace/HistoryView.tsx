"use client";

/**
 * «История» — the full checks table: search by URL/host, verdict + mode
 * filters, delete, open (loads the result into the check screen).
 */

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { ChevronRight, Loader2, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  VERDICT_LABELS_RU,
  VERDICT_ORDER,
  type HistoryItem,
  type VerdictLabel,
} from "@/lib/factcheck/types";
import { hostFromUrl, materialLabel, verdictDotColor } from "@/lib/factcheck/client";
import { useHistory } from "@/hooks/use-history";

interface HistoryViewProps {
  refreshKey: number;
  onSelect: (id: string) => void;
}

export function HistoryView({ refreshKey, onSelect }: HistoryViewProps) {
  const { items, error, loading, removeLocal } = useHistory(refreshKey);
  const [query, setQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"ALL" | VerdictLabel>("ALL");
  const [modeFilter, setModeFilter] = useState<"ALL" | "CONTROLLED" | "RESEARCH">("ALL");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((it) => {
      if (q && !it.url.toLowerCase().includes(q)) return false;
      if (verdictFilter !== "ALL" && it.overallVerdict !== verdictFilter) return false;
      if (modeFilter !== "ALL" && it.mode !== modeFilter) return false;
      return true;
    });
  }, [items, query, verdictFilter, modeFilter]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const r = await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      removeLocal(id);
    } catch {
      /* row stays; the next reload will reconcile */
    } finally {
      setDeletingId(null);
    }
  };

  const selectClass =
    "h-10 rounded-md border border-white/10 bg-white/[0.04] px-3 text-xs text-[#c3c8cf] outline-none transition-colors focus:border-[#2563EB]/60 [&>option]:bg-[#171a1f]";

  return (
    <section aria-labelledby="history-title" className="pb-2">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 id="history-title" className="gx-label text-sm">
            История проверок
          </h1>
          {items && (
            <span className="text-[11px] text-[#566272]">
              {filtered.length} из {items.length}
            </span>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#566272]"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по URL…"
              aria-label="Поиск по URL"
              className="h-10 w-44 rounded-md border border-white/10 bg-white/[0.04] pl-9 pr-3 text-xs text-[#c3c8cf] outline-none transition-colors placeholder:text-[#566272] focus:border-[#2563EB]/60 sm:w-56"
            />
          </div>
          <select
            value={verdictFilter}
            onChange={(e) => setVerdictFilter(e.target.value as typeof verdictFilter)}
            aria-label="Фильтр по вердикту"
            className={selectClass}
          >
            <option value="ALL">Все вердикты</option>
            {VERDICT_ORDER.map((v) => (
              <option key={v} value={v}>
                {VERDICT_LABELS_RU[v]}
              </option>
            ))}
          </select>
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as typeof modeFilter)}
            aria-label="Фильтр по режиму"
            className={selectClass}
          >
            <option value="ALL">Все режимы</option>
            <option value="CONTROLLED">Контролируемый</option>
            <option value="RESEARCH">Исследовательский</option>
          </select>
        </div>
      </div>

      <div className="gx-card overflow-hidden">
        {loading && !items ? (
          <div className="space-y-1 p-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md bg-[#e3e5e9]" />
            ))}
          </div>
        ) : error ? (
          <p className="px-4 py-8 text-center text-xs text-[#dc2626]">
            Не удалось загрузить историю: {error}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-[#6b7280]">
            {items && items.length > 0
              ? "Ничего не найдено по текущим фильтрам."
              : "Проверок пока нет — запустите первую с главного экрана."}
          </p>
        ) : (
          <ul className="gx-scroll-light max-h-[32rem] divide-y divide-[#e3e5e9] overflow-y-auto">
            {filtered.map((item) => (
              <HistoryRow
                key={item.id}
                item={item}
                deleting={deletingId === item.id}
                onSelect={() => onSelect(item.id)}
                onDelete={() => void handleDelete(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function HistoryRow({
  item,
  deleting,
  onSelect,
  onDelete,
}: {
  item: HistoryItem;
  deleting: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-center gap-3 px-4 transition-colors hover:bg-[#eaecf0]">
      <button
        type="button"
        onClick={onSelect}
        className="flex h-14 min-w-0 flex-1 items-center gap-3 text-left"
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
            "hidden w-[120px] shrink-0 truncate text-[11px] font-medium sm:block",
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

        <span className="hidden shrink-0 rounded border border-[#e3e5e9] bg-white px-1.5 py-0.5 text-[10px] text-[#6b7280] md:block">
          {item.mode === "RESEARCH" ? "исследовательский" : "контролируемый"}
        </span>
        <span className="hidden shrink-0 text-[11px] text-[#6b7280] lg:block">
          {item.claimCount > 0 ? `${item.claimCount} утв.` : "—"}
        </span>
        <span className="shrink-0 text-[11px] text-[#6b7280]">{relativeTime(item.createdAt)}</span>
        <ChevronRight className="size-4 shrink-0 text-[#9ca3af]" aria-hidden />
      </button>

      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        aria-label="Удалить проверку"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-[#9ca3af] transition-colors hover:bg-[#ef4444]/10 hover:text-[#dc2626] disabled:cursor-wait disabled:opacity-50"
      >
        {deleting ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="size-3.5" aria-hidden />
        )}
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
