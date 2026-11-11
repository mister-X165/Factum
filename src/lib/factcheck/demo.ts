/**
 * Демо-режим: пять захардкоженных сценариев полного анализа + таймлайны
 * событий, которые проигрываются через тот же reducer, что и живой SSE-поток
 * (reduceStreamEvent в useFactcheckStream.ts). Демо не обращается к сети и
 * LLM — рендер идентичен реальному запуску.
 *
 * Сценарии покрывают все ключевые вердикты: LIKELY_TRUE на хороших
 * источниках, PARTIALLY_TRUE, смешанный случай, INSUFFICIENT_EVIDENCE
 * и явный FALSE на рекламном материале.
 *
 * Содержание сценариев опирается на устойчивый медицинский консенсус
 * (ВОЗ, Cochrane, CDC, FDA, NIH), чтобы демо-режим выдавал корректные
 * результаты.
 */

import type {
  AnalysisMode,
  AnalysisResult,
  Claim,
  ClaimType,
  ContentNature,
  Evidence,
  EvidenceDirection,
  PipelineEvent,
  Report,
  Source,
  SourceQuality,
  SourceType,
  Verdict,
  VerdictLabel,
} from "./types";

/* ------------------------------------------------------------------ */
/* Типы демо                                                           */
/* ------------------------------------------------------------------ */

/** Один шаг таймлайна: подождать delayMs → отправить событие в reducer. */
export interface DemoStep {
  delayMs: number;
  event: PipelineEvent;
}

export interface DemoScenario {
  id: string;
  /** Короткое название на кнопке. */
  title: string;
  /** Хост «материала» — подпись на кнопке. */
  host: string;
  /** Однострочное описание сценария. */
  description: string;
  /** Ожидаемый итог — подпись-подсказка на кнопке. */
  expectedVerdict: string;
  result: AnalysisResult;
  timeline: DemoStep[];
}

/* ------------------------------------------------------------------ */
/* Хелперы конструирования фикстур                                     */
/* ------------------------------------------------------------------ */

function mkQuality(p: Partial<SourceQuality> & { overall: number }): SourceQuality {
  return {
    authority: 0.85,
    methodology: 0.8,
    recency: 0.8,
    relevance: 0.85,
    independence: 0.8,
    transparency: 0.8,
    ...p,
  };
}

function mkSource(
  id: string,
  p: {
    url: string;
    title: string;
    type: SourceType;
    tier: number;
    trusted: boolean;
    quality: SourceQuality;
    org?: string;
    excerpt?: string;
  },
): Source {
  return {
    id,
    url: p.url,
    title: p.title,
    organization: p.org,
    retrieved_at: "2026-11-10T10:24:00.000Z",
    source_type: p.type,
    evidence_level: p.tier,
    trusted: p.trusted,
    quality: p.quality,
    excerpt: p.excerpt,
    submitted_by: "SYSTEM",
  };
}

function mkClaim(
  id: string,
  text: string,
  type: ClaimType,
  importance: number,
): Claim {
  return {
    id,
    text,
    normalized_text: text.toLowerCase(),
    type,
    importance,
    check_required: true,
    context: "",
  };
}

function mkEvidence(
  id: string,
  claim_id: string,
  source_id: string,
  text: string,
  direction: EvidenceDirection,
  relevance: number,
  strength: number,
  evidence_type: string,
): Evidence {
  return {
    id,
    claim_id,
    source_id,
    text,
    evidence_type,
    direction,
    relevance,
    strength,
  };
}

function mkVerdict(
  claim_id: string,
  label: VerdictLabel,
  confidence: number,
  explanation: string,
  supporting: string[],
  contradicting: string[],
  source_ids: string[],
): Verdict {
  return {
    claim_id,
    label,
    confidence,
    explanation,
    supporting_evidence_ids: supporting,
    contradicting_evidence_ids: contradicting,
    source_ids,
  };
}

function mkReport(
  project_id: string,
  overall_verdict: VerdictLabel,
  overall_confidence: number,
  summary: string,
  methodology: string,
  limitations: string,
): Report {
  return {
    project_id,
    overall_verdict,
    overall_confidence,
    summary,
    methodology,
    limitations,
    generated_at: "2026-11-10T10:24:00.000Z",
    model_info: "Демо-режим · зафиксированный прогон",
  };
}

/* ------------------------------------------------------------------ */
/* Таймлайн-билдер — общая структура прогона конвейера                  */
/* ------------------------------------------------------------------ */

interface TimelineParams {
  mode: AnalysisMode;
  chars: number;
  queries: number;
  rawResults: number;
  /** Поисковые логи вида «Поиск: … → N результатов». */
  searchLogs: string[];
  /** Источники, видимые ДО поиска контраргументов (null → как sources). */
  sourcesBeforeAdversarial?: Source[];
  adversarial: { results: number } | null; // null → CONTROLLED: skipped
  adversarialLog?: string;
  evidenceCount: number;
  overallLabelRu: string;
  projectId: string;
  result: AnalysisResult;
}

function buildTimeline(p: TimelineParams): DemoStep[] {
  const steps: DemoStep[] = [];
  const add = (delayMs: number, event: PipelineEvent) => steps.push({ delayMs, event });

  add(0, { type: "stage", stage: "queued", status: "active" });

  add(300, { type: "stage", stage: "validating_url", status: "active" });
  add(450, { type: "stage", stage: "validating_url", status: "done" });

  add(0, { type: "stage", stage: "fetching_material", status: "active" });
  add(850, { type: "stage", stage: "fetching_material", status: "done" });

  add(0, { type: "stage", stage: "extracting_text", status: "active" });
  add(550, {
    type: "stage",
    stage: "extracting_text",
    status: "done",
    detail: `${p.chars.toLocaleString("ru-RU")} символов`,
  });

  add(350, { type: "stage", stage: "extracting_claims", status: "active" });
  add(1000, {
    type: "stage",
    stage: "extracting_claims",
    status: "done",
    detail: `${p.result.claims.length} утверждений`,
  });
  add(0, { type: "claims", claims: p.result.claims });
  add(0, {
    type: "log",
    level: "info",
    message: `Извлечено ${p.result.claims.length} проверяемых утверждений`,
  });

  add(400, { type: "stage", stage: "planning_research", status: "active" });
  add(650, {
    type: "stage",
    stage: "planning_research",
    status: "done",
    detail: `${p.queries} запросов`,
  });

  add(0, { type: "stage", stage: "searching_sources", status: "active" });
  add(1200, {
    type: "stage",
    stage: "searching_sources",
    status: "done",
    detail: `${p.rawResults} результатов`,
  });
  for (const line of p.searchLogs) {
    add(0, { type: "log", level: "info", message: line });
  }

  add(0, { type: "stage", stage: "evaluating_sources", status: "active" });
  add(900, {
    type: "stage",
    stage: "evaluating_sources",
    status: "done",
    detail: `${(p.sourcesBeforeAdversarial ?? p.result.sources).length} источников`,
  });
  add(0, {
    type: "sources",
    sources: p.sourcesBeforeAdversarial ?? p.result.sources,
  });

  if (p.adversarial === null) {
    // Контролируемый режим: контраргументы не ищутся — честно помечаем.
    add(300, {
      type: "stage",
      stage: "adversarial_search",
      status: "skipped",
      detail: "Контролируемый режим — только доверенный реестр",
    });
  } else {
    add(300, { type: "stage", stage: "adversarial_search", status: "active" });
    add(950, { type: "stage", stage: "adversarial_search", status: "done" });
    if (p.adversarialLog) {
      add(0, { type: "log", level: "info", message: p.adversarialLog });
    }
    add(0, { type: "sources", sources: p.result.sources });
  }

  add(0, { type: "stage", stage: "extracting_evidence", status: "active" });
  add(1300, {
    type: "stage",
    stage: "extracting_evidence",
    status: "done",
    detail: `${p.evidenceCount} фрагментов`,
  });
  add(0, { type: "evidence", evidence: p.result.evidence });

  add(0, { type: "stage", stage: "synthesising", status: "active" });
  add(850, {
    type: "stage",
    stage: "synthesising",
    status: "done",
    detail: `${p.result.verdicts.length} вердиктов`,
  });

  add(0, { type: "stage", stage: "calculating_verdict", status: "active" });
  add(650, {
    type: "stage",
    stage: "calculating_verdict",
    status: "done",
    detail: p.overallLabelRu,
  });

  add(0, { type: "stage", stage: "generating_report", status: "active" });
  add(750, { type: "stage", stage: "generating_report", status: "done" });

  add(250, {
    type: "report",
    report: p.result.report,
    claims: p.result.claims,
    verdicts: p.result.verdicts,
    sources: p.result.sources,
    evidence: p.result.evidence,
    document: p.result.document,
  });
  add(150, { type: "done", projectId: p.projectId });

  return steps;
}

