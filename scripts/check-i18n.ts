/**
 * Проверка локализации UI критического пути (i18n-аудит).
 *
 * Сканирует исходники компонентов и хуков на английские строки, видимые
 * пользователю, — не только URL-атрибуты, но и фрагменты текста:
 *   - текстовые узлы JSX (>Текст<)
 *   - значения placeholder / title / aria-label / alt
 *   - шаблонные строки с кириллицей-соседями (детали стадий, ошибки)
 *   - строковые литералы в message/error-полях
 *
 * Легитимные английские исключения: домены, URL, технические классы Tailwind,
 * имена npm-пакетов, enum-значения контракта (SUPPORTS, RCT...), латинина
 * в составе русских строк (РКИ, FDA, Tier-коды не считаются).
 *
 * Запуск: bun run scripts/check-i18n.ts
 * Код выхода: 0 — чисто, 1 — найдены непереведённые строки.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Каталоги UI критического пути + общие модули форматирования. */
const SCAN_DIRS = [
  "src/components/factcheck",
  "src/components/workspace",
  "src/components/shell",
  "src/app/login",
  "src/hooks",
];

/** Файлы, которые не сканируем (служебные, не содержат пользовательских строк). */
const SKIP_FILES = new Set<string>([]);

/** Английские слова, которые допустимы в русских строках (аббревиатуры, бренды). */
const ALLOWED_TOKENS = new Set<string>([
  // Организации и бренды
  "WHO", "CDC", "FDA", "NIH", "NHS", "AHA", "AAD", "ECDC", "NEJM", "PubMed",
  "Cochrane", "Gardasil", "Lancet", "VAERS", "NHLBI", "NIDDK", "Mayo",
  // Технические термины, устоявшиеся в русском мед. контексте
  "Tier", "HTTP", "JSON", "SSE", "LLM", "API", "URL", "MD", "PDF", "SSRF",
  "Enter", "Shift", "Esc",
]);

/**
 * Строка считается английской (непереведённой), если содержит ≥2 слов
 * латиницей длиной ≥3, не входящих в список исключений.
 */
function looksEnglish(text: string): boolean {
  const stripped = text
    .replace(/https?:\/\/\S+/g, " ") // URL
    .replace(/[\w.-]+@[\w.-]+/g, " ") // email
    .replace(/\b[A-Za-z]+(-[A-Za-z]+)+\b/g, " "); // kebab-case (классы)
  const words = stripped.match(/\b[A-Za-z]{3,}\b/g) ?? [];
  let englishWords = 0;
  for (const w of words) {
    if (ALLOWED_TOKENS.has(w)) continue;
    // camelCase / snake_case идентификаторы
    if (/[a-z][A-Z]/.test(w) || w.includes("_")) continue;
    englishWords++;
  }
  return englishWords >= 2;
}

interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

const findings: Finding[] = [];

function checkFile(path: string): void {
  const rel = path.replace(/^\.\//, "");
  if (SKIP_FILES.has(rel)) return;
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    const ln = i + 1;
    const no = line.trim();
    if (no.length === 0) return;
    // Пропускаем: импорты, комментарии, css-классы, декларации types.
    if (/^(import|export\s+(type|interface|const)\s|\/\/|\/\*|\*|\/\/)/.test(no)) return;

    // 1. Текстовые узлы JSX: >English text<
    const jsxText = line.match(/>\s*([A-Za-z][^<>{}\n]{6,})\s*</g);
    if (jsxText) {
      for (const m of jsxText) {
        const text = m.replace(/^>\s*/, "").replace(/\s*<$/, "");
        if (looksEnglish(text)) {
          findings.push({ file: rel, line: ln, kind: "JSX-текст", text: text.trim() });
        }
      }
    }

    // 2. Атрибуты: placeholder="...", title="...", aria-label="..."
    const attrs = line.matchAll(/\b(placeholder|title|aria-label|alt)=["']([^"']{6,})["']/g);
    for (const a of attrs) {
      if (looksEnglish(a[2])) {
        findings.push({ file: rel, line: ln, kind: `атрибут ${a[1]}`, text: a[2] });
      }
    }

    // 3. Литералы, присваиваемые в message/error/label-поля (SSE-контракт).
    const msgFields = line.matchAll(/\b(message|error|hint|detail|summary)\s*[:=]\s*["'`]([^"'`]{10,})["'`]/g);
    for (const m of msgFields) {
      if (looksEnglish(m[2])) {
        findings.push({ file: rel, line: ln, kind: `поле ${m[1]}`, text: m[2] });
      }
    }
  });
}

function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(name)) checkFile(full);
  }
}

for (const d of SCAN_DIRS) walk(d);

if (findings.length === 0) {
  console.log("OK: непереведённых английских строк в UI критического пути не найдено.");
  console.log("Проверены: JSX-текст, placeholder/title/aria-label, поля message/error/hint/detail.");
  process.exit(0);
} else {
  console.error(`НАЙДЕНО непереведённых строк: ${findings.length}\n`);
  let lastFile = "";
  for (const f of findings) {
    if (f.file !== lastFile) {
      console.error(`\n${f.file}:`);
      lastFile = f.file;
    }
    console.error(`  ${f.line}: [${f.kind}] "${f.text.slice(0, 100)}"`);
  }
  process.exit(1);
}
