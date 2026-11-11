/**
 * Валидатор демо-сценариев: проигрывает каждый таймлайн через тот же
 * редьюсер, что и живой SSE-поток, и проверяет согласованность результата.
 * Запуск: bun run scripts/validate-demo.ts
 */
import { DEMO_SCENARIOS } from "../src/lib/factcheck/demo";
import { reduceStreamEvent, INITIAL_STATE } from "../src/components/factcheck/useFactcheckStream";
import type { PipelineEvent } from "../src/lib/factcheck/types";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("FAIL:", msg);
};
const pass = (msg: string) => console.log("OK:  ", msg);

// 1. Проверка уникальности id сценариев и projectId.
const ids = new Set<string>();
const projectIds = new Set<string>();
for (const s of DEMO_SCENARIOS) {
  if (ids.has(s.id)) fail(`дубликат id сценария: ${s.id}`);
  ids.add(s.id);
  if (projectIds.has(s.result.projectId)) fail(`дубликат projectId: ${s.result.projectId}`);
  projectIds.add(s.result.projectId);
  if (!s.result.projectId.startsWith("demo-")) {
    fail(`projectId сценария ${s.id} не начинается с "demo-": ${s.result.projectId}`);
  }
}
pass(`уникальность id: ${DEMO_SCENARIOS.length} сценариев`);

// 2. Каждый таймлайн воспроизводится без ошибок и завершается done.
for (const s of DEMO_SCENARIOS) {
  let state = { ...INITIAL_STATE };
  let sawDone = false;
  let sawReport = false;
  let sawError = false;
  for (const step of s.timeline) {
    state = reduceStreamEvent(state, step.event, Date.now());
    if (step.event.type === "done") sawDone = true;
    if (step.event.type === "report") sawReport = true;
    if (step.event.type === "error") sawError = true;
  }
  if (sawError) fail(`${s.id}: таймлайн содержит событие error`);
  if (!sawDone) fail(`${s.id}: таймлайн не завершается событием done`);
  if (!sawReport) fail(`${s.id}: таймлайн не содержит событие report`);
  if (state.claims.length !== s.result.claims.length)
    fail(`${s.id}: claims в редьюсере (${state.claims.length}) ≠ фикстуре (${s.result.claims.length})`);
  if (state.sources.length !== s.result.sources.length)
    fail(`${s.id}: sources в редьюсере (${state.sources.length}) ≠ фикстуре (${s.result.sources.length})`);
  if (state.verdicts.length !== s.result.verdicts.length)
    fail(`${s.id}: verdicts в редьюсере (${state.verdicts.length}) ≠ фикстуре (${s.result.verdicts.length})`);
  if (state.report?.overall_verdict !== s.result.report.overall_verdict)
    fail(`${s.id}: overall_verdict в редьюсере (${state.report?.overall_verdict}) ≠ фикстуре (${s.result.report.overall_verdict})`);
  if (!state.completed) fail(`${s.id}: редьюсер не перешёл в completed`);
  pass(
    `${s.id}: таймлайн OK · ${s.result.claims.length} утв. · ${s.result.sources.length} ист. · итог «${s.result.report.overall_verdict}»`,
  );
}

// 3. Ссылочная целостность: evidence → claim_id / source_id существуют.
for (const s of DEMO_SCENARIOS) {
  const claimIds = new Set(s.result.claims.map((c) => c.id));
  const sourceIds = new Set(s.result.sources.map((src) => src.id));
  const evidenceIds = new Set<string>();
  for (const ev of s.result.evidence) {
    evidenceIds.add(ev.id);
    if (!claimIds.has(ev.claim_id)) fail(`${s.id}: evidence ${ev.id} ссылается на несуществующий claim ${ev.claim_id}`);
    if (!sourceIds.has(ev.source_id)) fail(`${s.id}: evidence ${ev.id} ссылается на несуществующий source ${ev.source_id}`);
  }
  for (const v of s.result.verdicts) {
    if (!claimIds.has(v.claim_id)) fail(`${s.id}: verdict ссылается на несуществующий claim ${v.claim_id}`);
    for (const id of [...v.supporting_evidence_ids, ...v.contradicting_evidence_ids]) {
      if (!evidenceIds.has(id)) fail(`${s.id}: verdict ${v.claim_id} ссылается на несуществующее evidence ${id}`);
    }
    for (const id of v.source_ids) {
      if (!sourceIds.has(id)) fail(`${s.id}: verdict ${v.claim_id} ссылается на несуществующий source ${id}`);
    }
  }
  pass(`${s.id}: ссылочная целостность OK`);
}

// 4. Каждый вердикт — из допустимого множества; confidence в [0,1].
const VALID_LABELS = new Set([
  "VERIFIED", "LIKELY_TRUE", "PARTIALLY_TRUE", "MISLEADING",
  "LIKELY_FALSE", "FALSE", "INSUFFICIENT_EVIDENCE",
]);
const coverage = new Set<string>();
for (const s of DEMO_SCENARIOS) {
  coverage.add(s.result.report.overall_verdict);
  for (const v of s.result.verdicts) {
    if (!VALID_LABELS.has(v.label)) fail(`${s.id}: недопустимый verdict label ${v.label}`);
    if (v.confidence < 0 || v.confidence > 1) fail(`${s.id}: confidence вне [0,1]: ${v.confidence}`);
    if (v.label === "INSUFFICIENT_EVIDENCE" && !v.insufficient_reason) {
      fail(`${s.id}: INSUFFICIENT_EVIDENCE без insufficient_reason (${v.claim_id})`);
    }
  }
}
// Требуемое покрытие сценариев.
const REQUIRED = ["LIKELY_TRUE", "PARTIALLY_TRUE", "INSUFFICIENT_EVIDENCE", "FALSE"];
for (const req of REQUIRED) {
  if (!coverage.has(req)) fail(`нет сценария с итоговым вердиктом ${req}`);
}
pass(`покрытие вердиктов: ${[...coverage].join(", ")}`);

// 5. Проверка соответствия контракту PipelineEvent (структурная).
for (const s of DEMO_SCENARIOS) {
  for (const step of s.timeline) {
    const ev = step.event as PipelineEvent;
    if (!["stage", "log", "claims", "sources", "evidence", "report", "error", "done"].includes(ev.type)) {
      fail(`${s.id}: неизвестный тип события ${ev.type}`);
    }
  }
}
pass("структура событий соответствует PipelineEvent");

console.log("");
if (failures > 0) {
  console.error(`ВАЛИДАЦИЯ ПРОВАЛЕНА: ${failures} ошибок`);
  process.exit(1);
} else {
  console.log("ВАЛИДАЦИЯ ДЕМО-СЦЕНАРИЕВ ПРОЙДЕНА.");
}