/* ------------------------------------------------------------------ */
/* Сценарий 1 — добротная статья о вакцинации против ВПЧ                */
/* ------------------------------------------------------------------ */

const hpvResult: AnalysisResult = {
  projectId: "demo-hpv-vaccine",
  url: "https://zdravinfo.ru/materialy/vaktsinatsiya-vpch-i-rak-sheyki-matki",
  mode: "RESEARCH",
  modelInfo: "Демо-режим · зафиксированный прогон",
  createdAt: "2026-11-10T10:24:00.000Z",
  status: "completed",
  revision: 0,
  document: {
    url: "https://zdravinfo.ru/materialy/vaktsinatsiya-vpch-i-rak-sheyki-matki",
    title: "Вакцинация против ВПЧ: как работает защита от рака шейки матки",
    excerpt:
      "Разбираем, как вакцинация против вируса папилломы человека снижает заболеваемость раком шейки матки, что говорят крупные исследования о её эффективности и безопасности и почему Австралия ближе всех к устранению этой болезни.",
    contentNature: "INFORMATION",
  },
  claims: [
    mkClaim(
      "c1",
      "Вирусы папилломы человека 16-го и 18-го типов вызывают около 70% случаев рака шейки матки",
      "MEDICAL_FACT",
      0.95,
    ),
    mkClaim(
      "c2",
      "У девушек, вакцинированных до контакта с вирусом, предраковые изменения шейки матки, связанные с ВПЧ 16/18, практически не встречаются в клинических исследованиях",
      "EFFICACY_CLAIM",
      0.9,
    ),
    mkClaim(
      "c3",
      "Вакцины против ВПЧ безопасны: серьёзные нежелательные явления не встречаются чаще, чем в контрольных группах",
      "SAFETY_CLAIM",
      0.9,
    ),
    mkClaim(
      "c4",
      "ВОЗ рекомендует включить вакцинацию против ВПЧ в национальные программы иммунизации",
      "PREVENTION_CLAIM",
      0.85,
    ),
    mkClaim(
      "c5",
      "Через 10–15 лет после внедрения повсеместной вакцинации Австралия ликвидирует рак шейки матки как проблему здравоохранения",
      "PREDICTION",
      0.7,
    ),
  ],
  sources: [
    mkSource("s1", {
      url: "https://www.who.int/ru/news-room/fact-sheets/detail/human-papillomavirus-(hpv)-and-cervical-cancer",
      title: "Вирус папилломы человека и рак шейки матки — информационный бюллетень ВОЗ",
      org: "Всемирная организация здравоохранения",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.98, methodology: 0.9, relevance: 0.95, overall: 0.95 }),
      excerpt:
        "Онкогенные типы ВПЧ 16 и 18 вызывают около 70% случаев рака шейки матки в мире; ВОЗ рекомендует вакцинацию девочек в рамках национальных программ.",
    }),
    mkSource("s2", {
      url: "https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD009092.pub3",
      title:
        "Cochrane: Prophylactic vaccination against human papillomaviruses to prevent cervical cancer and its precursors (2018)",
      org: "Cochrane Library",
      type: "COCHRANE_REVIEW",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.96, methodology: 0.97, relevance: 0.96, overall: 0.94 }),
      excerpt:
        "В РКИ с участием 24 000+ девушек вакцина снижала связанные с ВПЧ 16/18 предраковые изменения CIN2+ на 99% у серонегативных; частота серьёзных нежелательных явлений не отличалась от контроля.",
    }),
    mkSource("s3", {
      url: "https://www.cdc.gov/hpv/hcp/clinical-overview/index.html",
      title: "HPV Clinical Overview — CDC",
      org: "Centers for Disease Control and Prevention",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.88, relevance: 0.9, overall: 0.9 }),
      excerpt: "ВПЧ-вакцины проходят непрерывный мониторинг безопасности; серьёзных сигналов не выявлено.",
    }),
    mkSource("s4", {
      url: "https://pubmed.ncbi.nlm.nih.gov/31831513/",
      title:
        "Drolet M. et al. Population-level impact and herd effects following HPV vaccination programmes (Lancet Infect Dis, 2019)",
      org: "PubMed",
      type: "META_ANALYSIS",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.92, methodology: 0.93, relevance: 0.9, overall: 0.91 }),
      excerpt:
        "В странах с охватом ≥50% инфекции ВПЧ 16/18 среди девушек снизились на 83%, а среди юношей — на 37% (популяционный эффект).",
    }),
    mkSource("s5", {
      url: "https://www.fda.gov/vaccines-blood-biologics/vaccines/gardasil-9",
      title: "Gardasil 9 — FDA: Vaccines Licensed in the US",
      org: "FDA",
      type: "REGULATOR",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.97, methodology: 0.86, relevance: 0.85, overall: 0.89 }),
      excerpt: "Профиль безопасности оценивается непрерывно; польза превышает риски.",
    }),
    mkSource("s6", {
      url: "https://www.ecdc.europa.eu/en/human-papillomavirus",
      title: "Human papillomavirus — ECDC",
      org: "ECDC",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.93, methodology: 0.84, relevance: 0.86, overall: 0.87 }),
      excerpt: "Вакцинация против ВПЧ входит в рекомендации ECDC для стран ЕС.",
    }),
    mkSource("s7", {
      url: "https://pubmed.ncbi.nlm.nih.gov/31128519/",
      title:
        "Hall M. T. et al. Projected future impact of HPV vaccination on cervical cancer (Lancet Public Health, 2019)",
      org: "PubMed",
      type: "OBSERVATIONAL",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.82, methodology: 0.78, relevance: 0.8, transparency: 0.85, overall: 0.78 }),
      excerpt:
        "Моделирование: при охвате 80%+ Австралия достигнет порога устранения рака шейки матки (<4 случая на 100 000) к 2035–2040 гг.",
    }),
    mkSource("s8", {
      url: "https://zenodo-medicine.blogspot.com/2026/10/hpv-natural-immunity.html",
      title: "Естественный иммунитет против ВПЧ лучше вакцины?",
      type: "BLOG",
      tier: 7,
      trusted: false,
      quality: mkQuality({
        authority: 0.25,
        methodology: 0.15,
        relevance: 0.6,
        independence: 0.5,
        transparency: 0.3,
        overall: 0.33,
      }),
      excerpt: "Автор блога оспаривает программы вакцинации, опираясь на личное мнение; клинических данных нет.",
    }),
  ],
  evidence: [
    mkEvidence("e1", "c1", "s1", "Онкогенные ВПЧ 16/18 ответственны примерно за 70% случаев рака шейки матки в мире.", "SUPPORTS", 0.97, 0.95, "GUIDELINE_STATEMENT"),
    mkEvidence("e2", "c2", "s2", "У ВПЧ-серонегативных девушек 15–26 лет вакцина снижает риск CIN2+, связанного с ВПЧ 16/18, более чем на 95% (РКИ, n>24 000).", "SUPPORTS", 0.96, 0.93, "RCT_RESULT"),
    mkEvidence("e3", "c3", "s2", "Серьёзные нежелательные явления встречались с одинаковой частотой в группах вакцины и контроля (ОР 1.00).", "SUPPORTS", 0.95, 0.9, "RCT_RESULT"),
    mkEvidence("e4", "c4", "s1", "ВОЗ рекомендует включить ВПЧ-вакцинацию в национальные программы иммунизации (цель — ликвидация рака шейки матки).", "SUPPORTS", 0.96, 0.96, "GUIDELINE_STATEMENT"),
    mkEvidence("e5", "c2", "s4", "Инфекции ВПЧ 16/18 среди девушек в странах с высоким охватом вакцинацией снизились на 83% — популяционное подтверждение эффективности.", "SUPPORTS", 0.88, 0.88, "META_RESULT"),
    mkEvidence("e6", "c5", "s7", "Прогноз: при текущем охвате Австралия достигнет критерия устранения (<4/100 000) к 2035–2040 гг. — результат моделирования, а не наблюдения.", "SUPPORTS", 0.8, 0.74, "MODEL_PROJECTION"),
    mkEvidence("e7", "c3", "s5", "FDA: непрерывный мониторинг безопасности не выявил серьёзных сигналов после >100 млн доз.", "SUPPORTS", 0.85, 0.85, "REGULATORY"),
    mkEvidence("e8", "c4", "s6", "ECDC рекомендует вакцинацию девочек и мальчиков в странах ЕС.", "SUPPORTS", 0.85, 0.85, "GUIDELINE_STATEMENT"),
    mkEvidence("e9", "c3", "s3", "CDC: профили безопасности вакцин подтверждаются системами надзора (VAERS и клинические базы).", "SUPPORTS", 0.86, 0.84, "SURVEILLANCE"),
    mkEvidence("e10", "c1", "s8", "Блог утверждает, что «естественный иммунитет достаточен», не приводя клинических данных; оценка релевантности низкая.", "NEUTRAL", 0.4, 0.22, "OPINION"),
    mkEvidence("e11", "c1", "s2", "Метаанализ РКИ подтверждает этиологическую связь ВПЧ 16/18 с предраковыми изменениями.", "SUPPORTS", 0.92, 0.9, "META_RESULT"),
  ],
  verdicts: [
    mkVerdict(
      "c1",
      "VERIFIED",
      0.95,
      "Подтверждено бюллетенем ВОЗ и Кокрейновским обзором РКИ. Мнение блога не подтверждено клиническими данными и не влияет на вердикт.",
      ["e1", "e11"],
      [],
      ["s1", "s2", "s8"],
    ),
    mkVerdict(
      "c2",
      "VERIFIED",
      0.93,
      "Подтверждено РКИ из Кокрейновского обзора (снижение CIN2+ на 95%+) и популяционными данными (снижение инфекций на 83%).",
      ["e2", "e5"],
      [],
      ["s2", "s4"],
    ),
    mkVerdict(
      "c3",
      "VERIFIED",
      0.91,
      "Три независимых источника верхнего уровня (Cochrane, FDA, CDC) подтверждают сопоставимую с контролем частоту серьёзных нежелательных явлений.",
      ["e3", "e7", "e9"],
      [],
      ["s2", "s3", "s5"],
    ),
    mkVerdict(
      "c4",
      "VERIFIED",
      0.96,
      "Прямая рекомендация ВОЗ, подтверждённая позицией ECDC.",
      ["e4", "e8"],
      [],
      ["s1", "s6"],
    ),
    mkVerdict(
      "c5",
      "PARTIALLY_TRUE",
      0.74,
      "Утверждение опирается на модельный прогноз (Lancet Public Health), а не на установленный факт: корректно по сути, но подано как свершившееся. Дополнительный порог «ликвидации» относится к критерию <4/100 000, а не к нулю заболеваемости.",
      ["e6"],
      [],
      ["s7"],
    ),
  ],
  report: mkReport(
    "demo-hpv-vaccine",
    "LIKELY_TRUE",
    0.9,
    "Материал в целом достоверен: 4 из 5 утверждений подтверждены источниками верхнего уровня доказательности (ВОЗ, Cochrane, FDA, CDC). Пятое утверждение — корректный по сути, но модельный прогноз, поданный как установленный факт. Коммерческого интереса не выявлено; найденный критический блог не подтвердился клиническими данными.",
    "Исследовательский режим: 5 утверждений, 8 источников (7 из доверенного реестра), 11 фрагментов доказательств, поиск контраргументов выполнен. Вердикты рассчитаны детерминированным правилом поверх независимых оценок модели.",
    "Утверждение C-05 — прогноз: оно не может быть верифицировано ретроспективно, вывод опирается на моделирование при допущении сохранения охвата вакцинации.",
  ),
};

