# API для React — контракт v0.1

Статус: контракт v0.1 согласован, endpoints реализованы в Django/DRF. Локальный запуск описан в README. Production URL и интеграция React/Telegram пока не настроены.

## Общие правила

- Base URL в development: `http://localhost:8000/api`. В production рекомендуется общий origin и `/api`. В React используется `VITE_API_BASE_URL`; секретов в VITE-переменных нет.
- URL **без завершающего слеша**. Маршруты Django настроены под это правило, POST/PATCH не зависят от redirect.
- JSON, `Content-Type: application/json`; UUID — строки; даты-время — ISO 8601 UTC с `Z`; deadline — календарная дата `YYYY-MM-DD`.
- В интерфейсе время отображается в `Asia/Qyzylorda`. Обращение просрочено, если deadline раньше сегодняшней даты в этой зоне и status != RESOLVED. В день deadline оно ещё не просрочено.
- Координаты WGS84: объект `{latitude, longitude}`; **GeoJSON — `[longitude, latitude]`**. Leaflet `LatLng` получает обратный порядок.
- Поля read DTO присутствуют всегда; отсутствие значения — `null`, коллекции — `[]`. PATCH: пропущенное поле не меняется, `deadline: null` снимает срок. Неизвестные поля запроса → 400.
- Авторизованные GET и фото: `Cache-Control: private, no-store`. Персональные данные Telegram в inspector DTO не передаются.

## Авторизация

Inspector: Django session cookie, login/password, POST/PATCH с `credentials: 'include'` и `X-CSRFToken`. Токен CSRF возвращается JSON-полем, хранится в памяти. После login использовать новый токен. GET фото можно вставлять обычным `<img src={photo.url}>` при общем origin.

| Метод и путь | Запрос | Ответ |
| --- | --- | --- |
| GET /auth/csrf | — | 200 `{ "csrf_token": "…" }`, устанавливает CSRF cookie |
| POST /auth/login | `{ "username": "inspector", "password": "…" }` + CSRF | 200 `{ "user": { "id": "UUID", "username": "inspector" }, "csrf_token": "…" }`, session cookie |
| GET /auth/me | session | 200 `{ "id": "UUID", "username": "inspector" }` |
| POST /auth/logout | `{}` + CSRF | 204, session аннулирована |

Неверные credentials → 401; нет session → 401; CSRF/нет прав → 403. Это целевой единый формат, для него потребуется обработка ошибок DRF и Django CSRF. Пользователей создаёт администратор, публичной регистрации нет.

В development backend разрешает конкретный origin React (`http://localhost:5173`), credentials и CSRF trusted origin. На frontend host использовать `localhost`, не смешивать с `127.0.0.1`. В production HTTPS, Secure cookies и точный список origins. Endpoint бота использует отдельную серверную авторизацию (см. backend-design.md).

## Модель данных и статусы

`Report` — обращение гражданина, в том числе обращение без известного участка. `Plot` — земельный участок. `Application` — отдельная запись заявления с tracking-номером. Проверка обращения и заявления имеет единый tracking endpoint, но различается `kind`.

| Report.status | Подпись | Цвет маркера |
| --- | --- | --- |
| NEW | Новое | жёлтый |
| INSPECTION | На проверке | жёлтый |
| VIOLATION | Нарушение подтверждено | красный |
| IN_PROGRESS | Устраняется | красный |
| RESOLVED | Закрыто | зелёный |

Переходы: NEW → INSPECTION; INSPECTION → VIOLATION или RESOLVED; VIOLATION → IN_PROGRESS; IN_PROGRESS → RESOLVED. Другие переходы → 409. Для RESOLVED обязательно непустое `comment` (причина закрытия, включая неподтверждённое нарушение). Повтор текущего статуса допустим, история статуса не дублируется.

