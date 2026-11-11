/**
 * Экспорт отчёта — Markdown + печатная HTML-версия (для «Сохранить как PDF»).
 * Без внешних зависимостей: Blob + URL.createObjectURL + <a download> + window.print.
 *
 * Markdown открывается в любом редакторе / Obsidian / GitHub рендером.
 * PDF генерируется через стандартный диалог печати браузера — пользователь
 * выбирает «Сохранить как PDF». Это устойчивее, чем тянуть pdfkit/jsPDF в рантайм.
 */

import type { AnalysisResult, Evidence, Source, Verdict } from "./types";
import { VERDICT_LABELS_RU } from "./types";
import {
  formatConfidence,
  hostFromUrl,
  sourceTypeLabel,
  truncate,
} from "./client";

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

export interface AuditEventDto {
  id: string;
  stage: string;
  stageLabelRu: string;
  level: string;
  message: string;
  detail?: string;
  createdAt: string;
}

/** Нормализуем перевод строки и убираем маркдаун-разрывы внутри текста. */
function clean(text: string | undefined | null): string {
  if (!text) return "—";
  return text.replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string | undefined | null): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

export function exportReportMarkdown(
  result: AnalysisResult,
  audit: AuditEventDto[] = [],
): string {
  const lines: string[] = [];
  const doc = result.document;

  lines.push(`# Отчёт проверки: ${VERDICT_LABELS_RU[result.report.overall_verdict]}`);
  lines.push("");
  lines.push(
    `**Уверенность:** ${formatConfidence(result.report.overall_confidence)} · ` +
      `**Утверждений:** ${result.claims.length} · **Источников:** ${result.sources.length} · ` +
      `**Фрагментов доказательств:** ${result.evidence.length}`,
  );
  lines.push("");
  lines.push(`**Материал:** ${doc.title ? `«${doc.title}» — ` : ""}${doc.url}`);
  lines.push(
    `**Хост:** ${hostFromUrl(doc.url)} · **Режим:** ${
      result.mode === "RESEARCH" ? "исследовательский" : "контролируемый"
    } · **Дата:** ${new Date(result.createdAt || Date.now()).toLocaleString("ru-RU")}`,
  );
  if (result.revision > 0) {
    lines.push(`**Редакция вердиктов:** ${result.revision + 1} (после добавления источников)`);
  }
  lines.push("");

  lines.push("## Резюме");
  lines.push("");
  lines.push(clean(result.report.summary));
  lines.push("");

  lines.push("## Утверждения");
  lines.push("");
  const verdictMap = new Map<string, Verdict>(result.verdicts.map((v) => [v.claim_id, v]));
  const sourceMap = new Map<string, Source>(result.sources.map((s) => [s.id, s]));

  result.claims.forEach((claim, i) => {
    const v = verdictMap.get(claim.id);
    const idx = `C-${String(i + 1).padStart(2, "0")}`;
    const label = v ? VERDICT_LABELS_RU[v.label] : "—";
    const conf = v ? formatConfidence(v.confidence) : "—";
    lines.push(`### ${idx} · ${label} (${conf})`);
    lines.push("");
    lines.push(`> ${clean(claim.text)}`);
    lines.push("");
    if (v) {
      lines.push(`**Обоснование.** ${clean(v.explanation)}`);
      lines.push("");
      const supporting = pickEvidence(result.evidence, v.supporting_evidence_ids, sourceMap);
      const contradicting = pickEvidence(result.evidence, v.contradicting_evidence_ids, sourceMap);
      if (supporting.length > 0) {
        lines.push("**Доказательства ЗА:**");
        lines.push("");
        supporting.forEach((e) => lines.push(`- ${e}`));
        lines.push("");
      }
      if (contradicting.length > 0) {
        lines.push("**Доказательства ПРОТИВ:**");
        lines.push("");
        contradicting.forEach((e) => lines.push(`- ${e}`));
        lines.push("");
      }
      if (v.versions && v.versions.length > 0) {
        lines.push("**История вердикта:**");
        lines.push("");
        v.versions.forEach((ver) => {
          lines.push(
            `- Версия ${ver.version}: ${VERDICT_LABELS_RU[ver.label]} (${formatConfidence(
              ver.confidence,
            )}) — ${clean(ver.change_reason)}`,
          );
        });
        lines.push("");
      }
    }
  });

  lines.push("## Источники");
  lines.push("");
  if (result.sources.length === 0) {
    lines.push("Источники не найдены.");
    lines.push("");
  } else {
    result.sources.forEach((s, i) => {
      lines.push(
        `${i + 1}. [${clean(truncate(s.title || s.url, 90))}](${s.url}) — ${sourceTypeLabel(
          s.source_type,
        )} · уровень доказательности ${s.evidence_level}${s.trusted ? " · доверенный" : " · вне доверенного реестра"}${s.submitted_by === "USER" ? " · добавлен пользователем" : ""}`,
      );
    });
    lines.push("");
  }

  lines.push("## Методология");
  lines.push("");
  lines.push(clean(result.report.methodology));
  lines.push("");

  lines.push("## Ограничения");
  lines.push("");
  lines.push(clean(result.report.limitations));
  lines.push("");

  if (audit.length > 0) {
    lines.push("## Журнал аудита");
    lines.push("");
    lines.push("| Время | Стадия | Уровень | Сообщение |");
    lines.push("|---|---|---|---|");
    audit.forEach((e) => {
      const t = new Date(e.createdAt).toLocaleString("ru-RU");
      const detail = e.detail ? ` · ${e.detail}` : "";
      lines.push(
        `| ${t} | ${e.stageLabelRu ?? e.stage} | ${e.level} | ${clean(e.message + detail)} |`,
      );
    });
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `_Сформировано системой «Фактум» ${new Date().toLocaleString("ru-RU")}. ` +
      `Отчёт не заменяет медицинскую консультацию._`,
  );

  return lines.join("\n");
}

