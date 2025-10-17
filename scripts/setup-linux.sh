#!/usr/bin/env bash
# Linux setup helper for econ-game
# Mirrors the behaviour of scripts/setup.mjs for common workflows:
#   ./scripts/setup-linux.sh --docker [--dev]
#   ./scripts/setup-linux.sh --local [--start-db] [--db-push] [--skip-install]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES_DIR="${ROOT}/services"
DOCKER_COMPOSE=()
OS_NAME=""
OS_ID=""
OS_ID_LIKE=""
PKG_MANAGER=""
APT_UPDATED=0
AUTO_INSTALL="${AUTO_INSTALL:-1}"
INSTALL_PORTAINER=0
PORTAINER_EDITION="${PORTAINER_EDITION:-}"

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

run_with_sudo() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  elif command_exists sudo; then
    sudo "$@"
  else
    warn "Missing sudo; cannot execute: $*"
    return 1
  fi
}

require_in_repo() {
  if [[ ! -d "$SERVICES_DIR" ]]; then
    fail "Please run from repo root (missing ./services)."
  fi
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_NAME="${NAME:-Linux}"
    OS_ID="${ID:-}"
    OS_ID_LIKE="${ID_LIKE:-}"
  else
    local kernel
    kernel="$(uname -s 2>/dev/null || printf 'Linux')"
    OS_NAME="$kernel"
    OS_ID="${kernel,,}"
    OS_ID_LIKE=""
  fi
}

detect_pkg_manager() {
  if command_exists apt-get; then
    PKG_MANAGER="apt"
  elif command_exists dnf; then
    PKG_MANAGER="dnf"
  elif command_exists yum; then
    PKG_MANAGER="yum"
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
  elif command_exists zypper; then
    PKG_MANAGER="zypper"
  else
    PKG_MANAGER=""
  fi
}

initialize_platform() {
  detect_os
  detect_pkg_manager
  if [[ -n "$OS_NAME" ]]; then
    if [[ -n "$PKG_MANAGER" ]]; then
      log "Detected OS: ${OS_NAME} (package manager: ${PKG_MANAGER})."
    else
      warn "Detected OS: ${OS_NAME}. No supported package manager found for auto-install."
    fi
  fi
  if [[ "$AUTO_INSTALL" != "1" ]]; then
    log "Automatic dependency installation disabled (--no-auto-install)."
  fi
}

apt_update_if_needed() {
  if [[ "$PKG_MANAGER" != "apt" ]]; then
    return 0
  fi
  if ((APT_UPDATED == 1)); then
    return 0
  fi
  if run_with_sudo apt-get update; then
    APT_UPDATED=1
    return 0
  fi
  warn "apt-get update failed."
  return 1
}

install_packages() {
  local packages=("$@")
  if ((${#packages[@]} == 0)); then
    return 0
  fi
  if [[ -z "$PKG_MANAGER" ]]; then
    warn "Cannot install packages (${packages[*]}): package manager not detected."
    return 1
  fi
  log "Installing packages via ${PKG_MANAGER}: ${packages[*]}"
  case "$PKG_MANAGER" in
    apt)
      apt_update_if_needed || return 1
      if run_with_sudo apt-get install -y "${packages[@]}"; then
        return 0
      fi
      ;;
    dnf)
      if run_with_sudo dnf install -y "${packages[@]}"; then
        return 0
      fi
      ;;
    yum)
      if run_with_sudo yum install -y "${packages[@]}"; then
        return 0
      fi
      ;;
    pacman)
      if run_with_sudo pacman -Sy --noconfirm "${packages[@]}"; then
        return 0
      fi
      ;;
    zypper)
      if run_with_sudo zypper --non-interactive install -y "${packages[@]}"; then
        return 0
      fi
      ;;
    *)
      warn "Package installation not configured for manager: ${PKG_MANAGER}"
      return 1
      ;;
  esac
  warn "Failed to install packages via ${PKG_MANAGER}: ${packages[*]}"
  return 1
}

install_basic_packages() {
  install_packages "$@"
}

post_install_docker() {
  if command_exists systemctl; then
    if ! run_with_sudo systemctl enable --now docker >/dev/null 2>&1; then
      warn "Could not enable/start docker service automatically (you may need to start it manually)."
    fi
  fi
}

install_docker_packages() {
  case "$PKG_MANAGER" in
    apt)
      if install_packages docker.io docker-compose-plugin; then
        post_install_docker
        return 0
      fi
      ;;
    dnf|yum)
      if install_packages docker docker-compose; then
        post_install_docker
        return 0
      fi
      warn "Retrying Docker installation with moby-engine..."
      if install_packages moby-engine docker-compose; then
        post_install_docker
        return 0
      fi
      ;;
    pacman)
      if install_packages docker docker-compose; then
        post_install_docker
        return 0
      fi
      ;;
    zypper)
      if install_packages docker docker-compose; then
        post_install_docker
        return 0
      fi
      ;;
    *)
      warn "Docker installation not configured for manager: ${PKG_MANAGER:-unknown}"
      ;;
  esac
  warn "Automatic Docker installation failed."
  return 1
}

install_docker_compose_packages() {
  case "$PKG_MANAGER" in
    apt)
      if install_packages docker-compose-plugin; then
        return 0
      fi
      ;;
    dnf|yum|zypper)
      if install_packages docker-compose; then
        return 0
      fi
      ;;
    pacman)
      if install_packages docker-compose; then
        return 0
      fi
      ;;
    *)
      warn "Docker Compose installation not configured for manager: ${PKG_MANAGER:-unknown}"
      ;;
  esac
  warn "Automatic Docker Compose installation failed."
  return 1
}

