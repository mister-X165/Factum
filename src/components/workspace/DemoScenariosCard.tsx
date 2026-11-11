"use client";

/**
 * «Демо-сценарии» — карточка на главной с пятью захардкоженными прогонами,
 * покрывающими все ключевые вердикты: скорее правда · частично правда ·
 * скорее ложь · недостаточно данных · явный фейк (реклама). Позволяет
 * показать конвейер и панель вердиктов на презентации без зависимости от
 * скорости LLM и сети. Прогоны идут через тот же reducer, что и живой анализ.
 */

import { FlaskConical, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_SCENARIOS } from "@/lib/factcheck/demo";
import { verdictDotColor } from "@/lib/factcheck/client";
import { VERDICT_LABELS_RU, type VerdictLabel } from "@/lib/factcheck/types";

interface DemoScenariosCardProps {
  running: boolean;
  onRun: (scenarioId: string) => void;
}

/** Итоговый вердикт сценария — для цветовой метки на кнопке. */
function scenarioVerdictLabel(id: string): VerdictLabel {
  const s = DEMO_SCENARIOS.find((x) => x.id === id);
  return (s?.result.report.overall_verdict ?? "INSUFFICIENT_EVIDENCE") as VerdictLabel;
}

export function DemoScenariosCard({ running, onRun }: DemoScenariosCardProps) {
  return (
    <section className="gx-card p-4 sm:p-5" aria-labelledby="demo-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="demo-title" className="gx-label-card flex items-center gap-2">
          <FlaskConical className="size-3.5 text-[#6b7280]" aria-hidden />
          Демо-сценарии
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[#9ca3af]">
          офлайн · ~11 секунд · без LLM
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {DEMO_SCENARIOS.map((s) => {
          const verdict = scenarioVerdictLabel(s.id);
          return (
            <button
              key={s.id}
              type="button"
              disabled={running}
              onClick={() => onRun(s.id)}
              className={cn(
                "group flex h-full flex-col items-start gap-2 rounded-[4px] border border-[#e3e5e9] bg-white p-3.5 text-left transition-all",
                "hover:border-[#2563EB]/50 hover:shadow-[0_4px_16px_rgba(37,99,235,0.12)]",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[#e3e5e9] disabled:hover:shadow-none",
              )}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium leading-snug text-[#121418]">
                  {s.title}
                </span>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-[3px] bg-[#2563EB]/[0.08] text-[#2563EB] transition-colors group-hover:bg-[#2563EB] group-hover:text-white">
                  <Play className="size-3" aria-hidden />
                </span>
              </div>

              <p className="text-[12px] leading-snug text-[#6b7280]">{s.description}</p>

              <div className="mt-auto flex w-full items-center justify-between gap-2 pt-1.5">
                <span className="font-mono text-[11px] text-[#9ca3af]">{s.host}</span>
                <span className="flex items-center gap-1.5 text-[11px] font-medium">
                  <span
                    aria-hidden
                    className="size-2 rounded-[1px]"
                    style={{ background: verdictDotColor(verdict) }}
                  />
                  <span style={{ color: verdictDotColor(verdict) }}>
                    {VERDICT_LABELS_RU[verdict]}
                  </span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-[12px] leading-snug text-[#9ca3af]">
        Зафиксированные прогоны реального конвейера: телеметрия, тайминги и вердикты
        воспроизводятся детально. Сценарии покрывают все ключевые вердикты системы.
        Демо помечается бейджем и не записывается в историю.
      </p>
    </section>
  );
}
