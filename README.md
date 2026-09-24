# Pesok Gos — мониторинг земель

Inspector Web (React) → Django REST Framework → PostgreSQL. Отдельный Telegram-бот отправляет обращения в тот же API.

## Текущее состояние

Репозиторий содержит **предлагаемый контракт v0.1**, типы и примеры для параллельной разработки. Backend, frontend и bot пока не реализованы; перечисленные URL ещё не работают.

- [API для фронтенда](docs/frontend-api.md) — endpoints, статусы, карта, авторизация, ошибки, сценарий интеграции.
- [Типы TypeScript](contracts/api.ts) — DTO запросов и ответов.
- [Примеры данных](contracts/examples.json) — согласованные mock-ответы.
- [Backend и интеграция бота](docs/backend-design.md) — схема БД, права, фото, порядок реализации и QA.

Владелец контракта и Django API — Алиш. React и Telegram реализуются отдельно. Изменения полей/enum сначала отражаются в контракте и согласуются с потребителями.

## P0

Бот → POST /api/reports → PostgreSQL → GET /api/map → карточка → PATCH /api/reports/{id} → обновлённая карта и история.

Далее: tracking, инструкции, статистика, seed, production deployment. Heatmap/AI — после рабочего сквозного сценария.
