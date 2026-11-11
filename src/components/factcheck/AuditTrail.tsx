"use client";

/**
 * «Журнал аудита» — P1: видимый след проверок (AuditEvent из БД).
 * Подгружается по требованию при первом раскрытии. Показывает стадию,
 * уровень, сообщение и время — без внутренних промптов и JSON.
 */

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface AuditEventDto {
  id: string;
  stage: string;
  stageLabelRu: string;
  level: string; // DEBUG | INFO | WARNING | ERROR | CRITICAL
  message: string;
  detail?: string;
  createdAt: string;
}

export function AuditTrail({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || events !== null || error !== null) return;
    let cancelled = false;
    fetch(`/api/history/${projectId}/audit`)
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(
            r.status === 404
              ? "Проверка не найдена или уже удалена."
              : r.status === 403
                ? "Нет прав на просмотр аудита этой проверки."
                : r.status === 401
                  ? "Сессия истекла. Обновите страницу и войдите заново."
                  : "Не удалось загрузить журнал аудита. Повторите попытку.",
          );
        }
        return (await r.json()) as { events: AuditEventDto[] };
      })
      .then((data) => {
        if (!cancelled) setEvents(data.events);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Не удалось загрузить журнал");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, events, error, projectId]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <ChevronDown
          aria-hidden
          className="size-3.5 text-[#6b7280] transition-transform group-data-[state=open]:rotate-180"
        />
        <span className="gx-label-card">Журнал аудита</span>
        {events !== null && (
          <span className="font-mono text-[10px] text-[#9ca3af]">{events.length} записей</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {error !== null ? (
          <p className="mt-2 text-[11px] text-[#dc2626]">{error}</p>
        ) : events === null ? (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-[#6b7280]">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Загрузка журнала…
          </p>
        ) : events.length === 0 ? (
          <p className="mt-2 font-mono text-[11px] text-[#9ca3af]">— записей нет —</p>
        ) : (
          <div className="gx-scroll-light mt-2 max-h-56 overflow-y-auto rounded-[4px] border border-[#e3e5e9] bg-white px-3 py-2">
            {events.map((e) => (
              <p key={e.id} className="font-mono text-[11px] leading-relaxed">
                <span className="text-[#c3c8cf]">
                  {new Date(e.createdAt).toLocaleTimeString("ru-RU")}
                </span>{" "}
                <span className="text-[#9ca3af]">{e.stageLabelRu}</span>{" "}
                <span
                  className={cn(
                    e.level === "ERROR" || e.level === "CRITICAL"
                      ? "text-[#dc2626]"
                      : e.level === "WARNING"
                        ? "text-[#b45309]"
                        : "text-[#6b7280]",
                  )}
                >
                  {e.message}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </p>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
