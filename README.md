# Pesok Gos — мониторинг земель

Inspector Web (React) → Django REST Framework → PostgreSQL. Telegram-бот находится отдельно в `bot/`; его подключение к общему Django API ещё не выполнено.

## Реализовано

Backend по контракту v0.1: session login/CSRF, отдельный ключ бота, создание обращений с идемпотентностью, карта GeoJSON, карточки и списки, смена статуса/срока/участка с историей и контролем версии, фото-прокси, tracking, инструкции, статистика. Миграции, seed и тесты включены.

Готова **веб-панель инспектора** на React/Vite и Leaflet: анимированный рельеф, интерактивная карта, фильтры, карточки, история, аналитика и смена статусов. По умолчанию работает на явно обозначенных DEMO-данных с сохранением в браузере. Режим `api` подключает Django по существующему контракту v0.1.

В `bot/` реализован Telegram-диалог: выбор русского или казахского языка, сбор геолокации, фото и описания, личный кабинет обращений и справочник процедур. Сейчас бот запускается в `DATA_MODE=mock`: данные сохраняются локально и не попадают в Django или на карту инспектора. Его текущий API-клиент несовместим с контрактом backend v0.1; адаптация и production deployment ещё не выполнены. Для реальных фото нужен серверный `BOT_TOKEN` того же бота, который прислал file_id. Секреты не попадают в frontend.

## Запуск frontend

Требуется Node.js 22.12+:

```powershell
npm ci
npm run dev
```

Открыть `http://localhost:5173`. Сборка — `npm run build`, тесты — `npm test`, форматирование — `npm run format:check`. Для подключения бэкенда задать `VITE_DATA_MODE=api` в `.env` и перезапустить Vite. Запросы `/api` проксируются на `http://localhost:8000`.

[Запуск frontend, демо и подключение API](docs/frontend.md).

## Запуск Telegram-бота

Бот использует отдельные зависимости и `.env`. Из корня репозитория, в отдельном терминале (Node.js 20+):

```powershell
cd bot
npm ci
Copy-Item .env.example .env
# Укажите BOT_TOKEN в bot/.env и оставьте DATA_MODE=mock.
npm start
```

Не запускайте вторую polling-копию с токеном уже работающего бота. Команда `npm test` из `bot/` проверяет бота; команды из корня по-прежнему относятся к frontend. Docker Compose пока запускает только backend и БД.

`bot/.env`, `bot/data/reports.json` и `bot/data/user-preferences.json` не публикуются в Git. Перенос этих локальных файлов при смене места запуска выполняется отдельно, чтобы сохранить обращения и языки пользователей. Демо-сигнал не является официальным обращением в госорган.

[Документация бота](bot/README.md), [краткий контекст для ИИ](bot/TZKZ), [контракт Django для будущего подключения](docs/backend-design.md).

## Запуск через Docker (PowerShell)

Из корня репозитория:

```powershell
Copy-Item .env.example .env
# В .env замените DJANGO_SECRET_KEY, POSTGRES_PASSWORD и BOT_API_KEY.
# Для пароля PostgreSQL используйте URL-safe символы, например случайный hex.
docker compose up --build -d
docker compose exec api python manage.py create_inspector --username inspector
docker compose exec api python manage.py seed_demo --telegram-user-id 123456789
```

Команда create_inspector интерактивно запрашивает пароль. Для автоматизации допустим `INSPECTOR_PASSWORD` в окружении процесса; пароль не передавать аргументом командной строки. Повторный запуск не сбрасывает существующий пароль.

API: `http://localhost:8000/api`, health: `http://localhost:8000/api/health`. PostgreSQL доступен только внутри compose-сети; данные в volume. Seed не удаляет live-записи и не перезаписывает отредактированные данные. Seed без `--telegram-file-id` создаёт обращения без фотографий; настоящее фото можно добавить при первом seed этим флагом либо отправить новое обращение через API/бот.

Seed: 55 участков, 20 обращений (10 violation, 5 inspection, 5 resolved), 10 заявлений, 3 инструкции. Участки: 10 violation, 5 inspection, 40 normal — статусы вычисляются из обращений. Границы вымышленные.

## Локальный Python

Python 3.12, PostgreSQL 16. Можно использовать свою базу и `DATABASE_URL` из `.env`:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
.\.venv\Scripts\python backend\manage.py migrate
.\.venv\Scripts\python backend\manage.py create_inspector --username inspector
.\.venv\Scripts\python backend\manage.py seed_demo
.\.venv\Scripts\python backend\manage.py runserver
```

Для быстрого локального запуска без PostgreSQL: `DEBUG=true` и удалить DATABASE_URL из `.env`; тогда используется SQLite. Это только режим разработки: конкурентность и production проверяются на PostgreSQL. Gunicorn используется в Linux/Docker; на Windows для разработки — runserver.

## Проверка

```powershell
docker compose exec api python manage.py check
docker compose exec api python manage.py makemigrations --check --dry-run
docker compose exec api python manage.py test monitoring.tests --verbosity 2
```

Набор тестов проверяет обращения, карту, права, CSRF, фото-прокси с имитацией Telegram, tracking, историю, фильтры, seed, rollback, границу суток и реальные конкурентные транзакции PostgreSQL. На SQLite конкурентные тесты пропускаются. В GitHub Actions проверки настроены с PostgreSQL.

## Документация

- [API для React](docs/frontend-api.md)
- [Backend и контракт бота](docs/backend-design.md)
- [Локальный smoke-сценарий и деплой](docs/running.md)
- [Telegram-бот: запуск, возможности и ограничения API](bot/README.md)
- [Контекст Telegram-бота для ИИ](bot/TZKZ)
- [Типы TypeScript](contracts/api.ts)
- [Mock-данные](contracts/examples.json)

Владелец Django/DRF, БД и API — Алиш. Контракт v0.1 согласован; изменение полей/enum отражаем в документации и согласуем с React/bot-разработчиками.
