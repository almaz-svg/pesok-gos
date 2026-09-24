# Pesok Gos — мониторинг земель

Inspector Web (React) → Django REST Framework → PostgreSQL. Отдельный Telegram-бот отправляет обращения в тот же API.

## Текущее состояние

Готова **веб-панель инспектора** на React/Vite и Leaflet: анимированный рельеф, интерактивная карта, фильтры, карточки, история, аналитика и смена статусов. По умолчанию работает на явно обозначенных DEMO-данных с сохранением в браузере. Django и Telegram-бот пока не реализованы; контракт v0.1 подготовлен для их подключения.

```powershell
npm ci
npm run dev
```

Открыть `http://localhost:5173`. Сборка — `npm run build`, проверки — `npm test`. Требуется Node.js 22.12+.

- [Запуск frontend, демо и подключение API](docs/frontend.md).

- [API для фронтенда](docs/frontend-api.md) — endpoints, статусы, карта, авторизация, ошибки, сценарий интеграции.
- [Типы TypeScript](contracts/api.ts) — DTO запросов и ответов.
- [Примеры данных](contracts/examples.json) — согласованные mock-ответы.
- [Backend и интеграция бота](docs/backend-design.md) — схема БД, права, фото, порядок реализации и QA.

Владелец контракта и Django API — Алиш. Telegram реализуется отдельно. Frontend следует текущим полям и enum контракта; исходный вариант ТЗ с camelCase описан в заметке о различиях интеграции.

## P0

Бот → POST /api/reports → PostgreSQL → GET /api/map → карточка → PATCH /api/reports/{id} → обновлённая карта и история.

Далее: tracking, инструкции, статистика, seed, production deployment. Heatmap/AI — после рабочего сквозного сценария.
