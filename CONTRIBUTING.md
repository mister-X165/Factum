# Контрибуция в Factum

Спасибо, что хотите внести вклад! Перед началом — прочитайте этот
файл и [`SECURITY.md`](./SECURITY.md) (уязвимости через pull request
**не принимаются** — только через приватный канал).

## Как предложить изменение

1. Откройте issue с описанием проблемы или фичи. Для bug-репорта
   укажите: версия проекта, шаги воспроизведения, ожидаемое и
   фактическое поведение, логи (без секретов).
2. Форкните репозиторий, создайте ветку `feat/…` или `fix/…` от
   `main`.
3. Сделайте изменения. Соблюдайте существующий стиль кода.
4. Проверьте локально:

   ```bash
   bun install
   bun run lint
   bunx tsc --noEmit
   bun run db:push
   bun run dev
   ```

5. Если добавили новую переменную окружения — обновите `.env.example`
   и README.
6. Если изменили `prisma/schema.prisma` — создайте миграцию:
   `bun run db:migrate --name <короткое-имя>`.
7. Откройте pull request со ссылкой на исходный issue.

## Стиль кода

- TypeScript везде, `strict: true`. `any` не используется —
  типизируйте явно.
- React-компоненты — функциональные, с явными `Props`-типами.
- API-маршруты: `export const dynamic = "force-dynamic"` для
  защищённых маршрутов; первой строкой — `await requireUser(req)` /
  `await requireAdmin(req)`.
- Комментарии — на русском для бизнес-логики, на английском для
  технических деталей. Без ссылок на внутренние трекеры.
- `console.log` — только в dev-условиях (`if (process.env.NODE_ENV
  !== "production")`), без печати секретов / `passwordHash` /
  `LLM_API_KEY`.

## Чего не принимать

- Секреты в коммитах (даже в комментариях). CI упадёт на
  `gitleaks`/`trufflehog`-скане.
- Новые `any`-типы или `@ts-ignore` без веской причины.
- `dangerouslySetInnerHTML` без санитизации.
- `$queryRawUnsafe` / `$executeRawUnsafe` — только параметризованный
  `db.$queryRaw\`…\``.
- Ослабление SSRF-фильтра в `src/lib/factcheck/security.ts`.
- Отключение `requireUser` / `requireAdmin` на защищённых маршрутах.

## CI

В репозитории настроен минимальный CI (`.github/workflows/ci.yml`):
`bun install` → `bunx tsc --noEmit` → `bun run lint`. Pull request
должен проходить CI перед мержем.

## Лицензирование

Отправляя pull request, вы соглашаетесь, что ваш вклад будет
опубликован под лицензией [MIT](./LICENSE).

## Code of Conduct

Будьте уважительны. Деструктивное поведение (оскорбления, угрозы,
спам) — блок без предупреждения.