/* ------------------------------------------------------------------ */
/* Сценарий 2 — сомнительная статья о витамине C                        */
/* ------------------------------------------------------------------ */

const vitaminCResult: AnalysisResult = {
  projectId: "demo-vitamin-c",
  url: "https://natural-medic.ru/statji/vitamin-c-vysokie-dozy-ot-prostudy",
  mode: "RESEARCH",
  modelInfo: "Демо-режим · зафиксированный прогон",
  createdAt: "2026-11-10T10:24:00.000Z",
  status: "completed",
  revision: 0,
  document: {
    url: "https://natural-medic.ru/statji/vitamin-c-vysokie-dozy-ot-prostudy",
    title: "Витамин C в высоких дозах: незаслуженно забытая панацея от простуды",
    excerpt:
      "Почему регулярный приём витамина C в высоких дозах должен стать основой защиты от простуды и гриппа — и почему этот способ «скрывают» фармацевтические компании.",
    contentNature: "AFFILIATE_CONTENT",
  },
  claims: [
    mkClaim(
      "c1",
      "Регулярный приём витамина C предотвращает простуду у большинства людей",
      "PREVENTION_CLAIM",
      0.95,
    ),
    mkClaim(
      "c2",
      "Приём витамина C сокращает длительность простуды примерно на 8% у взрослых",
      "STATISTICAL_CLAIM",
      0.85,
    ),
    mkClaim(
      "c3",
      "Дозы витамина C от 1000 мг в день полностью безопасны для всех",
      "SAFETY_CLAIM",
      0.85,
    ),
    mkClaim(
      "c4",
      "Витамин C настолько усиливает иммунитет, что заменяет вакцинацию от гриппа",
      "TREATMENT_CLAIM",
      1.0,
    ),
    mkClaim(
      "c5",
      "Чем выше доза витамина C, тем лучше для здоровья",
      "MEDICAL_FACT",
      0.7,
    ),
  ],
  sources: [
    mkSource("s1", {
      url: "https://pubmed.ncbi.nlm.nih.gov/23440782/",
      title: "Hemilä H., Chalker E. Vitamin C for preventing and treating the common cold (Cochrane, 2013)",
      org: "Cochrane Library",
      type: "COCHRANE_REVIEW",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.96, methodology: 0.96, relevance: 0.97, overall: 0.93 }),
      excerpt:
        "Регулярный приём не снижает частоту простуд в общей популяции; длительность у взрослых короче на 8%. Исключение — экстремальные нагрузки: у марафонцев и военных риск ниже вдвое.",
    }),
    mkSource("s2", {
      url: "https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/",
      title: "Vitamin C — Fact Sheet for Health Professionals (NIH ODS)",
      org: "NIH Office of Dietary Supplements",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.96, methodology: 0.88, relevance: 0.93, overall: 0.92 }),
      excerpt:
        "При дозах >500 мг всасываемость падает; >3 г/сут могут вызывать диарею; у предрасположенных повышается риск оксалатных камней.",
    }),
    mkSource("s3", {
      url: "https://www.cdc.gov/flu/prevent/",
      title: "Flu Prevention — CDC",
      org: "CDC",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.87, relevance: 0.88, overall: 0.9 }),
      excerpt: "Вакцинация — основная подтверждённая мера профилактики гриппа; добавки альтернативой не являются.",
    }),
    mkSource("s4", {
      url: "https://www.mayoclinic.org/drugs-supplements/vitamin-c",
      title: "Vitamin C (Ascorbic acid) — Mayo Clinic",
      org: "Mayo Clinic",
      type: "SPECIALIZED_MEDICAL",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.9, methodology: 0.8, relevance: 0.85, overall: 0.85 }),
      excerpt: "Высокие дозы — желудочно-кишечные расстройства, тошнота; верхний предел 2000 мг/сут.",
    }),
    mkSource("s5", {
      url: "https://www.fda.gov/food/dietary-supplements",
      title: "Dietary Supplements — FDA",
      org: "FDA",
      type: "REGULATOR",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.82, relevance: 0.8, overall: 0.86 }),
      excerpt: "БАДы не предназначены для лечения или профилактики болезней; заявления о «замене лекарств» недопустимы.",
    }),
    mkSource("s6", {
      url: "https://www.nhs.uk/conditions/vitamins-and-minerals/vitamin-c/",
      title: "Vitamins and minerals — Vitamin C (NHS)",
      org: "NHS",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.93, methodology: 0.82, relevance: 0.84, overall: 0.86 }),
      excerpt: "Достаточно 40 мг/сут; регулярный приём немного сокращает длительность простуды у части людей.",
    }),
    mkSource("s7", {
      url: "https://natural-medic.ru/shop/vitamin-c-1000",
      title: "Витамин C 1000 мг — страница магазина",
      org: "natural-medic.ru",
      type: "COMMERCIAL",
      tier: 7,
      trusted: false,
      quality: mkQuality({
        authority: 0.2,
        methodology: 0.1,
        relevance: 0.7,
        independence: 0.15,
        transparency: 0.3,
        overall: 0.27,
      }),
      excerpt: "«Клинически доказанная профилактика простуды» — маркетинговое заявление без ссылок на РКИ; конфликт интересов.",
    }),
  ],
  evidence: [
    mkEvidence("e1", "c1", "s1", "Регулярный приём витамина C не снижает частоту простуды в общей популяции (Кокрейновский обзор РКИ, n>11 000).", "CONTRADICTS", 0.96, 0.92, "META_RESULT"),
    mkEvidence("e2", "c2", "s1", "Длительность простуды при регулярном приёме короче на 8% у взрослых и на 14% у детей.", "SUPPORTS", 0.92, 0.88, "META_RESULT"),
    mkEvidence("e3", "c1", "s2", "Профилактический эффект витамина C для населения в целом не продемонстрирован.", "CONTRADICTS", 0.9, 0.85, "SYSTEMATIC_REVIEW"),
    mkEvidence("e4", "c3", "s2", "Дозы выше 3 г/сут часто вызывают диарею; у предрасположенных людей повышают риск оксалатных камней в почках.", "CONTRADICTS", 0.9, 0.88, "SAFETY_DATA"),
    mkEvidence("e5", "c5", "s2", "Всасываемость падает при дозах выше ~200–500 мг/сут; избыток выводится почками, «больше» не означает «лучше».", "CONTRADICTS", 0.85, 0.8, "PHARMACOKINETICS"),
    mkEvidence("e6", "c4", "s3", "Подтверждённая мера профилактики гриппа — ежегодная вакцинация; витамин C не является её заменой.", "CONTRADICTS", 0.95, 0.93, "GUIDELINE_STATEMENT"),
    mkEvidence("e7", "c1", "s7", "Магазин утверждает о «доказанной профилактике», не приводя исследований; источник с прямым конфликтом интересов.", "SUPPORTS", 0.65, 0.3, "MARKETING"),
    mkEvidence("e8", "c3", "s4", "Побочные эффекты высоких доз: диарея, тошнота, спазмы; верхний допустимый уровень — 2000 мг/сут.", "CONTRADICTS", 0.86, 0.8, "CLINICAL_REFERENCE"),
    mkEvidence("e9", "c2", "s6", "NHS подтверждает небольшой эффект на длительность простуды при регулярном приёме.", "SUPPORTS", 0.85, 0.8, "HEALTH_SERVICE"),
    mkEvidence("e10", "c1", "s1", "Исключение из обзора: у марафонцев, лыжников и военных риск простуды ниже примерно на 50% — но это не «большинство людей».", "NEUTRAL", 0.6, 0.45, "META_RESULT"),
    mkEvidence("e11", "c4", "s5", "Для БАДов запрещены заявления о профилактике и лечении болезней; витамин C не зарегистрирован как средство от гриппа.", "CONTRADICTS", 0.88, 0.85, "REGULATORY"),
  ],
  verdicts: [
    mkVerdict(
      "c1",
      "LIKELY_FALSE",
      0.88,
      "Кокрейновский обзор РКИ и данные NIH не подтверждают профилактический эффект в общей популяции. «Поддерживающее» доказательство — маркетинговая страница продавца с прямым конфликтом интересов (учтена с минимальным весом). Исключение для спортсменов на экстремальных нагрузках не относится к формулировке «у большинства людей».",
      [],
      ["e1", "e3"],
      ["s1", "s2", "s7"],
    ),
    mkVerdict(
      "c2",
      "VERIFIED",
      0.9,
      "Единственное утверждение материала, полностью подтверждённое данными: обзор Cochrane и NHS сходятся на величине ~8% для взрослых. Типичная деталь недобросовестных публикаций — реальный факт используется как «якорь доверия».",
      ["e2", "e9"],
      [],
      ["s1", "s6"],
    ),
    mkVerdict(
      "c3",
      "LIKELY_FALSE",
      0.85,
      "NIH и Mayo Clinic: дозы 1000–3000+ мг/сут небезопасны для всех — возможны диарея, гастродуоденальные симптомы, риск оксалатных камней у предрасположенных; верхний допустимый уровень 2000 мг/сут.",
      [],
      ["e4", "e8"],
      ["s2", "s4"],
    ),
    mkVerdict(
      "c4",
      "FALSE",
      0.94,
      "Опасное утверждение: CDC прямо называет вакцинацию основной мерой профилактики гриппа, FDA запрещает позиционировать БАДы как средства профилактики болезней. Доказательств «замены» не существует.",
      [],
      ["e6", "e11"],
      ["s3", "s5"],
    ),
    mkVerdict(
      "c5",
      "MISLEADING",
      0.8,
      "Фармакокинетически неверно: всасываемость снижается уже при ~200 мг/сут, избыток выводится почками, а высокие дозы несут риски (см. C-03). Утверждение подаёт линейную зависимость там, где её нет.",
      [],
      ["e5"],
      ["s2", "s4"],
    ),
  ],
  report: mkReport(
    "demo-vitamin-c",
    "LIKELY_FALSE",
    0.85,
    "Материал сочетает одно подтверждённое утверждение (C-02, −8% длительности) с четырьмя искажёнными или ложными (C-01, C-03–C-05). Это характерная структура недобросовестной публикации: реальный научный факт используется как «якорь доверия» для обоснования неверных выводов. Публикация содержит партнёрские ссылки на магазин витаминов — конфликт интересов.",
    "Исследовательский режим: 5 утверждений, 7 источников (6 из доверенного реестра), 11 фрагментов доказательств, поиск контраргументов выполнен. Коммерческий источник учтён с минимальным весом из-за конфликта интересов.",
    "Оценка профилактического эффекта относится к общей популяции; для людей при экстремальных физических нагрузках эффект доказан, но в материале эта оговорка отсутствует.",
  ),
};

