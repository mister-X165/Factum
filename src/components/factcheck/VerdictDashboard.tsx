"use client";

/**
 * «Панель вердиктов» — главный экран результата (P0-2).
 *
 * Задача: читаемость за 10–15 секунд. Сверху — крупный общий вердикт,
 * уверенность и резюме; ниже — распределение вердиктов по утверждениям
 * одним стековым баром; затем список утверждений с цветовой кодировкой
 * (кромка, индекс C-01, ▲N/▼N). Раскрытие утверждения — доказательства
 * ЗА/ПРОТИВ, источники, история версий вердикта.
 *
 * Методология и ограничения свёрнуты, чтобы не превращать экран в «стену
 * текста». Внизу — источники, форма добавления альтернативного источника,
 * экспорт отчёта (MD) и журнал аудита (P1).
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Loader2, Plus, Printer } from "lucide-react";
import { motion } from "framer-motion";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  VERDICT_LABELS_RU,
  VERDICT_ORDER,
  type AnalysisResult,
  type ContentNature,
  type SourceUpdateResult,
  type VerdictLabel,
} from "@/lib/factcheck/types";
import {
  contentNatureLabel,
  countVerdicts,
  evidenceForClaim,
  formatConfidence,
  hostFromUrl,
  isInlineText,
  verdictByClaim,
  verdictColorClass,
  verdictDotColor,
} from "@/lib/factcheck/client";
import { downloadReportMarkdown, printReport } from "@/lib/factcheck/export";
import { ClaimAccordionHeader, ClaimCard } from "./ClaimCard";
import { SourceList } from "./SourceList";
import { AuditTrail } from "./AuditTrail";

interface VerdictDashboardProps {
  result: AnalysisResult;
  /** Демо-прогон: скрываем аудит (нет записи в БД) и помечаем экран. */
  demo?: boolean;
  /** Called after a user-submitted source recalculated the verdicts. */
  onSourceAdded?: (payload: SourceUpdateResult) => void;
}

