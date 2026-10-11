"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { VERDICT_LABELS_RU, type VerdictLabel } from "@/lib/factcheck/types";
import { verdictBgClass, verdictColorClass } from "@/lib/factcheck/client";

interface VerdictBadgeProps {
  label: VerdictLabel;
  /** Show as a colored chip (true) or as a flat text dot (false). */
  variant?: "chip" | "dot";
  className?: string;
}

export function VerdictBadge({ label, variant = "chip", className }: VerdictBadgeProps) {
  const text = VERDICT_LABELS_RU[label];
  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-2 text-xs", verdictColorClass(label), className)}>
        <span
          aria-hidden
          className="inline-block size-2 rounded-full"
          style={{ background: "currentColor" }}
        />
        {text}
      </span>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn("rounded-sm border px-2 py-0.5 text-[11px] font-semibold", verdictBgClass(label), verdictColorClass(label), className)}
    >
      {text}
    </Badge>
  );
}
