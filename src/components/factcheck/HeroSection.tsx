"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Фактум hero. Preserves the key-visual background and the
 * RF Dewi Expanded display font for the headline.
 */
export function HeroSection() {
  const scrollToWorkspace = () => {
    const el = document.getElementById("workspace");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <header className="gx-rise relative z-10 px-4 pt-14 pb-12 sm:px-8 sm:pt-20 sm:pb-16 lg:pt-28 lg:pb-20">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-8">
        {/* Wordmark */}
        <div className="flex items-center gap-3">
          <span
            className="gx-display text-2xl font-bold tracking-[0.12em] text-[#f4f6f7] sm:text-3xl"
            aria-label="Фактум"
          >
            Фактум
          </span>
        </div>

        {/* Headline + slogan */}
        <div className="max-w-3xl">
          <h1 className="gx-display text-3xl leading-[1.08] sm:text-4xl lg:text-5xl">
            Доказательная проверка
            <br />
            <span className="text-[#7fd1c4]">медицинской информации</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-[#dadee1] sm:text-base">
            Вставьте ссылку на статью о здоровье. Система выделит ключевые утверждения,
            найдёт научные источники, соберёт доказательства «за» и «против» — и выдаст
            независимый вердикт по каждому утверждению.
          </p>
        </div>

        {/* CTA */}
        <div className="flex flex-wrap items-center gap-4">
          <Button
            onClick={scrollToWorkspace}
            size="lg"
            className={cn(
              "gx-btn-primary h-12 rounded-sm border px-6 text-sm font-semibold tracking-wide text-white",
            )}
          >
            Открыть рабочую область
          </Button>
          <span className="text-xs text-[#8a9aa6]">
            Без постановки диагнозов. Без назначения лечения.
          </span>
        </div>
      </div>
    </header>
  );
}