export function VerdictDashboard({ result, demo, onSourceAdded }: VerdictDashboardProps) {
  const { report, document: doc } = result;
  const counts = countVerdicts(result.verdicts);
  const vMap = verdictByClaim(result.verdicts);
  const natureLabel = contentNatureLabel(doc.contentNature);
  const overallPct = Math.round(Math.max(0, Math.min(1, report.overall_confidence)) * 100);
  const [exportBusy, setExportBusy] = useState<"md" | "pdf" | null>(null);

  // Сегменты стекового бара — только ненулевые, в каноническом порядке.
  const segments = VERDICT_ORDER.filter((l) => counts[l] > 0).map((l) => ({
    label: VERDICT_LABELS_RU[l],
    count: counts[l],
    color: verdictDotColor(l),
    pct: (counts[l] / Math.max(1, result.verdicts.length)) * 100,
  }));

  const isDemo = demo ?? result.projectId.startsWith("demo-");

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="space-y-4"
      aria-labelledby="vd-title"
    >
      {/* ── Общий вердикт — Hero ──────────────────────────────────── */}
      <div
        className={cn(
          "gx-card relative overflow-hidden p-5 sm:p-7",
          "gx-bg-v-" + verdictSuffix(report.overall_verdict),
        )}
      >
        {/* Левая акцентная полоса — для «бьющих» вердиктов (false / insufficient / misleading). */}
        <span
          aria-hidden
          className={cn("gx-hero-edge", "gx-hero-edge-" + verdictSuffix(report.overall_verdict))}
        />
        <h2 id="vd-title" className="sr-only">
          Результат проверки
        </h2>

        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          {/* Левая колонка — крупный вердикт + мелкая мета */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="gx-label-card">Общий вердикт</span>
              {isDemo && (
                <span className="rounded-[3px] border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#b45309]">
                  Демо
                </span>
              )}
              {result.revision > 0 && (
                <Badge
                  variant="outline"
                  className="rounded-[3px] border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 text-[10px] font-semibold text-[#2563EB]"
                  title="Вердикты пересчитаны после добавления пользователем альтернативных источников"
                >
                  Редакция {result.revision + 1}
                </Badge>
              )}
              {natureLabel && (
                <Badge
                  variant="outline"
                  className="rounded-[3px] border-[#f59e0b]/50 bg-[#f59e0b]/10 px-2 py-0 text-[11px] font-semibold text-[#b45309]"
                >
                  ⚠ {natureLabel}
                </Badge>
              )}
            </div>
            <div
              className={cn(
                "gx-display mt-2 text-4xl leading-[1.05] tracking-tight sm:text-5xl",
                verdictColorClass(report.overall_verdict),
              )}
            >
              {VERDICT_LABELS_RU[report.overall_verdict]}
            </div>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[#9ca3af]">
              {doc.title && !isInlineText(doc.url) ? truncateTitle(doc.title) + " · " : ""}
              {isInlineText(doc.url) ? "Вставленный фрагмент текста" : hostFromUrl(doc.url)}
              {result.createdAt ? ` · ${formatDate(result.createdAt)}` : ""}
            </p>
          </div>

          {/* Правая колонка — confidence как SVG-кольцо (доминирующий элемент) */}
          <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
            <ConfidenceRing
              pct={overallPct}
              color={verdictDotColor(report.overall_verdict)}
              verdictColorClass={verdictColorClass(report.overall_verdict)}
            />
            <div className="sm:text-right">
              <div className="gx-label-card">Уверенность</div>
              <div className="mt-0.5 font-mono text-[11px] text-[#6b7280]">
                {result.mode === "RESEARCH" ? "Исследовательский режим" : "Контролируемый режим"}
              </div>
            </div>
          </div>
        </div>

        {/* Summary — намеренно приглушён, чтобы не конкурировать с вердиктом */}
        <p className="mt-5 max-w-4xl border-t border-black/5 pt-4 text-[13px] leading-relaxed text-[#4b5563]">
          {report.summary}
        </p>

        {/* ── Распределение вердиктов ─────────────────────────────── */}
        {result.verdicts.length > 0 && (
          <div className="mt-5">
            <div className="flex h-2.5 w-full overflow-hidden rounded-[2px] bg-[#e3e5e9]">
              {segments.map((s) => (
                <span
                  key={s.label}
                  title={`${s.label}: ${s.count}`}
                  style={{ width: `${s.pct}%`, background: s.color, minWidth: 4 }}
                />
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {segments.map((s) => (
                <span key={s.label} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-[1px]"
                    style={{ background: s.color }}
                  />
                  <span className="text-[12px] text-[#6b7280]">{s.label}</span>
                  <span className="font-mono text-[12px] font-semibold tabular-nums text-[#121418]">
                    {s.count}
                  </span>
                </span>
              ))}
              <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.1em] text-[#9ca3af]">
                {result.claims.length} утверждений · {result.sources.length} источников ·{" "}
                {result.evidence.length} доказательств
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Утверждения ───────────────────────────────────────────── */}
      {result.claims.length > 0 && (
        <div className="gx-card p-5 sm:p-6">
          <h3 className="gx-label-card mb-2.5">Утверждения ({result.claims.length})</h3>
          <Accordion
            type="multiple"
            className="overflow-hidden rounded-[4px] border border-[#e3e5e9] bg-white px-3"
          >
            {result.claims.map((claim, i) => {
              const v = vMap.get(claim.id);
              const claimEvidence = evidenceForClaim(result.evidence, claim.id);
              const supports = claimEvidence.filter((e) => e.direction === "SUPPORTS").length;
              const contradicts = claimEvidence.filter((e) => e.direction === "CONTRADICTS").length;
              return (
                <AccordionItem key={claim.id} value={claim.id} className="border-[#e3e5e9]">
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <ClaimAccordionHeader
                      claim={claim}
                      verdict={v}
                      index={i}
                      supports={supports}
                      contradicts={contradicts}
                    />
                  </AccordionTrigger>
                  <AccordionContent className="pb-4">
                    <ClaimCard
                      claim={claim}
                      verdict={v}
                      evidence={result.evidence}
                      sources={result.sources}
                    />
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      )}

      {/* ── Методология и ограничения (свёрнуто) ──────────────────── */}
      <div className="gx-card p-5 sm:p-6">
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left">
            <span className="gx-label-card">Методология и ограничения</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#9ca3af] transition-colors group-hover:text-[#2563EB]">
              раскрыть
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-[4px] border border-[#e3e5e9] bg-white p-3.5">
                <h4 className="gx-label-card mb-1.5">Методология</h4>
                <p className="text-xs leading-relaxed text-[#374151]">{report.methodology}</p>
              </div>
              <div
                className={cn(
                  "rounded-[4px] border p-3.5",
                  report.limitations && report.limitations.trim().length > 0
                    ? "border-[#f59e0b]/35 bg-[#f59e0b]/[0.06]"
                    : "border-[#e3e5e9] bg-white",
                )}
              >
                <h4 className="gx-label-card mb-1.5">Ограничения</h4>
                {report.limitations && report.limitations.trim().length > 0 ? (
                  <p className="text-xs leading-relaxed text-[#374151]">{report.limitations}</p>
                ) : (
                  <p className="text-xs text-[#6b7280]">Не указаны.</p>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* ── Источники + альтернативный источник ───────────────────── */}
      <div className="gx-card p-5 sm:p-6">
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <h3 className="gx-label-card">Источники и доказательства ({result.sources.length})</h3>
          {result.sources.some((s) => s.submitted_by === "USER") && (
            <span className="rounded-[3px] border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-px text-[9px] font-semibold text-[#2563EB]">
              + пользовательские
            </span>
          )}
        </div>
        <SourceList sources={result.sources} />
        {result.projectId && !isDemo && (
          <AddSourceForm projectId={result.projectId} onAdded={onSourceAdded} />
        )}
      </div>

      {/* ── Нижняя строка: экспорт (всегда) + аудит (только не demo) ── */}
      <div className="gx-card px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={exportBusy !== null}
              onClick={async () => {
                setExportBusy("md");
                try {
                  await downloadReportMarkdown(result);
                } finally {
                  setExportBusy(null);
                }
              }}
              className="h-8 rounded-[4px] border-[#e3e5e9] bg-white px-3.5 text-xs font-medium text-[#121418] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
            >
              {exportBusy === "md" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="size-3.5" aria-hidden />
              )}
              Скачать отчёт · Markdown
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={exportBusy !== null}
              onClick={async () => {
                setExportBusy("pdf");
                try {
                  await printReport(result);
                } finally {
                  setExportBusy(null);
                }
              }}
              className="h-8 rounded-[4px] border-[#e3e5e9] bg-white px-3.5 text-xs font-medium text-[#121418] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
            >
              {exportBusy === "pdf" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Printer className="size-3.5" aria-hidden />
              )}
              Сохранить как PDF
            </Button>
            <span className="text-[12px] text-[#9ca3af]">
              Полный отчёт: вердикты, доказательства, источники, аудит
            </span>
          </div>
          {result.projectId && !isDemo && (
            <span className="font-mono text-[11px] text-[#9ca3af]" title="Идентификатор проекта">
              #{result.projectId}
            </span>
          )}
          {isDemo && (
            <span className="rounded-[3px] border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#b45309]">
              Демо-прогон · не сохранён в истории
            </span>
          )}
        </div>
        {/* Аудит доступен только для реальных прогонов (есть projectId в БД). */}
        {result.projectId && !isDemo && (
          <div className="mt-3 border-t border-[#e3e5e9] pt-3">
            <AuditTrail projectId={result.projectId} />
          </div>
        )}
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/* Форма альтернативного источника (перенесена из ReportPanel)          */
/* ------------------------------------------------------------------ */

/**
 * § «Альтернативные источники»: submit a source URL for the finished
 * analysis. The backend re-fetches / re-evaluates it, re-extracts evidence,
 * recalculates verdicts (keeping the version history) and regenerates the
 * report. This can take 1–5 minutes — we show honest progress notes.
 */
function AddSourceForm({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded?: (payload: SourceUpdateResult) => void;
}) {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNote("Загрузка источника и пересчёт вердиктов… Это может занять несколько минут.");
    try {
      const res = await fetch(`/api/history/${projectId}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" && data.error.trim().length > 0
            ? data.error
            : "Не удалось добавить источник. Проверьте ссылку и повторите попытку.",
        );
      }
      const payload = data as SourceUpdateResult;
      setUrl("");
      setNote(null);
      const changed = payload.changedVerdicts.length;
      toast({
        title:
          changed > 0
            ? `Источник добавлен · вердикты обновлены (${changed})`
            : "Источник добавлен · вердикты не изменились",
        description:
          changed > 0
            ? payload.changedVerdicts
                .map(
                  (c) =>
                    `C-${c.claim_id}: ${VERDICT_LABELS_RU[c.from_label]} → ${
                      VERDICT_LABELS_RU[c.to_label]
                    }`
                )
                .join("\n")
            : "Новый источник учтён в доказательной базе.",
      });
      onAdded?.(payload);
    } catch (e) {
      setNote(null);
      setError(e instanceof Error ? e.message : "Не удалось добавить источник.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-[4px] border border-[#2563EB]/30 bg-[#2563EB]/[0.04] p-3">
      <label
        htmlFor="add-source-url"
        className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#2563EB]"
      >
        <Plus className="size-3" aria-hidden />
        Предложить источник
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="add-source-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="https://… — научная статья, руководство, опровержение"
          className="h-9 rounded-[4px] border-[#e3e5e9] bg-white text-xs text-[#121418] placeholder:text-[#9ca3af] focus-visible:border-[#2563EB]"
        />
        <Button
          type="button"
          disabled={busy || url.trim().length === 0}
          onClick={() => void submit()}
          className="h-9 shrink-0 rounded-[4px] bg-[#2563EB] px-4 text-xs font-medium text-white hover:bg-[#1d4ed8]"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          {busy ? "Пересчёт…" : "Добавить и пересчитать"}
        </Button>
      </div>
      {note && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-[#6b7280]">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {note}
        </p>
      )}
      {error && <p className="mt-2 text-[11px] text-[#dc2626]">{error}</p>}
      <p className="mt-2 text-[10px] leading-snug text-[#9ca3af]">
        Источник будет оценён по тем же критериям качества; вердикты пересчитаются с
        сохранением истории версий.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Мелкие хелперы                                                      */
/* ------------------------------------------------------------------ */

/**
 * SVG-кольцо уверенности — доминирующий визуальный элемент Hero.
 * Большой табличный % по центру, цветовая дуга, серый фон-трек.
 * На проекторе читается с дальнего расстояния.
 */
function ConfidenceRing({
  pct,
  color,
  verdictColorClass,
}: {
  pct: number;
  color: string;
  verdictColorClass: string;
}) {
  const size = 96;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-label={`Уверенность ${pct}%`}
      role="img"
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
        aria-hidden
      >
        {/* трек */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(11, 13, 16, 0.10)"
          strokeWidth={stroke}
        />
        {/* дуга — начинается сверху (повёрнутая на -90°) */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "gx-display font-mono text-[26px] font-bold tabular-nums leading-none",
            verdictColorClass,
          )}
        >
          {pct}
          <span className="text-[14px] font-semibold">%</span>
        </span>
      </div>
    </div>
  );
}

function truncateTitle(title: string): string {
  return title.length > 64 ? `${title.slice(0, 64).trimEnd()}…` : title;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return "";
  }
}

/** Convert VERDICT_LABEL → css suffix used by globals (verified / likely-true / …). */
function verdictSuffix(label: VerdictLabel): string {
  switch (label) {
    case "VERIFIED":
      return "verified";
    case "LIKELY_TRUE":
      return "likely-true";
    case "PARTIALLY_TRUE":
      return "partially-true";
    case "MISLEADING":
      return "misleading";
    case "LIKELY_FALSE":
      return "likely-false";
    case "FALSE":
      return "false";
    case "INSUFFICIENT_EVIDENCE":
      return "insufficient";
  }
}
