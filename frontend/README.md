# Frontend — панель инспектора

React/Vite и Leaflet. Команды ниже выполняются из `frontend/`:

```powershell
npm ci
npm run dev
npm test
npm run build
npm run format:check
```

По умолчанию используется DEMO. Для Django скопируйте `.env.example` в `.env` и задайте `VITE_DATA_MODE=api`. Vite проксирует `/api` на `http://localhost:8000`; настройка находится в `vite.config.js`. Серверные секреты остаются в корневом `.env`.

Production-сборка — `frontend/dist/` относительно корня репозитория.

- [Документация frontend](../docs/frontend.md)
- [Контракт API](../docs/frontend-api.md)
- [Общий запуск проекта](../README.md)
