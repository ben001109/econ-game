#!/usr/bin/env bash
# Interactive Linux setup helper for econ-game
# Mirrors the behaviour of the console setup wizard (`node scripts/console.mjs`).

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
VERBOSE_SELECTED=0
if [[ -n "${VERBOSE+x}" ]]; then
  VERBOSE_SELECTED=1
fi
VERBOSE="${VERBOSE:-0}"
MODE=""
DEV="0"
DB_PUSH="0"
START_DB="0"
SKIP_INSTALL="0"
NODE_REQUIRED_VERSION=""
NVM_NOT_FOUND_WARNED=0
SUMMARY_MESSAGES=()
PRIVATE_IP=""
USE_NEW_RELIC=0
NEW_RELIC_LICENSE=""
USE_SENTRY=0
SENTRY_DSN=""
SENTRY_ENVIRONMENT="development"
SENTRY_TRACES_SAMPLE_RATE="0"
SENTRY_PROFILES_SAMPLE_RATE=""
SENTRY_RELEASE=""

log() {
  printf '%s\n' "$1"
}

log_verbose() {
  if [[ "$VERBOSE" == "1" ]]; then
    printf '[verbose] %s\n' "$1"
  fi
}

log_section() {
  printf '\n== %s ==\n' "$1"
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

add_summary_line() {
  SUMMARY_MESSAGES+=("$1")
}

print_summary() {
  if ((${#SUMMARY_MESSAGES[@]} == 0)); then
    return 0
  fi
  printf '\n== Setup Summary ==\n'
  local entry=""
  for entry in "${SUMMARY_MESSAGES[@]}"; do
    printf ' - %s\n' "$entry"
  done
}

ensure_env_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    return 0
  fi
  local example="${path}.example"
  if [[ -f "$example" ]]; then
    cp "$example" "$path"
  else
    : >"$path"
  fi
}

update_env_file() {
  local path="$1"
  shift
  if (($# == 0)); then
    return 1
  fi
  local -a entries=("$@")
  local -a lines=()
  if [[ -f "$path" ]]; then
    mapfile -t lines <"$path"
  fi

  declare -A kv=()
  local -a order=()
  local entry=""
  for entry in "${entries[@]}"; do
    local key="${entry%%=*}"
    local value="${entry#*=}"
     if [[ -z "${kv[$key]+x}" ]]; then
       order+=("$key")
     fi
    kv["$key"]="$value"
  done

  local changed=0
  local idx=0
  for idx in "${!lines[@]}"; do
    local line="${lines[$idx]}"
    if [[ "$line" =~ ^([A-Za-z0-9_.-]+)= ]]; then
      local key="${BASH_REMATCH[1]}"
      if [[ -n "${kv[$key]+x}" ]]; then
        local new_value="${kv[$key]}"
        local new_line="${key}=${new_value}"
        if [[ "$line" != "$new_line" ]]; then
          lines[$idx]="$new_line"
          changed=1
        fi
        unset 'kv[$key]'
      fi
    fi
  done

  local key=""
  for key in "${order[@]}"; do
    if [[ -n "${kv[$key]+x}" ]]; then
      lines+=("${key}=${kv[$key]}")
      changed=1
      unset 'kv[$key]'
    fi
  done

  if [[ "$changed" == "1" ]]; then
    printf '%s\n' "${lines[@]}" >"$path"
    return 0
  fi
  return 1
}

configure_monitoring() {
  local new_relic_value=""
  if [[ "$USE_NEW_RELIC" == "1" ]]; then
    new_relic_value="${NEW_RELIC_LICENSE//$'\r'/}"
    if [[ -z "$new_relic_value" ]]; then
      warn "New Relic enabled but license key empty. Agent will remain disabled."
    fi
  fi

  local sentry_dsn_value=""
  if [[ "$USE_SENTRY" == "1" ]]; then
    sentry_dsn_value="${SENTRY_DSN//$'\r'/}"
    if [[ -z "$sentry_dsn_value" ]]; then
      warn "Sentry enabled but DSN empty. Monitoring will remain disabled."
    fi
  fi

  local sentry_env="${SENTRY_ENVIRONMENT:-development}"
  local sentry_traces="${SENTRY_TRACES_SAMPLE_RATE:-0}"
  if [[ -z "$sentry_traces" ]]; then
    sentry_traces="0"
  fi
  local sentry_profiles="$sentry_traces"
  if [[ -n "$SENTRY_PROFILES_SAMPLE_RATE" ]]; then
    sentry_profiles="$SENTRY_PROFILES_SAMPLE_RATE"
  fi
  local sentry_release_value="${SENTRY_RELEASE:-}"

  local -a env_files=(
    "${SERVICES_DIR}/api/.env"
    "${SERVICES_DIR}/api/.env.local"
    "${SERVICES_DIR}/worker/.env"
    "${SERVICES_DIR}/worker/.env.local"
    "${SERVICES_DIR}/bot/.env"
    "${SERVICES_DIR}/bot/.env.local"
    "${SERVICES_DIR}/frontend/.env"
    "${SERVICES_DIR}/frontend/.env.local"
  )

  local env_file=""
  for env_file in "${env_files[@]}"; do
    if [[ ! -f "$env_file" && "$USE_NEW_RELIC" != "1" && "$USE_SENTRY" != "1" ]]; then
      continue
    fi
    ensure_env_file "$env_file"
    local -a updates=(
      "NEW_RELIC_LICENSE_KEY=${new_relic_value}"
      "SENTRY_DSN=${sentry_dsn_value}"
      "SENTRY_ENVIRONMENT=${sentry_env}"
      "SENTRY_TRACES_SAMPLE_RATE=${sentry_traces}"
      "SENTRY_PROFILES_SAMPLE_RATE=${sentry_profiles}"
      "SENTRY_RELEASE=${sentry_release_value}"
    )
    if [[ "$env_file" == "${SERVICES_DIR}/frontend/.env" || "$env_file" == "${SERVICES_DIR}/frontend/.env.local" ]]; then
      updates+=(
        "NEXT_PUBLIC_SENTRY_DSN=${sentry_dsn_value}"
        "NEXT_PUBLIC_SENTRY_ENVIRONMENT=${sentry_env}"
        "NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${sentry_traces}"
        "NEXT_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE=${sentry_profiles}"
      )
    fi
    if update_env_file "$env_file" "${updates[@]}"; then
      local rel_path="${env_file#"${ROOT}/"}"
      log "Updated monitoring settings in ${rel_path}"
    fi
  done
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

detect_private_ip() {
  local candidate=""
  if command_exists hostname; then
    candidate="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $0 !~ /^127\./ {print; exit}')"
  fi
  if [[ -z "$candidate" ]] && command_exists ip; then
    candidate="$(ip -4 addr show scope global 2>/dev/null | awk '/inet / {sub(/\/.*/, \"\", $2); if ($2 !~ /^127\./) {print $2; exit}}')"
  fi
  if [[ -z "$candidate" ]] && command_exists ifconfig; then
    candidate="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2; exit}')"
  fi
  PRIVATE_IP="$candidate"
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
  detect_private_ip
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

download_to_file() {
  local url="$1"
  local dest="$2"
  local attempted=0
  if command_exists curl; then
    attempted=1
    if curl -fsSL "$url" -o "$dest"; then
      return 0
    fi
    warn "curl failed to download ${url}."
  fi
  if command_exists wget; then
    attempted=1
    if wget -qO "$dest" "$url"; then
      return 0
    fi
    warn "wget failed to download ${url}."
  fi
  if ((attempted == 0)); then
    warn "Neither curl nor wget is available; cannot download ${url}."
  else
    warn "Unable to download ${url} with available tools."
  fi
  return 1
}

install_docker_via_convenience_script() {
  local tmp=""
  tmp="$(mktemp)" || tmp=""
  if [[ -z "$tmp" ]]; then
    warn "mktemp failed; cannot stage Docker installation script."
    return 1
  fi
  if ! download_to_file "https://get.docker.com" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! run_with_sudo sh "$tmp"; then
    warn "Docker convenience script exited with an error."
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  post_install_docker
  return 0
}

post_install_docker() {
  if command_exists systemctl; then
    if ! run_with_sudo systemctl enable --now docker >/dev/null 2>&1; then
      warn "Could not enable/start docker service automatically (you may need to start it manually)."
    fi
  fi
}

install_docker_packages() {
  log "Installing Docker using the official Docker convenience script..."
  if install_docker_via_convenience_script; then
    return 0
  fi
  warn "Docker convenience script did not complete successfully."
  case "$PKG_MANAGER" in
    apt)
      warn "Skipping apt-based Docker packages to honor the non-APT installation requirement."
      ;;
    dnf|yum)
      warn "Retrying Docker installation via ${PKG_MANAGER} packages..."
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
      warn "Retrying Docker installation via pacman..."
      if install_packages docker docker-compose; then
        post_install_docker
        return 0
      fi
      ;;
    zypper)
      warn "Retrying Docker installation via zypper..."
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
  local requires_pkg_manager=1
  case "$dep" in
    docker)
      requires_pkg_manager=0
      ;;
    *)
      requires_pkg_manager=1
      ;;
  esac
  if ((requires_pkg_manager == 1)) && [[ -z "$PKG_MANAGER" ]]; then
    warn "Cannot auto-install ${dep}; no supported package manager detected."
    return 1
  fi
  local strategy=""
  case "$dep" in
    docker)
      strategy="the official Docker convenience script"
      ;;
    *)
      if [[ -n "$PKG_MANAGER" ]]; then
        strategy="$PKG_MANAGER"
      fi
      ;;
  esac
  if [[ -n "$strategy" ]]; then
    log "Attempting to install missing dependency '${dep}' via ${strategy}..."
  else
    log "Attempting to install missing dependency '${dep}'..."
  fi
  case "$dep" in
    docker)
      install_docker_packages || return 1
      ;;
    docker-compose)
      install_docker_compose_packages || return 1
      ;;
    node|npm)
      local desired="${NODE_REQUIRED_VERSION:-}"
      if [[ -z "$desired" ]]; then
        if desired="$(read_nvmrc_version 2>/dev/null)"; then
          :
        else
          desired=""
        fi
      fi
      if [[ -n "$desired" ]] && ensure_node_with_nvm "$desired"; then
        return 0
      fi
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

