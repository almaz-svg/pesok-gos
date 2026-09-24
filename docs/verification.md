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

HTTP smoke создал ещё одно явно помеченное демо-обращение, повторил POST с тем же ключом без дубликата, нашёл его на карте, провёл NEW → INSPECTION → VIOLATION → IN_PROGRESS → RESOLVED, проверил 5 записей истории и tracking, завершил session и проверил 401. В локальной базе после smoke: 55 участков, 21 обращение, 10 заявлений.

Фото-прокси проверен автоматизированно с настоящими PNG bytes и имитацией Telegram HTTP. Проверены сетевой сбой и недопустимый file_path. В live smoke BOT_TOKEN пустой, поэтому placeholder-фото ожидаемо вернуло 502. Это **не проверка живого Telegram**.

## Ещё требуется перед защитой

- Настоящий BOT_TOKEN/file_id и проверка фото из Telegram.
- Подключить отдельные React и Telegram-диалог к этим endpoints.
- Настроить HTTPS deployment, реальные origins, секреты и общий rate limit для worker-процессов.
- Повторить полный Telegram → Web сценарий три раза в production.
- Подготовить backup-обращение с доступным реальным фото.

Локальный инспектор `inspector` создан. Сгенерированный пароль находится в `INSPECTOR_PASSWORD` локального `.env`, который исключён из git. Общие секреты команды не помещать в эту документацию.
