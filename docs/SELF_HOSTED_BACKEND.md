# Сайт и backend на Linux + Docker

Сайт, API, PostgreSQL и файлы CRM запускаются на одном Linux-сервере. Caddy раздаёт статический сайт на `proaksenov.ru` и проксирует `api.proaksenov.ru` в API. Новая база пустая; данные из прежнего проекта Supabase не переносятся.

## 1. DNS, Docker и конфигурация

Направьте записи `A` для `proaksenov.ru` и `api.proaksenov.ru` на публичный IPv4 Linux-сервера. Установите Docker Engine и Docker Compose plugin, откройте входящие TCP-порты 80 и 443 (UDP 443 необязателен), затем клонируйте репозиторий.

Из корня проекта создайте два закрытых файла конфигурации:

```sh
cp .env.db.example .env.db
cp .env.backend.example .env.backend
chmod 600 .env.db .env.backend
```

Создайте разные пароли для PostgreSQL и секреты Авито:

```sh
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Вставьте первые два значения как `POSTGRES_PASSWORD` и `APP_DB_PASSWORD` в `.env.db`; те же `APP_DB_USER` и `APP_DB_PASSWORD` задайте в `.env.backend`. Последние два значения укажите как `AVITO_WEBHOOK_SECRET` и `AVITO_FEED_SECRET`. Плейсхолдеры Авито можно заполнить после создания владельца. Не коммитьте `.env.db` и `.env.backend`.

Если используете другие домены, обновите `Caddyfile`, `PUBLIC_API_URL`, `AVITO_CALLBACK_URL`, `APP_ORIGINS`, `AVITO_ALLOWED_ORIGINS` и build-аргумент `NEXT_PUBLIC_BACKEND_URL` в `docker-compose.yml`. В списках origin указывайте только origin без завершающего `/`, затем пересоберите сайт командой `docker compose up --build -d proxy`.

## 2. Запуск сайта, базы и API

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f proxy
```

Compose собирает статический сайт из Next.js, затем запускает Caddy, PostgreSQL 17 и API. Caddy получает HTTPS-сертификаты для обоих доменов, раздаёт сайт и проксирует API. PostgreSQL не публикует порт наружу. Docker создаёт отдельную роль приложения из `.env.db`; API подключается к базе этой ролью. На чистом volume API автоматически применяет [полную схему 015](015_create_self_hosted_backend_schema.sql). [Файл 016](016_create_backend_database_role.sql) создаёт роль приложения при первой инициализации PostgreSQL.

Проверьте `https://proaksenov.ru/` и `https://api.proaksenov.ru/healthz`. Ответ API `{"ok":true,"database":"connected"}` означает, что приложение подключилось к базе.

Публичный адрес API попадает в браузерный код во время сборки сайта. Он задан в `docker-compose.yml` как `NEXT_PUBLIC_BACKEND_URL`; после его изменения пересоберите сайт командой `docker compose up --build -d proxy`.

## 3. Создание пользователя CRM

Создайте владельца командой с интерактивным вводом пароля:

```sh
docker compose exec -it api node dist/backend/server/scripts/create-admin.js
```

Пароль не передаётся в командной строке. Команда напечатает UUID пользователя. Ключи Авито после настройки шифрования добавляются в CRM, в разделе «Авито»; вручную заносить их в базу или `.env.backend` не нужно.

Для добавления ключей используйте форму в CRM. Она проверяет ключи через API Авито и сохраняет их зашифрованными для вошедшего пользователя. Старые записи в `AVITO_ACCOUNTS_JSON` поддерживаются для совместимости.

## 4. Подключение Авито

В настройках OAuth-приложения Авито укажите точный redirect URI:

```text
https://proaksenov.ru/api/avito/callback,
```

CRM использует `AVITO_WEBHOOK_SECRET` для проверки уведомлений Авито, а `AVITO_FEED_SECRET` — для XML-фида и временных ссылок на фотографии. Сохраните оба значения отдельно. Серверные секреты не задаются через `NEXT_PUBLIC_*`.

## Обновление и резервные копии

Обновите исходники и пересоберите сайт и API:

```sh
git pull
docker compose up --build -d
```

Для изменения только API можно пересобрать его отдельно: `docker compose up --build -d api`. Для изменения только фронтенда используйте `docker compose up --build -d proxy`.

Резервная копия PostgreSQL и фотографий:

```sh
docker compose exec -T db sh -c 'PGPASSWORD="$APP_DB_PASSWORD" pg_dump -h 127.0.0.1 -U "$APP_DB_USER" -d "$POSTGRES_DB" -Fc' > prolot.dump
docker compose exec -T api tar -czf - -C /app/data/uploads . > uploads.tar.gz
```

Скопируйте архивы за пределы сервера. Для восстановления остановите API, восстановите дамп в уже инициализированную базу от имени `APP_DB_USER`, верните `uploads.tar.gz` в volume и запустите API. Проверьте восстановление на отдельной копии перед тем, как полагаться на резервную копию.

```sh
docker compose stop api
docker compose exec -T db sh -c 'PGPASSWORD="$APP_DB_PASSWORD" pg_restore -h 127.0.0.1 -U "$APP_DB_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < prolot.dump
docker compose run --rm -T --no-deps api tar -xzf - -C /app/data/uploads < uploads.tar.gz
docker compose up -d api
```

Docker volumes называются `postgres_data`, `product_uploads`, `caddy_data` и `caddy_config`; не удаляйте их при обновлении приложения.
## Добавление ключей Авито через CRM

После обновления backend миграция `017_create_avito_api_accounts.sql` применяется автоматически при запуске API. Войдите в CRM, откройте раздел «Авито», укажите название аккаунта, Client ID и Client Secret из кабинета Авито → «Авито API», затем нажмите «Проверить и сохранить ключи». CRM проверит доступ через API Авито и сохранит ключи в зашифрованном виде в PostgreSQL. Для подключения собственного аккаунта нажмите «Подключить по ключам»: CRM получит профиль и объявления через сохранённые ключи `client_credentials`; перенаправление на OAuth-страницу не требуется.

Для шифрования в `.env.backend` нужна переменная `AVITO_CREDENTIALS_ENCRYPTION_KEY`. Один раз создайте значение командой `openssl rand -hex 32`, сохраните его в `.env.backend` и оставляйте неизменным при обновлениях. Не публикуйте и не теряйте его: без этого значения сервер не сможет расшифровать сохранённые ключи.

## Генерация иллюстраций товаров

Для выполнения запросов с отдельного сервера используйте [сервис генерации и SSH-туннель](IMAGE_WORKER.md). В этом режиме ключ OpenAI хранится в `.env.images` сервера генерации, а в CRM нужны `IMAGE_WORKER_URL` и `IMAGE_WORKER_TOKEN`. Ниже описан прямой режим.

Чтобы включить создание изображений в форме нового объявления, добавьте API-ключ OpenAI непосредственно в закрытый файл `.env.backend` на сервере:

```dotenv
OPENAI_API_KEY=ваш_секретный_API_ключ
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
```

Ключ остаётся только в backend-контейнере и не передаётся браузеру. После добавления или замены ключа перезапустите API:

```sh
docker compose up -d --force-recreate api
```

В форме товара кнопка «Создать фото с GPT» использует описание и категорию, а результат можно проверить перед сохранением. Генерация доступна только после настройки `OPENAI_API_KEY`; запросы отправляются в OpenAI Images API.
