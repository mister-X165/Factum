#!/usr/bin/env bash
# ============================================================================
# Factum — smoke-тест развёрнутого сервиса (полный цикл).
#
# Проверяет: негативный логин, логин admin'а, /api/health, /api/me,
# SSE-прогон анализа (demo или LLM) с проверкой СОДЕРЖИМОГО потока
# (события stage/claims/report — фрагменты текста, а не только HTTP-коды),
# появление проекта в истории, чтение полного результата, журнал аудита
# и админскую статистику.
#
# Запускается НА СЕРВЕРЕ или с любой машины, видимой по сети.
#
# Использование:
#   BASE_URL="https://demo.example.com" ADMIN_PASSWORD='пароль' ./smoke-test.sh
# По умолчанию: BASE_URL=http://127.0.0.1:3000, ADMIN_PASSWORD=admin
#
# Зависимости: curl, python3 (парсинг SSE/JSON).
# ============================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
COOKIE_JAR="$(mktemp)"
SSE_LOG="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$SSE_LOG"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "OK:   $1"; }

# --- 1. негативный логин (проверка отказа при неверном пароле) ----------
BAD_LOGIN_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"definitely-wrong-pass\"}" \
  "$BASE_URL/api/login")"
[ "$BAD_LOGIN_CODE" = "401" ] || [ "$BAD_LOGIN_CODE" = "400" ] \
  || fail "негативный логин: ожидался 401/400, получен HTTP $BAD_LOGIN_CODE"
pass "негативный логин: неверный пароль отклонён (HTTP $BAD_LOGIN_CODE)"

# --- 2. логин ------------------------------------------------------------
# /api/health закрыт middleware-сессией, поэтому логин идёт ПЕРВЫМ.
LOGIN_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' \
  -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$BASE_URL/api/login")"
[ "$LOGIN_CODE" = "200" ] || fail "login: HTTP $LOGIN_CODE (проверьте ADMIN_USERNAME/ADMIN_PASSWORD; код 500 — отсутствует AUTH_SECRET)"
pass "login: admin вошёл (HTTP 200)"

# --- 3. health (с сессией) ----------------------------------------------
HEALTH="$(curl -sS -m 30 -b "$COOKIE_JAR" "$BASE_URL/api/health")"
echo "$HEALTH" | grep -q '"db":{' || fail "health: нет ответа /api/health"
DB_READY="$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["db"]["ready"])')"
[ "$DB_READY" = "True" ] || fail "health: db.ready=False (БД недоступна — проверьте DATABASE_URL и права на каталог db/)"
LLM_READY="$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["llm"]["ready"])')"
[ "$LLM_READY" = "True" ] || echo "WARN: llm.ready=False — LLM-провайдер недоступен, полный анализ не пройдёт"
pass "/api/health: db=ready (llm.ready=$LLM_READY)"

# --- 4. текущий пользователь (/api/me) -----------------------------------
ME="$(curl -sS -m 30 -b "$COOKIE_JAR" "$BASE_URL/api/me")"
echo "$ME" | python3 -c '
import json, sys
data = json.load(sys.stdin)
user = data.get("user") if isinstance(data, dict) else data
if not user or not user.get("username"):
    sys.exit(1)
' || fail "/api/me: не удалось получить текущего пользователя"
pass "/api/me: сессия активна ($(echo "$ME" | python3 -c 'import json,sys; d=json.load(sys.stdin); u=d.get("user",d); print(u.get("username","?"))'))"

# --- 4b. контракт текстового ввода (проверка фрагментов, не только ссылок) --
# Короткий текст должен отклоняться валидацией с русским сообщением (400).
# Полный текстовый прогон = обычный SSE-анализ, здесь проверяем только контракт.
TEXT_REJECT_CODE="$(curl -sS -m 30 -o /tmp/factum-text-reject.json -w '%{http_code}' \
  -b "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -d '{"text":"слишком коротко","mode":"CONTROLLED"}' \
  "$BASE_URL/api/analyze")"
[ "$TEXT_REJECT_CODE" = "400" ] || fail "text-input: короткий текст должен отклоняться с HTTP 400, получено $TEXT_REJECT_CODE"
grep -q 'символов' /tmp/factum-text-reject.json || fail "text-input: сообщение об ошибке не на русском или не про длину"
rm -f /tmp/factum-text-reject.json
pass "text-input: короткий фрагмент корректно отклоняется (HTTP 400, русское сообщение)"

# --- 5. анализ (SSE) с проверкой содержимого потока ----------------------
# Демо-URL: fact-sheet ВОЗ — проверен (HTTP 200) и доступен с сервера без
# anti-bot барьеров. CDC из некоторых сетей отдаёт 403 — не использовать.
URL="${TEST_URL:-https://www.who.int/news-room/fact-sheets/detail/tobacco}"
echo "… запускаю анализ: $URL"
curl -sS -N -m 900 -b "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\",\"mode\":\"CONTROLLED\"}" \
  "$BASE_URL/api/analyze" > "$SSE_LOG"