prompt_verbose_choice() {
  if [[ "$VERBOSE_SELECTED" == "1" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    VERBOSE_SELECTED=1
    return 0
  fi
  printf 'Enable verbose mode? [y/N]: ' >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      VERBOSE=1
      ;;
    n|no|0|"")
      VERBOSE=0
      ;;
    *)
      warn "Unknown selection '${answer}'. Keeping verbose mode disabled."
      ;;
  esac
  VERBOSE_SELECTED=1
}

prompt_docker_options() {
  DEV="1"
  if [[ ! -t 0 ]]; then
    return 0
  fi
  printf 'Include developer containers (api-dev, worker-dev, frontend-dev, bot-dev)? [Y/n]: ' >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    n|no|0)
      DEV="0"
      ;;
    *)
      DEV="1"
      ;;
  esac
  if [[ "$DEV" == "1" ]]; then
    log "Docker dev profile: enabled (hot reload services)."
  else
    log "Docker dev profile: disabled (production-like stack)."
  fi
}

prompt_local_options() {
  SKIP_INSTALL="0"
  DB_PUSH="0"
  START_DB="0"
  if [[ ! -t 0 ]]; then
    return 0
  fi
  printf 'Skip Node.js package installation (npm install)? [y/N]: ' >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      SKIP_INSTALL="1"
      ;;
  esac
  printf 'Start databases after setup? [y/N]: ' >&2
  answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      START_DB="1"
      ;;
  esac
  printf 'Push database migrations/data after setup? [y/N]: ' >&2
  answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      DB_PUSH="1"
      ;;
  esac
  log "Local npm install: $([[ "$SKIP_INSTALL" == "1" ]] && printf 'skipped' || printf 'will run')."
  log "Start local databases: $([[ "$START_DB" == "1" ]] && printf 'yes' || printf 'no')."
  log "Run Prisma db push: $([[ "$DB_PUSH" == "1" ]] && printf 'yes' || printf 'no')."
}

