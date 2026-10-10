#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/prolot-crm"
readonly LOCK_FILE="/run/lock/crm-github-deploy.lock"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Deployment receiver must run as root." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" || ! -s "$APP_DIR/.env.db" || ! -s "$APP_DIR/.env.backend" ]]; then
  echo "Deployment directory or server environment files are missing." >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another deployment is already running." >&2; exit 1; }

staging_dir="$(mktemp -d /var/tmp/crm-github-deploy.XXXXXX)"
cleanup() {
  case "$staging_dir" in
    /var/tmp/crm-github-deploy.*) rm -rf -- "$staging_dir" ;;
    *) echo "Refusing to clean unexpected staging directory: $staging_dir" >&2 ;;
  esac
}
trap cleanup EXIT

tar --extract --gzip --file=- --directory "$staging_dir" --no-same-owner --no-same-permissions

for required_file in docker-compose.yml Dockerfile Dockerfile.site Caddyfile package.json package-lock.json; do
  if [[ ! -s "$staging_dir/$required_file" ]]; then
    echo "Deployment archive is missing $required_file." >&2
    exit 1
  fi
done

rsync --archive --delete --exclude='/.env*' "$staging_dir/" "$APP_DIR/"
cd "$APP_DIR"
docker compose config --quiet
docker compose up -d --build

api_container="$(docker compose ps -q api)"
if [[ -z "$api_container" ]]; then
  echo "The API container was not created." >&2
  docker compose ps
  exit 1
fi

for attempt in $(seq 1 36); do
  api_health="$(docker inspect --format='{{.State.Health.Status}}' "$api_container" 2>/dev/null || true)"
  case "$api_health" in
    healthy) break ;;
    unhealthy)
      docker compose logs --tail=100 api >&2
      exit 1
      ;;
  esac
  sleep 5
done

if [[ "$api_health" != "healthy" ]]; then
  echo "The API did not become healthy within 180 seconds." >&2
  docker compose ps
  docker compose logs --tail=100 api >&2
  exit 1
fi

docker compose ps
