# Генерация изображений на отдельном сервере

Схема: браузер → API CRM → закрытый SSH-туннель → сервис на `132.243.28.106` → OpenAI Images API.
Внешний запрос делает сервис генерации. PostgreSQL, фотографии, сессии и остальные запросы CRM работают как прежде.
Сервис получает системный промпт и сведения о товаре; ключ OpenAI хранится только на сервере генерации.

## Сервер генерации: 132.243.28.106

Разместите текущие исходники проекта в `/opt/prolot-images` на сервере с Docker Compose. Используйте отдельный Compose-проект:

```sh
cd /opt/prolot-images
cp -n .env.images.example .env.images
chmod 600 .env.images
```

Заполните **`/opt/prolot-images/.env.images`**:

```dotenv
OPENAI_API_KEY=ваш_ключ_OpenAI
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
IMAGE_WORKER_TOKEN=случайный_секрет_для_связи_серверов
```

Создайте служебный токен командой `openssl rand -hex 32`; этот же токен понадобится в `.env.backend` основной CRM. Не отправляйте ключ OpenAI в чат, не помещайте его во frontend или Git. Файлы `.env.images` и `.env.backend` исключены из Git и Docker build context.

Для скрытого ввода ключа в уже созданный файл выполните `python3 /opt/prolot-images/scripts/configure-image-key.py`. Вставьте ключ и нажмите Enter: символы не отображаются. Команда сохраняет `OPENAI_API_KEY` и оставляет служебный токен без изменений.

```sh
docker compose -p prolot-images -f docker-compose.images.yml up --build -d
docker compose -p prolot-images -f docker-compose.images.yml ps
curl --fail http://127.0.0.1:3010/healthz
```

Порт 3010 публикуется только на `127.0.0.1`. Открывать его в firewall или создавать DNS-запись не нужно. Сервис не запускается без ключа и служебного токена. Проверка `/healthz` подтверждает запуск, но не баланс или доступ аккаунта OpenAI.

## Постоянный SSH-туннель

На основном сервере CRM создайте отдельный SSH-ключ, если его ещё нет:

```sh
install -d -m 700 /opt/prolot-image-ssh
test -f /opt/prolot-image-ssh/id_ed25519 || ssh-keygen -t ed25519 -N '' -C prolot-image-tunnel -f /opt/prolot-image-ssh/id_ed25519
cat /opt/prolot-image-ssh/id_ed25519.pub
```

На сервере генерации создайте пользователя `crm-images` без административных прав и добавьте этот публичный ключ в его `~/.ssh/authorized_keys`. Перед ключом укажите ограничения:

```text
restrict,port-forwarding,permitopen="127.0.0.1:3010",command="/bin/false" ssh-ed25519 ПУБЛИЧНЫЙ_КЛЮЧ prolot-image-tunnel
```

Папка `.ssh` должна принадлежать `crm-images` и иметь права `700`, файл ключей — `600`. У пользователя должен быть действующий login shell; команды всё равно запрещены указанным `command`. Чтобы запретить обратный проброс портов, настройте для этого пользователя в конфигурации SSH:

```text
Match User crm-images
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:3010
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
```

Проверьте конфигурацию `sshd -t` перед перезагрузкой SSH. Сохраните текущую административную SSH-сессию до проверки нового соединения.

Сохраните проверенный публичный host key сервера генерации в `/opt/prolot-image-ssh/known_hosts` основного сервера. Его отпечаток следует сверить через административную консоль сервера (`ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub` для установленного на этом сервере RSA-ключа). Туннель использует `StrictHostKeyChecking=yes` и не принимает неизвестные/изменившиеся ключи автоматически.

## Подключение CRM

В `.env.backend` основного сервера:

```dotenv
IMAGE_WORKER_URL=http://image-tunnel:3010
IMAGE_WORKER_TOKEN=тот_же_секрет_из_сервера_генерации
OPENAI_API_KEY=
```

На основном сервере рядом с `docker-compose.yml` создайте `docker-compose.override.yml` с содержимым `docker-compose.image-tunnel.yml`. Docker Compose автоматически подключит его при обычном `docker compose up`, включая автодеплой. Если override уже существует, объедините раздел `image-tunnel` с его содержимым, не перезаписывайте другие настройки.

Перед следующим автодеплоем обновите установленный `/usr/local/sbin/crm-github-deploy` из `scripts/deploy-server-root.sh`: новая версия исключает серверный override из `rsync --delete`. Само обновление файла в Git не обновляет установленный получатель архива. Override исключён из Git; секреты и ключ SSH находятся за пределами исходников.

```sh
docker compose up --build -d image-tunnel api
docker compose logs --tail=30 image-tunnel
docker compose exec -T api node -e "fetch('http://image-tunnel:3010/healthz').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

Туннель доступен только контейнерам сети CRM и автоматически переподключается при обрыве. `IMAGE_WORKER_URL` включает удалённый режим: при ошибках нет прямого обращения к OpenAI с основного сервера. Служебный токен обязателен, незашифрованные публичные HTTP-адреса запрещены; HTTP внутри SSH-туннеля защищён SSH. Можно также указать HTTPS-origin доверенного сервиса с действительным сертификатом.

В CRM откройте новый товар, заполните описание и категорию и нажмите «Создать фото с GPT». Реальная генерация расходует лимит API. Модель и параметры задаются на сервисе: одно JPEG-изображение 1024×1024, medium. Сервис принимает только генерацию, ограничивает её пятью запросами в минуту и двумя одновременно; запросы не повторяются автоматически.

## Обновления

Обновляйте исходники на сервере генерации отдельно от основной CRM и пересобирайте `docker compose -p prolot-images -f docker-compose.images.yml up --build -d`. Обычный автодеплой основной CRM не обновляет второй сервер. После замены секретов пересоздайте соответствующие контейнеры. Ключ OpenAI никогда не передаётся по туннелю: CRM использует отдельный служебный токен.

Для возврата к прямому режиму очистите `IMAGE_WORKER_URL` и `IMAGE_WORKER_TOKEN`, настройте `OPENAI_API_KEY` в backend и пересоздайте контейнер API; отключайте туннель только после смены режима.

Описание Images API: https://developers.openai.com/api/reference/resources/images/methods/generate
