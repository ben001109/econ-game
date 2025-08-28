#!/usr/bin/env bash
set -euo pipefail

# Clean only dev containers, then start dev profile

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
cd "$REPO_ROOT"

DEV_SERVICES=(api-dev worker-dev frontend-dev bot-dev)

echo "[dev-up] Cleaning previous dev containers: ${DEV_SERVICES[*]}"
# Stop and remove only the dev service containers; ignore errors if none exist
if ! docker compose rm -s -f "${DEV_SERVICES[@]}"; then
  echo "[dev-up] Nothing to remove or cleanup failed; continuing..."
fi

echo "[dev-up] Starting dev profile (dbs + dev services)"
docker compose --profile dev up --build -d postgres redis "${DEV_SERVICES[@]}" adminer redis-commander "$@"

echo "[dev-up] Done. Use: docker compose logs -f api-dev worker-dev frontend-dev bot-dev"

