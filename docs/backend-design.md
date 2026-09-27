# Django/DRF: схема и интеграция v0.1

Контракт v0.1 согласован и реализован в Django/DRF. Bot-процесс и его диалог реализует отдельный участник; Django владеет данными, проверкой переходов, tracking и фото-прокси. Запуск — в README, deployment и smoke-сценарий — в running.md.

## Схема БД

| Модель | Поля / ограничения |
| --- | --- |
| User | UUID PK, username unique, password hash, is_active, роль inspector; custom user до первой миграции |
| LandPlot | UUID PK, cadastral_number unique, area_ha decimal >0, purpose, address nullable, geometry JSON nullable |
| TrackingRecord | UUID PK, number unique, owner_telegram_user_id bigint; общий namespace номеров report/application |
| TrackingSequence | BigAutoField PK — внутренняя PostgreSQL sequence для выдачи общих tracking-номеров |
| Report | UUID PK, tracking OneToOne PROTECT, category, description, latitude/longitude, plot nullable FK SET_NULL, status, deadline nullable DateField, version positive int, created_at/updated_at |
| ReportPhoto | UUID PK, report FK CASCADE, telegram_file_id (server only), ordinal, unique(report, ordinal) |
| StatusHistory | UUID PK, report FK CASCADE, event, before JSON nullable, after JSON, comment nullable, actor_user nullable FK SET_NULL, actor_type, actor_label, created_at |
| Application | UUID PK, tracking OneToOne PROTECT, status, deadline nullable, updated_at |
| ApplicationHistory | UUID PK, application FK CASCADE, status, label, created_at |
| Instruction | slug PK, title, body plain text, sort_order, updated_at |
| IdempotencyRecord | service identity + key unique, normalized payload hash, stored response/status, created_at |

TrackingRecord должен принадлежать ровно одному Report или Application: сервис создания проверяет это в одной транзакции. PK и FK самостоятельно не обеспечивают XOR двух разных таблиц. Номера генерируются сервером из общей PostgreSQL sequence: `KZ-2026-000042` (год UTC на момент создания, минимум 6 цифр; demo `KZ-2026-042` также допустим как seed). Уникальность обеспечивается БД, нельзя использовать count()+1. Пропуски последовательности допустимы.

Геометрия P0 — JSONField с валидацией GeoJSON, PostgreSQL без обязательного PostGIS. Проверять тип, вложенность, диапазоны, минимум 4 позиции кольца и замыкание. Для 50–60 участков bbox-проверка в Python приемлема; PostGIS и индексы — следующий этап. Это не юридически значимые кадастровые границы. Автопривязки point-in-polygon в v0.1 нет: новое обращение получает plot=null, инспектор привязывает его через PATCH.

Plot.status и active_reports_count вычисляются из связанных Report (count всех, кроме RESOLVED). Нельзя хранить вручную редактируемый дубликат статуса. Один запрос с аннотациями либо prefetch; не N+1 на каждый полигон. Report.is_overdue вычисляется при чтении, а не хранится boolean, устаревающим в полночь.

Индексы: Report(status, created_at), deadline, plot_id, category; tracking number unique; history(report_id, created_at, id). История read-only, порядок created_at ASC, id ASC. CREATED имеет before=null, after с NEW; каждый принятый PATCH создаёт UPDATED. Изменение только комментария тоже сохраняет before/after.

## Bot → Django

Один Telegram bot token обслуживает диалог и фото. Bot-разработчик хранит BOT_TOKEN на своём сервере; Django хранит тот же token только для getFile/download. Между bot и Django используется **другой** секрет BOT_API_KEY. Ни один из них не передаётся в React или git.

Все bot-запросы: `Authorization: Bearer <BOT_API_KEY>`, HTTPS в production. Этот ключ разрешает создание reports, tracking только по указанному владельцу и чтение instructions. Он не разрешает inspector GET /reports, /map, /photos или PATCH. Ключ не является login-токеном инспектора. Скомпрометированный бот может заявить произвольный telegram_user_id, поэтому доверие к нему — явная серверная граница.

### POST /api/reports

Обязательный `Idempotency-Key`: UUID, сгенерированный ботом на одно завершённое обращение и сохранённый до успешного ответа. При timeout использовать тот же ключ и тело; для нового обращения — новый ключ.

```json
{
  "telegram_user_id": "123456789",
  "location": { "latitude": 43.3, "longitude": 68.3 },
  "photos": [{ "telegram_file_id": "TELEGRAM_FILE_ID_FROM_UPDATE" }],
  "description": "Обнаружена стихийная свалка возле земельного участка.",
  "category": "DUMPING"
}
```

201:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "tracking_number": "KZ-2026-000042",
  "status": "NEW",
  "created_at": "2026-09-25T08:00:00Z"
}
```

Валидация: telegram_user_id — положительная десятичная строка, помещающаяся в signed bigint; location обязательно, latitude [-90,90], longitude [-180,180], конечные числа; description 10–3000 символов после trim; category обязателен; photos 1–3, непустые уникальные file_id длиной до 1024. file_id считается opaque string. Бот передаёт один вариант размера каждой фотографии (предпочтительно самый большой), а не все варианты из Telegram update. Пустое/отсутствующее фото или location → 400. Нельзя присылать status, tracking_number, plot_id, deadline или произвольный photo URL.

Создание Report + TrackingRecord + Photo + CREATED history + IdempotencyRecord — атомарно. Сначала проверка auth и тела, затем транзакция. Одинаковые service/key и нормализованное тело возвращают исходный 201 и тот же JSON; другое тело с тем же ключом → 409 idempotency_conflict. Параллельные дубли сериализуются уникальным ограничением и повторным чтением. В течение хакатона ключи не удаляем. Проверка доступности Telegram-файла не блокирует сохранение обращения: syntactically valid file_id может позже вернуть photo_unavailable.

Бот сообщает об успехе только после 201, показывает tracking_number. При 400 возвращает пользователя к соответствующему шагу; при 429 учитывает Retry-After; при timeout/5xx повторяет с backoff и тем же ключом. Не логировать Authorization, токены и полный body с данными пользователя.

### GET /api/tracking/{tracking_number}?telegram_user_id=123456789

Только bot key; telegram_user_id обязателен. Возвращает 200 TrackingResponse (см. contracts/api.ts и examples.json). Для чужого и отсутствующего номера одинаковый 404 not_found. Это предотвращает перебор последовательных номеров обычным гражданином через бот. Не делаем публичный endpoint проверки по одному номеру.

Report и Application различаются `kind`. Для Report возвращаются публичные status-события (CREATED и только фактические изменения статуса); внутренние comments, исполнители, фото, описание и location не возвращаются. Для Application — публичная ApplicationHistory. Labels возвращает сервер на русском. Deadline nullable. Application lifecycle: RECEIVED → IN_REVIEW → INSPECTION_SCHEDULED → COMPLETED; IN_REVIEW → COMPLETED или REJECTED. В P1 заявления создаются seed/администратором; публичного POST /applications нет.

### GET /api/instructions

Доступен bot key и inspector session. Возвращает Instruction[] в порядке sort_order, id. body — обычный текст, не HTML/Telegram Markdown; бот экранирует текст перед применением собственного parse_mode или отправляет без него. Пустая база → [].

## Фото-прокси

Seed содержит специально обозначенный sample PNG (`demo-photo:seed-v1`), который backend отдаёт локально для проверки карточки. Bot POST не принимает этот служебный file_id. Демонстрационная картинка не является доказательством нарушения.

GET /api/photos/{uuid} требует inspector session. Найти ReportPhoto; неизвестный id → 404. Сервер вызывает Telegram getFile, затем получает bytes файла; никогда не делает redirect клиента на Telegram. Не принимать внешние download URLs от клиента. Использовать фиксированный Telegram host, запретить следование redirect на произвольные хосты, валидировать file_path, не логировать URL с токеном.

Timeout соединения 3 секунды, чтения 10 секунд; лимит файла приложения 10 MiB (контролировать поток, не только Content-Length). Разрешить JPEG/PNG/WebP, проверить содержимое изображения, отдавать Content-Type и X-Content-Type-Options: nosniff. Ошибку Telegram/неподдерживаемый или слишком большой файл нормализовать в 502 photo_unavailable без деталей Telegram. Бот предупреждает об ограничении до отправки. Кеш server-side по Photo UUID допустим, но ответ браузеру private,no-store; invalid file_path не кешировать навсегда. Ограничение 10 MiB — наше продуктовое решение.

## PATCH и конкурентность

Inspector-only. transaction.atomic + select_for_update по Report; проверить version, разрешённый переход и значения; обновить запись/version, добавить историю. На ошибке откатить всё. Response — новый ReportDetail. Статусы участков производные, поэтому новая и прежняя привязка отражаются при следующем GET. Все записи имеют version=1 после создания.

## Порядок реализации

1. Django/DRF, PostgreSQL, custom User, env example, миграции, session auth/CSRF, единая обработка ошибок.
2. Models, serializers, bot authentication, POST reports + idempotency; простой management command для inspector.
3. GET reports/detail/map/plots + photo proxy. Подключить bot и React: проверить создание точки с реальным фото.
4. PATCH + история + version; полный проход до изменения цвета карты.
5. Tracking, instructions, statistics, детерминированный seed. Seed: 55 plots, 20 reports, 10 applications; статусы участков выводятся из обращений. Если нужны 12 inspection и 10 violation участков, потребуется минимум 22 активных обращения, а не 15–20: распределение согласовать, не подделывать счётчики.
6. Deployment: Django API под production WSGI/ASGI сервером, PostgreSQL, frontend, отдельный bot worker/webhook. Бот-разработчик отвечает за Telegram webhook/диалог, Алиш — API, БД, secrets и общий deployment. Запуск миграций перед трафиком; seed идемпотентный, без удаления live-обращений.

Env: DJANGO_SECRET_KEY, DEBUG=false, DATABASE_URL, ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, CORS_ALLOWED_ORIGINS, BOT_API_KEY, BOT_TOKEN. Значения задаются при запуске/деплое, пример — `.env.example`. README содержит команды запуска. Production endpoint и credentials пока не созданы.

## Проверки до передачи backend

- Создание от бота → БД → GET map → правильные longitude/latitude → detail → bytes фото.
- PATCH по допустимому переходу обновляет status/version/history; deadline переживает повторный GET; RESOLVED требует комментарий.
- Два PATCH с одинаковой version: один успех, один 409, нет потерянной истории.
- Два POST с одним idempotency key: одно обращение; изменённое тело с этим ключом → 409.
- NEW без plot появляется на карте; привязка/отвязка/перепривязка изменяет производные статусы нужных участков.
- Участок с двумя нарушениями остаётся красным после закрытия одного.
- Tracking чужого пользователя → 404; bot key не может PATCH; anonymous не получает фото/данные инспектора; CSRF обязателен для session mutations.
- Пустые списки, неверный enum/bbox/координаты, отсутствие фото, чужой UUID, недоступность Telegram, превышение лимита карты.
- Просрочка на границе суток Asia/Qyzylorda; RESOLVED не просрочен; статистика соответствует БД.
- Production: повторить полный сценарий трижды; иметь существующее backup-обращение. Фото fixture не выдавать за проверку живого Telegram.
