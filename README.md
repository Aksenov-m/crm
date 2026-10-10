# ПроЛот — CRM для Авито

CRM хранит товары, фотографии, покупателей, черновики ответов и переписку Авито на собственном сервере. Сайт, API, PostgreSQL и файлы работают в Docker на Linux. Новая база начинается пустой.

## Демонстрация

Откройте `/demo/` или выберите «Попробовать демо без входа». Демо не обращается к API и Авито: изменения существуют только до перезагрузки страницы. Для статического хостинга Next.js создаёт `out/demo/index.html`.

## Локальная разработка

Нужен Node.js 22 или новее и Docker Compose. Подготовьте конфигурацию сервера по [инструкции развёртывания](docs/SELF_HOSTED_BACKEND.md), запустите PostgreSQL и API, создайте владельца CRM, затем настройте фронтенд:

```powershell
Copy-Item .env.example .env.local
# В .env.local укажите NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3001
npm.cmd install
npm.cmd run dev
```

Откройте http://127.0.0.1:3000. Данные из старого демо автоматически не импортируются.

Команды backend:

```text
npm run backend:dev       запуск API в режиме разработки
npm run backend:build     компиляция API
npm run backend:migrate   применение схемы docs/015 к пустой базе
npm run backend:create-admin  интерактивное создание пользователя CRM
```

В Docker схема создаётся при первом запуске API. Файл `docs/016_create_backend_database_role.sql` используется при инициализации пустого PostgreSQL volume. SQL-файлы `001–014` относятся к прежнему варианту на Supabase и автоматически не применяются.

## Развёртывание на сервере

Направьте DNS-записи `A` для `proaksenov.ru` и `api.proaksenov.ru` на Linux-сервер. Подготовьте `.env.db` и `.env.backend` по [инструкции развёртывания](docs/SELF_HOSTED_BACKEND.md), затем выполните:

```sh
docker compose up --build -d
```

Docker собирает статическую версию Next.js и включает её в Caddy-образ. Caddy раздаёт сайт на `https://proaksenov.ru`, а `https://api.proaksenov.ru` проксирует в backend. Он также автоматически получает HTTPS-сертификаты для доменов.

## Возможности

- Карточки товаров с описанием, ценой, категорией и фотографией; этапы «Новый», «Подготовка», «Готов», «Опубликован», «Продан».
- Доска продаж, поиск и фильтры, покупатели, заметки и статусы, черновики ответов.
- Вход по email и паролю, серверные сессии, изоляция записей по владельцу.
- Фото JPEG/PNG/WebP до 5 MiB в приватном Docker volume; размер и формат файла проверяются сервером.
- Подключение аккаунтов Авито, импорт объявлений, связь с товарами, обновление цены, описания и главного фото.
- Диалоги Авито, отправка и удаление сообщений, отметка прочтения, webhook и обновления переписки через PostgreSQL LISTEN/NOTIFY и SSE.
- Публикация через Авито Автозагрузку и защищённый XML-фид.
- Аналитика по товарам и продажам.

Регистрации и восстановления пароля в интерфейсе нет; пользователей создаёт владелец сервера. Переписки и публикации Авито требуют учётных данных Авито и отдельной настройки — см. [AVITO_SETUP.md](docs/AVITO_SETUP.md) и [AVITO_MESSENGER.md](docs/AVITO_MESSENGER.md).

## Структура

- `src/components/crm-session.tsx` — вход и сессия.
- `src/components/crm-app.tsx` — рабочий интерфейс CRM.
- `src/lib/backend.ts`, `src/lib/crm-repository.ts` — HTTP-клиент API и данные CRM.
- `src/lib/avito.ts` — браузерный клиент интеграции Авито.
- `server/` — API, серверные сессии, PostgreSQL, хранение фото и webhook Авито.
- `server/avito/` — логика OAuth, операций Авито и проверки webhook.
- `docs/015_create_self_hosted_backend_schema.sql` — полная схема новой базы.
- `docker-compose.yml`, `Dockerfile`, `Dockerfile.site`, `Caddyfile` — сайт и backend на Linux + Docker.

Демонстрационные фотографии: [Unsplash](https://unsplash.com/license). Источники находятся в `scripts/download-assets.mjs`.