`Plot.status`: NORMAL / INSPECTION / VIOLATION. Производный статус: если есть связанные VIOLATION или IN_PROGRESS → VIOLATION; иначе NEW или INSPECTION → INSPECTION; иначе NORMAL. Закрытые обращения не делают участок «нарушением». Участок без обращений — NORMAL. Фильтр «Устранено» применяется к обращениям RESOLVED, не к участкам.

`category`: DUMPING (свалка), LAND_GRAB (самозахват), UNUSED_LAND (неиспользуемая земля), ABANDONED_PLOT (заброшенный участок), OTHER (другое).

## Endpoints инспектора

Все требуют inspector session. Права: чтение, изменение обращения, просмотр фото; создание обращений — только бот.

| Метод и путь | Результат |
| --- | --- |
| GET /reports | 200 Page<Report> |
| GET /reports/{id} | 200 ReportDetail с history |
| PATCH /reports/{id} | 200 обновлённый ReportDetail |
| GET /plots | 200 Page<Plot> |
| GET /plots/{id} | 200 Plot |
| GET /map | 200 MapResponse с двумя FeatureCollection |
| GET /statistics | 200 Statistics |
| GET /photos/{id} | 200 бинарное изображение |
| GET /instructions | 200 Instruction[] |

Не вводим параллельные `/complaints` и `/reports/{id}/status`. Одно атомарное PATCH меняет статус, срок и участок.

### Списки и фильтры

`GET /reports?status=VIOLATION&category=DUMPING&overdue=true&plot_id=UUID&search=042&page=1&page_size=20`

- `status`, `category`: одно значение enum; `overdue`: true/false; `plot_id`: UUID.
- `search`: до 100 символов, регистронезависимое частичное совпадение tracking_number или кадастрового номера связанного участка.
- Фильтры объединяются AND. Пустой search игнорируется. Пустое/неверное значение остальных параметров и неизвестный параметр → 400.
- `GET /plots?status=VIOLATION&search=019&page=1&page_size=20`: search по cadastral_number.
- Пагинация только списков: default page=1, page_size=20, максимум 100. Сортировка reports: created_at DESC, id DESC; plots: cadastral_number ASC, id ASC.
- Ответ `{ "count": 0, "next": null, "previous": null, "results": [] }`. next/previous — URL либо null; count после фильтров. page<1 → 400, страница за концом → 404 (пустая page=1 → 200).

### Карта

`GET /map?bbox=68.20,43.20,68.40,43.40&report_status=VIOLATION&plot_status=VIOLATION&category=DUMPING&overdue=true&search=019`

Параметры опциональны. bbox = west,south,east,north, west<east, south<north, допустимые диапазоны longitude [-180,180], latitude [-90,90]. Пересечение антимеридиана в v0.1 не поддерживается. bbox отбирает точки внутри границ и полигоны, чьи bounding boxes пересекаются с bbox.

`report_status`, category, overdue фильтруют только обращения; `plot_status` — только участки; search — обе коллекции по правилам списков. Поэтому подходящее обращение может отображаться без полигона. UI должен учитывать независимость слоёв. Фильтр «Все» не отправляет параметры статусов.

Ответ содержит `plots` и `reports` — GeoJSON FeatureCollection. Plot geometry — Polygon или MultiPolygon, Report geometry — Point. `Feature.id` = UUID; properties содержат данные для popup (см. types). Кольца полигонов замкнуты. Карточку загружаем отдельным GET по UUID. Участки с `geometry: null` остаются в списке, но исключаются из карты.

Карта не пагинируется; лимит 2000 объектов суммарно. При превышении → 422 `map_limit_exceeded`; никаких незаметно обрезанных данных. UI предлагает приблизить карту. Default без bbox разрешён для demo dataset.

### Изменение обращения

```json
{
  "version": 1,
  "status": "INSPECTION",
  "deadline": "2026-09-30",
  "plot_id": "11111111-1111-4111-8111-111111111111",
  "comment": "Назначена первичная проверка"
}
```

