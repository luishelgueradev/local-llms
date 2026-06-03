#!/usr/bin/env bash
# bin/deploy-router.sh — local-llms router deploy wrapper (Phase 20 / OPS-01)
#
# Subcommands:
#   full         build router image + force-recreate container + wait healthz + smoke
#   config-only  Valkey DEL caches + force-recreate (NO image rebuild) + wait healthz
#   check        run Phase 20 smoke gates against currently-running router (no rebuild)
#
# Flags (after subcommand):
#   --profile {dev|prod}   default: prod (mirrors bin/smoke-test-router.sh)
#   --strict               only for `check`: hard-fail on BUILD_SHA mismatch (default: warn-only)
#   --skip-smoke           only for `full`: skip the smoke gate after deploy (CI use)
#   -h | --help            print this help and exit 0
#
# Examples:
#   bash bin/deploy-router.sh full                        # rebuild + deploy + smoke (prod)
#   bash bin/deploy-router.sh config-only                 # after models.yaml edit, no rebuild
#   bash bin/deploy-router.sh check                       # diagnose drift without redeploying
#   bash bin/deploy-router.sh check --strict              # CI gate
#
# Exit codes:
#   0  Success
#   1  Failure (build / recreate / healthz timeout / smoke / `check --strict` mismatch)
#   2  Bad CLI input
#
# Design notes:
#   - Mirrors bin/smoke-test-router.sh + bin/preflight-gpu.sh conventions:
#     set -uo pipefail, sectioned output, .env discovery via grep-not-source.
#   - No new tooling dependency (D-07: bash, NOT just/make). Requires:
#     docker, curl, jq, grep, git (standard utilities all available).
#   - Honors project_models_yaml_hot_edit memory: config-only is the atomic
#     recipe for models.yaml edits (DEL model-registry + mcp:tools + backend-health
#     caches + force-recreate router so the new YAML is parsed).
#   - BUILD_SHA + BUILD_TIME passed as --build-arg per D-08 (Phase 20 / OPS-02).
#
set -uo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Defaults
PROFILE="prod"
STRICT=false
SKIP_SMOKE=false
SUBCOMMAND=""

# ─── usage ───────────────────────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: bash bin/deploy-router.sh {full|config-only|check} [options]

Subcommands:
  full         Build router image with BUILD_SHA + force-recreate + wait healthz + smoke verify
  config-only  Valkey DEL (model-registry + mcp:tools + backend-health) + force-recreate (no build)
  check        Compare git HEAD against running /healthz build_sha + run smoke gate

Options:
  --profile {dev|prod}    Router profile (default: prod). prod → http://127.0.0.1:3210,
                          dev → http://127.0.0.1:3000.
  --strict                Only for `check`: hard-fail on BUILD_SHA mismatch (default: warn-only).
  --skip-smoke            Only for `full`: skip the smoke gate after deploy (CI use).
  -h | --help             Print this help and exit 0.

Examples:
  bash bin/deploy-router.sh full                      # rebuild + deploy + smoke (prod)
  bash bin/deploy-router.sh config-only               # after models.yaml edit
  bash bin/deploy-router.sh check                     # drift diagnostic (warn-only)
  bash bin/deploy-router.sh check --strict            # CI drift gate
  bash bin/deploy-router.sh full --skip-smoke         # CI build (smoke run separately)
USAGE
}

# ─── Color helpers (mirror bin/smoke-test-router.sh) ─────────────────────────

pass() { echo "[deploy-router] PASS: $*"; }
fail() { echo "[deploy-router] FAIL: $*" >&2; }
warn() { echo "[deploy-router] WARN: $*" >&2; }
info() { echo "[deploy-router] INFO: $*"; }

# ─── ROUTER_URL derivation per profile ───────────────────────────────────────

derive_router_url() {
  case "$PROFILE" in
    prod) echo "http://127.0.0.1:3210" ;;
    dev)  echo "http://127.0.0.1:3000" ;;
    *)    fail "unknown PROFILE: $PROFILE"; exit 2 ;;
  esac
}

# ─── wait_for_healthz: poll /healthz until 200 (max 60s) ─────────────────────