prompt_portainer_selection() {
  INSTALL_PORTAINER=0
  PORTAINER_EDITION=""
  if [[ ! -t 0 ]]; then
    return 0
  fi
  printf 'Deploy Portainer? [y/N]: ' >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      INSTALL_PORTAINER=1
      ;;
    *)
      INSTALL_PORTAINER=0
      ;;
  esac
  if [[ "$INSTALL_PORTAINER" != "1" ]]; then
    log "Portainer deployment skipped."
    return 0
  fi
  printf '%s\n' 'Select Portainer edition:' >&2
  printf '%s\n' '  1) Portainer Community Edition (CE)' >&2
  printf '%s\n' '  2) Portainer Enterprise Edition (EE)' >&2
  printf 'Enter choice [1]: ' >&2
  local selection=""
  read -r selection || selection=""
  selection="${selection,,}"
  case "$selection" in
    2|ee|enterprise|be|business)
      PORTAINER_EDITION="ee"
      ;;
    ""|1|ce|community)
      PORTAINER_EDITION="ce"
      ;;
    *)
      warn "Unknown Portainer edition '${selection}', defaulting to Community Edition."
      PORTAINER_EDITION="ce"
      ;;
  esac
  if [[ "$INSTALL_PORTAINER" == "1" ]]; then
    local label="Community Edition"
    if [[ "$PORTAINER_EDITION" == "ee" ]]; then
      label="Enterprise Edition"
    fi
    log "Portainer deployment selected (${label})."
  else
    log "Portainer deployment skipped."
  fi
}

