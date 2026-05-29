#!/bin/bash
# =============================================================================
# local-llms — Instalador automatico
# =============================================================================
# Uso:
#   curl -sL https://raw.githubusercontent.com/luishelgueradev/local-llms/master/install.sh | bash
#
# O desde el repo ya clonado:
#   bash install.sh
#
# Que hace:
#   1. Instala git, curl, openssl, jq, docker, docker compose, nvidia-container-toolkit
#      (omite el toolkit en WSL2 — Docker Desktop trae su propia integracion GPU)
#   2. Crea /opt/luishelgueradev/ + clona el repo
#   3. Corre bin/bootstrap-host.sh (crea /srv/local-llms/... con permisos correctos)
#   4. Corre bin/preflight-gpu.sh (verifica passthrough GPU end-to-end)
#   5. Pregunta los secretos faltantes y arma .env (con backup del existente)
#   6. docker compose --profile <ollama|llamacpp|vllm> up -d --wait
#   7. Pull del modelo workhorse (qwen2.5:7b-instruct-q4_K_M) + embeddings (bge-m3)
#   8. Health check via /healthz del router (curl)
#   9. Imprime URLs de acceso (Tailscale + Cloudflare Tunnel si aplica)
#
# Requisitos del host:
#   - Linux x86_64 con GPU NVIDIA (>=16 GB VRAM recomendado) o Windows + WSL2
#   - Driver NVIDIA en el HOST (NUNCA dentro de WSL); >= 555 para CUDA 12.9 (vllm)
#   - sudo disponible (o ejecutar como root)
#   - Conectividad a github.com, hub.docker.com, ghcr.io, ollama.com
#
# Variables que se pueden pre-setear (para correr 100% desatendido):
#   ROUTER_BEARER_TOKEN, POSTGRES_PASSWORD, VALKEY_PASSWORD, OLLAMA_API_KEY,
#   TAILNET_HOSTNAME, TRAEFIK_BASIC_AUTH_USER, TRAEFIK_BASIC_AUTH_PASS_PLAIN,
#   GRAFANA_ADMIN_PASSWORD, COMPOSE_PROFILE (default: ollama), SKIP_MODEL_PULL=1
# =============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
GIT_USER="luishelgueradev"
APP_NAME="local-llms"
INSTALL_DIR="/opt/${GIT_USER}/${APP_NAME}"
REPO_URL="https://github.com/${GIT_USER}/${APP_NAME}.git"
HEALTH_URL="http://127.0.0.1:3210/healthz"
DEFAULT_PROFILE="${COMPOSE_PROFILE:-ollama}"
WORKHORSE_MODEL="qwen2.5:7b-instruct-q4_K_M"
EMBED_MODEL="bge-m3"

# -- Colores -----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# -- Banner ------------------------------------------------------------------
echo ""
echo "============================================================="
echo "  local-llms — Instalador"
echo "  Router OpenAI/Anthropic-compatible · Ollama · llama.cpp · vLLM"
echo "  + Ollama Cloud fallback · Postgres · Valkey · Traefik · OWUI"
echo "============================================================="
echo ""

# -- Helpers -----------------------------------------------------------------
have()  { command -v "$1" >/dev/null 2>&1; }

# sudo solo si no somos root y existe sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  have sudo && SUDO="sudo" || warn "sin sudo ni root: la instalacion de paquetes puede fallar"
fi

# Detectar gestor de paquetes una vez
PKG=""
for c in apt-get dnf yum apk pacman; do have "$c" && { PKG="$c"; break; }; done

pkg_install() {
  local p="$1"
  case "$PKG" in
    apt-get) $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p" ;;
    dnf|yum) $SUDO "$PKG" install -y "$p" ;;
    apk)     $SUDO apk add --no-cache "$p" ;;
    pacman)  $SUDO pacman -Sy --noconfirm "$p" ;;
    *)       return 1 ;;
  esac
}

ensure_cmd() {
  local cmd="$1" pkg="${2:-$1}"
  have "$cmd" && { ok "$cmd presente"; return 0; }
  info "Falta '$cmd' — instalando ($pkg)..."
  pkg_install "$pkg" && have "$cmd" && ok "$cmd instalado" \
    || error "No pude instalar '$cmd' automaticamente. Instalalo y reintenta."
}

TTY=""; [ -e /dev/tty ] && TTY="/dev/tty"

