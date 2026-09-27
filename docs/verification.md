# Проверка backend v0.1

Проверено локально 25 сентября 2026, Windows + Docker Desktop.

| Проверка | Результат |
| --- | --- |
| Django system check | 0 issues |
| makemigrations --check --dry-run | No changes detected |
| 12 тестов на PostgreSQL 16 | Все прошли, включая два конкурентных теста; тестовая БД корректно удаляется |
| Docker build, Python 3.12 | Образ собран |
| docker compose up --build -d --wait | API и PostgreSQL healthy |
| Миграции в чистую Compose-базу | Применены |
| seed_demo | 55 участков, 20 обращений, 10 заявлений, 3 инструкции |
| HTTP smoke с реальной session cookie и CSRF | Прошёл |
| check --deploy при DEBUG=false и SSL redirect | Без ошибок; W021: HSTS preload намеренно выключен до выбора production-домена |

HTTP smoke создал ещё одно явно помеченное демо-обращение, повторил POST с тем же ключом без дубликата, нашёл его на карте, провёл NEW → INSPECTION → VIOLATION → IN_PROGRESS → RESOLVED, проверил 5 записей истории и tracking, завершил session и проверил 401. В локальной базе обращения из smoke остаются как явно помеченные демо-записи; повторное выполнение smoke добавляет ещё одну такую запись. Seed не стирает и не перезаписывает их.

Фото-прокси проверен автоматизированно с примерным PNG seed-записи и с имитацией Telegram HTTP. Проверены сетевой сбой и недопустимый file_path. В live smoke BOT_TOKEN пустой, поэтому placeholder-фото ожидаемо вернуло 502. Это **не проверка живого Telegram**.

## Ещё требуется перед защитой

- Настоящий BOT_TOKEN/file_id и проверка фото из Telegram.
- Подключить отдельные React и Telegram-диалог к этим endpoints.
- Настроить HTTPS deployment, реальные origins, секреты и общий rate limit для worker-процессов.
- Повторить полный Telegram → Web сценарий три раза в production.
- Подготовить backup-обращение с доступным реальным фото.

Локальный инспектор `inspector` создан. Сгенерированный пароль находится в `INSPECTOR_PASSWORD` локального `.env`, который исключён из git. Общие секреты команды не помещать в эту документацию.

## Полная локальная сборка

Проверено 25 сентября 2026: `docker compose up --build -d --wait` собрал frontend в API-режиме и запустил Nginx, Django и PostgreSQL. Все три контейнера healthy. `npm --prefix frontend test` — 16/16, `format:check` прошёл, `python manage.py test monitoring.tests` в контейнере — 12/12 на PostgreSQL. Через `http://localhost:8080` пройдены login, карта, создание обращения с идемпотентным повтором, четыре смены статуса, tracking и logout. Примерный PNG из seed открылся через авторизованный `/api/photos/{id}`. Тестовое обращение с placeholder Telegram file_id получило ожидаемый 502 для фото; живое Telegram API без `BOT_TOKEN` не проверялось.
