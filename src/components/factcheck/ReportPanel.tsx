"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  VERDICT_LABELS_RU,
  type Claim,
  type ContentNature,
  type Evidence,
  type Report,
  type Source,
  type Verdict,
} from "@/lib/factcheck/types";
import {
  contentNatureLabel,
  countVerdicts,
  formatConfidence,
  hostFromUrl,
  truncate,
  verdictByClaim,
  verdictColorClass,
} from "@/lib/factcheck/client";
import { motion } from "framer-motion";
import { ClaimAccordionHeader, ClaimCard } from "./ClaimCard";
import { SourceList } from "./SourceList";

interface ReportPanelProps {
  report: Report;
  claims: Claim[];
  verdicts: Verdict[];
  sources: Source[];
  evidence: Evidence[];
  document?: {
    url: string;
    title?: string;
    excerpt: string;
    contentNature: ContentNature;
  };
  projectId?: string;
  onReset: () => void;
}

export function ReportPanel({
  report,
  claims,
  verdicts,
  sources,
  evidence,
  document,
  projectId,
  onReset,
}: ReportPanelProps) {
  const counts = countVerdicts(verdicts);
  const vMap = verdictByClaim(verdicts);
  const natureLabel = contentNatureLabel(document?.contentNature);
  const overallPct = Math.round(Math.max(0, Math.min(1, report.overall_confidence)) * 100);

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="gx-panel gx-rise-delay relative z-10 p-5 sm:p-6"
    >
      {/* Header row: project id + new-analysis button */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="gx-display text-sm tracking-wider text-[#f4f6f7] sm:text-base">
          Результат проверки
        </h2>
        <div className="flex items-center gap-2">
          {projectId && (
            <span className="text-[11px] text-[#4e6676]" title="Идентификатор проекта">
              #{truncate(projectId, 12)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            className="h-8 rounded-sm border-[rgba(218,222,225,0.25)] px-3 text-xs text-[#dadee1] hover:bg-[rgba(218,222,225,0.08)]"
          >
            Новая проверка
          </Button>
        </div>
      </div>

      {/* Source document info */}
      {document && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-[rgba(218,222,225,0.12)] bg-[rgba(7,9,11,0.35)] px-3 py-2 text-xs text-[#8a9aa6]">
          <span className="text-[#dadee1]">Материал:</span>
          <a
            href={document.url}
            target="_blank"
            rel="noopener noreferrer"
            className="max-w-[280px] truncate text-[#7fd1c4] hover:underline sm:max-w-[400px]"
            title={document.url}
          >
            {document.title || hostFromUrl(document.url)}
          </a>
          {document.title && (
            <span className="opacity-60">· {hostFromUrl(document.url)}</span>
          )}
        </div>
      )}

      {/* Overall verdict card */}
      <div
        className={cn(
          "mb-5 rounded-sm border p-4 sm:p-5",
          "gx-bg-v-" + verdictSuffix(report.overall_verdict),
        )}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[#8a9aa6]">
              Общий вердикт
            </div>
            <div
              className={cn(
                "gx-display mt-1 text-2xl sm:text-3xl",
                verdictColorClass(report.overall_verdict),
              )}
            >
              {VERDICT_LABELS_RU[report.overall_verdict]}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-[#8a9aa6]">
              Общая уверенность
            </div>
            <div
              className={cn(
                "gx-display mt-1 text-2xl",
                verdictColorClass(report.overall_verdict),
              )}
            >
              {formatConfidence(report.overall_confidence)}
            </div>
          </div>
        </div>

        <Progress
          value={overallPct}
          className="mt-3 h-1 bg-[rgba(218,222,225,0.12)]"
        />

        {natureLabel && (
          <div className="mt-3">
            <Badge
              variant="outline"
              className="rounded-sm border-[rgba(233,196,106,0.5)] bg-[rgba(233,196,106,0.1)] px-2 py-0.5 text-[11px] font-semibold text-[#e9c46a]"
            >
              ⚠ {natureLabel}
            </Badge>
          </div>
        )}

        <p className="mt-4 text-sm leading-relaxed text-[#dadee1]">{report.summary}</p>

        {/* Stat row */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCell label="Проверено" value={verdicts.length} color="#f4f6f7" />
          <StatCell label="Подтверждено" value={counts.VERIFIED} color="#2ec4b6" />
          <StatCell label="Частично" value={counts.PARTIALLY_TRUE + counts.LIKELY_TRUE} color="#e9c46a" />
          <StatCell label="Вводит в заблуждение" value={counts.MISLEADING} color="#f4a261" />
          <StatCell label="Недостоверно" value={counts.LIKELY_FALSE + counts.FALSE} color="#ff5c8a" />
          <StatCell label="Недостаточно данных" value={counts.INSUFFICIENT_EVIDENCE} color="#8a9aa6" />
        </div>
      </div>

      {/* Methodology + limitations */}
      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-sm border border-[rgba(218,222,225,0.14)] bg-[rgba(7,9,11,0.35)] p-3">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-[#8a9aa6]">
            Методология
          </h3>
          <p className="text-xs leading-relaxed text-[#dadee1]">{report.methodology}</p>
        </div>
        <div
          className={cn(
            "rounded-sm border p-3",
            report.limitations && report.limitations.trim().length > 0
              ? "border-[rgba(233,196,106,0.35)] bg-[rgba(233,196,106,0.05)]"
              : "border-[rgba(218,222,225,0.14)] bg-[rgba(7,9,11,0.35)]",
          )}
        >
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-[#8a9aa6]">
            Ограничения
          </h3>
          {report.limitations && report.limitations.trim().length > 0 ? (
            <p className="text-xs leading-relaxed text-[#dadee1]">{report.limitations}</p>
          ) : (
            <p className="text-xs text-[#8a9aa6]">Не указаны.</p>
          )}
        </div>
      </div>

      {/* Key claims */}
      {claims.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-[#8a9aa6]">
            Ключевые утверждения ({claims.length})
          </h3>
          <Accordion type="multiple" className="rounded-sm border border-[rgba(218,222,225,0.12)] px-3">
            {claims.map((claim) => {
              const v = vMap.get(claim.id);
              return (
                <AccordionItem key={claim.id} value={claim.id} className="border-[rgba(218,222,225,0.1)]">
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <ClaimAccordionHeader claim={claim} verdict={v} />
                  </AccordionTrigger>
                  <AccordionContent className="pb-4">
                    <ClaimCard
                      claim={claim}
                      verdict={v}
                      evidence={evidence}
                      sources={sources}
                    />
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <div className="mb-2">
          <h3 className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-[#8a9aa6]">
            Источники ({sources.length})
          </h3>
          <SourceList sources={sources} />
        </div>
      )}

      {/* Medical safety disclaimer */}
      <Alert className="mt-5 border-[rgba(233,196,106,0.25)] bg-[rgba(233,196,106,0.04)]">
        <AlertTitle className="text-[#e9c46a]">Медицинская безопасность</AlertTitle>
        <AlertDescription className="text-xs text-[#dadee1]">
          Система верификации информации, а не диагностический инструмент. Не ставит
          диагнозов и не назначает лечение. Решения о лечении принимайте вместе с
          квалифицированным врачом.
        </AlertDescription>
      </Alert>
    </motion.section>
  );
}

function StatCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-sm border border-[rgba(218,222,225,0.1)] bg-[rgba(7,9,11,0.45)] px-2.5 py-1.5">
      <div className="gx-display text-lg leading-none" style={{ color }}>
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[#8a9aa6]">{label}</div>
    </div>
  );
}

/** Convert VERDICT_LABEL → css suffix used by globals (verified / likely-true / …). */
function verdictSuffix(label: Verdict["label"]): string {
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