/* ------------------------------------------------------------------ */
/* Сценарий 3 — рекламный фейк про магнитный браслет                    */
/* ------------------------------------------------------------------ */

const braceletResult: AnalysisResult = {
  projectId: "demo-magnetic-bracelet",
  url: "https://zdorovie-magnit.ru/catalog/braslet-magnetwell-davlenie",
  mode: "CONTROLLED",
  modelInfo: "Демо-режим · зафиксированный прогон",
  createdAt: "2026-11-10T10:24:00.000Z",
  status: "completed",
  revision: 0,
  document: {
    url: "https://zdorovie-magnit.ru/catalog/braslet-magnetwell-davlenie",
    title: "Магнитный браслет MagnetWell: нормализует давление без лекарств",
    excerpt:
      "Запатентованная технология воздействия статического магнитного поля на кровоток — давление нормализуется за 2 недели ношения. Клинически подтверждено. Забудьте о таблетках!",
    contentNature: "ADVERTISEMENT",
  },
  claims: [
    mkClaim(
      "c1",
      "Статическое магнитное поле браслета нормализует артериальное давление",
      "MEDICAL_FACT",
      0.95,
    ),
    mkClaim(
      "c2",
      "Клинические испытания подтвердили эффективность магнитных браслетов при гипертонии",
      "EFFICACY_CLAIM",
      0.95,
    ),
    mkClaim(
      "c3",
      "Магнитный браслет может заменить гипотензивные препараты",
      "TREATMENT_CLAIM",
      1.0,
    ),
    mkClaim(
      "c4",
      "Эффект объясняется воздействием магнитного поля на ионы железа в гемоглобине",
      "SCIENTIFIC_CLAIM",
      0.75,
    ),
    mkClaim(
      "c5",
      "Поскольку браслет не содержит лекарств, он полностью безопасен",
      "SAFETY_CLAIM",
      0.8,
    ),
  ],
  sources: [
    mkSource("s1", {
      url: "https://www.heart.org/en/health-topics/high-blood-pressure",
      title: "High Blood Pressure — American Heart Association",
      org: "American Heart Association",
      type: "SPECIALIZED_MEDICAL",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.92, methodology: 0.85, relevance: 0.9, overall: 0.88 }),
      excerpt:
        "Обоснованное лечение гипертонии — изменение образа жизни и назначенные препараты; магнитная терапия в рекомендациях отсутствует.",
    }),
    mkSource("s2", {
      url: "https://www.fda.gov/consumers/health-fraud-scams",
      title: "Health Fraud Scams — FDA",
      org: "FDA",
      type: "REGULATOR",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.96, methodology: 0.84, relevance: 0.88, overall: 0.9 }),
      excerpt:
        "FDA предупреждала продавцов магнитных изделий о недопустимости заявлений о лечении заболеваний; магнитные «лечебные» браслеты — типичный объект таких предупреждений.",
    }),
    mkSource("s3", {
      url: "https://www.nhs.uk/conditions/high-blood-pressure-hypertension/",
      title: "High blood pressure (hypertension) — NHS",
      org: "NHS",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.94, methodology: 0.85, relevance: 0.9, overall: 0.9 }),
      excerpt: "Гипертонию контролируют образом жизни и лекарственной терапией; методы без доказательной базы не рекомендуются.",
    }),
    mkSource("s4", {
      url: "https://www.who.int/news-room/fact-sheets/detail/hypertension",
      title: "Hypertension — WHO Fact Sheet",
      org: "ВОЗ",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.97, methodology: 0.88, relevance: 0.92, overall: 0.93 }),
      excerpt: "Неконтролируемая гипертония — ведущий предотвратимый фактор смертности; лечение — образ жизни и медикаменты.",
    }),
    mkSource("s5", {
      url: "https://pubmed.ncbi.nlm.nih.gov/?term=static+magnetic+therapy+blood+pressure",
      title: "Статические магнитные поля и кровяное давление — сводка исследований PubMed",
      org: "PubMed",
      type: "NARRATIVE_REVIEW",
      tier: 3,
      trusted: true,
      quality: mkQuality({ authority: 0.9, methodology: 0.78, relevance: 0.9, overall: 0.8 }),
      excerpt:
        "Слепые рандомизированные исследования статических магнитных браслетов не показывают преимущества над плацебо по объективным показателям.",
    }),
    mkSource("s6", {
      url: "https://zdorovie-magnit.ru/catalog/braslet-magnetwell-davlenie",
      title: "Магнитный браслет MagnetWell — страница товара",
      org: "zdorovie-magnit.ru",
      type: "ADVERTISEMENT",
      tier: 8,
      trusted: false,
      quality: mkQuality({
        authority: 0.15,
        methodology: 0.05,
        relevance: 0.75,
        independence: 0.1,
        transparency: 0.2,
        overall: 0.22,
      }),
      excerpt: "«Клинически подтверждено», «вместо таблеток» — маркетинговые заявления; в качестве «доказательств» приведены отзывы покупателей.",
    }),
    mkSource("s7", {
      url: "https://www.nhlbi.nih.gov/health/high-blood-pressure",
      title: "High Blood Pressure — NHLBI (NIH)",
      org: "NIH / NHLBI",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.85, relevance: 0.9, overall: 0.9 }),
      excerpt: "Физиология и лечение гипертонии; немедикаментозные методы с доказанной эффективностью перечислены — магнитотерапия отсутствует.",
    }),
    mkSource("s8", {
      url: "https://www.mayoclinic.org/diseases-conditions/high-blood-pressure",
      title: "High blood pressure — Mayo Clinic",
      org: "Mayo Clinic",
      type: "SPECIALIZED_MEDICAL",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.9, methodology: 0.82, relevance: 0.88, overall: 0.86 }),
      excerpt: "Задержка начала доказательного лечения гипертонии повышает риск инсульта, инфаркта и поражения органов-мишеней.",
    }),
  ],
  evidence: [
    mkEvidence("e1", "c1", "s1", "Рекомендации AHA по лечению гипертонии не содержат магнитотерапию; обоснованные меры — образ жизни и препараты.", "CONTRADICTS", 0.92, 0.87, "GUIDELINE_STATEMENT"),
    mkEvidence("e2", "c2", "s5", "Слепые рандомизированные исследования статических магнитных браслетов не показали преимущества над плацебо.", "CONTRADICTS", 0.9, 0.85, "RCT_SUMMARY"),
    mkEvidence("e3", "c1", "s3", "NHS: методы без доказательной базы для контроля давления не рекомендуются.", "CONTRADICTS", 0.9, 0.86, "HEALTH_SERVICE"),
    mkEvidence("e4", "c3", "s4", "ВОЗ: неконтролируемая гипертония — ведущий фактор смертности; отказ от терапии резко повышает риск инсульта и инфаркта.", "CONTRADICTS", 0.97, 0.93, "GUIDELINE_STATEMENT"),
    mkEvidence("e5", "c1", "s6", "Страница товара утверждает «клинически подтверждено» без указания исследований; конфликт интересов.", "SUPPORTS", 0.7, 0.3, "MARKETING"),
    mkEvidence("e6", "c2", "s6", "«Клинические подтверждения» на странице — отзывы покупателей, а не испытания.", "SUPPORTS", 0.65, 0.25, "MARKETING"),
    mkEvidence("e7", "c2", "s1", "AHA: эффективность метода подтверждается только рандомизированными слепыми испытаниями; для магнитных браслетов таких данных нет.", "CONTRADICTS", 0.92, 0.88, "GUIDELINE_STATEMENT"),
    mkEvidence("e8", "c4", "s7", "Оксигенированный гемоглобин диамагнитен; слабое статическое поле браслета не влияет на кровоток — физиологическое объяснение несостоятельно.", "CONTRADICTS", 0.85, 0.84, "PHYSIOLOGY"),
    mkEvidence("e9", "c5", "s8", "Прямой вред от ношения мал, однако перенос ожиданий на браслет откладывает визит к врачу — документированный непрямой вред.", "CONTRADICTS", 0.84, 0.8, "CLINICAL_REFERENCE"),
    mkEvidence("e10", "c1", "s2", "FDA предупреждала продавцов магнитных изделий за заявления о лечении заболеваний.", "CONTRADICTS", 0.9, 0.9, "REGULATORY"),
    mkEvidence("e11", "c1", "s4", "ВОЗ: контроль гипертонии строится на образе жизни и медикаментах; «магнитные» методы в перечне отсутствуют.", "CONTRADICTS", 0.93, 0.88, "GUIDELINE_STATEMENT"),
    mkEvidence("e12", "c4", "s8", "Объяснение через «ионы железа» противоречит базовой физиологии: железо гемоглобина не обеспечивает магнитный отклик, доступный бытовому браслету.", "CONTRADICTS", 0.82, 0.82, "PHYSIOLOGY"),
    mkEvidence("e13", "c3", "s4", "ВОЗ: отказ от медикаментозной терапии гипертонии — прямой путь к инсульту, инфаркту и поражению органов-мишеней; замена лекарств бижутерией недопустима.", "CONTRADICTS", 0.95, 0.94, "GUIDELINE_STATEMENT"),
    mkEvidence("e14", "c3", "s8", "Mayo Clinic: задержка начала доказательного лечения гипертонии документированно повышает риск сердечно-сосудистых событий.", "CONTRADICTS", 0.88, 0.86, "CLINICAL_REFERENCE"),
  ],
  verdicts: [
    mkVerdict(
      "c1",
      "FALSE",
      0.9,
      "Утверждение противоречит клиническим рекомендациям AHA, NHS и ВОЗ; FDA предупреждала продавцов магнитных изделий за лечение заболеваний. Единственный «поддерживающий» источник — сам продающий сайт.",
      [],
      ["e1", "e3", "e10", "e11"],
      ["s1", "s2", "s3", "s4"],
    ),
    mkVerdict(
      "c2",
      "FALSE",
      0.92,
      "Слепые РКИ не показывают преимущества статических магнитов над плацебо; «клиническими подтверждениями» на странице товара служат отзывы покупателей. Критерий ≥2 независимых релевантных источников не выполнен ни одним «за».",
      [],
      ["e2", "e7"],
      ["s1", "s5"],
    ),
    mkVerdict(
      "c3",
      "FALSE",
      0.95,
      "Опасное утверждение: отказ от гипотензивной терапии при неконтролируемой гипертонии резко повышает риск инсульта и инфаркта (ВОЗ, Mayo Clinic). Утверждение распространяет прямой вред здоровью.",
      [],
      ["e4", "e13", "e14"],
      ["s4", "s8"],
    ),
    mkVerdict(
      "c4",
      "FALSE",
      0.89,
      "Псевдонаучное объяснение: оксигенированный гемоглобин диамагнитен, а поле бытового браслета слишком слабо для какого-либо воздействия на кровоток.",
      [],
      ["e8", "e12"],
      ["s7", "s8"],
    ),
    mkVerdict(
      "c5",
      "MISLEADING",
      0.78,
      "Формально браслет не токсичен, но утверждение маскирует непрямой вред: ожидание эффекта откладывает начало доказательного лечения гипертонии.",
      [],
      ["e9"],
      ["s3", "s8"],
    ),
  ],
  report: mkReport(
    "demo-magnetic-bracelet",
    "FALSE",
    0.91,
    "Все ключевые утверждения страницы опровергнуты клиническими рекоменданиями (AHA, NHS, ВОЗ, NHLBI) и регуляторными предупреждениями FDA. Материал является рекламным и потенциально опасным: подталкивает к замене гипотензивной терапии бижутерией. Единственный «поддерживающий» источник — сам продающий сайт.",
    "Контролируемый режим: 5 утверждений, 8 источников из доверенного реестра, 14 фрагментов доказательств. Поиск контраргументов не выполнялся — все утверждения опровергнуты прямыми данными реестра.",
    "Проверка не заменяет медицинскую консультацию: при решении о лечении гипертонии следует руководствоваться рекомендациями лечащего врача.",
  ),
};

