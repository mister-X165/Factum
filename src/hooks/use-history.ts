"use client";

/**
 * Shared hook: the /api/history list (most recent first).
 * Used by both the home "Последние проверки" block and the History view.
 */

import { useCallback, useEffect, useState } from "react";
import type { HistoryItem } from "@/lib/factcheck/types";

export interface UseHistoryResult {
  items: HistoryItem[] | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Optimistically remove one row (after a successful DELETE). */
  removeLocal: (id: string) => void;
}

export function useHistory(refreshKey: number): UseHistoryResult {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/history", { signal });
      if (!r.ok) {
        throw new Error(
          r.status === 401
            ? "Сессия истекла. Обновите страницу и войдите в систему заново."
            : r.status === 403
              ? "Нет доступа к истории проверок."
              : r.status === 429
                ? "Слишком много запросов. Повторите попытку через 30–60 секунд."
                : "Не удалось загрузить историю. Повторите попытку через минуту.",
        );
      }
      const data: { projects?: HistoryItem[] } | HistoryItem[] = await r.json();
      const list = Array.isArray(data) ? data : (data?.projects ?? []);
      setItems(list);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(
        err instanceof Error
          ? err.message
          : "Не удалось загрузить историю. Проверьте соединение.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const removeLocal = useCallback((id: string) => {
    setItems((prev) => prev?.filter((x) => x.id !== id) ?? null);
  }, []);

  return { items, error, loading, reload, removeLocal };
}