prompt_monitoring_options() {
  if [[ ! -t 0 ]]; then
    return 0
  fi

  printf 'Configure New Relic APM? [y/N]: ' >&2
  local answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      USE_NEW_RELIC=1
      printf 'Enter New Relic license key: ' >&2
      read -r NEW_RELIC_LICENSE || NEW_RELIC_LICENSE=""
      NEW_RELIC_LICENSE="${NEW_RELIC_LICENSE//$'\r'/}"
      if [[ -z "$NEW_RELIC_LICENSE" ]]; then
        warn 'New Relic enabled but license key empty. Agent will remain disabled.'
      fi
      ;;
    *)
      USE_NEW_RELIC=0
      log 'New Relic configuration skipped.'
      ;;
  esac

  printf 'Configure Sentry monitoring? [y/N]: ' >&2
  answer=""
  read -r answer || answer=""
  case "${answer,,}" in
    y|yes|1)
      USE_SENTRY=1
      printf 'Enter Sentry DSN: ' >&2
      read -r SENTRY_DSN || SENTRY_DSN=""
      SENTRY_DSN="${SENTRY_DSN//$'\r'/}"
      if [[ -z "$SENTRY_DSN" ]]; then
        warn 'Sentry enabled but DSN empty. Monitoring will remain disabled.'
      fi
      printf 'Sentry environment name [development]: ' >&2
      read -r SENTRY_ENVIRONMENT || SENTRY_ENVIRONMENT=""
      SENTRY_ENVIRONMENT="${SENTRY_ENVIRONMENT//$'\r'/}"
      if [[ -z "$SENTRY_ENVIRONMENT" ]]; then
        SENTRY_ENVIRONMENT='development'
      fi
      printf 'Sentry traces sample rate (0-1, default 0): ' >&2
      read -r SENTRY_TRACES_SAMPLE_RATE || SENTRY_TRACES_SAMPLE_RATE=""
      SENTRY_TRACES_SAMPLE_RATE="${SENTRY_TRACES_SAMPLE_RATE//$'\r'/}"
      if [[ -z "$SENTRY_TRACES_SAMPLE_RATE" ]]; then
        SENTRY_TRACES_SAMPLE_RATE='0'
      fi
      printf 'Sentry profiles sample rate (0-1, blank to reuse traces): ' >&2
      read -r SENTRY_PROFILES_SAMPLE_RATE || SENTRY_PROFILES_SAMPLE_RATE=""
      SENTRY_PROFILES_SAMPLE_RATE="${SENTRY_PROFILES_SAMPLE_RATE//$'\r'/}"
      printf 'Sentry release identifier (optional): ' >&2
      read -r SENTRY_RELEASE || SENTRY_RELEASE=""
      SENTRY_RELEASE="${SENTRY_RELEASE//$'\r'/}"
      ;;
    *)
      USE_SENTRY=0
      log 'Sentry configuration skipped.'
      ;;
  esac
}

