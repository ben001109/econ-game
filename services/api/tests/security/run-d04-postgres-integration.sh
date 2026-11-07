#!/bin/sh
set -eu

repository_root=$(git rev-parse --show-toplevel)
expected_root='/Users/ben001109/Desktop/work/econ-game'
if [ "$repository_root" != "$expected_root" ]; then
  echo "Refusing to run outside $expected_root" >&2
  exit 1
fi

container_name="econ-game-d04-$PPID"
image='postgres:16-alpine'

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Required local image $image is unavailable; refusing to pull during D04 verification." >&2
  exit 1
fi

cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach --name "$container_name" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=d04-local-only \
  --env POSTGRES_DB=d04_test \
  --volume "$repository_root:/workspace:ro" \
  "$image" >/dev/null

attempt=0
until docker exec "$container_name" \
  psql --username postgres --dbname d04_test --tuples-only --no-align \
  --command 'SELECT 1' 2>/dev/null | grep -qx '1'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Temporary PostgreSQL did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

docker exec --interactive "$container_name" \
  psql --username postgres --dbname d04_test \
  --file /workspace/services/api/tests/security/d04-discord-link-postgres.sql

echo 'D04 durable challenge, atomic link/audit, RLS, and rollback integration passed.'