/* ------------------------------------------------------------------ */
/* Сценарий 4 — коллаген для кожи: недостаточно данных                  */
/* ------------------------------------------------------------------ */

const collagenResult: AnalysisResult = {
  projectId: "demo-collagen-skin",
  url: "https://beauty-science.ru/statji/kollagen-dlya-kozhi-chto-govoryat-issledovaniya",
  mode: "RESEARCH",
  modelInfo: "Демо-режим · зафиксированный прогон",
  createdAt: "2026-11-10T10:24:00.000Z",
  status: "completed",
  revision: 0,
  document: {
    url: "https://beauty-science.ru/statji/kollagen-dlya-kozhi-chto-govoryat-issledovaniya",
    title: "Коллаген для кожи: что действительно говорят исследования",
    excerpt:
      "Разбираем, работают ли добавки коллагена для упругости кожи и борьбы с морщинами — и почему результаты исследований пока не позволяют дать однозначный ответ.",
    contentNature: "INFORMATION",
  },
  claims: [
    mkClaim(
      "c1",
      "Приём гидролизованного коллагена улучшает эластичность кожи и снижает глубину морщин",
      "EFFICACY_CLAIM",
      0.9,
    ),
    mkClaim(
      "c2",
      "Клинические исследования доказали эффективность коллагена для кожи",
      "EFFICACY_CLAIM",
      0.85,
    ),
    mkClaim(
      "c3",
      "Добавки коллагена безопасны при длительном приёме",
      "SAFETY_CLAIM",
      0.7,
    ),
  ],
  sources: [
    mkSource("s1", {
      url: "https://pubmed.ncbi.nlm.nih.gov/32589362/",
      title: "Bolke L. et al. A Collagen Supplement Improves Skin Hydration (Nutrients, 2019)",
      org: "PubMed",
      type: "RCT",
      tier: 3,
      trusted: true,
      quality: mkQuality({ authority: 0.75, methodology: 0.55, relevance: 0.85, independence: 0.4, transparency: 0.6, overall: 0.58 }),
      excerpt:
        "Небольшое РКИ (n=72, 12 недель): умеренное улучшение гидратации и эластичности. Спонсировано производителем коллагена; слепой метод соблюдён частично.",
    }),
    mkSource("s2", {
      url: "https://ods.od.nih.gov/factsheets/Collagen/",
      title: "Collagen — информационная страница NIH ODS",
      org: "NIH Office of Dietary Supplements",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.96, methodology: 0.85, relevance: 0.9, overall: 0.89 }),
      excerpt:
        "Доказательства пользы коллагена для кожи ограничены малыми исследованиями, многие из которых профинансированы производителями. Независимых крупных РКИ недостаточно.",
    }),
    mkSource("s3", {
      url: "https://www.fda.gov/food/dietary-supplements",
      title: "Dietary Supplements — FDA",
      org: "FDA",
      type: "REGULATOR",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.82, relevance: 0.7, overall: 0.8 }),
      excerpt: "БАДы не проходят предварительную проверку эффективности; заявления о «доказанном эффекте» требуют клинических данных, которых для коллагена недостаточно.",
    }),
    mkSource("s4", {
      url: "https://pubmed.ncbi.nlm.nih.gov/34718780/",
      title: "de Miranda R.B. et al. Effects of hydrolyzed collagen on skin (Int J Dermatol, 2021)",
      org: "PubMed",
      type: "SYSTEMATIC_REVIEW",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.88, methodology: 0.8, relevance: 0.88, independence: 0.6, transparency: 0.75, overall: 0.75 }),
      excerpt:
        "Систематический обзор 19 исследований: положительная тенденция по эластичности и гидратации, но большинство исследований малы, коротки и спонсированы индустрией. Авторы прямо называют доказательства недостаточными.",
    }),
    mkSource("s5", {
      url: "https://www.aad.org/public/diseases/a-z/collagen-supplements",
      title: "Collagen supplements — American Academy of Dermatology",
      org: "American Academy of Dermatology",
      type: "SPECIALIZED_MEDICAL",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.9, methodology: 0.8, relevance: 0.85, overall: 0.83 }),
      excerpt:
        "AAD: потенциальная польза возможна, но качество доказательств остаётся низким; независимых данных высокого уровня нет. Топические ретиноиды и солнцезащита имеют более сильную базу.",
    }),
    mkSource("s6", {
      url: "https://beauty-pills.ru/shop/kollagen-premium",
      title: "Коллаген Премиум — страница магазина",
      org: "beauty-pills.ru",
      type: "COMMERCIAL",
      tier: 7,
      trusted: false,
      quality: mkQuality({ authority: 0.2, methodology: 0.1, relevance: 0.65, independence: 0.15, transparency: 0.3, overall: 0.25 }),
      excerpt: "«Клинически доказанный эффект за 4 недели» — маркетинговое заявление; ссылок на независимые исследования нет.",
    }),
  ],
  evidence: [
    mkEvidence("e1", "c1", "s1", "РКИ (n=72): улучшение гидратации и эластичности кожи через 12 недель приёма; эффект умеренный, выборка мала.", "SUPPORTS", 0.8, 0.55, "RCT_RESULT"),
    mkEvidence("e2", "c1", "s4", "Систематический обзор 19 РКИ: положительная тенденция, но большинство исследований малы, коротки и спонсированы индустрией; доказательства недостаточны.", "NEUTRAL", 0.85, 0.6, "SYSTEMATIC_REVIEW"),
    mkEvidence("e3", "c1", "s2", "NIH: доказательства ограничены малыми исследованиями с конфликтом интересов; независимых крупных РКИ недостаточно.", "NEUTRAL", 0.88, 0.7, "GOVERNMENT_ASSESSMENT"),
    mkEvidence("e4", "c2", "s4", "Обзор фиксирует «положительную тенденцию», но прямо не подтверждает эффективность — формулировка «доказали» завышает уровень уверенности.", "CONTRADICTS", 0.82, 0.62, "SYSTEMATIC_REVIEW"),
    mkEvidence("e5", "c2", "s3", "FDA: БАДы не проверяются на эффективность до выхода на рынок; заявление «клинически доказано» требует данных, которых нет.", "CONTRADICTS", 0.78, 0.65, "REGULATORY"),
    mkEvidence("e6", "c3", "s2", "NIH: при обычных дозах выраженных рисков не зафиксировано, но долгосрочных независимых данных о безопасности также мало.", "SUPPORTS", 0.7, 0.5, "GOVERNMENT_ASSESSMENT"),
    mkEvidence("e7", "c1", "s5", "AAD: качество доказательств низкое; более надёжные стратегии профилактики старения кожи — ретиноиды и фотозащита.", "NEUTRAL", 0.8, 0.55, "EXPERT_REVIEW"),
    mkEvidence("e8", "c2", "s6", "Магазин заявляет «клинически доказанный эффект», не приводя независимых исследований; прямой конфликт интересов.", "SUPPORTS", 0.6, 0.25, "MARKETING"),
  ],
  verdicts: [
    {
      ...mkVerdict(
        "c1",
        "INSUFFICIENT_EVIDENCE",
        0.55,
        "Существующие РКИ показывают положительную тенденцию, но они малы, коротки и в большинстве спонсированы производителями коллагена. Независимых крупных исследований недостаточно, чтобы подтвердить или опровергнуть эффект.",
        ["e1"],
        [],
        ["s1", "s4"],
      ),
      insufficient_reason:
        "Релевантных независимых источников верхнего уровня недостаточно (найдено 1 малое РКИ с конфликтом интересов); остальные данные — обзоры с явлением недостаточности доказательств.",
    },
    {
      ...mkVerdict(
        "c2",
        "MISLEADING",
        0.72,
        "Формулировка «клинические исследования доказали» завышает уровень уверенности: систематический обзор фиксирует лишь тенденцию и прямо называет доказательства недостаточными. Такой язык типичен для маркетинга БАД.",
        [],
        ["e4", "e5"],
        ["s3", "s4"],
      ),
    },
    {
      ...mkVerdict(
        "c3",
        "INSUFFICIENT_EVIDENCE",
        0.5,
        "Явных сигналов вреда при обычных дозах нет, но долгосрочных независимых исследований безопасности также недостаточно — уверенное заявление о безопасности преждевременно.",
        ["e6"],
        [],
        ["s2"],
      ),
      insufficient_reason:
        "Долгосрочные независимые данные о безопасности отсутствуют; имеющиеся наблюдения не позволяют ни подтвердить, ни опровергнуть заявление.",
    },
  ],
  report: mkReport(
    "demo-collagen-skin",
    "INSUFFICIENT_EVIDENCE",
    0.58,
    "Проверка не смогла ни подтвердить, ни опровергнуть основные заявления материала. Имеющиеся исследования коллагена для кожи показывают положительную тенденцию, но малы по объёму, коротки по длительности и в большинстве профинансированы производителями. Независимых крупных РКИ недостаточно. Формулировка «клинически доказано» в статье завышает уровень уверенности — система отметила это как вводящее в заблуждение.",
    "Исследовательский режим: 3 утверждения, 6 источников (5 из доверенного реестра), 8 фрагментов доказательств, поиск контраргументов выполнен. Два утверждения получили вердикт «Недостаточно данных» — сработал порог минимального числа независимых релевантных источников.",
    "Отсутствие вердикта — тоже результат: тема находится в зоне активных, но незавершённых исследований. При появлении независимых крупных РКИ вердикт может измениться в любую сторону.",
  ),
};