prompt() {
  local __var="$1" __msg="$2" __def="${3:-}" __cur __ans
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && return 0
  if [ -z "$TTY" ]; then
    [ -n "$__def" ] && { eval "$__var=\$__def"; return 0; } \
                    || error "Falta $__var y no hay terminal. Pasalo como variable de entorno."
  fi
  if [ -n "$__def" ]; then
    read -r -p "$__msg [$__def]: " __ans < "$TTY"; __ans="${__ans:-$__def}"
  else
    read -r -p "$__msg: " __ans < "$TTY"
  fi
  eval "$__var=\$__ans"
}

prompt_secret() {
  local __var="$1" __msg="$2" __cur __ans
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && return 0
  [ -z "$TTY" ] && error "Falta $__var (secreto) y no hay terminal. Pasalo como variable de entorno."
  read -r -s -p "$__msg: " __ans < "$TTY"; echo ""
  eval "$__var=\$__ans"
}

gen_hex_token() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes" 2>/dev/null \
    || python3 -c "import secrets; print(secrets.token_hex($bytes))" 2>/dev/null \
    || head -c "$((bytes * 4))" /dev/urandom | base64 | tr -d '/+=' | cut -c1-$((bytes * 2))
}

# Detectar WSL2 → desactivamos la instalacion del toolkit dentro de WSL
IS_WSL2=0
grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && IS_WSL2=1

# ─── 1. Dependencias base ─────────────────────────────────────────────────────
info "Verificando dependencias base..."
ensure_cmd git
ensure_cmd curl
ensure_cmd openssl
ensure_cmd jq
ensure_cmd ca-certificates ca-certificates 2>/dev/null || true

# Docker (engine + compose plugin v2)
if ! have docker; then
  info "Docker no esta instalado — usando script oficial 'get.docker.com'..."
  curl -fsSL https://get.docker.com | $SUDO sh
  if [ "$IS_WSL2" -eq 0 ]; then
    $SUDO systemctl enable --now docker 2>/dev/null || true
  fi
  ok "Docker instalado"
else
  ok "docker presente ($(docker --version | awk '{print $3}' | tr -d ','))"
fi

if ! docker compose version >/dev/null 2>&1; then
  error "docker compose plugin v2 no encontrado. Reinstalar Docker via get.docker.com (incluye el plugin)."
fi
ok "docker compose v2 presente ($(docker compose version --short))"

# Grupo docker (para no necesitar sudo en cada `docker` post-install)
if [ "$(id -u)" -ne 0 ] && ! id -nG "$(id -un)" | grep -qw docker; then
  info "Agregando $(id -un) al grupo docker..."
  $SUDO usermod -aG docker "$(id -un)" || warn "No pude agregar al grupo docker — esta corrida usara sudo si hace falta."
  warn "Tendras que reloguear (o newgrp docker) para que el cambio aplique fuera de esta corrida."
fi

# ─── 2. GPU passthrough ──────────────────────────────────────────────────────
info "Verificando passthrough GPU..."
if [ "$IS_WSL2" -eq 1 ]; then
  warn "WSL2 detectado — NO instalo nvidia-container-toolkit en el distro."
  warn "Asegurate de tener el driver NVIDIA instalado en WINDOWS (no dentro de WSL)."
  if ! docker info 2>/dev/null | grep -qiE 'nvidia|gpu'; then
    warn "Docker no parece tener integracion GPU activa."
    warn "  Windows: Docker Desktop → Settings → Resources → enable GPU passthrough."
    warn "  Verificalo despues con: docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi"
  else
    ok "Docker reporta integracion GPU"
  fi
else
  if ! have nvidia-ctk; then
    info "Instalando nvidia-container-toolkit (Linux nativo)..."
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq nvidia-container-toolkit
    $SUDO nvidia-ctk runtime configure --runtime=docker
    $SUDO systemctl restart docker
    ok "nvidia-container-toolkit instalado y registrado en Docker"
  else
    ok "nvidia-container-toolkit ya instalado"
  fi
fi

# ─── 3. Clonar repo (con proteccion contra pisar repo de desarrollo) ─────────
info "Preparando $INSTALL_DIR..."
$SUDO mkdir -p "/opt/${GIT_USER}"
$SUDO chown "$(id -un)":"$(id -gn)" "/opt/${GIT_USER}" 2>/dev/null || true

