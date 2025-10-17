#!/usr/bin/env bash
# Linux setup helper for econ-game
# Mirrors the behaviour of scripts/setup.mjs for common workflows:
#   ./scripts/setup-linux.sh --docker [--dev]
#   ./scripts/setup-linux.sh --local [--start-db] [--db-push] [--skip-install]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_DIR="${ROOT}/services"
DOCKER_COMPOSE=()

log() {
  printf '%s\n' "$1"
}

warn() {
  printf '[warn] %s\n' "$1" >&2
}

fail() {
  local msg="$1"
  local code="${2:-1}"
  printf '[error] %s\n' "$msg" >&2
  exit "$code"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_in_repo() {
  if [[ ! -d "$SERVICES_DIR" ]]; then
    fail "Please run from repo root (missing ./services)."
  fi
}

ensure_docker() {
  if ((${#DOCKER_COMPOSE[@]} > 0)); then
    return 0
  fi
  if ! command_exists docker; then
    fail "Docker is required. Install Docker engine before continuing."
  fi
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
    return 0
  fi
  if command_exists docker-compose; then
    DOCKER_COMPOSE=(docker-compose)
    return 0
  fi
  fail "Docker Compose plugin not found. Update Docker to include 'docker compose'."
}

docker_compose() {
  ensure_docker
  "${DOCKER_COMPOSE[@]}" "$@"
}

read_nvmrc() {
  local nvmrc="${ROOT}/.nvmrc"
  if [[ ! -f "$nvmrc" ]]; then
    return 1
  fi
  local raw
  raw="$(<"$nvmrc")"
  raw="${raw#"v"}"
  printf '%s' "${raw%%.*}"
}

get_node_major() {
  if ! command_exists node; then
    return 1
  fi
  local version
  version="$(node --version 2>/dev/null || true)"
  version="${version#"v"}"
  printf '%s' "${version%%.*}"
}

setup_docker() {
  local dev="$1"
  ensure_docker
  if [[ "$dev" == "1" ]]; then
    log "Cleaning previous dev containers (api-dev, worker-dev, frontend-dev, bot-dev)..."
    if ! docker_compose rm -s -f api-dev worker-dev frontend-dev bot-dev >/dev/null 2>&1; then
      warn "No existing dev containers to remove or cleanup failed; continuing."
    fi
    log "Starting dev profile containers (api-dev, worker-dev, frontend-dev, bot-dev, dbs)..."
    docker_compose --profile dev up --build -d postgres redis api-dev worker-dev frontend-dev bot-dev adminer redis-commander
  else
    log "Building and starting production-like stack..."
    docker_compose up --build -d
  fi
  log "Docker setup complete."
}

install_package_deps() {
  local dir="$1"
  if [[ ! -f "${dir}/package.json" ]]; then
    return 0
  fi
  pushd "$dir" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  popd >/dev/null
}

setup_local() {
  local skip_install="$1"
  local db_push="$2"
  local start_db="$3"

  local required_node=""
  if required_node="$(read_nvmrc)"; then
    :
  else
    required_node="20"
  fi

  local current_node=""
  if current_node="$(get_node_major)"; then
    if [[ "$current_node" -lt "$required_node" ]]; then
      warn "Node ${required_node}+ recommended (found $(node --version))."
      warn "Use nvm: 'nvm use' then rerun if available."
    fi
  else
    warn "Node is not installed or not in PATH. Some steps may fail."
  fi

  if [[ "$start_db" == "1" ]]; then
    if command_exists docker; then
      log "Starting Postgres and Redis via Docker..."
      docker_compose up -d postgres redis
    else
      fail "Docker not available. Install Docker or run DB services manually."
    fi
  fi

  if [[ "$skip_install" != "1" ]]; then
    log "Installing dependencies for api..."
    install_package_deps "${SERVICES_DIR}/api"
    log "Installing dependencies for worker..."
    install_package_deps "${SERVICES_DIR}/worker"
    log "Installing dependencies for frontend..."
    install_package_deps "${SERVICES_DIR}/frontend"
  else
    log "Skipping npm install for services."
  fi

  if [[ -d "${SERVICES_DIR}/api/prisma" ]]; then
    log "Generating Prisma client (api)..."
    (cd "${SERVICES_DIR}/api" && npx prisma generate)
    if [[ "$db_push" == "1" ]]; then
      log "Pushing Prisma schema to DB (requires reachable Postgres)..."
      (cd "${SERVICES_DIR}/api" && npx prisma db push)
    fi
  fi

  log "Local setup complete."
  log "Next steps:"
  log "- API:      cd services/api && npm run dev"
  log "- Worker:   cd services/worker && npm run dev"
  log "- Frontend: cd services/frontend && npm run dev"
}

print_help() {
  cat <<'EOF'
econ-game Linux setup

Options:
  --docker            Build and start Docker stack
  --docker --dev      Use dev profile (hot reload api/worker/frontend)
  --local             Install Node deps and generate Prisma
  --local --start-db  Start Postgres+Redis with Docker (for local dev)
  --local --db-push   Run Prisma db push (DB must be reachable)
  --skip-install      Skip npm install steps (local mode)
  --verbose           Reserved (no-op)
  -h, --help          Show this help

Examples:
  ./scripts/setup-linux.sh --docker
  ./scripts/setup-linux.sh --docker --dev
  ./scripts/setup-linux.sh --local --start-db
  ./scripts/setup-linux.sh --local --db-push
EOF
}

main() {
  require_in_repo

  local mode=""
  local dev="0"
  local db_push="0"
  local start_db="0"
  local skip_install="0"

  while (($# > 0)); do
    case "$1" in
      --docker)
        mode="docker"
        ;;
      --local)
        mode="local"
        ;;
      --dev)
        dev="1"
        ;;
      --db-push)
        db_push="1"
        ;;
      --start-db)
        start_db="1"
        ;;
      --skip-install)
        skip_install="1"
        ;;
      --mode=*)
        mode="${1#*=}"
        ;;
      --verbose)
        ;;
      -h|--help)
        print_help
        exit 0
        ;;
      --install-db)
        fail "--install-db is only supported on Windows. See README for guidance."
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
    shift
  done

  if [[ -z "$mode" ]]; then
    if command_exists docker; then
      log "No mode specified. Detected Docker; using --docker --dev."
      mode="docker"
      dev="1"
    else
      log "No mode specified. Docker not found; using --local."
      mode="local"
    fi
  fi

  case "$mode" in
    docker)
      setup_docker "$dev"
      ;;
    local)
      setup_local "$skip_install" "$db_push" "$start_db"
      ;;
    *)
      fail "Unknown mode: $mode"
      ;;
  esac
}

main "$@"