function pickEvidence(
  all: Evidence[],
  ids: string[],
  sourceMap: Map<string, Source>,
): string[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  return ids
    .map((id) => byId.get(id))
    .filter((e): e is Evidence => e !== undefined)
    .map((e) => {
      const src = sourceMap.get(e.source_id);
      const srcLabel = src ? truncate(src.title || src.url, 48) : e.source_id;
      return `«${clean(e.text)}» — ${srcLabel}`;
    });
}

/** Скачивает отчёт как Markdown-файл. Подгружает аудит, если projectId реальный. */
export async function downloadReportMarkdown(result: AnalysisResult): Promise<void> {
  let audit: AuditEventDto[] = [];
  if (result.projectId && !result.projectId.startsWith("demo-")) {
    try {
      const r = await fetch(`/api/history/${result.projectId}/audit`);
      if (r.ok) {
        const data = (await r.json()) as { events?: AuditEventDto[] };
        audit = data.events ?? [];
      }
    } catch {
      // не критично — отчёт выгружается без аудита
    }
  }
  const md = exportReportMarkdown(result, audit);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `factum-report-${result.projectId || "check"}-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Печать / PDF                                                        */
/* ------------------------------------------------------------------ */

/**
 * Генерирует автономный HTML-документ, оптимизированный под печать и
 * «Сохранить как PDF» в диалоге печати браузера.
 */
export function exportReportHtml(
  result: AnalysisResult,
  audit: AuditEventDto[] = [],
): string {
  const doc = result.document;
  const verdictMap = new Map<string, Verdict>(result.verdicts.map((v) => [v.claim_id, v]));
  const sourceMap = new Map<string, Source>(result.sources.map((s) => [s.id, s]));
  const overallPct = Math.round(
    Math.max(0, Math.min(1, result.report.overall_confidence)) * 100,
  );

  const claimsHtml = result.claims
    .map((claim, i) => {
      const v = verdictMap.get(claim.id);
      const idx = `C-${String(i + 1).padStart(2, "0")}`;
      const label = v ? VERDICT_LABELS_RU[v.label] : "—";
      const conf = v ? formatConfidence(v.confidence) : "—";
      const supporting = v
        ? pickEvidence(result.evidence, v.supporting_evidence_ids, sourceMap)
        : [];
      const contradicting = v
        ? pickEvidence(result.evidence, v.contradicting_evidence_ids, sourceMap)
        : [];
      return `
        <div class="claim">
          <h3>${idx} · ${escapeHtml(label)} <span class="conf">(${escapeHtml(conf)})</span></h3>
          <blockquote>${escapeHtml(claim.text)}</blockquote>
          ${v ? `<p class="expl"><strong>Обоснование.</strong> ${escapeHtml(v.explanation)}</p>` : ""}
          ${supporting.length > 0 ? `<p class="dir"><strong>ЗА:</strong></p><ul>${supporting.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
          ${contradicting.length > 0 ? `<p class="dir"><strong>ПРОТИВ:</strong></p><ul>${contradicting.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
        </div>`;
    })
    .join("");

  const sourcesHtml =
    result.sources.length === 0
      ? "<p>Источники не найдены.</p>"
      : `<ol>${result.sources
          .map(
            (s) =>
              `<li><a href="${escapeHtml(s.url)}">${escapeHtml(truncate(s.title || s.url, 90))}</a> — ${escapeHtml(sourceTypeLabel(s.source_type))} · уровень доказательности ${s.evidence_level}${s.trusted ? " · доверенный" : ""}</li>`,
          )
          .join("")}</ol>`;

  const auditHtml =
    audit.length === 0
      ? ""
      : `<h2>Журнал аудита</h2>
         <table class="audit">
           <thead><tr><th>Время</th><th>Стадия</th><th>Уровень</th><th>Сообщение</th></tr></thead>
           <tbody>
             ${audit
               .map((e) => {
                 const t = new Date(e.createdAt).toLocaleString("ru-RU");
                 const detail = e.detail ? ` · ${e.detail}` : "";
                 return `<tr><td>${escapeHtml(t)}</td><td>${escapeHtml(e.stageLabelRu ?? e.stage)}</td><td>${escapeHtml(e.level)}</td><td>${escapeHtml(e.message + detail)}</td></tr>`;
               })
               .join("")}
           </tbody>
         </table>`;

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Отчёт проверки — ${escapeHtml(VERDICT_LABELS_RU[result.report.overall_verdict])}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", sans-serif; line-height: 1.55; color: #1f2937; max-width: 820px; margin: 0 auto; padding: 32px 28px; }
    h1 { font-size: 22px; margin: 0 0 4px; color: #121418; }
    h2 { font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e3e5e9; color: #374151; }
    h3 { font-size: 14px; margin: 16px 0 4px; color: #121418; }
    .meta { font-size: 12px; color: #6b7280; margin-bottom: 16px; }
    .hero { background: #f8fafc; border-left: 4px solid #2563EB; padding: 14px 16px; margin: 12px 0 20px; border-radius: 4px; }
    .hero .label { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #6b7280; }
    .hero .verdict { font-size: 26px; font-weight: 600; color: #2563EB; margin-top: 2px; }
    .hero .conf-line { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .claim { margin: 12px 0; padding: 12px; border: 1px solid #e3e5e9; border-radius: 4px; break-inside: avoid; }
    .claim blockquote { margin: 8px 0; padding: 8px 12px; background: #f9fafb; border-left: 3px solid #c3c8cf; font-style: normal; color: #374151; }
    .claim .conf { color: #6b7280; font-weight: 400; }
    .claim .expl { font-size: 13px; }
    .claim .dir { margin: 6px 0 2px; font-size: 13px; }
    .claim ul { margin: 4px 0 8px 18px; padding: 0; }
    .claim li { font-size: 12px; color: #4b5563; }
    .audit { width: 100%; border-collapse: collapse; font-size: 11px; }
    .audit th, .audit td { border: 1px solid #e3e5e9; padding: 4px 6px; text-align: left; vertical-align: top; }
    .audit th { background: #f3f4f6; font-weight: 600; }
    a { color: #2563EB; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e3e5e9; font-size: 11px; color: #9ca3af; }
    @media print {
      body { max-width: none; padding: 0; }
      .claim { break-inside: avoid; }
      a { color: #1f2937; text-decoration: none; }
    }
  </style>
</head>
<body>
  <h1>Отчёт проверки материала</h1>
  <p class="meta">
    ${escapeHtml(doc.title ? `«${doc.title}» · ` : "")}${escapeHtml(doc.url)}<br />
    Хост: ${escapeHtml(hostFromUrl(doc.url))} ·
    Режим: ${result.mode === "RESEARCH" ? "исследовательский" : "контролируемый"} ·
    Дата: ${escapeHtml(new Date(result.createdAt || Date.now()).toLocaleString("ru-RU"))}
  </p>

  <div class="hero">
    <div class="label">Общий вердикт</div>
    <div class="verdict">${escapeHtml(VERDICT_LABELS_RU[result.report.overall_verdict])}</div>
    <div class="conf-line">Уверенность: ${escapeHtml(formatConfidence(result.report.overall_confidence))} (${overallPct}%) · Утверждений: ${result.claims.length} · Источников: ${result.sources.length} · Доказательств: ${result.evidence.length}</div>
  </div>

  <h2>Резюме</h2>
  <p>${escapeHtml(result.report.summary)}</p>

  <h2>Утверждения</h2>
  ${claimsHtml || "<p>Утверждений не выделено.</p>"}

  <h2>Источники</h2>
  ${sourcesHtml}

  <h2>Методология</h2>
  <p>${escapeHtml(result.report.methodology || "—")}</p>

  <h2>Ограничения</h2>
  <p>${escapeHtml(result.report.limitations || "Не указаны.")}</p>

  ${auditHtml}

  <div class="footer">
    Сформировано системой «Фактум» ${escapeHtml(new Date().toLocaleString("ru-RU"))}.
    Отчёт не заменяет медицинскую консультацию.
  </div>
</body>
</html>`;
}

/**
 * Открывает печатную версию отчёта в новом окне и вызывает диалог печати
 * браузера — пользователь выбирает «Сохранить как PDF» или физический принтер.
 * Подгружает аудит, если projectId реальный (не demo).
 */
export async function printReport(result: AnalysisResult): Promise<void> {
  let audit: AuditEventDto[] = [];
  if (result.projectId && !result.projectId.startsWith("demo-")) {
    try {
      const r = await fetch(`/api/history/${result.projectId}/audit`);
      if (r.ok) {
        const data = (await r.json()) as { events?: AuditEventDto[] };
        audit = data.events ?? [];
      }
    } catch {
      // не критично — печатаем без аудита
    }
  }
  const html = exportReportHtml(result, audit);
  const win = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
  if (!win) {
    // Браузер заблокировал всплывающее окно — fallback: скачиваем HTML-файл.
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `factum-report-${result.projectId || "check"}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Даём браузеру отрисовать документ перед вызовом печати.
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      // ignore — пользователь может вызвать печать вручную через меню
    }
  }, 400);
}
