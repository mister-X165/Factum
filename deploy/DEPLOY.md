# Factum — деплой на продакшен-сервер (Ubuntu 22.04/24.04, домен + Caddy)

Пошаговая инструкция развёртывания.
Время: ~30–40 минут. Всё приложение живёт в `/opt/factum/app`.

---

## 0. Предпосылки

Сервер (2+ ГБ RAM), домен с A-записью на сервер (например `demo.example.com`),
открытые порты 80/443, root-доступ. На сервере НЕ нужен Bun — сборку делаем
локально и переносим готовый standalone-бандл.

## 1. Локальная сборка (на вашей машине)

```bash
cd factum/
bun install                        # или npm install
cp .env.example .env               # значения для сборки не критичны
bun run build                      # next build + копирование static/public в standalone
```

Проверьте, что сборка завершилась без ошибок. Артефакты: `.next/standalone/`,
`.next/static/`, `public/`.

## 2. Перенос на сервер

Переносим исходники + prisma-схему + standalone-бандл (node_modules не нужен):

```bash
tar --exclude='node_modules' --exclude='.next/cache' \
    --exclude='.git' --exclude='analysis' --exclude='*.db' \
    -czf factum.tar.gz -C . .next public prisma src package.json bun.lock \
    next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs \
    components.json .env.example deploy
scp factum.tar.gz root@SERVER:/tmp/
```

## 3. Развёртывание на сервере

```bash
# 3.1 Пользователь и каталоги
adduser --system --group --home /opt/factum factum
mkdir -p /opt/factum/app/db
cd /opt/factum/app
tar -xzf /tmp/factum.tar.gz

# 3.2 Node.js (если ещё нет; нужен >= 20)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

# 3.3 .env из шаблона
cp deploy/env.production .env
nano .env     # заполнить AUTH_SECRET (openssl rand -hex 32), ADMIN_PASSWORD, LLM_API_KEY

# 3.4 Генерация Prisma-клиента + создание БД (без node_modules — ставим prisma точечно)
cd /opt/factum/app
npm install --no-save prisma@6.11.1 @prisma/client@6.11.1
npx prisma generate
npx prisma db push          # создаст db/factum.db по абсолютному пути из DATABASE_URL
chown -R factum:factum /opt/factum/app

# 3.5 systemd
cp deploy/factum.service /etc/systemd/system/factum.service
systemctl daemon-reload
systemctl enable --now factum
journalctl -u factum -f     # дождаться старта; Ctrl+C
```

Проверка: `curl -s http://127.0.0.1:3000/api/health | head -c 400` → должно
вернуть JSON с `"db":{"ready":true}`.

## 4. Caddy (TLS + reverse proxy + SSE)

```bash
apt-get install -y caddy
# в deploy/Caddyfile заменить demo.example.com на ваш домен:
cp deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
systemctl reload caddy
```

КЛЮЧЕВОЙ момент для SSE: `flush_interval -1` в reverse_proxy — без него
стрим анализа буферизуется и в браузере «замирает». В готовом Caddyfile это
уже включено.

## 5. Smoke-тест

```bash
cd /opt/factum/app
BASE_URL="https://demo.example.com" ADMIN_PASSWORD='ваш-пароль' bash deploy/smoke-test.sh
```

Тест проверяет: health → login admin → полный SSE-прогон анализа → историю.
Последняя строка должна быть `SMOKE TEST PASSED`.

## 6. Чек-лист перед запуском

- [ ] `https://домен` открывается, форма входа работает
- [ ] Вход admin'ом (пароль из `.env`, НЕ admin/admin)
- [ ] Создан отдельный пользователь (Администрирование → добавить)
- [ ] Анализ URL `https://www.who.int/news-room/fact-sheets/detail/tobacco` проходит до `done` за разумное время
      (Groq: ~1–3 мин на полный прогон)
- [ ] `/api/health` показывает `llm.ready:true` (Groq ключ рабочий)
- [ ] Проверить URL страниц с этого сервера: Wikipedia может отдавать
      403 на серверные IP; надёжные варианты — who.int fact sheets, cdc.gov
- [ ] Бэкап БД: `cp /opt/factum/app/db/factum.db /root/factum-backup-$(date +%F).db`

## 7. Если что-то пошло не так

| Симптом | Причина / действие |
|---|---|
| Login: «Сбой генерации session-токена» | Нет `AUTH_SECRET` в `.env` → задать и `systemctl restart factum` |
| Health: `db.ready:false` | `DATABASE_URL` не абсолютный / каталог db/ не принадлежит factum → см. шаг 3.3 |
| LLM 404 на вызове модели | Модель недоступна ключу → `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY"` и выбрать ID из списка (резерв: `openai/gpt-oss-120b`) |
| LLM 401 | Неверный `LLM_API_KEY` |
| Анализ «замирает» без событий | Caddy без `flush_interval -1` → раздел 4 |
| 429 на /api/analyze | Сработал лимит 4 прогона/час/IP → подождать или перезапустить сервис (лимитер in-memory) |
| Страница источников пустая | Серверный IP заблокирован поисковиком → `SEARCH_PROVIDER="bing"` в `.env` |

## 8. Откат

```bash
systemctl stop factum
# восстановить предыдущий бандл/БД из бэкапа, затем:
systemctl start factum
```