ENV_BACKUP=""
if [ -d "$INSTALL_DIR/.git" ]; then
  EXISTING_REMOTE=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || echo "")
  DIRTY=$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null | wc -l)
  if [ "$DIRTY" -gt 0 ]; then
    error "$INSTALL_DIR tiene cambios sin commitear — abortando para no pisar tu copia de desarrollo. Movela/comiteala y reintenta."
  fi
  if [ -n "$EXISTING_REMOTE" ] && [ "$EXISTING_REMOTE" != "$REPO_URL" ]; then
    warn "$INSTALL_DIR/.git apunta a otro remote: $EXISTING_REMOTE — actualizando a $REPO_URL"
  fi
  info "Instalacion previa detectada — actualizando (git pull)..."
  # Backup del .env antes de tocar nada
  if [ -f "$INSTALL_DIR/.env" ]; then
    ENV_BACKUP="$(mktemp -t local-llms-env-XXXXXX)"
    cp "$INSTALL_DIR/.env" "$ENV_BACKUP"
    ok "Backup de .env existente -> $ENV_BACKUP"
  fi
  # Bajar el stack antes de actualizar fuentes
  ( cd "$INSTALL_DIR" && docker compose --profile "$DEFAULT_PROFILE" down 2>/dev/null || true )
  ( cd "$INSTALL_DIR" && git fetch --all --tags && git reset --hard origin/master )
  ok "Repo actualizado"
else
  info "Clonando $REPO_URL -> $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Repo clonado"
fi

cd "$INSTALL_DIR"

