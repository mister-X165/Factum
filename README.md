# Factum

Система автоматической проверки фактов: берёт URL или текст, извлекает утверждения,
ищет источники, сопоставляет доказательства и выдаёт обоснованный вердикт с
полным аудиторским следом. Next.js 16 + React 19 + Prisma (SQLite) + LLM через
OpenAI-совместимый API (по умолчанию — Groq).

> Статус: v0.3.0, MVP. Безопасность и стабильность основного пути
> (логин → анализ → история) проверены вручную. Смотрите раздел
> «Известные ограничения» ниже.

---

## Возможности

- Извлечение утверждений из веб-страницы или произвольного текста.
- Поиск источников без API-ключей (DuckDuckGo → Bing, HTML-парсинг).
- SSRF-фильтрация URL: блок file/ftp/data, приватных диапазонов,
  link-local, CGNAT, cloud-metadata endpoints.
- Сопоставление «утверждение → источник → доказательство» с уровнем
  доказательности (Tier 1–8) и оценкой authority/methodology/recency.
- Вердикт по каждому утверждению и общий отчёт с методологией.
- Версионирование вердиктов: при добавлении источника пользователем
  вердикт пересчитывается, предыдущая версия сохраняется.
- Чат с контекстом анализа (вопросы по источникам и утверждениям).
- Экспорт отчёта в Markdown и печать в PDF.
- Аудит-трейл каждой стадии (orchestrator → claims → sources → evidence
  → verdicts → report).
- Аутентификация: логин/пароль (scrypt + 16-байтовый salt, timing-safe
  compare), подписанная HMAC-SHA256 кука, роли `admin`/`user`, баны.
- Rate-limiting: `/api/login` (10/15мин/IP), `/api/analyze` (4/час/IP),
  `/api/chat` (40/час/IP).

---

## Стек

| Слой            | Технология                                            |
| --------------- | ----------------------------------------------------- |
| UI              | Next.js 16 (App Router), React 19, Tailwind 4         |
| Компоненты      | shadcn-style на Radix UI                              |
| БД              | SQLite через Prisma 6                                 |
| Runtime         | Bun (разработка/сборка), Node.js ≥ 20 (продакшен)     |
| LLM             | Любой OpenAI-совместимый `/chat/completions` (Groq)   |

---

## Быстрый старт

```bash
# 1. Зависимости
bun install                         # или: npm install

# 2. Переменные окружения
cp .env.example .env
# заполнить AUTH_SECRET и LLM_API_KEY (минимум для запуска):
#   AUTH_SECRET=$(openssl rand -hex 32)
#   LLM_API_KEY=gsk_...

# 3. База данных
bun run db:generate                 # prisma generate
bun run db:push                     # создать схему в SQLite

# 4. Запуск
bun run dev                         # http://localhost:3000
```

При первом старте на пустой БД автоматически создаётся admin-аккаунт
из `ADMIN_USERNAME` / `ADMIN_PASSWORD` (см. `.env`). Если пароль пустой —
будет `admin/admin` с предупреждением в логе; **смените его сразу**.

---

## Переменные окружения

Полный список — в [`.env.example`](./.env.example). Минимум для запуска:

| Переменная        | Назначение                                                |
| ----------------- | --------------------------------------------------------- |
| `DATABASE_URL`    | SQLite-путь, локально `file:./db/custom.db`               |
| `AUTH_SECRET`     | HMAC-ключ сессионной куки (32 байта hex)                  |
| `ADMIN_USERNAME`  | Имя первого администратора                                |
| `ADMIN_PASSWORD`  | Пароль первого администратора                             |
| `LLM_PROVIDER`    | `groq` (по умолчанию) или любой OpenAI-совместимый        |
| `LLM_API_KEY`     | Ключ LLM-провайдера                                       |
| `LLM_MODEL`       | ID модели, например `qwen/qwen3.8-27b`                    |
| `LLM_BASE_URL`    | Базовый URL API провайдера                                |

Дополнительно: `LLM_MAX_TOKENS` (рекомендуется 3000), `LLM_TIMEOUT_MS`,
`LLM_TEMPERATURE`, `SEARCH_PROVIDER`, `LOG_QUERIES`.

---

## Деплой

Полная инструкция для продакшен-сервера (systemd + Caddy + TLS) — в
[`deploy/DEPLOY.md`](./deploy/DEPLOY.md). Комплект `deploy/` включает
systemd-юнит с hardening, Caddyfile с поддержкой SSE и smoke-тест.

