"use client";

import { Badge } from "@/components/ui/badge";
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
  truncate,
  verdictBgClass,
  verdictColorClass,
  verdictDotColor,
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
        <p className="text-sm leading-relaxed text-[#121418]">{claim.text}</p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#6b7280]">
          <span className="rounded border border-[#e3e5e9] bg-white px-1.5 py-0.5">
            {CLAIM_TYPE_LABELS_RU[claim.type]}
          </span>
          <span>
            Важность: <span className="font-medium text-[#374151]">{formatConfidence(claim.importance)}</span>
          </span>
        </div>
      </div>

      {/* Verdict explanation */}
      {verdict && (
        <div
          className={cn(
            "rounded-md border px-3 py-2.5",
            verdictBgClass(verdict.label),
          )}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={cn("text-xs font-semibold uppercase tracking-wider", verdictColorClass(verdict.label))}>
              {VERDICT_LABELS_RU[verdict.label]}
            </span>
            <span className={cn("text-xs font-medium", verdictColorClass(verdict.label))}>
              {formatConfidence(verdict.confidence)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-[#374151]">
            <span className="text-[#6b7280]">Почему: </span>
            {verdict.explanation}
          </p>
          {verdict.label === "INSUFFICIENT_EVIDENCE" && verdict.insufficient_reason && (
            <p className="mt-2 border-t border-[#e3e5e9] pt-2 text-xs text-[#b45309]">
              <span className="text-[#6b7280]">Причина недостаточности: </span>
              {verdict.insufficient_reason}
            </p>
          )}
        </div>
      )}

      {/* Verdict version history — shown when the verdict was recalculated */}
      {verdict?.versions && verdict.versions.length > 0 && (
        <VersionTimeline
          versions={verdict.versions}
          currentLabel={verdict.label}
          currentConfidence={verdict.confidence}
        />
      )}

      {/* Evidence blocks */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <EvidenceColumn
          title="Доказательства ЗА"
          accent="#047857"
          items={supports}
          sMap={sMap}
        />
        <EvidenceColumn
          title="Доказательства ПРОТИВ"
          accent="#dc2626"
          items={contradicts}
          sMap={sMap}
        />
      </div>

      {/* Source-quality mini-bars — с типом и уровнем доказательности каждого источника */}
      {usedSources.length > 0 && (
        <div className="space-y-2.5">
          <h4 className="gx-label-card">Качество источников ({usedSources.length})</h4>
          <div className="space-y-2">
            {usedSources.map((s) => (
              <div
                key={s.id}
                className="rounded-md border border-[#e3e5e9] bg-white p-2.5"
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-xs font-medium text-[#2563EB] hover:underline"
                    title={s.title || s.url}
                  >
                    {s.title || hostFromUrl(s.url)}
                  </a>
                  <span className="shrink-0 text-[11px] font-medium text-[#6b7280]">
                    {formatConfidence(s.quality.overall)}
                  </span>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span
                    className="rounded border border-[#e3e5e9] bg-[#f9fafb] px-1.5 py-0 text-[10px] font-medium text-[#374151]"
                    title="Тип источника"
                  >
                    {sourceTypeLabel(s.source_type)}
                  </span>
                  <span
                    className="rounded border border-[#e3e5e9] bg-[#f9fafb] px-1.5 py-0 text-[10px] text-[#6b7280]"
                    title="Уровень доказательности (1 — высший, 8 — низший)"
                  >
                    Ур. {s.evidence_level}
                  </span>
                  {s.trusted ? (
                    <span
                      className="rounded border border-[#10b981]/40 bg-[#10b981]/10 px-1.5 py-0 text-[10px] font-semibold text-[#047857]"
                      title="Источник входит в доверенный реестр"
                    >
                      Доверенный
                    </span>
                  ) : (
                    <span
                      className="rounded border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-1.5 py-0 text-[10px] font-medium text-[#b45309]"
                      title="Источник не входит в доверенный реестр — учитывается с пониженным весом"
                    >
                      Вне реестра
                    </span>
                  )}
                  {s.submitted_by === "USER" && (
                    <span className="rounded border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-0 text-[10px] font-medium text-[#2563EB]">
                      Добавлен пользователем
                    </span>
                  )}
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
      <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
        {title} <span className="font-normal text-[#9ca3af]">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="rounded-md border border-[#e3e5e9] bg-white/60 p-2.5 text-[11px] text-[#9ca3af]">
          Не найдено
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((ev) => {
            const src = sMap.get(ev.source_id);
            return (
              <div
                key={ev.id}
                className="rounded-md border border-[#e3e5e9] bg-white p-2.5"
              >
                <div className="mb-1 flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="rounded px-1.5 py-0 text-[10px] font-semibold"
                    style={{
                      color: accent,
                      borderColor: `${accent}55`,
                      background: `${accent}14`,
                    }}
                  >
                    {directionLabel(ev.direction)}
                  </Badge>
                  <span className="text-[10px] text-[#6b7280]">
                    Сила: {formatConfidence(ev.strength)}
                  </span>
                </div>
                <p className="mb-1.5 text-xs leading-snug text-[#374151]">{ev.text}</p>
                <div className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-[#e3e5e9]">
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
                    className="inline-flex items-center gap-1 text-[11px] text-[#2563EB] hover:underline"
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
      <div className="flex items-center justify-between text-[10px] text-[#6b7280]">
        <span className="truncate">{label}</span>
        <span className="font-medium text-[#374151]">{pct}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#e3e5e9]">
        <div
          className="h-full rounded-full bg-[#6b7280]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Compact accordion header — color edge + index C-01 + claim text +
 * ▲N/▼N evidence counts + verdict badge + confidence.
 */
export function ClaimAccordionHeader({
  claim,
  verdict,
  index,
  supports,
  contradicts,
}: {
  claim: Claim;
  verdict: Verdict | undefined;
  /** Zero-based claim index — displayed as C-01, C-02, … */
  index: number;
  /** Supporting evidence count. */
  supports: number;
  /** Contradicting evidence count. */
  contradicts: number;
}) {
  const edge = verdict ? verdictDotColor(verdict.label) : "#c3c8cf";
  return (
    <div className="flex w-full items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 h-10 w-[3px] shrink-0 rounded-[1px]"
        style={{ background: edge }}
      />
      <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold tracking-wider text-[#9ca3af]">
        C-{String(index + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1 text-left text-sm leading-snug text-[#121418]">
        {truncate(claim.text, 180)}
      </span>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {verdict ? (
          <>
            <div className="flex items-center gap-2.5">
              {(supports > 0 || contradicts > 0) && (
                <span className="font-mono text-[10px] tabular-nums">
                  {supports > 0 && (
                    <span className="font-semibold text-[#047857]" title="Доказательства ЗА">
                      ▲{supports}
                    </span>
                  )}
                  {supports > 0 && contradicts > 0 && (
                    <span className="text-[#c3c8cf]"> </span>
                  )}
                  {contradicts > 0 && (
                    <span className="font-semibold text-[#dc2626]" title="Доказательства ПРОТИВ">
                      ▼{contradicts}
                    </span>
                  )}
                </span>
              )}
              <VerdictBadge label={verdict.label} confidence={verdict.confidence} />
            </div>
          </>
        ) : (
          <span className="text-[11px] text-[#9ca3af]">—</span>
        )}
      </div>
    </div>
  );
}

/**
 * Verdict version timeline: v1 (initial) → v2 (recalculated after a user
 * source) → … → current. Every previous state is preserved — the history
 * never overwrites.
 */
function VersionTimeline({
  versions,
  currentLabel,
  currentConfidence,
}: {
  versions: NonNullable<Verdict["versions"]>;
  currentLabel: Verdict["label"];
  currentConfidence: number;
}) {
  const entries = [
    ...versions.map((v) => ({
      version: v.version,
      label: v.label,
      confidence: v.confidence,
      reason: v.change_reason,
      current: false,
    })),
    {
      version: versions.length + 1,
      label: currentLabel,
      confidence: currentConfidence,
      reason: "Текущий вердикт",
      current: true,
    },
  ];

  return (
    <div className="rounded-md border border-[#2563EB]/30 bg-[#2563EB]/[0.05] px-3 py-2.5">
      <h4 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#2563EB]">
        История вердикта
        <span className="font-normal text-[#9ca3af]">({entries.length} версии)</span>
      </h4>
      <ol className="relative ml-1.5 space-y-2.5 border-l border-[#2563EB]/30 pl-4">
        {entries.map((e) => (
          <li key={e.version} className="relative">
            <span
              aria-hidden
              className={cn(
                "absolute -left-[21px] top-1 size-2 rounded-full border",
                e.current
                  ? "border-[#2563EB] bg-[#2563EB]"
                  : "border-[#2563EB]/50 bg-white",
              )}
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-[#9ca3af]">
                Версия {e.version}
              </span>
              <span className={cn("text-xs font-semibold", verdictColorClass(e.label))}>
                {VERDICT_LABELS_RU[e.label]}
              </span>
              <span className={cn("text-[11px] font-medium", verdictColorClass(e.label))}>
                {formatConfidence(e.confidence)}
              </span>
              {e.current && (
                <span className="rounded border border-[#2563EB]/40 bg-[#2563EB]/10 px-1.5 py-0 text-[9px] uppercase tracking-wider text-[#2563EB]">
                  сейчас
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-[#6b7280]">
              {e.reason}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