# Restaurar .env si lo tenemos del backup
if [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  ok ".env restaurado desde backup"
  rm -f "$ENV_BACKUP"
fi

# ─── 4. Bootstrap host filesystem (idempotente) ──────────────────────────────
info "Corriendo bin/bootstrap-host.sh (crea /srv/local-llms con permisos)..."
bash "$INSTALL_DIR/bin/bootstrap-host.sh"

# ─── 5. Preflight GPU (idempotente; sale 0 en WSL2 con Docker Desktop) ───────
info "Corriendo bin/preflight-gpu.sh..."
if ! bash "$INSTALL_DIR/bin/preflight-gpu.sh"; then
  error "Preflight GPU fallo. Revisa la salida arriba — sin GPU funcional el stack no levanta. (Si estas en WSL2, asegurate de tener el driver NVIDIA en Windows + GPU passthrough activado en Docker Desktop.)"
fi

# ─── 6. Resolver .env interactivamente ───────────────────────────────────────
ENV_FILE="$INSTALL_DIR/.env"

# Cargar lo que ya este en .env como defaults para los prompts
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE" 2>/dev/null || true; set +a
fi

info "Resolviendo secretos / config en .env (lo que falte se pregunta o se genera)..."

# 1) ROUTER_BEARER_TOKEN — genera 'local-llms_<hex64>' si vacio
if [ -z "${ROUTER_BEARER_TOKEN:-}" ]; then
  ROUTER_BEARER_TOKEN="local-llms_$(gen_hex_token 32)"
  ok "ROUTER_BEARER_TOKEN generado"
fi

# 2) POSTGRES_PASSWORD — genera si vacio
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(gen_hex_token 24)"
  ok "POSTGRES_PASSWORD generado"
fi

# 3) VALKEY_PASSWORD — genera si vacio
if [ -z "${VALKEY_PASSWORD:-}" ]; then
  VALKEY_PASSWORD="$(gen_hex_token 24)"
  ok "VALKEY_PASSWORD generado"
fi

# 4) OWUI_SECRET_KEY — genera si vacio
if [ -z "${OWUI_SECRET_KEY:-}" ]; then
  OWUI_SECRET_KEY="$(gen_hex_token 32)"
  ok "OWUI_SECRET_KEY generado"
fi

# 5) GRAFANA_ADMIN_PASSWORD — genera si vacio
if [ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]; then
  GRAFANA_ADMIN_PASSWORD="$(gen_hex_token 16)"
  ok "GRAFANA_ADMIN_PASSWORD generado"
fi

# 6) OLLAMA_API_KEY — opcional (solo si se va a usar Ollama Cloud)
if [ -z "${OLLAMA_API_KEY:-}" ]; then
  prompt OLLAMA_API_KEY "OLLAMA_API_KEY (Ollama Cloud — opcional; vacio = solo local)" ""
fi

# 7) TAILNET_HOSTNAME — opcional (para acceso via *.<tailnet>.ts.net)
if [ -z "${TAILNET_HOSTNAME:-}" ]; then
  DETECTED_TAILNET=""
  if have tailscale; then
    DETECTED_TAILNET="$(tailscale status --json 2>/dev/null | jq -r '.MagicDNSSuffix // empty' | sed 's/\.$//' | sed 's/\.ts\.net$//' 2>/dev/null || echo "")"
  fi
  prompt TAILNET_HOSTNAME "TAILNET_HOSTNAME (sufijo del tailnet, sin .ts.net — vacio = saltear Tailscale)" "${DETECTED_TAILNET:-local-llms}"
fi

# 8) TRAEFIK basic auth para OpenWebUI — htpasswd-style
if [ -z "${TRAEFIK_BASIC_AUTH:-}" ]; then
  prompt TRAEFIK_BASIC_AUTH_USER "Usuario para OpenWebUI basic-auth" "admin"
  if [ -z "${TRAEFIK_BASIC_AUTH_PASS_PLAIN:-}" ]; then
    prompt_secret TRAEFIK_BASIC_AUTH_PASS_PLAIN "Password para OpenWebUI basic-auth"
  fi
  if have htpasswd; then
    TRAEFIK_BASIC_AUTH="$(htpasswd -nbB "$TRAEFIK_BASIC_AUTH_USER" "$TRAEFIK_BASIC_AUTH_PASS_PLAIN" 2>/dev/null)"
  else
    # Fallback: bcrypt via python3 / openssl no es trivial; usamos APR1 (compatible Traefik)
    info "htpasswd no instalado — instalando apache2-utils..."
    pkg_install apache2-utils 2>/dev/null || pkg_install httpd-tools 2>/dev/null || error "Instala 'apache2-utils' o 'httpd-tools' (htpasswd) y reintenta."
    TRAEFIK_BASIC_AUTH="$(htpasswd -nbB "$TRAEFIK_BASIC_AUTH_USER" "$TRAEFIK_BASIC_AUTH_PASS_PLAIN" 2>/dev/null)"
  fi
  ok "TRAEFIK_BASIC_AUTH calculado para usuario '$TRAEFIK_BASIC_AUTH_USER'"
fi

# 9) HOST_DATA_ROOT — default /srv/local-llms (bootstrap ya lo creo)
HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"

# Construir .env desde .env.example, sustituyendo valores resueltos
info "Escribiendo $ENV_FILE..."

# Si no existe, partir de .env.example
[ -f "$ENV_FILE" ] || cp "$INSTALL_DIR/.env.example" "$ENV_FILE"

# Sustituir clave-por-clave (idempotente con sed in-place)
set_env_var() {
  local key="$1" val="$2"
  # Escapar caracteres especiales para sed: & y / y \n
  local escaped
  escaped=$(printf '%s' "$val" | sed -e 's/[\/&]/\\&/g')
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

set_env_var COMPOSE_PROJECT_NAME "local-llms"
set_env_var HOST_DATA_ROOT       "$HOST_DATA_ROOT"
set_env_var ROUTER_BEARER_TOKEN  "$ROUTER_BEARER_TOKEN"
set_env_var POSTGRES_PASSWORD    "$POSTGRES_PASSWORD"
set_env_var VALKEY_PASSWORD      "$VALKEY_PASSWORD"
set_env_var OWUI_SECRET_KEY      "$OWUI_SECRET_KEY"
set_env_var GRAFANA_ADMIN_PASSWORD "$GRAFANA_ADMIN_PASSWORD"
set_env_var OLLAMA_API_KEY       "${OLLAMA_API_KEY:-}"
set_env_var TAILNET_HOSTNAME     "${TAILNET_HOSTNAME:-}"
set_env_var TRAEFIK_BASIC_AUTH   "${TRAEFIK_BASIC_AUTH:-}"
[ -n "${TRAEFIK_BASIC_AUTH_USER:-}" ]       && set_env_var TRAEFIK_BASIC_AUTH_USER       "$TRAEFIK_BASIC_AUTH_USER"
[ -n "${TRAEFIK_BASIC_AUTH_PASS_PLAIN:-}" ] && set_env_var TRAEFIK_BASIC_AUTH_PASS_PLAIN "$TRAEFIK_BASIC_AUTH_PASS_PLAIN"

chmod 600 "$ENV_FILE"
ok ".env escrito ($(wc -l < "$ENV_FILE") lineas, modo 600)"

# ─── 7. Levantar stack ───────────────────────────────────────────────────────
info "Levantando stack con profile '$DEFAULT_PROFILE'..."
cd "$INSTALL_DIR"
# Permitir docker sin sudo para esta corrida si el usuario aun no fue al grupo docker
DOCKER="docker"
if [ "$(id -u)" -ne 0 ] && ! id -nG "$(id -un)" | grep -qw docker; then
  DOCKER="sudo docker"
fi

# `compose up -d --wait` espera healthchecks; pero compose con profiles + GPU
# preflight container puede demorar. Subir en pasos:
$DOCKER compose --profile "$DEFAULT_PROFILE" pull --quiet || warn "compose pull fallo (no fatal — build local seguira)"
$DOCKER compose --profile "$DEFAULT_PROFILE" up -d --wait --wait-timeout 180 \
  || { warn "compose up no llego a healthy en 180s — revisando estado..."; $DOCKER compose ps; }

# ─── 8. Pull del modelo workhorse + embeddings ───────────────────────────────
if [ "${SKIP_MODEL_PULL:-0}" = "1" ]; then
  warn "SKIP_MODEL_PULL=1 — salteando pull de $WORKHORSE_MODEL + $EMBED_MODEL"
else
  if [ "$DEFAULT_PROFILE" = "ollama" ]; then
    info "Pull del modelo workhorse '$WORKHORSE_MODEL' (puede demorar ~5min la primera vez)..."
    $DOCKER compose exec -T ollama ollama pull "$WORKHORSE_MODEL" \
      || warn "Pull de $WORKHORSE_MODEL fallo — podes hacerlo despues con: docker compose exec ollama ollama pull $WORKHORSE_MODEL"
    info "Pull del modelo de embeddings '$EMBED_MODEL'..."
    $DOCKER compose exec -T ollama ollama pull "$EMBED_MODEL" \
      || warn "Pull de $EMBED_MODEL fallo — corre manualmente despues."
  fi
fi

# ─── 9. Health check ─────────────────────────────────────────────────────────
info "Health check via $HEALTH_URL (hasta 30s)..."
RETRIES=0
MAX_RETRIES=15
while [ $RETRIES -lt $MAX_RETRIES ]; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    ok "Router /healthz responde 200"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 2
done
if [ $RETRIES -ge $MAX_RETRIES ]; then
  warn "Health check NO paso en 30s. Logs del router:"
  $DOCKER compose logs router --tail 30 || true
  warn "Reintenta despues con: curl -fsS $HEALTH_URL && docker compose ps"
fi

# ─── 10. Resumen final ───────────────────────────────────────────────────────
TAILSCALE_IP=""
have tailscale && TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -1 || echo "")"

cat <<EOF

=============================================================
  ${GREEN}Instalacion completada${NC}
=============================================================

  Stack:      local-llms (profile: $DEFAULT_PROFILE)
  Ubicacion:  $INSTALL_DIR
  Host data:  $HOST_DATA_ROOT
  Bearer:     $ROUTER_BEARER_TOKEN

  ──── Acceso local (loopback) ────────────────────────────
  Router:      http://127.0.0.1:3210
    test:      curl -H "Authorization: Bearer \$ROUTER_BEARER_TOKEN" \\
                    -H "Content-Type: application/json" \\
                    -d '{"model":"chat-local","messages":[{"role":"user","content":"OK"}]}' \\
                    http://127.0.0.1:3210/v1/chat/completions

EOF

if [ -n "${TAILNET_HOSTNAME:-}" ] && [ -n "$TAILSCALE_IP" ]; then
cat <<EOF
  ──── Acceso via Tailscale (recomendado) ─────────────────
  Router:      http://router.${TAILNET_HOSTNAME}.ts.net
  Open WebUI:  http://chat.${TAILNET_HOSTNAME}.ts.net    (user/pass: el que diste)
  Grafana:     http://grafana.${TAILNET_HOSTNAME}.ts.net

  Si los nombres no resuelven desde otra maquina, agregar al /etc/hosts:
    ${TAILSCALE_IP}    router.${TAILNET_HOSTNAME}.ts.net chat.${TAILNET_HOSTNAME}.ts.net grafana.${TAILNET_HOSTNAME}.ts.net

EOF
fi

cat <<EOF
  ──── Comandos utiles ────────────────────────────────────
  Logs:        cd $INSTALL_DIR && docker compose logs -f router
  Estado:      cd $INSTALL_DIR && docker compose ps
  Reiniciar:   cd $INSTALL_DIR && docker compose --profile $DEFAULT_PROFILE restart
  Bajar:       cd $INSTALL_DIR && docker compose --profile $DEFAULT_PROFILE down
  Smoke:       cd $INSTALL_DIR && bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210

  ──── Proximos pasos opcionales ──────────────────────────
  1. Cloudflare Tunnel para exposicion publica: ver DEPLOY.md §"Cloudflare Tunnel"
  2. Backups off-host (restic): completar BACKUP_RESTIC_REPO en .env + cron bin/backup-postgres.sh
  3. Disk alert: completar DISK_ALERT_THRESHOLD_PCT y cron bin/disk-alert.sh
  4. Cambiar de profile (llamacpp o vllm): docker compose --profile <X> up -d --wait

=============================================================
EOF
