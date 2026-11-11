# Changelog

Все заметные изменения проекта Factum документируются здесь. Формат
основан на [Keep a Changelog](https://keepachangelog.com/), версияing —
[Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-11-11

### Added
- Полный пайплайн проверки фактов: URL/текст → утверждения → источники →
  доказательства → вердикты → отчёт, с SSE-стримингом стадий.
- Аутентификация: логин/пароль (scrypt + 16-байтовый salt, timing-safe),
  подписанная HMAC-SHA256 сессионная кука (Edge-safe, Web Crypto),
  роли `admin`/`user`, баны с перепроверкой в БД на каждом API-вызове.
- Версионирование вердиктов: при добавлении источника пользователем
  вердикт пересчитывается, предыдущая версия сохраняется.
- Чат с контекстом анализа (вопросы по источникам и утверждениям).
- Markdown-экспорт отчёта с журналом аудита и печать в PDF.
- Аудит-трейл каждой стадии (orchestrator → claims → sources → evidence
  → verdicts → report).
- SSRF-фильтр `validateUrl()`: блок file/ftp/gopher/data/blob/javascript,
  приватных IPv4/IPv6, link-local, CGNAT, multicast, cloud-metadata
  endpoints (AWS/GCP/Azure), `.internal`/`.local`/`.localhost`,
  userinfo-credentials; ручная обработка редиректов с ревалидацией.
- Open-redirect-фильтр `safeInternalPath()` на `/login?next=`.
- Rate-limiting: `/api/login` 10/15мин/IP, `/api/analyze` 4/час/IP,
  `/api/chat` 40/час/IP, `/api/history/[id]/sources` 6/час/IP —
  in-memory sliding-window per IP+bucket.
- `deploy/` комплект: systemd-юнит с hardening (`NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `ProtectKernelTunnels`,
  `MemoryMax=2G`, scoped `ReadWritePaths`), Caddyfile с
  `flush_interval -1` (без него SSE «замирает»), `env.production`,
  `smoke-test.sh` с проверкой содержимого SSE-потока.
- `.env.example` с подробными комментариями про относительность
  SQLite-пути к `schema.prisma`, инструкцией `openssl rand -hex 32`,
  резервными моделями Groq.

### Security
- Все защищаемые API-маршруты (`/api/analyze`, `/api/chat`, `/api/me`,
  `/api/history*`, `/api/admin/*`) вызывают `requireUser`/`requireAdmin`.
- Ownership-проверка `project.userId === user.id || role === "admin"`
  на `/api/history/[id]`, `/api/chat`, `/api/history/[id]/sources`.
- SQL: только параметризованные запросы Prisma; единственный raw-SQL —
  `db.$queryRaw\`SELECT 1\`` в `/api/health`.
- XSS: React-экранирование везде; `dangerouslySetInnerHTML` /
  `innerHTML` / `eval` / `child_process` / `fs.write` в `src/` не
  используются.
- `console.*` не печатает ключи/токены/`passwordHash`; ошибка LLM
  включает только тело ответа провайдера (обрезано до 300 символов).
- Bootstrap-администратор конкурентно-безопасный: cached
  `Promise<void>` singleton, ретраи при P2002/transient DB-ошибках,
  очистка кэша при сбое.

### Known Limitations
- In-memory rate-limiter сбрасывается рестартом процесса; для
  multi-instance нужен Redis-стор.
- DNS rebinding TOCTOU: `validateUrl` проверяет hostname до запроса,
  но `fetch` резолвит DNS повторно. Для закрытого контура риск
  приемлем; полное закрытие требует пиннинга IP.
- Single-instance: оркестратор хранит глобальный лок «один анализ
  одновременно» в памяти процесса.
- Поиск через HTML-парсинг DuckDuckGo/Bing — без API-ключей, может
  ломаться при смене разметки; при сбое пайплайн деградирует штатно.

### Removed (в публичной сборке)
- `mini-services-factum/llm-bridge/` — локальный LLM-мост, зависел от
  закрытого SDK; для основной конфигурации (Groq) не нужен.
- `prisma/db/factum.db` — бинарный SQLite-файл; теперь в `.gitignore`,
  создаётся `bun run db:push`.
- Фирменные шрифты `RFDewiExpanded-Bold.ttf` (TypeType) и
  `ResistSansText-Light.otf` — редистрибуция требует подтверждения
  лицензии; заменены на системный стек.
- Стаб `GET /api` (Hello, world!) от `create-next-app`.
- `tsconfig.tsbuildinfo`, `next-env.d.ts` (генерируются заново при
  сборке).