install_node_packages() {
  case "$PKG_MANAGER" in
    apt|dnf|yum|pacman|zypper)
      if install_packages nodejs npm; then
        return 0
      fi
      ;;
    *)
      warn "Node installation not configured for manager: ${PKG_MANAGER:-unknown}"
      ;;
  esac
  warn "Automatic Node.js installation failed."
  return 1
}

auto_install_dependency() {
  local dep="$1"
  if [[ "$AUTO_INSTALL" != "1" ]]; then
    return 1
  fi
  if [[ -z "$PKG_MANAGER" ]]; then
    warn "Cannot auto-install ${dep}; no supported package manager detected."
    return 1
  fi
  log "Attempting to install missing dependency '${dep}' via ${PKG_MANAGER}..."
  case "$dep" in
    docker)
      install_docker_packages || return 1
      ;;
    docker-compose)
      install_docker_compose_packages || return 1
      ;;
    node|npm)
      install_node_packages || return 1
      ;;
    git|curl)
      install_basic_packages "$dep" || return 1
      ;;
    *)
      warn "No auto-install routine configured for '${dep}'."
      return 1
      ;;
  esac
  return 0
}

choose_portainer_edition() {
  local selection="${PORTAINER_EDITION,,}"
  if [[ -z "$selection" ]]; then
    if [[ -t 0 ]]; then
      printf 'Install Portainer Community Edition (ce) or Business Edition (be)? [ce/be]: ' >&2
      read -r selection || selection=""
      selection="${selection,,}"
    fi
  fi
  if [[ -z "$selection" ]]; then
    selection="ce"
  fi
  case "$selection" in
    ce|community)
      PORTAINER_EDITION="ce"
      ;;
    be|business|ee)
      PORTAINER_EDITION="be"
      ;;
    *)
      warn "Unknown Portainer edition '${selection}', defaulting to Community Edition."
      PORTAINER_EDITION="ce"
      ;;
  esac
}

install_portainer() {
  choose_portainer_edition
  ensure_docker
  if ! docker info >/dev/null 2>&1; then
    if command_exists systemctl; then
      run_with_sudo systemctl start docker >/dev/null 2>&1 || true
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon is not running. Start Docker and retry Portainer installation."
  fi

  local edition="$PORTAINER_EDITION"
  local image=""
  local label=""
  case "$edition" in
    be)
      image="portainer/portainer-ee:latest"
      label="Business Edition"
      ;;
    *)
      image="portainer/portainer-ce:latest"
      label="Community Edition"
      ;;
  esac

  log "Deploying Portainer ${label}..."

  if docker ps -a --format '{{.Names}}' | grep -Fxq 'portainer'; then
    warn "A container named 'portainer' already exists. Skipping Portainer deployment."
    return 0
  fi

  if ! docker volume inspect portainer_data >/dev/null 2>&1; then
    if ! docker volume create portainer_data >/dev/null; then
      fail "Failed to create Docker volume 'portainer_data' for Portainer."
    fi
  fi

  if ! docker run -d \
    --name portainer \
    --restart=always \
    -p 8000:8000 \
    -p 9443:9443 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v portainer_data:/data \
    "$image" >/dev/null; then
    fail "Portainer deployment failed. Review Docker output for details."
  fi

  log "Portainer ${label} is running on https://localhost:9443 (or your host IP)."
  if [[ "$edition" == "be" ]]; then
    warn "Portainer Business Edition requires a valid license after first login."
  fi
}

ensure_docker() {
  if ((${#DOCKER_COMPOSE[@]} > 0)); then
    return 0
  fi
  if ! command_exists docker; then
    if auto_install_dependency docker && command_exists docker; then
      log "Docker installation complete."
    else
      fail "Docker is required. Install Docker engine before continuing."
    fi
  fi
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
    return 0
  fi
  if command_exists docker-compose; then
    DOCKER_COMPOSE=(docker-compose)
    return 0
  fi
  if auto_install_dependency docker-compose; then
    if docker compose version >/dev/null 2>&1; then
      DOCKER_COMPOSE=(docker compose)
      return 0
    fi
    if command_exists docker-compose; then
      DOCKER_COMPOSE=(docker-compose)
      return 0
    fi
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
    if auto_install_dependency node && current_node="$(get_node_major)"; then
      log "Installed Node.js via ${PKG_MANAGER}."
      if [[ "$current_node" -lt "$required_node" ]]; then
        warn "Node ${required_node}+ recommended (found $(node --version))."
        warn "Use nvm: 'nvm use' then rerun if available."
      fi
    else
      warn "Node is not installed or not in PATH. Some steps may fail."
    fi
  fi

  if ! command_exists npm; then
    if auto_install_dependency node && command_exists npm; then
      log "Installed npm via ${PKG_MANAGER}."
    else
      warn "npm is not installed or not in PATH. npm install steps may fail."
    fi
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
  --no-auto-install   Disable automatic package installation
  --auto-install      Re-enable automatic package installation (default)
  --portainer         Deploy Portainer (select edition interactively)
  --portainer=ce      Deploy Portainer Community Edition
  --portainer=be      Deploy Portainer Business Edition
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
      --no-auto-install)
        AUTO_INSTALL=0
        ;;
      --auto-install)
        AUTO_INSTALL=1
        ;;
      --portainer)
        INSTALL_PORTAINER=1
        PORTAINER_EDITION=""
        ;;
      --portainer=*)
        INSTALL_PORTAINER=1
        PORTAINER_EDITION="${1#*=}"
        ;;
      --portainer-ce)
        INSTALL_PORTAINER=1
        PORTAINER_EDITION="ce"
        ;;
      --portainer-be)
        INSTALL_PORTAINER=1
        PORTAINER_EDITION="be"
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

  initialize_platform

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

  if [[ "$INSTALL_PORTAINER" == "1" ]]; then
    install_portainer
  fi
}

main "$@"