prompt_mode_selection() {
  if [[ -n "$MODE" ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    if command_exists docker; then
      MODE="docker"
      DEV="1"
      log "Non-interactive mode: auto-selected Docker workflow (dev profile)."
    else
      MODE="local"
      log "Non-interactive mode: auto-selected Local workflow."
    fi
    return 0
  fi
  printf '%s\n' 'Select setup workflow:' >&2
  printf '%s\n' '  1) Docker (Docker Compose stack for services)' >&2
  printf '%s\n' '  2) Local (install Node.js dependencies locally)' >&2
  printf 'Enter choice [1]: ' >&2
  local selection=""
  read -r selection || selection=""
  selection="${selection,,}"
  case "$selection" in
    2|local|l)
      MODE="local"
      ;;
    ""|1|docker|d)
      MODE="docker"
      ;;
    *)
      warn "Unknown selection '${selection}'. Defaulting to Docker workflow."
      MODE="docker"
      ;;
  esac
  log "Selected workflow: ${MODE}."
  if [[ "$MODE" == "docker" ]]; then
    prompt_docker_options
  else
    prompt_local_options
  fi
  prompt_portainer_selection
  prompt_monitoring_options
  return 0
}

format_local_and_lan() {
  local scheme="$1"
  local port="$2"
  local path="${3:-}"
  local local_url="${scheme}://localhost"
  if [[ -n "$port" ]]; then
    local_url+=":${port}"
  fi
  local_url+="$path"
  if [[ -n "$PRIVATE_IP" ]]; then
    local lan_url="${scheme}://${PRIVATE_IP}"
    if [[ -n "$port" ]]; then
      lan_url+=":${port}"
    fi
    lan_url+="$path"
    printf '%s (LAN %s)' "$local_url" "$lan_url"
  else
    printf '%s' "$local_url"
  fi
}

record_docker_summary() {
  local dev_flag="$1"
  if [[ "$dev_flag" == "1" ]]; then
    add_summary_line "Docker dev profile running (api-dev, worker-dev, frontend-dev, bot-dev)."
  else
    add_summary_line "Docker stack running with production profile containers."
  fi
  add_summary_line "Frontend: $(format_local_and_lan http 3000)"
  add_summary_line "API (REST): $(format_local_and_lan http 4000)"
  add_summary_line "Adminer (Postgres UI): $(format_local_and_lan http 8080)"
  add_summary_line "Redis Commander: $(format_local_and_lan http 8081)"
  add_summary_line "Postgres: postgres://game:gamepass@localhost:5432/game"
  if [[ -n "$PRIVATE_IP" ]]; then
    add_summary_line "Postgres from LAN: postgres://game:gamepass@${PRIVATE_IP}:5432/game"
  fi
  add_summary_line "Redis: redis://localhost:6379"
  add_summary_line "Inspect containers with: docker compose ps"
  if [[ "$dev_flag" == "1" ]]; then
    add_summary_line "Follow logs with: docker compose --profile dev logs -f"
  else
    add_summary_line "Follow logs with: docker compose logs -f"
  fi
}

