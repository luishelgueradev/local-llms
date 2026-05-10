#!/usr/bin/env bash
set -euo pipefail

# bin/bootstrap-host.sh — idempotent host filesystem bootstrap for local-llms
# Usage: bash bin/bootstrap-host.sh
#
# Creates the full v1 host tree under HOST_DATA_ROOT, sets ownership to the
# invoking user, copies .env.example → .env if missing, and prints next steps.
#
# Safe to re-run: every mkdir is -p, every chown is conditional, .env copy
# uses cp -n (no-clobber). No apt install, no curl | sh, no ollama pull,
# no docker commands — those are documented manual steps in README.md.

# ── Resolve script location ───────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Load HOST_DATA_ROOT from .env if present (fall back to default) ───────────
HOST_DATA_ROOT="/srv/local-llms"
if [ -f "$REPO_ROOT/.env" ]; then
  # Source only HOST_DATA_ROOT to avoid polluting the shell with all env vars
  HOST_DATA_ROOT_FROM_ENV=$(grep -E '^HOST_DATA_ROOT=' "$REPO_ROOT/.env" | head -1 | cut -d'=' -f2- || true)
  if [ -n "$HOST_DATA_ROOT_FROM_ENV" ]; then
    HOST_DATA_ROOT="$HOST_DATA_ROOT_FROM_ENV"
  fi
fi

echo "[bootstrap] Using host data root: ${HOST_DATA_ROOT}"

# ── Create the full v1 host tree idempotently (D-02) ─────────────────────────
# Try without sudo first; fall back to sudo if the directory is not writable.
_create_dirs() {
  mkdir -p \
    "${HOST_DATA_ROOT}/models-gguf/gguf" \
    "${HOST_DATA_ROOT}/models-gguf/ollama" \
    "${HOST_DATA_ROOT}/models-hf" \
    "${HOST_DATA_ROOT}/postgres" \
    "${HOST_DATA_ROOT}/valkey" \
    "${HOST_DATA_ROOT}/traefik/acme" \
    "${HOST_DATA_ROOT}/traefik/logs"
}

if mkdir -p "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null; then
  rmdir "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null || true
  echo "[bootstrap] Creating directory tree (no sudo needed)..."
  _create_dirs
else
  echo "[bootstrap] Creating directory tree (sudo required for ${HOST_DATA_ROOT})..."
  sudo mkdir -p \
    "${HOST_DATA_ROOT}/models-gguf/gguf" \
    "${HOST_DATA_ROOT}/models-gguf/ollama" \
    "${HOST_DATA_ROOT}/models-hf" \
    "${HOST_DATA_ROOT}/postgres" \
    "${HOST_DATA_ROOT}/valkey" \
    "${HOST_DATA_ROOT}/traefik/acme" \
    "${HOST_DATA_ROOT}/traefik/logs"
fi

echo "[bootstrap] Host tree created:"
echo "  ${HOST_DATA_ROOT}/models-gguf/gguf"
echo "  ${HOST_DATA_ROOT}/models-gguf/ollama"
echo "  ${HOST_DATA_ROOT}/models-hf"
echo "  ${HOST_DATA_ROOT}/postgres"
echo "  ${HOST_DATA_ROOT}/valkey"
echo "  ${HOST_DATA_ROOT}/traefik/acme"
echo "  ${HOST_DATA_ROOT}/traefik/logs"

# ── Set ownership to the invoking user ───────────────────────────────────────
#
# ─── chown — Phase 1 scope ────────────────────────────────────────────────
# SAFE in Phase 1: only models-gguf/, models-hf/, traefik/{acme,logs}/ exist
#                  with real content; all are user-owned.
#
# FUTURE FOOTGUN — DO NOT REMOVE THIS COMMENT:
#   After Phase 5 (Postgres, postgres/ subdir) and Phase 8 (Valkey,
#   valkey/ subdir) land, those services run as non-user uids inside
#   their containers (Postgres uid 999, Valkey uid 999/1000 depending
#   on image). A blanket `chown -R $(id -u):$(id -g) ${HOST_DATA_ROOT}`
#   on a re-run will clobber the required ownership and break Postgres
#   on the next `docker compose up`.
#
#   When Phase 5 or Phase 8 lands, this script MUST be updated to
#   exclude postgres/ and valkey/ from the recursive chown — e.g. via
#   `find "${HOST_DATA_ROOT}" -mindepth 1 -maxdepth 1 \
#      ! -name postgres ! -name valkey -exec chown -R ... {} +`
#   or by chowning the specific Phase 1 subdirs explicitly.
#
#   Phase 1 itself requires NO logic change — just this comment so the
#   constraint is not forgotten when the later phases ship.
# ──────────────────────────────────────────────────────────────────────────
CURRENT_UID=$(id -u)
DIR_UID=$(stat -c '%u' "${HOST_DATA_ROOT}" 2>/dev/null || echo "0")
if [ "${DIR_UID}" != "${CURRENT_UID}" ]; then
  echo "[bootstrap] Setting ownership of ${HOST_DATA_ROOT} to $(id -u):$(id -g)..."
  sudo chown -R "$(id -u):$(id -g)" "${HOST_DATA_ROOT}"
else
  echo "[bootstrap] Ownership of ${HOST_DATA_ROOT} already correct (uid ${CURRENT_UID})."
fi

# ── Copy .env.example → .env if missing (D-14) ───────────────────────────────
if [ ! -f "$REPO_ROOT/.env" ]; then
  if [ ! -f "$REPO_ROOT/.env.example" ]; then
    echo "[bootstrap] ERROR: .env.example not found at ${REPO_ROOT}/.env.example"
    echo "[bootstrap] ERROR: Cannot create .env — please run from the repo root."
    exit 1
  fi
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  chmod 600 "$REPO_ROOT/.env"
  echo "[bootstrap] Created .env from .env.example. Edit it to fill in tokens for later phases."
else
  echo "[bootstrap] .env already exists — leaving it alone."
fi

# ── Print next steps ──────────────────────────────────────────────────────────
echo ""
echo "Bootstrap complete."
echo ""
echo "Host data root: ${HOST_DATA_ROOT}"
echo ".env file:      ${REPO_ROOT}/.env"
echo ""
cat <<'NEXTSTEPS'
Next steps:
  1. Run bin/preflight-gpu.sh to verify GPU passthrough.
  2. Once preflight exits 0, run: docker compose up -d
  3. After Ollama is healthy, pull the verification model:
       docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M
  4. Run bin/smoke-test-gpu.sh to verify GPU inference end-to-end.
NEXTSTEPS
