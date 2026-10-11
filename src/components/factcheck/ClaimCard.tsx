"use client";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  CLAIM_TYPE_LABELS_RU,
  type Claim,
  type Evidence,
  type Source,
  type Verdict,
} from "@/lib/factcheck/types";
import {
  directionLabel,
  evidenceForClaim,
  formatConfidence,
  hostFromUrl,
  sourceMap,
  sourceTypeLabel,
  sourcesForClaim,
  tierLabel,
  truncate,
  verdictBgClass,
  verdictColorClass,
} from "@/lib/factcheck/client";
import { VERDICT_LABELS_RU } from "@/lib/factcheck/types";
import { VerdictBadge } from "./VerdictBadge";

interface ClaimCardProps {
  claim: Claim;
  verdict: Verdict | undefined;
  evidence: Evidence[];
  sources: Source[];
}

/** The quality dimensions, with labels — used for the source-quality mini-bars. */
const QUALITY_DIMS: { key: keyof Source["quality"]; label: string }[] = [
  { key: "authority", label: "Авторитетность" },
  { key: "methodology", label: "Методология" },
  { key: "recency", label: "Актуальность" },
  { key: "relevance", label: "Релевантность" },
  { key: "independence", label: "Независимость" },
  { key: "transparency", label: "Прозрачность" },
];

export function ClaimCard({ claim, verdict, evidence, sources }: ClaimCardProps) {
  const sMap = sourceMap(sources);
  const claimEvidence = evidenceForClaim(evidence, claim.id);
  const supports = claimEvidence.filter((e) => e.direction === "SUPPORTS");
  const contradicts = claimEvidence.filter((e) => e.direction === "CONTRADICTS");
  const usedSources = sourcesForClaim(claim, verdict, evidence, sources);

  return (
    <div className="space-y-4">
      {/* Full claim text + meta */}
      <div className="space-y-2">
        <p className="text-sm leading-relaxed text-[#f4f6f7]">{claim.text}</p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8a9aa6]">
          <span className="rounded-sm border border-[rgba(218,222,225,0.2)] px-1.5 py-0.5">
            {CLAIM_TYPE_LABELS_RU[claim.type]}
          </span>
          <span>
            Важность: <span className="text-[#dadee1]">{formatConfidence(claim.importance)}</span>
          </span>
        </div>
      </div>

      {/* Verdict explanation */}
      {verdict && (
        <div
          className={cn(
            "rounded-sm border px-3 py-2.5",
            verdictBgClass(verdict.label),
          )}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={cn("text-xs font-semibold uppercase tracking-wider", verdictColorClass(verdict.label))}>
              {VERDICT_LABELS_RU[verdict.label]}
            </span>
            <span className={cn("text-xs", verdictColorClass(verdict.label))}>
              {formatConfidence(verdict.confidence)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-[#dadee1]">
            <span className="text-[#8a9aa6]">Почему: </span>
            {verdict.explanation}
          </p>
          {verdict.label === "INSUFFICIENT_EVIDENCE" && verdict.insufficient_reason && (
            <p className="mt-2 border-t border-[rgba(218,222,225,0.18)] pt-2 text-xs text-[#e9c46a]">
              <span className="text-[#8a9aa6]">Причина недостаточности: </span>
              {verdict.insufficient_reason}
            </p>
          )}
        </div>
      )}

      {/* Evidence blocks */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <EvidenceColumn
          title="Доказательства ЗА"
          accent="#2ec4b6"
          items={supports}
          sMap={sMap}
        />
        <EvidenceColumn
          title="Доказательства ПРОТИВ"
          accent="#ff5c8a"
          items={contradicts}
          sMap={sMap}
        />
      </div>

      {/* Source-quality mini-bars */}
      {usedSources.length > 0 && (
        <div className="space-y-2.5">
          <h4 className="text-xs uppercase tracking-wider text-[#8a9aa6]">
            Качество источников ({usedSources.length})
          </h4>
          <div className="space-y-2">
            {usedSources.map((s) => (
              <div
                key={s.id}
                className="rounded-sm border border-[rgba(218,222,225,0.12)] bg-[rgba(7,9,11,0.4)] p-2.5"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-xs text-[#7fd1c4] hover:underline"
                    title={s.title || s.url}
                  >
                    {s.title || hostFromUrl(s.url)}
                  </a>
                  <span className="shrink-0 text-[11px] text-[#8a9aa6]">
                    {formatConfidence(s.quality.overall)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                  {QUALITY_DIMS.map((dim) => (
                    <MiniBar key={dim.key} label={dim.label} value={s.quality[dim.key]} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface EvidenceColumnProps {
  title: string;
  accent: string;
  items: Evidence[];
  sMap: Map<string, Source>;
}

function EvidenceColumn({ title, accent, items, sMap }: EvidenceColumnProps) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs uppercase tracking-wider" style={{ color: accent }}>
        {title} <span className="text-[#8a9aa6]">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="rounded-sm border border-[rgba(218,222,225,0.1)] bg-[rgba(7,9,11,0.3)] p-2.5 text-[11px] text-[#8a9aa6]">
          Не найдено
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((ev) => {
            const src = sMap.get(ev.source_id);
            return (
              <div
                key={ev.id}
                className="rounded-sm border border-[rgba(218,222,225,0.14)] bg-[rgba(7,9,11,0.4)] p-2.5"
              >
                <div className="mb-1 flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="rounded-sm border px-1.5 py-0 text-[10px] font-semibold"
                    style={{
                      color: accent,
                      borderColor: `${accent}55`,
                      background: `${accent}14`,
                    }}
                  >
                    {directionLabel(ev.direction)}
                  </Badge>
                  <span className="text-[10px] text-[#8a9aa6]">
                    Сила: {formatConfidence(ev.strength)}
                  </span>
                </div>
                <p className="mb-1.5 text-xs leading-snug text-[#dadee1]">{ev.text}</p>
                <div className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-[rgba(218,222,225,0.1)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round(Math.max(0, Math.min(1, ev.strength)) * 100)}%`,
                      background: accent,
                    }}
                  />
                </div>
                {src && (
                  <a
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-[#7fd1c4] hover:underline"
                  >
                    <span className="truncate">{truncate(src.title || src.url, 56)}</span>
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-[#8a9aa6]">
        <span className="truncate">{label}</span>
        <span className="text-[#dadee1]">{pct}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[rgba(218,222,225,0.1)]">
        <div
          className="h-full rounded-full bg-[#4e6676]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Compact accordion header — claim text + verdict badge + confidence. */
export function ClaimAccordionHeader({
  claim,
  verdict,
}: {
  claim: Claim;
  verdict: Verdict | undefined;
}) {
  return (
    <div className="flex w-full items-start justify-between gap-3">
      <span className="min-w-0 flex-1 text-left text-sm leading-snug text-[#f4f6f7]">
        {truncate(claim.text, 180)}
      </span>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {verdict ? (
          <>
            <VerdictBadge label={verdict.label} />
            <span className={cn("text-[11px]", verdictColorClass(verdict.label))}>
              {formatConfidence(verdict.confidence)}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-[#8a9aa6]">—</span>
        )}
      </div>
    </div>
  );
}