record_local_summary() {
  local skip_install="$1"
  local db_push="$2"
  local start_db="$3"
  add_summary_line "Local development ready in services/."
  add_summary_line "API: cd services/api && npm run dev"
  add_summary_line "Worker: cd services/worker && npm run dev"
  add_summary_line "Frontend: cd services/frontend && npm run dev"
  if [[ "$start_db" == "1" ]]; then
    add_summary_line "Postgres & Redis started via docker compose up -d postgres redis"
  else
    add_summary_line "Remember to start Postgres & Redis (docker compose up -d postgres redis)."
  fi
  if [[ "$skip_install" == "1" ]]; then
    add_summary_line "npm install skipped; run npm install in each service before dev."
  fi
  if [[ "$db_push" == "1" ]]; then
    add_summary_line "Prisma schema pushed to database."
  fi
}

enable_verbose_tracing() {
  if [[ "$VERBOSE" == "1" ]]; then
    log "Verbose mode enabled."
    set -x
  fi
}

choose_portainer_edition() {
  local selection="${PORTAINER_EDITION,,}"
  if [[ -z "$selection" ]]; then
    if [[ -t 0 ]]; then
      printf '%s\n' 'Select Portainer edition' >&2
      printf '%s\n' '  1) Portainer Community Edition (CE)' >&2
      printf '%s\n' '  2) Portainer Enterprise Edition (EE)' >&2
      printf 'Enter choice [1]: ' >&2
      read -r selection || selection=""
      selection="${selection,,}"
    fi
  fi
  if [[ -z "$selection" ]]; then
    selection="1"
  fi
  case "$selection" in
    1|ce|community)
      PORTAINER_EDITION="ce"
      ;;
    2|ee|enterprise|be|business)
      PORTAINER_EDITION="ee"
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
    ee|be)
      image="portainer/portainer-ee:latest"
      label="Enterprise Edition"
      ;;
    *)
      image="portainer/portainer-ce:latest"
      label="Community Edition"
      ;;
  esac

  log "Deploying Portainer ${label} via Docker image '${image}'..."

  if ! docker image inspect "$image" >/dev/null 2>&1; then
    log_verbose "Pulling Portainer image ${image}."
    if ! docker pull "$image" >/dev/null 2>&1; then
      warn "Pre-pull of ${image} failed; Docker will retry during container creation."
    fi
  fi

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
  if [[ "$edition" == "ee" || "$edition" == "be" ]]; then
    warn "Portainer Enterprise Edition requires a valid license after first login."
  fi
  local portainer_endpoint="https://localhost:9443"
  if [[ -n "$PRIVATE_IP" ]]; then
    portainer_endpoint+=" (LAN https://${PRIVATE_IP}:9443)"
  fi
  add_summary_line "Portainer ${label}: ${portainer_endpoint}"
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

read_nvmrc_version() {
  local nvmrc="${ROOT}/.nvmrc"
  if [[ ! -f "$nvmrc" ]]; then
    return 1
  fi
  local raw
  raw="$(tr -d ' \t\r\n' <"$nvmrc")"
  raw="${raw#"v"}"
  if [[ -z "$raw" ]]; then
    return 1
  fi
  printf '%s' "$raw"
}

read_nvmrc() {
  local version
  if ! version="$(read_nvmrc_version)"; then
    return 1
  fi
  printf '%s' "${version%%.*}"
}