/* ------------------------------------------------------------------ */
/* Сценарий 5 — прерывистое голодание: частично верно                   */
/* ------------------------------------------------------------------ */

const fastingResult: AnalysisResult = {
  projectId: "demo-intermittent-fasting",
  url: "https://fitlife.ru/blog/intervalnoe-golodanie-polnyy-gid",
  mode: "RESEARCH",
  modelInfo: "Демо-режим · зафиксированный прогон",
  createdAt: "2026-11-10T10:24:00.000Z",
  status: "completed",
  revision: 0,
  document: {
    url: "https://fitlife.ru/blog/intervalnoe-golodanie-polnyy-gid",
    title: "Интервальное голодание: полный гид по методу 16/8",
    excerpt:
      "Всё об интервальном голодании: как оно помогает худеть, «запускает аутофагию», ускоряет метаболизм и подходит ли оно всем — разбор с опорой на научные данные.",
    contentNature: "INFORMATION",
  },
  claims: [
    mkClaim(
      "c1",
      "Интервальное голодание помогает снижать вес не хуже, чем обычное ограничение калорий",
      "EFFICACY_CLAIM",
      0.9,
    ),
    mkClaim(
      "c2",
      "Голодание «запускает аутофагию», которая предотвращает развитие рака у человека",
      "CAUSAL_CLAIM",
      0.85,
    ),
    mkClaim(
      "c3",
      "Интервальное голодание ускоряет обмен веществ",
      "MEDICAL_FACT",
      0.8,
    ),
    mkClaim(
      "c4",
      "Метод 16/8 безопасен для всех взрослых без исключений",
      "SAFETY_CLAIM",
      0.85,
    ),
  ],
  sources: [
    mkSource("s1", {
      url: "https://www.nejm.org/doi/full/10.1056/NEJMra1905136",
      title: "de Cabo R., Mattson M.P. Effects of Intermittent Fasting on Health (NEJM, 2019)",
      org: "New England Journal of Medicine",
      type: "NARRATIVE_REVIEW",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.95, methodology: 0.85, relevance: 0.92, overall: 0.88 }),
      excerpt:
        "Обзор: интервальное голодание сопоставимо по эффективности с непрерывным ограничением калорий; данные об аутофагии у человека предварительные. Эффект на метаболизм в покое не подтверждён.",
    }),
    mkSource("s2", {
      url: "https://pubmed.ncbi.nlm.nih.gov/36235891/",
      title: "Lowe D.A. et al. Effects of Time-Restricted Eating on Weight Loss (NEJM, 2022)",
      org: "PubMed",
      type: "RCT",
      tier: 2,
      trusted: true,
      quality: mkQuality({ authority: 0.93, methodology: 0.9, relevance: 0.95, overall: 0.9 }),
      excerpt:
        "РКИ (n=139, 12 месяцев): ограничение времени приёма пищи не дало значимого преимущества в снижении веса по сравнению с обычным ограничением калорий.",
    }),
    mkSource("s3", {
      url: "https://www.who.int/news-room/fact-sheets/detail/cancer",
      title: "Cancer — информационный бюллетень ВОЗ",
      org: "Всемирная организация здравоохранения",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.97, methodology: 0.85, relevance: 0.65, overall: 0.8 }),
      excerpt: "Подтверждённые факторы профилактики рака не включают интервальное голодание; данные об аутофагии у человека экспериментальные.",
    }),
    mkSource("s4", {
      url: "https://www.niddk.nih.gov/health-information/dieting-thruths",
      title: "Dieting and Metabolism — NIDDK (NIH)",
      org: "NIH / NIDDK",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.94, methodology: 0.85, relevance: 0.88, overall: 0.87 }),
      excerpt: "Голодание не «ускоряет метаболизм»; длительное ограничение калорий может замедлять базовый обмен — адаптивный термогенез.",
    }),
    mkSource("s5", {
      url: "https://www.nhs.uk/live-well/eat-well/food-types/intermittent-fasting/",
      title: "Intermittent fasting — NHS",
      org: "NHS",
      type: "GOVERNMENT_AUTHORITY",
      tier: 1,
      trusted: true,
      quality: mkQuality({ authority: 0.93, methodology: 0.82, relevance: 0.85, overall: 0.85 }),
      excerpt: "Интервальное голодание не подходит беременным, людям с диабетом на терапии, расстройствами пищевого поведения и подросткам без консультации врача.",
    }),
    mkSource("s6", {
      url: "https://fitlife.ru/blog/intervalnoe-golodanie-polnyy-gid",
      title: "Интервальное голодание: полный гид — исходная статья",
      org: "fitlife.ru",
      type: "BLOG",
      tier: 6,
      trusted: false,
      quality: mkQuality({ authority: 0.35, methodology: 0.25, relevance: 0.8, independence: 0.7, transparency: 0.4, overall: 0.4 }),
      excerpt: "Автор блога продаёт курс по интервальному голоданию — коммерческий интерес; раздел о противопоказаниях отсутствует.",
    }),
  ],
  evidence: [
    mkEvidence("e1", "c1", "s2", "РКИ (n=139, 12 месяцев): интервальное голодание и обычное ограничение калорий дали сопоставимое снижение веса; значимой разницы нет.", "SUPPORTS", 0.93, 0.9, "RCT_RESULT"),
    mkEvidence("e2", "c1", "s1", "Обзор NEJM: эффективность интервального голодания сопоставима с непрерывным ограничением калорий.", "SUPPORTS", 0.88, 0.82, "NARRATIVE_REVIEW"),
    mkEvidence("e3", "c2", "s1", "Данные об аутофагии получены преимущественно на животных моделях; у человека эффект предварительный, клинических подтверждений профилактики рака нет.", "CONTRADICTS", 0.85, 0.78, "NARRATIVE_REVIEW"),
    mkEvidence("e4", "c2", "s3", "ВОЗ не включает интервальное голодание в перечень подтверждённых мер профилактики рака.", "CONTRADICTS", 0.82, 0.75, "GUIDELINE_STATEMENT"),
    mkEvidence("e5", "c3", "s4", "NIH: голодание не ускоряет метаболизм; длительное ограничение калорий может замедлять базовый обмен (адаптивный термогенез).", "CONTRADICTS", 0.9, 0.85, "GOVERNMENT_ASSESSMENT"),
    mkEvidence("e6", "c4", "s5", "NHS: интервальное голодание противопоказано беременным, людям с диабетом на терапии, расстройствами пищевого поведения и подросткам.", "CONTRADICTS", 0.92, 0.88, "HEALTH_SERVICE"),
    mkEvidence("e7", "c4", "s6", "В исходной статье раздел о противопоказаниях отсутствует — автор продаёт курс по голоданию.", "CONTRADICTS", 0.7, 0.55, "CONFLICT_OF_INTEREST"),
    mkEvidence("e8", "c2", "s6", "Автор блога утверждает, что «аутофагия очищает клетки от рака», ссылаясь на нобелевскую премию Осуми — механизм существует, но экстраполяция на профилактику рака у человека не обоснована.", "SUPPORTS", 0.6, 0.3, "MARKETING"),
  ],
  verdicts: [
    mkVerdict(
      "c1",
      "VERIFIED",
      0.88,
      "РКИ в NEJM (n=139, 12 месяцев) и обзор NEJM сходятся: интервальное голодание сопоставимо по эффективности с обычным ограничением калорий. Утверждение корректно — заметим, что оно скромнее типичного маркетингового «голодание лучше диет».",
      ["e1", "e2"],
      [],
      ["s1", "s2"],
    ),
    mkVerdict(
      "c2",
      "LIKELY_FALSE",
      0.8,
      "Механизм аутофагии реален (Нобелевская премия 2016), но данные о профилактике рака у человека отсутствуют: выводы сделаны на животных моделях. ВОЗ не включает голодание в меры профилактики рака. Экстраполяция с мышей на людей научно некорректна.",
      [],
      ["e3", "e4"],
      ["s1", "s3"],
    ),
    mkVerdict(
      "c3",
      "FALSE",
      0.87,
      "Прямо противоречит данным NIH: голодание не ускоряет метаболизм, а длительное ограничение калорий может его замедлять (адаптивный термогенез). Потеря веса при голодании объясняется снижением потребления калорий, а не «разгоном» обмена.",
      [],
      ["e5"],
      ["s4"],
    ),
    mkVerdict(
      "c4",
      "LIKELY_FALSE",
      0.85,
      "NHS перечисляет группы, для которых интервальное голодание небезопасно или требует врачебной консультации: беременные, люди с диабетом на терапии, расстройствами пищевого поведения, подростки. В статье противопоказания не упомянуты — автор продаёт курс.",
      [],
      ["e6", "e7"],
      ["s5", "s6"],
    ),
  ],
  report: mkReport(
    "demo-intermittent-fasting",
    "PARTIALLY_TRUE",
    0.84,
    "Материал частично достоверен: утверждение о сопоставимой с диетами эффективности голодания подтверждено РКИ и обзором NEJM. Однако три ключевых заявления искажают науку: аутофагия как профилактика рака у человека не подтверждена (данные только на животных), «ускорение метаболизма» противоречит данным NIH, а заявление о безопасности для всех игнорирует противопоказания из NHS. Статья продаёт курс по голоданию — коммерческий интерес.",
    "Исследовательский режим: 4 утверждения, 6 источников (5 из доверенного реестра), 8 фрагментов доказательств, поиск контраргументов выполнен. Смешанный вердикт отражён в стековом баре распределения.",
    "Утверждение C-02 касается активно исследуемой темы: при появлении клинических данных об аутофагии у человека вердикт может быть пересмотрен.",
  ),
};

