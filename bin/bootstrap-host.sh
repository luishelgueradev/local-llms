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
# Single source of truth for the v1 host directory list. If you add a new
# service in a later phase, add its directory here ONLY — both the
# unprivileged and the sudo branches consume this array.
DIRS=(
  "${HOST_DATA_ROOT}/models-gguf/gguf"
  "${HOST_DATA_ROOT}/models-gguf/ollama"
  "${HOST_DATA_ROOT}/models-hf"
  "${HOST_DATA_ROOT}/postgres-data"     # compose.yml: postgres-data:/var/lib/postgresql/data
  "${HOST_DATA_ROOT}/postgres-backups"  # compose.yml: postgres-backups:/backups (pg-backup sidecar)
  "${HOST_DATA_ROOT}/valkey"
  "${HOST_DATA_ROOT}/traefik/acme"
  "${HOST_DATA_ROOT}/traefik/logs"
  # Phase 7 (Plan 07-01) — vLLM torch.compile AOT cache. Bind-mounted at
  # /root/.cache/vllm in the vllm: and vllm-embed: services so the 264s
  # torch.compile step (07-00-SUMMARY.md Wave 0 evidence) is amortized
  # across cold-starts instead of being re-paid every restart.
  "${HOST_DATA_ROOT}/vllm-compile-cache"
  # Phase 7 (Plan 07-02) — observability state dirs. Both are bind-mounted by
  # the prometheus: and grafana: services for persistent TSDB / Grafana state.
  # Pre-create them here so the bind-mount sources exist on a fresh host AND
  # have the right ownership (Pitfall P-2 — prom runs as uid 65534; chown
  # handled in the targeted loop below).
  "${HOST_DATA_ROOT}/prometheus"
  "${HOST_DATA_ROOT}/grafana"
)

# Try without sudo first; fall back to sudo if the directory is not writable.
if mkdir -p "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null; then
  rmdir "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null || true
  echo "[bootstrap] Creating directory tree (no sudo needed)..."
  mkdir -p "${DIRS[@]}"
else
  echo "[bootstrap] Creating directory tree (sudo required for ${HOST_DATA_ROOT})..."
  sudo mkdir -p "${DIRS[@]}"
fi

echo "[bootstrap] Host tree created:"
echo "  ${HOST_DATA_ROOT}/models-gguf/gguf"
echo "  ${HOST_DATA_ROOT}/models-gguf/ollama"
echo "  ${HOST_DATA_ROOT}/models-hf"
echo "  ${HOST_DATA_ROOT}/postgres-data"
echo "  ${HOST_DATA_ROOT}/postgres-backups"
echo "  ${HOST_DATA_ROOT}/valkey"
echo "  ${HOST_DATA_ROOT}/traefik/acme"
echo "  ${HOST_DATA_ROOT}/traefik/logs"
echo "  ${HOST_DATA_ROOT}/vllm-compile-cache"
echo "  ${HOST_DATA_ROOT}/prometheus"
echo "  ${HOST_DATA_ROOT}/grafana"

# ── Set ownership to the invoking user (targeted — Phase 5 guard active) ─────
#
# Phase 5 (Postgres) has shipped. postgres-data/ and postgres-backups/ must be
# owned by uid 70 (postgres:17-alpine) — NOT by the invoking user. A blanket
# `chown -R $(id -u):$(id -g) ${HOST_DATA_ROOT}` clobbers that ownership and
# breaks the Postgres container on the next `docker compose up postgres`.
#
# Strategy:
#   1. Chown only the user-owned subtrees explicitly (models-gguf, models-hf,
#      valkey, traefik).
#   2. Pre-set postgres-data/ and postgres-backups/ to uid 70:70 so the
#      postgres:17-alpine container can write immediately without a runtime
#      `chown` step.
echo "[bootstrap] Setting directory ownership..."

for dir in \
  "${HOST_DATA_ROOT}/models-gguf" \
  "${HOST_DATA_ROOT}/models-hf" \
  "${HOST_DATA_ROOT}/valkey" \
  "${HOST_DATA_ROOT}/traefik" \
  "${HOST_DATA_ROOT}/vllm-compile-cache" \
  "${HOST_DATA_ROOT}/grafana"; do
  if [ -d "$dir" ]; then
    dir_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "0")
    if [ "$dir_uid" != "$(id -u)" ]; then
      sudo chown -R "$(id -u):$(id -g)" "$dir"
      echo "[bootstrap]   chown $(id -u):$(id -g) $dir (was uid $dir_uid)"
    else
      echo "[bootstrap]   $dir — ownership already correct (uid $(id -u))"
    fi
  fi
done

# Postgres dirs: owned by uid 70 (postgres:17-alpine). Pre-create with the
# correct uid so the container can write immediately on first `compose up`.
sudo chown 70:70 "${HOST_DATA_ROOT}/postgres-data" 2>/dev/null \
  && echo "[bootstrap]   chown 70:70 ${HOST_DATA_ROOT}/postgres-data" \
  || echo "[bootstrap]   chown 70:70 ${HOST_DATA_ROOT}/postgres-data — skipped (may not exist yet)"
sudo chown 70:70 "${HOST_DATA_ROOT}/postgres-backups" 2>/dev/null \
  && echo "[bootstrap]   chown 70:70 ${HOST_DATA_ROOT}/postgres-backups" \
  || echo "[bootstrap]   chown 70:70 ${HOST_DATA_ROOT}/postgres-backups — skipped (may not exist yet)"

# Phase 7 Plan 07-02 — Prometheus dir: owned by uid 65534 (prom/prometheus
# runs as `nobody`). Pre-set ownership so the TSDB write on first `compose up`
# does not fail with "opening storage failed: permission denied" (Pitfall P-2).
# Same pattern as the postgres 70:70 chown above (Phase 5 idiom).
sudo chown 65534:65534 "${HOST_DATA_ROOT}/prometheus" 2>/dev/null \
  && echo "[bootstrap]   chown 65534:65534 ${HOST_DATA_ROOT}/prometheus" \
  || echo "[bootstrap]   chown 65534:65534 ${HOST_DATA_ROOT}/prometheus — skipped (may not exist yet)"

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
