"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDownIcon, Trash2Icon, ExternalLinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalysisMode, VerdictLabel, AnalysisResult } from "@/lib/factcheck/types";
import { VERDICT_LABELS_RU } from "@/lib/factcheck/types";
import { hostFromUrl, truncate, verdictDotColor } from "@/lib/factcheck/client";

export interface HistoryItem {
  id: string;
  url: string;
  mode: AnalysisMode;
  status: string;
  createdAt: string;
  overallVerdict?: VerdictLabel;
  overallConfidence?: number;
  claimCount: number;
}

interface HistoryPanelProps {
  /** Called when the user clicks an item — should load the full result. */
  onSelect: (item: AnalysisResult) => void;
  /** Called when the current analysis completes (to refresh the list). */
  refreshKey: number;
}

export function HistoryPanel({ onSelect, refreshKey }: HistoryPanelProps) {
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // On mount + when refreshKey changes, fetch the list.
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    fetch("/api/history")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { projects?: HistoryItem[] } | HistoryItem[]) => {
        // Backend returns { projects: [...] }; tolerate a bare array too.
        const list = Array.isArray(data) ? data : (data?.projects ?? []);
        if (!cancelled) setItems(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Ошибка");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleSelect = async (id: string) => {
    setLoadingId(id);
    try {
      const r = await fetch(`/api/history/${id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: AnalysisResult = await r.json();
      onSelect(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoadingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const r = await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setItems((prev) => prev?.filter((x) => x.id !== id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setDeletingId(null);
    }
  };

  const trigger = (
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 rounded-sm px-4 py-3 text-left transition-colors hover:bg-[rgba(218,222,225,0.04)]"
      >
        <span className="flex items-center gap-2.5">
          <span className="gx-display text-xs uppercase tracking-wider text-[#f4f6f7]">
            История проверок
          </span>
          {items && items.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-sm border-[rgba(218,222,225,0.2)] bg-[rgba(7,9,11,0.5)] px-1.5 text-[10px] text-[#dadee1]"
            >
              {items.length}
            </Badge>
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 text-[#8a9aa6] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
    </CollapsibleTrigger>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="gx-panel relative z-10 overflow-hidden"
    >
      {trigger}
      <CollapsibleContent>
        <div className="border-t border-[rgba(218,222,225,0.1)] px-4 py-3">
          {items === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-sm bg-[rgba(218,222,225,0.05)]" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="rounded-sm border border-[rgba(218,222,225,0.1)] bg-[rgba(7,9,11,0.3)] px-3 py-4 text-center text-xs text-[#8a9aa6]">
              Пока нет сохранённых проверок.
            </p>
          ) : (
            <ul className="max-h-96 space-y-1.5 overflow-y-auto gx-scroll pr-1">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "group flex items-start gap-3 rounded-sm border border-[rgba(218,222,225,0.12)] bg-[rgba(7,9,11,0.4)] p-2.5 transition-colors",
                    loadingId === item.id
                      ? "border-[rgba(46,196,182,0.4)]"
                      : "hover:border-[rgba(218,222,225,0.25)]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(item.id)}
                    disabled={loadingId === item.id}
                    className="min-w-0 flex-1 text-left"
                    aria-label={`Открыть проверку ${truncate(item.url, 60)}`}
                  >
                    <div className="flex items-center gap-2">
                      {item.overallVerdict ? (
                        <span
                          aria-hidden
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ background: verdictDotColor(item.overallVerdict) }}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="inline-block size-2 shrink-0 rounded-full border border-[rgba(218,222,225,0.35)]"
                        />
                      )}
                      <span className="truncate text-xs text-[#7fd1c4] hover:underline" title={item.url}>
                        {truncate(item.url, 64)}
                      </span>
                      <ExternalLinkIcon className="size-3 shrink-0 text-[#4e6676] opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[#8a9aa6]">
                      <Badge
                        variant="outline"
                        className="rounded-sm border-[rgba(218,222,225,0.2)] bg-transparent px-1 text-[9px] text-[#dadee1]"
                      >
                        {item.mode === "RESEARCH" ? "Исследовательский" : "Контролируемый"}
                      </Badge>
                      {item.overallVerdict && (
                        <span style={{ color: verdictDotColor(item.overallVerdict) }}>
                          {VERDICT_LABELS_RU[item.overallVerdict]}
                        </span>
                      )}
                      {item.claimCount > 0 && (
                        <span>· Утверждений: {item.claimCount}</span>
                      )}
                      <span>· {relativeTime(item.createdAt)}</span>
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Удалить проверку"
                    disabled={deletingId === item.id}
                    onClick={() => handleDelete(item.id)}
                    className="size-8 shrink-0 rounded-sm text-[#8a9aa6] hover:bg-[rgba(255,92,138,0.1)] hover:text-[#ff8aad]"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="mt-2 text-xs text-[#ff8aad]">Ошибка истории: {error}</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ru });
  } catch {
    return "—";
  }
}
