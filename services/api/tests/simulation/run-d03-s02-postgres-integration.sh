#!/bin/sh
set -eu

repository_root=$(git rev-parse --show-toplevel)
expected_root='/Users/ben001109/Desktop/work/econ-game'
if [ "$repository_root" != "$expected_root" ]; then
  echo "Refusing to run outside $expected_root" >&2
  exit 1
fi

container_name="econ-game-d03-s02-$PPID"
image='postgres:16-alpine'

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "[EVIDENCE_MISSING] Required local image $image is unavailable; refusing to pull during D03-S-02 verification." >&2
  exit 1
fi

cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach --name "$container_name" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=d03-s02-local-only \
  --env POSTGRES_DB=d03_s02_test \
  --publish 127.0.0.1::5432 \
  --volume "$repository_root:/workspace:ro" \
  "$image" >/dev/null

attempt=0
until docker exec "$container_name" \
  psql --username postgres --dbname d03_s02_test --tuples-only --no-align \
  --command 'SELECT 1' 2>/dev/null | grep -qx '1'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Temporary PostgreSQL did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

docker exec --interactive "$container_name" \
  psql --username postgres --dbname d03_s02_test \
  --file /workspace/services/api/tests/simulation/d03-s02-postgres-setup.sql

published_port=$(docker port "$container_name" 5432/tcp)
published_port=${published_port##*:}
case "$published_port" in
  ''|*[!0-9]*)
    echo 'Could not resolve isolated PostgreSQL port.' >&2
    exit 1
    ;;
esac

D03_S02_TEST_DATABASE_URL="postgresql://postgres:d03-s02-local-only@127.0.0.1:${published_port}/d03_s02_test" \
  npm exec --prefix "$repository_root/services/worker" -- \
  tsx "$repository_root/services/api/tests/simulation/d03-s02-postgres.integration.ts"

docker exec --interactive "$container_name" \
  psql --username postgres --dbname d03_s02_test \
  --file /workspace/services/api/tests/simulation/d03-s02-postgres-verification.sql

echo 'D03-S-02 migration, lease reclaim, retry/DLQ, RLS, unique tick, replay, and rollback integration passed.'
