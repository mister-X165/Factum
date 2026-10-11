"use client";

import { cn } from "@/lib/utils";
import { STAGE_LABELS_RU, type PipelineStage } from "@/lib/factcheck/types";
import { STAGE_ORDER } from "@/lib/factcheck/client";
import type { StreamState } from "./useFactcheckStream";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * The progress panel. Renders the ordered pipeline stages, the live stats
 * (claims/sources/evidence counts), and the latest error (if any).
 *
 * Per §106 we MUST NOT show chain-of-thought, internal prompts, JSON,
 * or internal IDs — only stage names + their status + a short detail line.
 */
interface ProgressPanelProps {
  state: StreamState;
}

/** Visible stages (we skip "queued"/"error"/"done" because they are implied). */
const VISIBLE_STAGES: PipelineStage[] = STAGE_ORDER.filter(
  (s) => s !== "queued" && s !== "error" && s !== "done",
);

export function ProgressPanel({ state }: ProgressPanelProps) {
  const { stages, activeDetail, lastLog, error, errorStage, claims, sources, evidence } = state;

  return (
    <section className="gx-panel gx-rise-delay relative z-10 p-5 sm:p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="gx-spinner" aria-hidden />
        <h2 className="gx-display text-sm tracking-wider text-[#f4f6f7] sm:text-base">
          Идёт анализ
        </h2>
      </header>

      {/* Live stats */}
      <div className="mb-5 grid grid-cols-3 gap-2">
        <StatChip label="Утверждений" value={claims.length} accent="#7fd1c4" />
        <StatChip label="Источников" value={sources.length} accent="#2ec4b6" />
        <StatChip label="Доказательств" value={evidence.length} accent="#e9c46a" />
      </div>

      {/* Stage list */}
      <ol className="space-y-1.5">
        {VISIBLE_STAGES.map((stage) => {
          const status = stages[stage];
          return (
            <StageRow
              key={stage}
              label={STAGE_LABELS_RU[stage]}
              status={status}
              detail={status === "active" ? activeDetail : undefined}
              isFailed={errorStage === stage}
            />
          );
        })}
      </ol>

      {/* Latest log */}
      {lastLog && !error && (
        <p
          className={cn(
            "mt-4 border-t border-[rgba(218,222,225,0.1)] pt-3 text-xs leading-snug",
            lastLog.level === "error"
              ? "text-[#ff8aad]"
              : lastLog.level === "warn"
                ? "text-[#e9c46a]"
                : "text-[#8a9aa6]",
          )}
        >
          {lastLog.message}
        </p>
      )}

      {/* Error */}
      {error && (
        <Alert variant="destructive" className="mt-4 border-[rgba(255,92,138,0.4)] bg-[rgba(255,92,138,0.08)]">
          <AlertTitle className="text-[#ff8aad]">Не удалось завершить анализ</AlertTitle>
          <AlertDescription className="text-[#dadee1]">{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

interface StageRowProps {
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  detail?: string;
  isFailed?: boolean;
}

function StageRow({ label, status, detail, isFailed }: StageRowProps) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-sm px-2 py-1.5 transition-colors",
        status === "active" && "bg-[rgba(46,196,182,0.05)]",
        status === "failed" && "bg-[rgba(255,92,138,0.06)]",
      )}
    >
      <StatusDot status={status} isFailed={isFailed} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "text-sm",
            status === "pending" && "text-[#8a9aa6]",
            status === "done" && "text-[#f4f6f7]",
            status === "active" && "text-[#f4f6f7]",
            status === "skipped" && "text-[#4e6676] line-through",
            status === "failed" && "text-[#ff8aad]",
          )}
        >
          {label}
        </span>
        {detail && (
          <span className="text-xs leading-snug text-[#8a9aa6]">{detail}</span>
        )}
      </div>
    </li>
  );
}

function StatusDot({
  status,
  isFailed,
}: {
  status: "pending" | "active" | "done" | "skipped" | "failed";
  isFailed?: boolean;
}) {
  if (status === "done") {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex size-4 items-center justify-center rounded-full bg-[#2ec4b6]"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-3 text-[#07090b]"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "active") {
    return <span className="gx-spinner mt-1" aria-hidden />;
  }
  if (status === "skipped") {
    return (
      <span
        aria-hidden
        className="mt-1.5 size-3 rounded-full border border-[rgba(78,102,118,0.5)] bg-transparent"
      />
    );
  }
  if (status === "failed" || isFailed) {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex size-4 items-center justify-center rounded-full bg-[#ff5c8a]"
      >
        <svg viewBox="0 0 16 16" className="size-3 text-white" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="mt-1.5 size-3 rounded-full border border-[rgba(218,222,225,0.35)] bg-transparent"
    />
  );
}

function StatChip({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-sm border border-[rgba(218,222,225,0.14)] bg-[rgba(7,9,11,0.5)] px-3 py-2">
      <div
        className="gx-display text-xl leading-none"
        style={{ color: accent }}
        aria-live="polite"
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[#8a9aa6]">
        {label}
      </div>
    </div>
  );
}
