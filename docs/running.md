# Интеграция и эксплуатация

## Проверка без готового Telegram-диалога

Backend принимает ровно тот JSON, который позднее пришлёт бот. Можно проверить его через PowerShell. Сначала задайте `$env:BOT_API_KEY` значением из локального `.env` (не вставляйте секрет в документацию/коммит). Следующий `file_id` — placeholder: создание работает, фото будет возвращать 502, пока не используется реальный Telegram file_id.

```powershell
$headers = @{
  Authorization = "Bearer $env:BOT_API_KEY"
  'Idempotency-Key' = [guid]::NewGuid().ToString()
}
$body = @{
  telegram_user_id = '123456789'
  location = @{ latitude = 43.3; longitude = 68.3 }
  photos = @(@{ telegram_file_id = 'REPLACE_WITH_REAL_TELEGRAM_FILE_ID' })
  description = 'Обнаружена стихийная свалка возле земельного участка.'
  category = 'DUMPING'
} | ConvertTo-Json -Depth 5
$created = Invoke-RestMethod http://localhost:8000/api/reports -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$created
```

Повтор с теми же headers/body возвращает то же обращение. Для следующего обращения создайте новый ключ.

## React: login и первый GET

```typescript
const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api';
const csrfResponse = await fetch(`${base}/auth/csrf`, { credentials: 'include' });
if (!csrfResponse.ok) throw new Error('Не удалось получить CSRF');
const { csrf_token } = await csrfResponse.json();
const loginResponse = await fetch(`${base}/auth/login`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf_token },
  body: JSON.stringify({ username, password }),
});
if (!loginResponse.ok) throw await loginResponse.json();
const session = await loginResponse.json();
// session.csrf_token использовать в последующих POST/PATCH (после login он изменён).
const mapResponse = await fetch(`${base}/map`, { credentials: 'include' });
if (!mapResponse.ok) throw await mapResponse.json();
const map = await mapResponse.json();
```

В `frontend/.env` React нет BOT_API_KEY/BOT_TOKEN. Корневой `.env` используется Django/Compose. Для локальной разработки React использует `http://localhost:5173`, API — `http://localhost:8000`. Если порт другой, измените CORS_ALLOWED_ORIGINS и CSRF_TRUSTED_ORIGINS в backend `.env`.

## Проверка фото и полного сценария

1. Разработчик бота выдаёт тот же BOT_TOKEN серверу Django через секреты окружения, не через git.
2. Бот получает фото → выбирает самый большой PhotoSize → передаёт file_id в POST /api/reports вместе с location/description/category.
3. React GET /api/map показывает точку, GET /api/reports/{id} — фото и описание.
4. GET /api/photos/{photo_id} из авторизованного браузера возвращает bytes, а не Telegram URL.
5. Инспектор выполняет NEW → INSPECTION → VIOLATION → IN_PROGRESS → RESOLVED; перед закрытием вводит комментарий. Каждый PATCH использует актуальную version.
6. Бот GET /api/tracking/{number}?telegram_user_id=… получает актуальный публичный статус.

Этот live-сценарий требует работающего бота и React. API-тесты не означают, что Telegram → Web уже проверено с этими клиентами.

## Production

Compose-файл — локальный стенд: панель на `http://localhost:8080`, прямой API на `http://localhost:8000`; оба порта привязаны к loopback. Для production нужен HTTPS reverse proxy/hosting. Базовые настройки:

- DEBUG=false; новые случайные DJANGO_SECRET_KEY, BOT_API_KEY и пароль БД; настоящий BOT_TOKEN в secret store.
- DATABASE_URL на PostgreSQL; ALLOWED_HOSTS — точный hostname; CORS/CSRF origins — точные HTTPS origins.
- Предпочтителен один origin для React и `/api`: session cookies имеют SameSite=Lax. Frontend на другом сайте требует отдельного решения для cookie-политики, текущий контракт этого не обещает.
- SECURE_SSL_REDIRECT=true. TRUST_PROXY=true только если ваш proxy перезаписывает X-Forwarded-Proto. Health `/api/health` освобождён от HTTPS redirect для внутренней проверки контейнера; это только состояние БД.
- Выполнить `python manage.py migrate --noinput` отдельным release-шагом перед запуском нескольких реплик. Dockerfile запускает только Gunicorn; collectstatic при необходимости выполнить при релизе. Локальный Compose делает migrate/collectstatic перед стартом единственного API-контейнера.
- Выполнить `python manage.py check --deploy`, создать инспектора, seed только в нужной базе. Seed не создаёт пароль и не сбрасывает данные.
- Текущий DRF throttling хранится в памяти каждого worker. Для общего лимита нескольких процессов/реплик добавить Redis cache либо rate limits на reverse proxy. Ограничить login и bot endpoints на ingress до публичного запуска.
- Бот разворачивается отдельным процессом другой командой. Django не устанавливает webhook и не запускает Telegram polling.
- Проверить backup БД, TLS, доступность фото и полный сценарий три раза. Не удалять volume с данными при обновлении.

Для health нет авторизации. Все данные карты, карточек и фото требуют inspector session. Служебный ключ не даёт права инспектора.

## Статус проверки

Работающий локальный backend и автоматизированные проверки не равны production deployment. URL production, live BOT_TOKEN и интеграция клиентов задаются отдельно. Реальные кадастровые данные, автоматическое определение участка, AI и уведомления Telegram о смене статуса в v0.1 не реализованы.
