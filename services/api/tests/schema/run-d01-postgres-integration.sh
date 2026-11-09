#!/bin/sh
set -eu

repository_root=$(git rev-parse --show-toplevel)
expected_root='/Users/ben001109/Desktop/work/econ-game'
if [ "$repository_root" != "$expected_root" ]; then
  echo "Refusing to run outside $expected_root" >&2
  exit 1
fi

container_name="econ-game-d01-$PPID"
image='postgres:16-alpine'

cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach --name "$container_name" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=d01-local-only \
  --env POSTGRES_DB=d01_test \
  --volume "$repository_root:/workspace:ro" \
  "$image" >/dev/null

attempt=0
until docker exec "$container_name" \
  psql --username postgres --dbname d01_test --tuples-only --no-align \
  --command 'SELECT 1' 2>/dev/null | grep -qx '1'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Temporary PostgreSQL did not become ready.' >&2
    exit 1
  fi
  sleep 1
done

set +e
precondition_output=$(docker exec "$container_name" \
  psql --username postgres --dbname d01_test --set ON_ERROR_STOP=1 \
  --file /workspace/services/api/prisma/migrations/20260814000100_d01_p0_persistence/migration.sql 2>&1)
precondition_status=$?
set -e

if [ "$precondition_status" -eq 0 ]; then
  echo 'Migration unexpectedly accepted a database without Supabase roles.' >&2
  exit 1
fi

case "$precondition_output" in
  *'D01 migration requires Supabase roles anon, authenticated, and service_role'*) ;;
  *)
    echo 'Migration did not fail with the expected Supabase role precondition.' >&2
    exit 1
    ;;
esac

docker exec --interactive "$container_name" \
  psql --username postgres --dbname d01_test \
  --file /workspace/services/api/tests/schema/d01-postgres-integration.sql

echo 'D01 PostgreSQL migration, RLS, retention, and rollback integration passed.'