wait_for_healthz() {
  local url="$1"
  local deadline=$(( $(date +%s) + 60 ))
  info "waiting for ${url}/healthz to return 200 (≤60s)..."
  while [[ $(date +%s) -lt "$deadline" ]]; do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' "${url}/healthz" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
      pass "router is healthy at ${url}/healthz (HTTP 200)"
      return 0
    fi
    sleep 1
  done
  fail "router did not become healthy within 60s (last HTTP code: ${code:-unknown})"
  return 1
}

# ─── load_valkey_password: extract from .env (grep, NOT source — WR-05) ──────

load_valkey_password() {
  if [[ -z "${VALKEY_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
    VALKEY_PASSWORD=$(
      grep -E '^VALKEY_PASSWORD=' "${REPO_ROOT}/.env" \
        | tail -1 \
        | cut -d= -f2- \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
    )
    export VALKEY_PASSWORD
  fi
  if [[ -z "${VALKEY_PASSWORD:-}" ]]; then
    fail "VALKEY_PASSWORD is not set (export it or fill in ${REPO_ROOT}/.env)"
    return 1
  fi
  return 0
}

# ─── cmd_full: build + force-recreate + healthz + smoke ──────────────────────

cmd_full() {
  cd "$REPO_ROOT"

  local BUILD_SHA BUILD_TIME ROUTER_URL
  BUILD_SHA=$(git rev-parse HEAD)
  BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ROUTER_URL=$(derive_router_url)

  info "Phase 20 OPS-01 — full deploy (profile=${PROFILE}, BUILD_SHA=${BUILD_SHA:0:7}, BUILD_TIME=${BUILD_TIME})"

  info "step 1/4 — docker compose build router (with BUILD_SHA + BUILD_TIME)"
  if ! docker compose build router \
      --build-arg "BUILD_SHA=${BUILD_SHA}" \
      --build-arg "BUILD_TIME=${BUILD_TIME}"; then
    fail "docker compose build router failed"
    return 1
  fi
  pass "image built with BUILD_SHA=${BUILD_SHA:0:7}"

  info "step 2/4 — docker compose up -d --force-recreate router"
  if ! docker compose up -d --force-recreate router; then
    fail "docker compose up -d --force-recreate router failed"
    return 1
  fi
  pass "router container recreated"

  info "step 3/4 — wait for /healthz"
  if ! wait_for_healthz "$ROUTER_URL"; then
    return 1
  fi

  if [[ "$SKIP_SMOKE" == "true" ]]; then
    info "step 4/4 — SKIPPED (--skip-smoke)"
    pass "full deploy complete (smoke skipped)"
    return 0
  fi

  info "step 4/4 — running bin/smoke-test-router.sh --profile ${PROFILE}"
  if bash "${SCRIPT_DIR}/smoke-test-router.sh" --profile "$PROFILE"; then
    pass "full deploy complete + smoke verified"
    return 0
  else
    fail "smoke-test-router.sh exited non-zero — router is deployed but smoke failed"
    return 1
  fi
}

# ─── cmd_config_only: DEL caches + force-recreate (no build) ─────────────────

cmd_config_only() {
  cd "$REPO_ROOT"

  local ROUTER_URL
  ROUTER_URL=$(derive_router_url)

  info "Phase 20 OPS-01 — config-only deploy (profile=${PROFILE})"

  if ! load_valkey_password; then
    return 1
  fi

  info "step 1/3 — DEL Valkey caches (model-registry + mcp:tools + backend-health)"
  # Use KEYS + DEL pattern (single-host, single-user — cardinality bounded).
  # Each pattern is enumerated separately so a 0-key match for one doesn't
  # block the others. Quiet stdout — only print failures.
  local CACHE_PATTERNS=("model-registry:*" "mcp:tools:*" "backend-health:*")
  for pattern in "${CACHE_PATTERNS[@]}"; do
    local keys
    keys=$(docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning --scan --pattern "$pattern" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')
    if [[ -n "$keys" ]]; then
      # shellcheck disable=SC2086
      docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning DEL $keys >/dev/null 2>&1 \
        && info "  DEL ${pattern} → $(echo "$keys" | wc -w) key(s) deleted" \
        || warn "  DEL ${pattern} returned non-zero (continuing)"
    else
      info "  ${pattern} — no keys to delete"
    fi
  done
  pass "Valkey caches cleared"

  info "step 2/3 — docker compose up -d --force-recreate router"
  if ! docker compose up -d --force-recreate router; then
    fail "docker compose up -d --force-recreate router failed"
    return 1
  fi
  pass "router container recreated"

  info "step 3/3 — wait for /healthz"
  if ! wait_for_healthz "$ROUTER_URL"; then
    return 1
  fi

  pass "config-only deploy complete"
  return 0
}

# ─── cmd_check: compare git HEAD vs running build_sha + smoke ────────────────

cmd_check() {
  cd "$REPO_ROOT"

  local ROUTER_URL BUILD_SHA_LOCAL BUILD_SHA_RUNNING
  ROUTER_URL=$(derive_router_url)
  BUILD_SHA_LOCAL=$(git rev-parse HEAD)

  info "Phase 20 OPS-02 — drift check (profile=${PROFILE}, strict=${STRICT})"

  # Probe /healthz for build_sha
  local HEALTHZ_BODY
  HEALTHZ_BODY=$(curl -s "${ROUTER_URL}/healthz" 2>/dev/null || echo "")
  if [[ -z "$HEALTHZ_BODY" ]]; then
    fail "could not reach ${ROUTER_URL}/healthz — is the router running?"
    return 1
  fi

  BUILD_SHA_RUNNING=$(echo "$HEALTHZ_BODY" | jq -r '.build_sha // "<missing>"' 2>/dev/null || echo "<missing>")

  info "local HEAD     : ${BUILD_SHA_LOCAL}"
  info "running BUILD  : ${BUILD_SHA_RUNNING}"

  if [[ "$BUILD_SHA_RUNNING" == "<missing>" ]]; then
    warn "running router does not expose build_sha in /healthz"
    warn "either the running image is older than Phase 20 OPS-02 or it was built without --build-arg BUILD_SHA"
    if [[ "$STRICT" == "true" ]]; then
      fail "--strict: missing build_sha is treated as drift"
      return 1
    fi
    info "continuing to smoke gate (warn-only — no --strict)"
  elif [[ "$BUILD_SHA_RUNNING" == "unknown" ]]; then
    warn "running router reports BUILD_SHA=unknown (image was built without --build-arg)"
    if [[ "$STRICT" == "true" ]]; then
      fail "--strict: unknown BUILD_SHA is treated as drift"
      return 1
    fi
    info "continuing to smoke gate (warn-only — no --strict)"
  elif [[ "$BUILD_SHA_LOCAL" != "$BUILD_SHA_RUNNING" ]]; then
    warn "DRIFT — git HEAD (${BUILD_SHA_LOCAL:0:7}) != running image (${BUILD_SHA_RUNNING:0:7})"
    warn "the running router does NOT match the source tree."
    warn "remediation: bash bin/deploy-router.sh full"
    if [[ "$STRICT" == "true" ]]; then
      fail "--strict: BUILD_SHA mismatch is hard-fail"
      return 1
    fi
    info "continuing to smoke gate (warn-only — no --strict)"
  else
    pass "BUILD_SHA matches git HEAD (${BUILD_SHA_LOCAL:0:7}) — no source/image drift"
  fi

  info "running smoke gate: bin/smoke-test-router.sh --profile ${PROFILE}"
  if bash "${SCRIPT_DIR}/smoke-test-router.sh" --profile "$PROFILE"; then
    pass "drift check + smoke complete"
    return 0
  else
    fail "smoke-test-router.sh exited non-zero"
    return 1
  fi
}

# ─── Argv parsing ────────────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

# First positional arg is the subcommand (or help)
case "$1" in
  -h|--help|help)
    usage
    exit 0
    ;;
  full|config-only|check)
    SUBCOMMAND="$1"
    shift
    ;;
  *)
    fail "unknown subcommand: $1"
    usage >&2
    exit 2
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:?--profile requires an argument (prod|dev)}"
      case "$PROFILE" in
        prod|dev) ;;
        *) fail "--profile must be 'prod' or 'dev', got: $PROFILE"; exit 2 ;;
      esac
      shift 2
      ;;
    --strict)
      STRICT=true
      shift
      ;;
    --skip-smoke)
      SKIP_SMOKE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
done

# ─── Dispatch ────────────────────────────────────────────────────────────────

case "$SUBCOMMAND" in
  full)        cmd_full ;;
  config-only) cmd_config_only ;;
  check)       cmd_check ;;
  *)           fail "internal error: unknown subcommand after parse: $SUBCOMMAND"; exit 2 ;;
esac