/* ------------------------------------------------------------------ */
/* Реестр сценариев                                                     */
/* ------------------------------------------------------------------ */

const hpvScenario: DemoScenario = {
  id: "hpv-vaccine",
  title: "Вакцинация против ВПЧ",
  host: "zdravinfo.ru",
  description: "Материал о защите от рака шейки матки — добротная публицистика, близкая к научному консенсусу.",
  expectedVerdict: "Скорее правда",
  result: hpvResult,
  timeline: buildTimeline({
    mode: "RESEARCH",
    chars: 12480,
    queries: 7,
    rawResults: 18,
    searchLogs: [
      'Поиск: «ВПЧ 16 18 рак шейки матки» → 6 результатов',
      'Поиск: «HPV vaccine efficacy Cochrane» → 4 результата',
      'Поиск: «ВПЧ-вакцина безопасность РКИ» → 8 результатов',
    ],
    sourcesBeforeAdversarial: hpvResult.sources.filter((s) => s.id !== "s8"),
    adversarial: { results: 4 },
    adversarialLog: "Контраргументы: 4 результата, 1 релевантный (оценка качества — низкая)",
    evidenceCount: hpvResult.evidence.length,
    overallLabelRu: "Скорее правда",
    projectId: hpvResult.projectId,
    result: hpvResult,
  }),
};