# 5a. структурные события конвейера.
grep -q '"type":"stage"' "$SSE_LOG" || fail "analyze: нет ни одного stage-события"
grep -q '"type":"done"' "$SSE_LOG" || fail "analyze: поток завершился без события done (пайплайн упал — смотрите journalctl -u factum)"
FINAL_STATUS="$(python3 - "$SSE_LOG" <<'PY'
import json, sys
status = None
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line.startswith("data:"):
        continue
    try:
        ev = json.loads(line[5:])
    except Exception:
        continue
    if ev.get("type") == "done":
        status = ev.get("status") or ev.get("projectStatus") or "done"
print(status or "done")
PY
)"
pass "analyze: пайплайн завершён (done, status=$FINAL_STATUS)"

# 5b. содержимое потока: ключевые события и кириллица в деталях стадий.
# Проверяем ФРАГМЕНТЫ ТЕКСТА в ответе, а не только факт наличия событий.
python3 - "$SSE_LOG" <<'PY' || fail "analyze: содержимое потока неполное (смотрите вывод выше)"
import json, sys

events = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line.startswith("data:"):
        continue
    try:
        events.append(json.loads(line[5:]))
    except Exception:
        continue

types = [e.get("type") for e in events]
errors = [e for e in events if e.get("type") == "error"]
problems = []

# Ключевые события полного цикла.
for expected in ("stage", "claims", "sources", "evidence", "report", "done"):
    if expected not in types:
        problems.append(f"нет события типа {expected}")

# Явные ошибки в потоке — критично.
if errors:
    for e in errors[:3]:
        problems.append(f"событие error: {e.get('message', '')[:120]}")

# Событие report: непустые вердикты и утверждения.
report = next((e for e in events if e.get("type") == "report"), None)
if report:
    if not report.get("claims"):
        problems.append("report: пустой список утверждений")
    if not report.get("verdicts"):
        problems.append("report: пустой список вердиктов")
    if not report.get("sources"):
        problems.append("report: пустой список источников")
    # Кириллица в вердикте/резюме — интерфейс должен быть на русском.
    summary = report.get("report", {}).get("summary", "")
    if summary and not any("\u0400" <= ch <= "\u04ff" for ch in summary):
        problems.append("report.summary не содержит кириллицы (проверьте локализацию)")

# Детали стадий: «N утверждений» и т. п. — тоже фрагменты текста.
stage_details = [e.get("detail", "") for e in events if e.get("type") == "stage" and e.get("detail")]
if stage_details and not any(any("\u0400" <= ch <= "\u04ff" for ch in d) for d in stage_details):
    problems.append("ни одна деталь стадии не содержит кириллицы")

if problems:
    for p in problems:
        print(f"  • {p}", file=sys.stderr)
    sys.exit(1)

claims_n = len(report["claims"]) if report else 0
sources_n = len(report["sources"]) if report else 0
verdicts_n = len(report["verdicts"]) if report else 0
print(f"  поток: {claims_n} утверждений, {sources_n} источников, {verdicts_n} вердиктов, события {sorted(set(types))}")
PY
pass "analyze: содержимое потока полное (claims/sources/evidence/report, кириллица в деталях)"

# --- 6. история: проект появился -----------------------------------------
HISTORY="$(curl -sS -m 30 -b "$COOKIE_JAR" "$BASE_URL/api/history")"
PROJECT_ID="$(echo "$HISTORY" | python3 -c '
import json, sys
data = json.load(sys.stdin)
projects = data.get("projects", data) if isinstance(data, dict) else data
print(projects[0]["id"] if projects else "")
')"
[ -n "$PROJECT_ID" ] || fail "history: после анализа в истории нет ни одного проекта"
pass "history: проект в истории (#${PROJECT_ID:0:10}…)"

# --- 7. полный результат проекта ------------------------------------------
RESULT_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  "$BASE_URL/api/history/$PROJECT_ID")"
[ "$RESULT_CODE" = "200" ] || fail "history/$PROJECT_ID: HTTP $RESULT_CODE"
# Содержимое: вердикты и резюме на месте.
curl -sS -m 30 -b "$COOKIE_JAR" "$BASE_URL/api/history/$PROJECT_ID" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if not data.get("claims"):
    sys.exit(1)
if not data.get("verdicts"):
    sys.exit(1)
if not data.get("report", {}).get("summary"):
    sys.exit(1)
' || fail "history/$PROJECT_ID: неполный результат (нет claims/verdicts/summary)"
pass "history/$PROJECT_ID: полный результат (claims + verdicts + summary)"

# --- 8. журнал аудита проекта ---------------------------------------------
AUDIT_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  "$BASE_URL/api/history/$PROJECT_ID/audit")"
[ "$AUDIT_CODE" = "200" ] || fail "audit: HTTP $AUDIT_CODE"
curl -sS -m 30 -b "$COOKIE_JAR" "$BASE_URL/api/history/$PROJECT_ID/audit" | python3 -c '
import json, sys
data = json.load(sys.stdin)
events = data.get("events", [])
if len(events) < 5:
    sys.exit(1)
' || fail "audit: слишком мало записей аудита (<5) — трассировка конвейера не записана"
pass "audit: журнал аудита записан (≥5 записей)"

# --- 9. админская статистика ----------------------------------------------
STATS_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
  "$BASE_URL/api/admin/stats")"
[ "$STATS_CODE" = "200" ] || fail "admin/stats: HTTP $STATS_CODE (войдите под администратором)"
pass "admin/stats: статистика доступна (HTTP 200)"

echo
echo "SMOKE TEST PASSED — сервис готов к работе."