Обязателен `version` из последнего GET; хотя бы одно из status/deadline/plot_id/comment. `plot_id: null` отвязывает участок; несуществующий UUID → 400 field error. category/description/location/photos через этот endpoint не редактируются. deadline может быть прошлой датой (для учёта просроченных случаев). comment 1–2000 символов после trim. Изменение без комментария допустимо, кроме закрытия.

Каждый принятый PATCH увеличивает version ровно на 1 и создаёт одну history-запись с before/after, даже если изменён только срок, привязка или добавлен комментарий. Передача тех же значений без комментария → 400 `no_changes`. Устаревший version → 409 `version_conflict`: перечитать карточку и показать конфликт, не перезаписывать автоматически. Запись обращения, история и пересчёт участков — одна транзакция.

После PATCH обновить карточку ответом и инвалидировать reports/map/plots/statistics. Для живой карты достаточно polling раз в 10 секунд, при возвращении на вкладку — повтор GET. Отменять предыдущий запрос через AbortController, чтобы старый ответ не затирал актуальные фильтры.

### Фото

`photos: [{ "id": "UUID", "url": "/api/photos/UUID" }]`. URL относительный к origin API: при отдельном origin использовать `new URL(photo.url, API_ORIGIN)`. Это URL backend, не Telegram. Endpoint проверяет session, получает файл сервером и отдаёт bytes с корректным image Content-Type. В DTO нет `file_id`, bot token или Telegram download URL.

При недоступном Telegram → 502 `photo_unavailable`; UI показывает placeholder и кнопку повтора. GET JSON карточки продолжает работать независимо от фото. У записи без фото `photos: []` (seed/исторические записи); новая заявка бота требует минимум одно фото.

### Статистика

Глобальная, без фильтров: total_plots — число участков; active_violations — число reports со статусом VIOLATION или IN_PROGRESS; under_inspection — NEW или INSPECTION; resolved — RESOLVED; overdue — активные обращения с истёкшим deadline. Один участок может иметь несколько обращений; счётчики обращений не суммируются в total_plots.

## Ошибки

```json
{
  "error": {
    "code": "validation_error",
    "message": "Проверьте поля запроса",
    "fields": { "deadline": ["Ожидается дата YYYY-MM-DD"] },
    "request_id": "req-123"
  }
}
```

fields всегда объект (может быть пустым). Клиент ветвится по code, не message. Вложенные поля обозначаются точками, например `location.latitude`, `photos.0.telegram_file_id`.

| HTTP | code | Поведение UI |
| --- | --- | --- |
| 400 | validation_error / no_changes | Подсветить поля или показать message |
| 401 | authentication_required / invalid_credentials | Открыть login |
| 403 | permission_denied / csrf_failed | Сообщить об отсутствии доступа / обновить CSRF |
| 404 | not_found | Объект не найден |
| 409 | version_conflict / invalid_transition / idempotency_conflict | Показать конфликт |
| 422 | map_limit_exceeded | Попросить приблизить карту |
| 429 | rate_limited | Уважать Retry-After (секунды) |
| 500 | internal_error | Ошибка + request_id + повтор GET |
| 502 | photo_unavailable | Placeholder фото |

GET можно повторять с задержкой. PATCH после сетевого обрыва: сначала перечитать объект, поскольку изменение могло сохраниться. Не делать слепой повтор.

## Первый сценарий React

1. GET csrf → login → сохранить новый csrf_token → GET me.
2. Параллельно GET map, statistics, reports; показать loading/error/empty отдельно для каждого блока.
3. Клик по marker → GET reports/{id}; показать описание, photos, статус, deadline, историю.
4. Выбрать разрешённый следующий статус → PATCH с version и CSRF.
5. Использовать ответ PATCH, обновить карту/списки/статистику. При закрытии запросить комментарий.
6. Новое обращение из бота появляется при очередном polling; никакой ручной правки fixtures.

Для разработки интерфейса доступны `contracts/api.ts` и `contracts/examples.json`; mock режим включать явно. Для интеграции используйте локальный backend. Нельзя молча переключаться на mock при ошибках production API.