---

## Структура проекта

```
factum-publish/
├── src/
│   ├── app/                  # Next.js App Router (страницы и API-маршруты)
│   │   ├── api/              # REST + SSE эндпоинты
│   │   └── login/            # Страница входа
│   ├── components/
│   │   ├── factcheck/        # Mission control, verdict dashboard, source list
│   │   ├── workspace/        # Экраны рабочего стола
│   │   ├── shell/            # AppShell / Topbar / Sidebar
│   │   └── ui/               # shadcn-style primitives
│   ├── lib/
│   │   ├── auth.ts           # scrypt + ban re-check + bootstrap admin
│   │   ├── auth-edge.ts      # HMAC-SHA256 token (Web Crypto, Edge-safe)
│   │   ├── ratelimit.ts      # In-memory sliding window per IP+bucket
│   │   ├── db.ts             # Prisma client
│   │   └── factcheck/        # Оркестратор пайплайна и его этапы
│   └── middleware.ts         # Проверка сессионной куки
├── prisma/
│   ├── schema.prisma         # 11 моделей: User, Project, Claim, Source, …
│   └── migrations/           # SQL-миграции
├── deploy/                   # systemd, Caddyfile, env.production, smoke-test
├── scripts/                  # check-i18n.ts, validate-demo.ts
├── public/                   # logo.svg, brand assets
└── .env.example
```

---

## Безопасность

- Аутентификация: scrypt (N=16384, r=16, p=1) + 16-байтовый salt,
  `crypto.timingSafeEqual` для сравнения хэшей.
- Сессия: подписанная HMAC-SHA256 кука `httpOnly` + `SameSite=Lax` +
  `Secure` в production, TTL 24 часа.
- На каждом API-вызове статус `banned`/`role` перепроверяется в БД —
  бан сразу блокирует даже валидный токен.
- SSRF: `validateUrl()` блокирует file/ftp/gopher/data/blob/javascript
  схемы, приватные диапазоны IPv4/IPv4, link-local, CGNAT, multicast,
  cloud-metadata endpoints (AWS/GCP/Azure), `.internal`/`.local`/
  `.localhost`, userinfo-credentials в URL. Редиректы обрабатываются
  вручную с повторной валидацией на каждом хопе (до 3).
- Open-redirect на `/login?next=` закрыт (`safeInternalPath`).
- SQL: только параметризованные запросы Prisma; единственный raw-SQL —
  `db.$queryRaw\`SELECT 1\`` в `/api/health`.
- XSS: React-экранирование везде; `dangerouslySetInnerHTML` /
  `innerHTML` / `eval` в `src/` не используются.
- Rate-limiting на критических маршрутах (см. выше).

Если вы нашли уязвимость — см. [`SECURITY.md`](./SECURITY.md).

---

## Известные ограничения

- **In-memory rate-limiter** сбрасывается рестартом процесса; при
  горизонтальном масштабировании заменить на Redis-стор.
- **DNS rebinding**: `validateUrl` проверяет hostname до запроса, но
  `fetch` резолвит DNS повторно — теоретический TOCTOU. Для закрытого
  контура риск приемлем; полное закрытие требует пиннинга IP.
- **Поиск через HTML-парсинг** DuckDuckGo/Bing — без API-ключей, может
  ломаться при смене разметки; при сбое пайплайн деградирует штатно.
- **Single-instance**: оркестратор хранит глобальный лок «один анализ
  одновременно» в памяти процесса. Для multi-instance нужен Redis-лок.

---

## Разработка

```bash
bun run dev          # разработка (http://localhost:3000)
bun run lint         # eslint
bun run db:push      # применить схему к локальной БД
bun run db:migrate   # создать миграцию из изменений schema.prisma
bun run build        # production-сборка (standalone)
```

См. [`CONTRIBUTING.md`](./CONTRIBUTING.md) для правил контрибуции.

---

## Лицензия

[MIT](./LICENSE). Брендинг (логотип, key-visual) — собственность автора
проекта, см. [`NOTICE.md`](./NOTICE.md). Шрифты `RF Dewi Expanded` и
`Resist Sans Text` из публичной сборки **удалены** — заменены на
системный стек; если вы хотите вернуть фирменные шрифты, подтвердите
лицензию на редистрибуцию от TypeType и соответствующей студии.