const vitaminCScenario: DemoScenario = {
  id: "vitamin-c",
  title: "Витамин C против простуды",
  host: "natural-medic.ru",
  description: "Смесь верных и искажённых данных о высоких дозах витамина C — с партнёрскими ссылками на магазин.",
  expectedVerdict: "Скорее ложь",
  result: vitaminCResult,
  timeline: buildTimeline({
    mode: "RESEARCH",
    chars: 9310,
    queries: 8,
    rawResults: 22,
    searchLogs: [
      'Поиск: «витамин C профилактика простуды РКИ» → 9 результатов',
      'Поиск: «vitamin C common cold Cochrane» → 5 результатов',
      'Поиск: «высокие дозы витамина C безопасность» → 8 результатов',
    ],
    sourcesBeforeAdversarial: vitaminCResult.sources.filter((s) => s.id !== "s7"),
    adversarial: { results: 3 },
    adversarialLog: "Контраргументы: 3 результата, учтён источник с конфликтом интересов (вес снижен)",
    evidenceCount: vitaminCResult.evidence.length,
    overallLabelRu: "Вводит в заблуждение",
    projectId: vitaminCResult.projectId,
    result: vitaminCResult,
  }),
};

const braceletScenario: DemoScenario = {
  id: "magnetic-bracelet",
  title: "Магнитный браслет от давления",
  host: "zdorovie-magnit.ru",
  description: "Рекламная страница с недостоверными медицинскими заявлениями и призывом отказаться от лекарств.",
  expectedVerdict: "Недостоверно",
  result: braceletResult,
  timeline: buildTimeline({
    mode: "CONTROLLED",
    chars: 4120,
    queries: 5,
    rawResults: 14,
    searchLogs: [
      'Поиск: «магнитный браслет артериальное давление РКИ» → 6 результатов',
      'Поиск: «static magnets hypertension trial» → 8 результатов',
    ],
    adversarial: null, // CONTROLLED — фаза честно помечается как пропущенная
    evidenceCount: braceletResult.evidence.length,
    overallLabelRu: "Недостоверно",
    projectId: braceletResult.projectId,
    result: braceletResult,
  }),
};

const collagenScenario: DemoScenario = {
  id: "collagen-skin",
  title: "Коллаген для кожи",
  host: "beauty-science.ru",
  description: "Добавки коллагена: малые спонсированные исследования, независимых данных недостаточно.",
  expectedVerdict: "Недостаточно данных",
  result: collagenResult,
  timeline: buildTimeline({
    mode: "RESEARCH",
    chars: 7830,
    queries: 6,
    rawResults: 15,
    searchLogs: [
      'Поиск: «коллаген добавки кожа эластичность РКИ» → 7 результатов',
      'Поиск: «hydrolyzed collagen skin RCT» → 5 результатов',
      'Поиск: «коллаген независимые исследования безопасность» → 3 результата',
    ],
    sourcesBeforeAdversarial: collagenResult.sources.filter((s) => s.id !== "s6"),
    adversarial: { results: 3 },
    adversarialLog: "Контраргументы: 3 результата, учтён источник с конфликтом интересов (вес снижен)",
    evidenceCount: collagenResult.evidence.length,
    overallLabelRu: "Недостаточно данных",
    projectId: collagenResult.projectId,
    result: collagenResult,
  }),
};

const fastingScenario: DemoScenario = {
  id: "intermittent-fasting",
  title: "Интервальное голодание",
  host: "fitlife.ru",
  description: "Гид по методу 16/8: часть фактов подтверждена РКИ, часть — маркетинговые упрощения.",
  expectedVerdict: "Частично правда",
  result: fastingResult,
  timeline: buildTimeline({
    mode: "RESEARCH",
    chars: 10250,
    queries: 7,
    rawResults: 19,
    searchLogs: [
      'Поиск: «интервальное голодание снижение веса РКИ» → 8 результатов',
      'Поиск: «intermittent fasting weight loss trial» → 6 результатов',
      'Поиск: «аутофагия голодание рак человек доказательства» → 5 результатов',
    ],
    sourcesBeforeAdversarial: fastingResult.sources.filter((s) => s.id !== "s6"),
    adversarial: { results: 4 },
    adversarialLog: "Контраргументы: 4 результата, включая данные об адаптивном термогенезе",
    evidenceCount: fastingResult.evidence.length,
    overallLabelRu: "Частично правда",
    projectId: fastingResult.projectId,
    result: fastingResult,
  }),
};

export const DEMO_SCENARIOS: DemoScenario[] = [
  hpvScenario,
  fastingScenario,
  vitaminCScenario,
  collagenScenario,
  braceletScenario,
];

export function getDemoScenario(id: string): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((s) => s.id === id);
}