extract_major_version() {
  local version="$1"
  version="${version#v}"
  if [[ "$version" =~ ^([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

load_nvm() {
  if command -v nvm >/dev/null 2>&1; then
    return 0
  fi
  local candidates=()
  if [[ -n "${NVM_DIR:-}" ]]; then
    candidates+=("$NVM_DIR")
  fi
  candidates+=("$HOME/.nvm" "/usr/local/nvm" "/usr/share/nvm")
  local candidate=""
  for candidate in "${candidates[@]}"; do
    if [[ -s "${candidate}/nvm.sh" ]]; then
      export NVM_DIR="$candidate"
      # shellcheck disable=SC1090
      . "${candidate}/nvm.sh"
      if command -v nvm >/dev/null 2>&1; then
        return 0
      fi
    fi
  done
  return 1
}

ensure_node_with_nvm() {
  local version="$1"
  if [[ -z "$version" ]]; then
    return 1
  fi
  if ! load_nvm; then
    if ((NVM_NOT_FOUND_WARNED == 0)); then
      warn "nvm not detected; install nvm (https://github.com/nvm-sh/nvm) to manage Node.js versions."
      NVM_NOT_FOUND_WARNED=1
    fi
    return 1
  fi
  if ! nvm ls "$version" >/dev/null 2>&1; then
    log "Installing Node.js ${version} via nvm..."
    if ! nvm install "$version"; then
      warn "nvm install ${version} failed."
      return 1
    fi
  fi
  log "Switching to Node.js ${version} via nvm..."
  if ! nvm use "$version" >/dev/null 2>&1; then
    warn "nvm use ${version} failed."
    return 1
  fi
  hash -r 2>/dev/null || true
  local resolved_version
  resolved_version="$(node --version 2>/dev/null || printf '%s' "$version")"
  log "Node.js active: ${resolved_version}"
  return 0
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
  log_section "Docker Workflow"
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
  record_docker_summary "$dev"
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
  log_section "Local Workflow"

  local required_node_spec="20"
  local nvmrc_spec=""
  if nvmrc_spec="$(read_nvmrc_version 2>/dev/null)"; then
    required_node_spec="$nvmrc_spec"
  fi
  NODE_REQUIRED_VERSION="$required_node_spec"

  local required_node_major=""
  if ! required_node_major="$(extract_major_version "$required_node_spec")"; then
    required_node_major=""
  fi

  local node_via_nvm=0
  if ensure_node_with_nvm "$required_node_spec"; then
    node_via_nvm=1
  fi

  local current_node=""
  if current_node="$(get_node_major)"; then
    if [[ -n "$required_node_major" && "$current_node" -lt "$required_node_major" ]]; then
      warn "Node ${required_node_major}+ recommended (found $(node --version))."
      warn "Run 'nvm install ${required_node_spec}' then rerun."
    fi
  else
    if ((node_via_nvm == 0)); then
      if auto_install_dependency node && current_node="$(get_node_major)"; then
        log "Installed Node.js via ${PKG_MANAGER}."
        if [[ -n "$required_node_major" && "$current_node" -lt "$required_node_major" ]]; then
          warn "Node ${required_node_major}+ recommended (found $(node --version))."
          warn "Run 'nvm install ${required_node_spec}' then rerun."
        fi
      else
        warn "Node is not installed or not in PATH. Some steps may fail."
      fi
    else
      warn "Node is not installed or not in PATH even after attempting nvm setup. Some steps may fail."
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
  record_local_summary "$skip_install" "$db_push" "$start_db"
}

main() {
  require_in_repo

  if (($# > 0)); then
    fail "This script is interactive. Run it without command-line arguments."
  fi

  if [[ "$VERBOSE_SELECTED" != "1" ]]; then
    prompt_verbose_choice
  fi

  enable_verbose_tracing

  initialize_platform

  prompt_mode_selection

  case "$MODE" in
    docker)
      setup_docker "$DEV"
      ;;
    local)
      setup_local "$SKIP_INSTALL" "$DB_PUSH" "$START_DB"
      ;;
    *)
      fail "Unknown mode: ${MODE:-unset}"
      ;;
  esac

  if [[ "$INSTALL_PORTAINER" == "1" ]]; then
    install_portainer
  fi
  configure_monitoring
  print_summary
}

main "$@"
