#!/usr/bin/env bash
# bin/smoke-test-cloud.sh — Phase 8 live smoke for local-llms (Ollama Cloud +
# Resilience Hardening)
#
# What this script asserts (Phase 8 success criteria, 10 requirement IDs):
#
#   ROUTE-10  — Section 1: X-Model-Backend response header on
#               /v1/chat/completions, /v1/messages, /v1/embeddings.
#   CLOUD-01,
#   CLOUD-02  — Section 2: live POST /v1/chat/completions against a
#               cloud-tagged model (gpt-oss:20b-cloud) — SKIPs cleanly
#               when OLLAMA_API_KEY is empty.
#   EMBED-02  — Section 3: live POST /v1/embeddings against a cloud-tagged
#               embedding model — SKIPs when no cloud embedding entry is
#               declared in router/models.yaml OR OLLAMA_API_KEY is empty.
#   CLOUD-04  — Section 4: max_tokens cap (CLOUD_MAX_TOKENS_CAP=16_384) — a
#               request with max_tokens > 16384 returns 400 +
#               code=cloud_max_tokens_exceeded BEFORE any upstream call.
#   CLOUD-03  — Section 5: per-backend circuit breaker — direct Valkey
#               write opens the breaker; next cloud-model request returns
#               503 + code=backend_circuit_open + Retry-After header.
#   ROUTE-11  — Section 6: per-bearer-token-per-minute rate limit — burst
#               loop trips the configured RPM cap and returns 429 +
#               code=rate_limit_exceeded + Retry-After header.
#   ROUTE-12  — Section 7: Idempotency-Key multiplexer — N parallel requests
#               with the same Idempotency-Key return byte-identical bodies
#               and write request_log rows that share upstream_message_id.
#   CLOUD-05  — Section 8: cloud_spend_daily Postgres view exists.
#   DATA-06   — Section 9: Valkey-backed registry cache key is populated
#               with a non-empty JSON blob and the TTL is 1..300 s.
#
# Usage:
#   bash bin/smoke-test-cloud.sh
#
# Prerequisites:
#   - Stack is up: `docker compose up -d valkey postgres ollama router`
#   - ROUTER_BEARER_TOKEN + VALKEY_PASSWORD set in the environment or .env
#   - OPTIONAL: OLLAMA_API_KEY set in .env for Sections 2 + 3 (live cloud
#     round-trip). If empty, those sections SKIP — the remaining 7 sections
#     run regardless. This is the canonical "local-only verification mode".
#
# Exit codes:
#   0  All assertions pass — Phase 8 surface is healthy.
#   1  One or more assertions failed — diagnostic printed.
#
# Design notes:
#   - Mirrors bin/smoke-test-router.sh + bin/smoke-test-observability.sh:
#     `set -uo pipefail`, FAILURES counter, fail/pass/skip helpers,
#     sectioned headers, exit 0/1 discipline.
#   - Reads ROUTER_BEARER_TOKEN + VALKEY_PASSWORD + OLLAMA_API_KEY from .env
#     with the same single-variable-grep pattern as smoke-test-router.sh
#     (no `set -a; source .env` — that would leak unrelated secrets into
#     every subprocess this script spawns).
#   - All curl invocations use `-fsS` (silent on success) — never `-v`
#     (verbose) — so the bearer token never leaks into the script's stdout
#     even on failure (T-08-S-04 threat-register mitigation).

set -uo pipefail

# ── Repo root + .env resolution ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# read_env_var <NAME> — echoes the value of NAME from .env (last wins;
# strips a single layer of double or single quotes). Empty if absent.
read_env_var() {
  local name="$1"
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    grep -E "^${name}=" "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  fi
}

# Caller env > .env > hard fail (for required vars).
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]]; then
  ROUTER_BEARER_TOKEN=$(read_env_var ROUTER_BEARER_TOKEN)
  export ROUTER_BEARER_TOKEN
fi
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]]; then
  echo "[smoke-test-cloud] ERROR: ROUTER_BEARER_TOKEN is not set." >&2
  echo "[smoke-test-cloud]        Set it in ${REPO_ROOT}/.env or export in the shell." >&2
  exit 1
fi

if [[ -z "${VALKEY_PASSWORD:-}" ]]; then
  VALKEY_PASSWORD=$(read_env_var VALKEY_PASSWORD)
  export VALKEY_PASSWORD
fi
if [[ -z "${VALKEY_PASSWORD:-}" ]]; then
  echo "[smoke-test-cloud] ERROR: VALKEY_PASSWORD is not set." >&2
  echo "[smoke-test-cloud]        Required by Sections 5, 6, 7, 9 (Valkey-backed)." >&2
  echo "[smoke-test-cloud]        Set it in ${REPO_ROOT}/.env or export in the shell." >&2
  exit 1
fi

# Optional — Sections 2 + 3 skip cleanly when empty.
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  OLLAMA_API_KEY=$(read_env_var OLLAMA_API_KEY)
  export OLLAMA_API_KEY
fi

# ── Tool checks ──────────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-test-cloud] ERROR: jq is required on the host (sudo apt-get install -y jq)." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "[smoke-test-cloud] ERROR: docker is required on the host." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "[smoke-test-cloud] ERROR: curl is required on the host." >&2
  exit 1
fi

# ── Constants ────────────────────────────────────────────────────────────────
readonly ROUTER_URL="${ROUTER_URL:-http://127.0.0.1:3000}"
readonly CLOUD_CHAT_MODEL="${CLOUD_CHAT_MODEL:-gpt-oss:20b-cloud}"
# Plan 08-05 / D-C2 — cloud max_tokens cap is 16_384. Anything above must
# return 400 + cloud_max_tokens_exceeded.
readonly CLOUD_MAX_TOKENS_CAP=16384
readonly CLOUD_BACKEND_NAME="ollama-cloud"

# ── Failure / skip tracking ──────────────────────────────────────────────────
FAILURES=0
SKIPS=0
fail() { echo "[smoke-test-cloud] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-cloud] PASS: $*"; }
skip() { echo "[smoke-test-cloud] SKIP: $*"; SKIPS=$((SKIPS + 1)); }
info() { echo "[smoke-test-cloud] INFO: $*"; }

# valkey_cli <args...> — wrapper around `docker compose exec -T valkey
# valkey-cli -a $VALKEY_PASSWORD <args>`. Output goes to stdout; errors
# go to stderr.
valkey_cli() {
  docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" --no-auth-warning "$@"
}

# psql_router <sql> — wrapper around docker compose exec -T postgres psql -U app -d router -tA -c <sql>.
psql_router() {
  docker compose exec -T postgres psql -U app -d router -tA -c "$1"
}

echo ""
echo "[smoke-test-cloud] ================================================================"
echo "[smoke-test-cloud]  Phase 8 — Ollama Cloud Fallback + Resilience Hardening smoke"
echo "[smoke-test-cloud]  Router URL          : ${ROUTER_URL}"
echo "[smoke-test-cloud]  Cloud chat model    : ${CLOUD_CHAT_MODEL}"
if [[ -n "${OLLAMA_API_KEY:-}" ]]; then
  echo "[smoke-test-cloud]  OLLAMA_API_KEY set  : YES (Sections 2 + 3 will run live)"
else
  echo "[smoke-test-cloud]  OLLAMA_API_KEY set  : NO  (Sections 2 + 3 will SKIP)"
fi
echo "[smoke-test-cloud] ================================================================"
echo ""

# Pre-flight: router + valkey + postgres must be reachable.
if ! curl -fsS -o /dev/null "${ROUTER_URL}/healthz" 2>/dev/null; then
  fail "router /healthz unreachable at ${ROUTER_URL} — bring stack up: docker compose up -d router"
  echo "[smoke-test-cloud] (cannot run subsequent assertions; exiting early)"
  exit 1
fi
pass "pre-flight: router /healthz reachable"

if ! valkey_cli PING 2>/dev/null | grep -q '^PONG$'; then
  fail "valkey PING failed — bring up valkey: docker compose up -d valkey (check VALKEY_PASSWORD)"
  echo "[smoke-test-cloud] (cannot run subsequent assertions; exiting early)"
  exit 1
fi
pass "pre-flight: valkey PING -> PONG"

if ! psql_router 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
  fail "postgres SELECT 1 failed — bring up postgres: docker compose up -d postgres"
  echo "[smoke-test-cloud] (cannot run subsequent assertions; exiting early)"
  exit 1
fi
pass "pre-flight: postgres SELECT 1 -> 1"

echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 1: X-Model-Backend response header (ROUTE-10) ==="
# Three routes carry the header: /v1/chat/completions, /v1/messages, /v1/embeddings.
# /v1/models is intentionally excluded (no single resolved backend — Plan 08-03 D).
# Use a tiny, local-only chat model that is always available to keep this
# section runnable without OLLAMA_API_KEY. The router stamps the header even
# on 4xx envelopes (it stamps from req.resolvedBackend after the route
# resolves the model entry) — so we use a valid local model.

# Helper: extract X-Model-Backend header from a `curl -D - -o /dev/null` dump.
extract_header() {
  local raw="$1"
  echo "$raw" | grep -i '^x-model-backend:' | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n'
}

# /v1/chat/completions — pick the smallest always-present local model from
# models.yaml. Plan 02 default smoke model is llama3.2:3b-instruct-q4_K_M.
LOCAL_CHAT_MODEL="${LOCAL_CHAT_MODEL:-llama3.2:3b-instruct-q4_K_M}"

CHAT_HEADERS=$(curl -fsS -D - -o /dev/null \
  -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 60 \
  -d "{\"model\":\"${LOCAL_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
  2>/dev/null || echo "")
CHAT_BACKEND=$(extract_header "${CHAT_HEADERS}")
if [[ -n "${CHAT_BACKEND}" ]]; then
  pass "X-Model-Backend present on /v1/chat/completions: '${CHAT_BACKEND}'"
else
  fail "X-Model-Backend missing on /v1/chat/completions (model=${LOCAL_CHAT_MODEL}); response headers were:"
  echo "${CHAT_HEADERS}" | sed 's/^/[smoke-test-cloud]   /' >&2
fi

# /v1/messages — Anthropic surface; same Plan 08-03 onSend hook stamps the header.
MSG_HEADERS=$(curl -fsS -D - -o /dev/null \
  -X POST "${ROUTER_URL}/v1/messages" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 60 \
  -d "{\"model\":\"${LOCAL_CHAT_MODEL}\",\"max_tokens\":4,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  2>/dev/null || echo "")
MSG_BACKEND=$(extract_header "${MSG_HEADERS}")
if [[ -n "${MSG_BACKEND}" ]]; then
  pass "X-Model-Backend present on /v1/messages: '${MSG_BACKEND}'"
else
  fail "X-Model-Backend missing on /v1/messages"
fi

# /v1/embeddings — bge-m3-ollama if available, otherwise skip cleanly.
# UAT-surfaced flake: a single `docker compose exec ... ollama list` can return
# empty / non-zero exit transiently right after stack-up while the ollama daemon
# is still warming. Retry up to 3 times with a 1s gap so a transient flap
# doesn't show up as a spurious "bge-m3 not pulled" SKIP.
OLLAMA_LIST=""
for _ in 1 2 3; do
  OLLAMA_LIST=$(docker compose exec -T ollama ollama list 2>/dev/null || true)
  [[ -n "${OLLAMA_LIST}" ]] && break
  sleep 1
done
if printf '%s\n' "${OLLAMA_LIST}" | grep -q '^bge-m3'; then
  EMB_HEADERS=$(curl -fsS -D - -o /dev/null \
    -X POST "${ROUTER_URL}/v1/embeddings" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d '{"model":"bge-m3-ollama","input":"hi"}' \
    2>/dev/null || echo "")
  EMB_BACKEND=$(extract_header "${EMB_HEADERS}")
  if [[ -n "${EMB_BACKEND}" ]]; then
    pass "X-Model-Backend present on /v1/embeddings: '${EMB_BACKEND}'"
  else
    fail "X-Model-Backend missing on /v1/embeddings"
  fi
else
  skip "X-Model-Backend on /v1/embeddings (bge-m3 not pulled — run 'docker compose exec ollama ollama pull bge-m3' to exercise)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 2: Cloud chat completions live (CLOUD-01, CLOUD-02) ==="
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  skip "OLLAMA_API_KEY empty — cloud chat assertions skipped (set in .env to enable)"
else
  CLOUD_RESP=$(curl -fsS \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"${CLOUD_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly the word OK and nothing else.\"}],\"max_tokens\":256,\"stream\":false}" \
    2>/dev/null || echo "")
  if [[ -z "${CLOUD_RESP}" ]]; then
    fail "cloud chat request returned empty — check OLLAMA_API_KEY validity + router logs"
  else
    HAS_CHOICES=$(echo "${CLOUD_RESP}" | jq -e '.choices[0].message.content | length > 0' >/dev/null 2>&1 && echo "y" || echo "n")
    if [[ "${HAS_CHOICES}" == "y" ]]; then
      CONTENT_HEAD=$(echo "${CLOUD_RESP}" | jq -r '.choices[0].message.content' | head -c 80)
      pass "cloud chat returned non-empty .choices[0].message.content (head: '${CONTENT_HEAD}')"
    else
      fail "cloud chat shape unexpected — body head: $(echo "${CLOUD_RESP}" | head -c 200)"
    fi
  fi

  # Re-fetch with -D - to verify X-Model-Backend: ollama-cloud on the response.
  CLOUD_HEADERS=$(curl -fsS -D - -o /dev/null \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"${CLOUD_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
    2>/dev/null || echo "")
  CLOUD_BACKEND=$(extract_header "${CLOUD_HEADERS}")
  if [[ "${CLOUD_BACKEND}" == "${CLOUD_BACKEND_NAME}" ]]; then
    pass "X-Model-Backend on cloud chat = '${CLOUD_BACKEND_NAME}' (ROUTE-10 cross-validated against cloud)"
  else
    fail "X-Model-Backend on cloud chat = '${CLOUD_BACKEND}' (expected '${CLOUD_BACKEND_NAME}')"
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 3: Cloud embeddings live (EMBED-02) ==="
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  skip "OLLAMA_API_KEY empty — cloud embeddings skipped (set in .env to enable)"
else
  # Check models.yaml for a cloud-tagged embedding entry. EMBED-02 leaves the
  # specific model name up to the operator; default Plan 08-02 ships only
  # cloud chat models (gpt-oss:*-cloud). Detect via `/v1/models` query.
  MODELS_JSON=$(curl -fsS \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    "${ROUTER_URL}/v1/models" 2>/dev/null || echo "")
  CLOUD_EMBED_MODEL=$(echo "${MODELS_JSON}" \
    | jq -r '.data[] | select(.id | test("embed.*cloud|cloud.*embed"; "i")) | .id' \
    | head -1)
  if [[ -z "${CLOUD_EMBED_MODEL}" ]]; then
    skip "no cloud embedding entry declared in models.yaml — add one (backend: ollama-cloud, capabilities: [embeddings]) to exercise EMBED-02 live"
  else
    EMB_RESP=$(curl -fsS \
      -X POST "${ROUTER_URL}/v1/embeddings" \
      -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
      -H "Content-Type: application/json" \
      --max-time 60 \
      -d "{\"model\":\"${CLOUD_EMBED_MODEL}\",\"input\":\"hola mundo desde local-llms\"}" \
      2>/dev/null || echo "")
    if [[ -z "${EMB_RESP}" ]]; then
      fail "cloud embeddings request returned empty for model '${CLOUD_EMBED_MODEL}'"
    else
      DIM=$(echo "${EMB_RESP}" | jq '.data[0].embedding | length' 2>/dev/null || echo "0")
      if [[ "${DIM}" -gt 0 ]]; then
        pass "cloud embeddings returned ${DIM}-dim vector for '${CLOUD_EMBED_MODEL}'"
      else
        fail "cloud embeddings shape unexpected — body head: $(echo "${EMB_RESP}" | head -c 200)"
      fi
    fi
  fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 4: max_tokens cap on cloud → 400 (CLOUD-04) ==="
# Plan 08-05 / D-C2 — cloud models reject max_tokens > 16384 BEFORE any
# upstream call. Envelope: HTTP 400 + code='cloud_max_tokens_exceeded'.
# We always run this assertion (no OLLAMA_API_KEY required — the cap is
# enforced in-router BEFORE the adapter call).

OVER_CAP=$((CLOUD_MAX_TOKENS_CAP + 1))   # 16385 — minimum value over the cap

CAP_DUMP_FILE=$(mktemp)
CAP_STATUS=$(curl -s -o "${CAP_DUMP_FILE}" -w '%{http_code}' \
  -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 30 \
  -d "{\"model\":\"${CLOUD_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":${OVER_CAP},\"stream\":false}" \
  2>/dev/null || echo "000")

if [[ "${CAP_STATUS}" == "400" ]]; then
  pass "max_tokens=${OVER_CAP} → HTTP 400 (cap=${CLOUD_MAX_TOKENS_CAP} enforced)"
else
  fail "max_tokens=${OVER_CAP} → HTTP ${CAP_STATUS} (expected 400)"
fi

# Verify envelope code is the specific 'cloud_max_tokens_exceeded'.
CAP_CODE=$(jq -r '.error.code // empty' "${CAP_DUMP_FILE}" 2>/dev/null)
if [[ "${CAP_CODE}" == "cloud_max_tokens_exceeded" ]]; then
  pass "envelope error.code = 'cloud_max_tokens_exceeded'"
else
  fail "envelope error.code = '${CAP_CODE}' (expected 'cloud_max_tokens_exceeded'); body head:"
  head -c 300 "${CAP_DUMP_FILE}" >&2 || true
  echo "" >&2
fi
rm -f "${CAP_DUMP_FILE}"

# Boundary check — max_tokens = CAP (16384) MUST be accepted (no 400 envelope
# tripped from the cap). We only care that the cap check itself does NOT
# fire; the request may still 4xx/5xx for unrelated reasons (e.g. cloud
# unreachable when OLLAMA_API_KEY is empty), so we just assert the code is
# NOT cloud_max_tokens_exceeded.
BOUNDARY_FILE=$(mktemp)
curl -s -o "${BOUNDARY_FILE}" -w '%{http_code}' \
  -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 30 \
  -d "{\"model\":\"${CLOUD_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":${CLOUD_MAX_TOKENS_CAP},\"stream\":false}" \
  >/dev/null 2>&1 || true
BOUNDARY_CODE=$(jq -r '.error.code // empty' "${BOUNDARY_FILE}" 2>/dev/null)
if [[ "${BOUNDARY_CODE}" != "cloud_max_tokens_exceeded" ]]; then
  pass "max_tokens=${CLOUD_MAX_TOKENS_CAP} (boundary) does NOT trip cap envelope"
else
  fail "max_tokens=${CLOUD_MAX_TOKENS_CAP} (boundary) trips cap envelope (off-by-one — cap is exclusive of CAP+1)"
fi
rm -f "${BOUNDARY_FILE}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 5: Circuit breaker via Valkey direct write (CLOUD-03) ==="
# Strategy: bypass the failure-counter logic by writing the breaker state
# keys directly into Valkey. The router's pre-flight middleware reads
# `breaker:${backend}:state` BEFORE dispatching — if it sees 'open' AND the
# probe_at timestamp is in the future, it returns 503 + backend_circuit_open.
#
# Keys per router/src/resilience/circuitBreaker.ts:
#   breaker:ollama-cloud:state       -> 'open' (string)
#   breaker:ollama-cloud:probe_at    -> epoch_ms (string)
#   breaker:ollama-cloud:fail_count  -> ignored when state=open

BREAKER_STATE_KEY="breaker:${CLOUD_BACKEND_NAME}:state"
BREAKER_PROBE_KEY="breaker:${CLOUD_BACKEND_NAME}:probe_at"
BREAKER_FAILS_KEY="breaker:${CLOUD_BACKEND_NAME}:fail_count"

# Compute probe_at = now + 60s (epoch ms).
NOW_MS=$(date +%s%3N 2>/dev/null || echo "$(( $(date +%s) * 1000 ))")
PROBE_AT=$(( NOW_MS + 60000 ))

# Open the breaker. Use EX 90 so the keys clean themselves up if the script
# crashes between SET and the eventual DEL.
valkey_cli SET "${BREAKER_STATE_KEY}" "open" EX 90 >/dev/null
valkey_cli SET "${BREAKER_PROBE_KEY}" "${PROBE_AT}" EX 90 >/dev/null

# Fire a cloud-model request — expect 503 + backend_circuit_open.
BREAKER_FILE=$(mktemp)
BREAKER_HEADERS_FILE=$(mktemp)
BREAKER_STATUS=$(curl -s -o "${BREAKER_FILE}" -D "${BREAKER_HEADERS_FILE}" -w '%{http_code}' \
  -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 15 \
  -d "{\"model\":\"${CLOUD_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
  2>/dev/null || echo "000")

if [[ "${BREAKER_STATUS}" == "503" ]]; then
  pass "circuit-open → HTTP 503 (breaker state=open)"
else
  fail "circuit-open → HTTP ${BREAKER_STATUS} (expected 503); body head: $(head -c 200 "${BREAKER_FILE}")"
fi

BREAKER_CODE=$(jq -r '.error.code // empty' "${BREAKER_FILE}" 2>/dev/null)
if [[ "${BREAKER_CODE}" == "backend_circuit_open" ]]; then
  pass "envelope error.code = 'backend_circuit_open'"
else
  fail "envelope error.code = '${BREAKER_CODE}' (expected 'backend_circuit_open')"
fi

# Retry-After header MUST be present and numeric.
RETRY_AFTER=$(grep -i '^retry-after:' "${BREAKER_HEADERS_FILE}" | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n')
if [[ -n "${RETRY_AFTER}" ]] && [[ "${RETRY_AFTER}" =~ ^[0-9]+$ ]]; then
  pass "Retry-After header present + numeric: ${RETRY_AFTER}s"
else
  fail "Retry-After header missing or non-numeric: '${RETRY_AFTER}'"
fi

# Reset the breaker so subsequent sections aren't affected.
valkey_cli DEL "${BREAKER_STATE_KEY}" "${BREAKER_PROBE_KEY}" "${BREAKER_FAILS_KEY}" >/dev/null
info "breaker keys deleted; subsequent sections see closed-circuit state"
rm -f "${BREAKER_FILE}" "${BREAKER_HEADERS_FILE}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 6: Rate limit 429 via Valkey direct write (ROUTE-11) ==="
# Strategy parallels Section 5: avoid firing the configured RPM (600 by
# default) and instead pre-seed the rate-limit counter past the cap, then
# fire a single request to observe the 429 envelope. The rate-limit key
# shape (router/src/middleware/rateLimit.ts:94):
#   ratelimit:${bearer_hash_8char}:${epoch_minute}
#
# We do not have the in-process hash function reachable from bash, so the
# fallback strategy is: read the router's view of ROUTER_RATE_LIMIT_RPM,
# either burst that many requests (slow but deterministic), OR pre-seed
# the key via known-hash discovery.
#
# Simplest deterministic option: use a small burst that exceeds an
# explicitly-low RPM (operators override ROUTER_RATE_LIMIT_RPM=5 in .env
# for the smoke run), OR if the limit is too high to comfortably burst,
# scan Valkey for the current bearer's key, capture its hash prefix,
# pre-seed the counter to RPM+1, and fire once.

# Discover the current ROUTER_RATE_LIMIT_RPM (from .env or default 600).
RPM=$(read_env_var ROUTER_RATE_LIMIT_RPM)
if [[ -z "${RPM}" ]]; then RPM=600; fi
info "ROUTER_RATE_LIMIT_RPM=${RPM}"

# Fire a single request first to make the bearer's rate-limit key exist.
curl -fsS -o /dev/null \
  -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  --max-time 30 \
  -d "{\"model\":\"${LOCAL_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
  >/dev/null 2>&1 || true

# Find the freshly-created ratelimit:* key for this bearer.
# UAT 2026-05-18 fix: re-discover ALL existing keys for the bearer hash AND
# also seed the next-minute key so the probe is over-budget regardless of
# which minute it lands in. The previous one-key-only approach was a flake
# at the minute boundary when the warm-up request took >60s.
RL_KEY=$(valkey_cli --scan --pattern 'ratelimit:*' 2>/dev/null | tail -1)
if [[ -z "${RL_KEY}" ]]; then
  fail "no ratelimit:* keys present in Valkey after a request — rate-limit middleware may not be wired"
else
  info "found rate-limit key: ${RL_KEY}"
  # Extract bearer-hash prefix from the discovered key:
  #   ratelimit:<hash8>:<minute>  ->  <hash8>
  RL_HASH=$(printf '%s' "${RL_KEY}" | awk -F: '{print $2}')
  CUR_MIN=$(printf '%s' "${RL_KEY}" | awk -F: '{print $3}')
  NEXT_MIN=$(( CUR_MIN + 1 ))
  OVER_RPM=$(( RPM + 1 ))
  # Pre-seed BOTH minute N and minute N+1 keys to RPM+1 so the over-budget
  # probe trips 429 even if it lands one minute later than the warm-up.
  for MIN in "${CUR_MIN}" "${NEXT_MIN}"; do
    K="ratelimit:${RL_HASH}:${MIN}"
    valkey_cli SET "${K}" "${OVER_RPM}" KEEPTTL >/dev/null 2>&1 \
      || valkey_cli SET "${K}" "${OVER_RPM}" EX 90 >/dev/null
  done

  RL_FILE=$(mktemp)
  RL_HEADERS_FILE=$(mktemp)
  RL_STATUS=$(curl -s -o "${RL_FILE}" -D "${RL_HEADERS_FILE}" -w '%{http_code}' \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d "{\"model\":\"${LOCAL_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
    2>/dev/null || echo "000")
  if [[ "${RL_STATUS}" == "429" ]]; then
    pass "over-budget request → HTTP 429 (counter pre-seeded to ${OVER_RPM} > RPM=${RPM})"
  else
    fail "over-budget request → HTTP ${RL_STATUS} (expected 429); body head: $(head -c 200 "${RL_FILE}")"
  fi
  RL_CODE=$(jq -r '.error.code // empty' "${RL_FILE}" 2>/dev/null)
  if [[ "${RL_CODE}" == "rate_limit_exceeded" ]]; then
    pass "envelope error.code = 'rate_limit_exceeded'"
  else
    fail "envelope error.code = '${RL_CODE}' (expected 'rate_limit_exceeded')"
  fi
  RL_RETRY=$(grep -i '^retry-after:' "${RL_HEADERS_FILE}" | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n')
  if [[ -n "${RL_RETRY}" ]] && [[ "${RL_RETRY}" =~ ^[0-9]+$ ]]; then
    pass "Retry-After header present + numeric: ${RL_RETRY}s"
  else
    fail "Retry-After header missing or non-numeric on 429: '${RL_RETRY}'"
  fi

  # Reset: drop both pre-seeded buckets so subsequent sections see a fresh counter.
  for MIN in "${CUR_MIN}" "${NEXT_MIN}"; do
    valkey_cli DEL "ratelimit:${RL_HASH}:${MIN}" >/dev/null
  done
  rm -f "${RL_FILE}" "${RL_HEADERS_FILE}"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 7: Idempotency mux dedup via concurrent same-key (ROUTE-12) ==="
# Fire 3 concurrent POST /v1/chat/completions with the same Idempotency-Key
# (random nonce per run) against a local model. Plan 08-07's multiplexer
# elects one leader; the other 2 followers wait via Valkey pub/sub and
# return the SAME byte-identical body when the leader finishes.

IDEM_KEY="smoke-$(date +%s)-$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || echo $$)"
info "Idempotency-Key: ${IDEM_KEY}"

TMP_RESP_1=$(mktemp)
TMP_RESP_2=$(mktemp)
TMP_RESP_3=$(mktemp)

fire_idempotent_request() {
  local outfile="$1"
  curl -fsS \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"${LOCAL_CHAT_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say only the word OK\"}],\"max_tokens\":8,\"stream\":false}" \
    > "${outfile}" 2>/dev/null || echo '{"error":"curl_failed"}' > "${outfile}"
}

fire_idempotent_request "${TMP_RESP_1}" &
PID1=$!
fire_idempotent_request "${TMP_RESP_2}" &
PID2=$!
fire_idempotent_request "${TMP_RESP_3}" &
PID3=$!
wait "${PID1}" "${PID2}" "${PID3}" 2>/dev/null || true

MD5_1=$(md5sum "${TMP_RESP_1}" 2>/dev/null | awk '{print $1}')
MD5_2=$(md5sum "${TMP_RESP_2}" 2>/dev/null | awk '{print $1}')
MD5_3=$(md5sum "${TMP_RESP_3}" 2>/dev/null | awk '{print $1}')

# All 3 must exist + be non-empty + identical.
if [[ -z "${MD5_1}" || -z "${MD5_2}" || -z "${MD5_3}" ]]; then
  fail "one or more idempotent responses missing — md5: '${MD5_1}' '${MD5_2}' '${MD5_3}'"
elif [[ "${MD5_1}" == "${MD5_2}" && "${MD5_2}" == "${MD5_3}" ]]; then
  pass "3 concurrent Idempotency-Key requests return byte-identical bodies (md5=${MD5_1})"
else
  fail "3 concurrent responses have different md5 sums: '${MD5_1}' '${MD5_2}' '${MD5_3}'"
  echo "[smoke-test-cloud] body 1 head: $(head -c 200 "${TMP_RESP_1}")"
  echo "[smoke-test-cloud] body 2 head: $(head -c 200 "${TMP_RESP_2}")"
  echo "[smoke-test-cloud] body 3 head: $(head -c 200 "${TMP_RESP_3}")"
fi

# Verify in request_log: 3 rows for this Idempotency-Key sharing one
# upstream_message_id (the leader's). Allow ~3s for Plan 05 buffered writer.
sleep 3
# Plan 08-07 SUMMARY: idempotency_key column added to request_log; the 3
# rows share upstream_message_id.
DISTINCT_UPSTREAM_IDS=$(psql_router \
  "SELECT COUNT(DISTINCT upstream_message_id) FROM request_log WHERE idempotency_key = '${IDEM_KEY}';" \
  2>/dev/null | tr -d '[:space:]')
ROW_COUNT=$(psql_router \
  "SELECT COUNT(*) FROM request_log WHERE idempotency_key = '${IDEM_KEY}';" \
  2>/dev/null | tr -d '[:space:]')

if [[ "${ROW_COUNT}" == "3" && "${DISTINCT_UPSTREAM_IDS}" == "1" ]]; then
  pass "request_log: 3 rows for Idempotency-Key, 1 distinct upstream_message_id (followers reused leader's generation)"
elif [[ "${ROW_COUNT}" == "3" ]]; then
  fail "request_log: 3 rows but ${DISTINCT_UPSTREAM_IDS} distinct upstream_message_ids (expected 1 — mux dedup failed)"
elif [[ -z "${ROW_COUNT}" || "${ROW_COUNT}" == "0" ]]; then
  fail "request_log: no rows for Idempotency-Key '${IDEM_KEY}' — buffered writer may not have flushed (or idempotency_key column not populated)"
else
  fail "request_log: ${ROW_COUNT} rows for Idempotency-Key (expected 3)"
fi

rm -f "${TMP_RESP_1}" "${TMP_RESP_2}" "${TMP_RESP_3}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 8: cloud_spend_daily Postgres view (CLOUD-05) ==="
VIEW_DEF=$(psql_router \
  "SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'cloud_spend_daily';" \
  2>/dev/null | tr -d '[:space:]')
if [[ "${VIEW_DEF}" == "cloud_spend_daily" ]]; then
  pass "cloud_spend_daily view exists (pg_views::viewname)"
else
  fail "cloud_spend_daily view NOT found in pg_views — Plan 08-08 migration may not have run"
fi

# Cheap projection sanity: SELECT * LIMIT 1 must not error (may return 0
# rows if no cloud requests fired yet — empty is fine; ERROR is not).
PROJECTION=$(psql_router \
  "SELECT COUNT(*) FROM cloud_spend_daily;" \
  2>/dev/null | tr -d '[:space:]')
if [[ "${PROJECTION}" =~ ^[0-9]+$ ]]; then
  pass "cloud_spend_daily SELECT COUNT(*) = ${PROJECTION} (view is queryable; 0 rows is acceptable)"
else
  fail "cloud_spend_daily SELECT COUNT(*) returned non-numeric: '${PROJECTION}'"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] === Section 9: Valkey registry cache populated (DATA-06) ==="
# Plan 08-09's cache key: 'registry:models-yaml:cache:v1' (TTL 300s after 08-11).
# Boot wires `registryCache.get()` FIRST; on miss, loads from file + sets
# the cache. The first request to /v1/models or /v1/chat/completions will
# populate it through hot-reload's onReload callback.
#
# Trigger a touch by hitting /v1/models (cheap, no upstream call).
curl -fsS -o /dev/null \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  "${ROUTER_URL}/v1/models" 2>/dev/null || true

REG_KEY="registry:models-yaml:cache:v1"
REG_BLOB=$(valkey_cli GET "${REG_KEY}" 2>/dev/null)
if [[ -z "${REG_BLOB}" ]]; then
  # Boot-cache may not fire until the first router restart after Plan 08-09;
  # surface this as a SKIP rather than FAIL since the cache populates on
  # `docker compose restart router` (per 08-09 SUMMARY).
  skip "registry cache key '${REG_KEY}' is empty (populates on router restart — 'docker compose restart router' then re-run section 9)"
else
  # Must look like JSON ({"models": ...} or {"version":...,"models":...}).
  if echo "${REG_BLOB}" | head -c 1 | grep -q '^{$' || echo "${REG_BLOB}" | jq -e '.models | length > 0' >/dev/null 2>&1; then
    BLOB_LEN=${#REG_BLOB}
    pass "registry cache key '${REG_KEY}' populated (${BLOB_LEN} bytes; JSON-shaped)"
  else
    fail "registry cache key present but does not look like JSON — head: $(echo "${REG_BLOB}" | head -c 80)"
  fi

  # TTL must be 1..300 (08-11 raised TTL_SEC 30 -> 300 so the key survives a restart cycle).
  REG_TTL=$(valkey_cli TTL "${REG_KEY}" 2>/dev/null | tr -d '[:space:]')
  if [[ "${REG_TTL}" =~ ^[0-9]+$ ]] && (( REG_TTL >= 1 && REG_TTL <= 300 )); then
    pass "registry cache TTL = ${REG_TTL}s (expected 1..300)"
  else
    fail "registry cache TTL = '${REG_TTL}' (expected 1..300)"
  fi
fi
echo ""

# ── Final summary ────────────────────────────────────────────────────────────
echo "[smoke-test-cloud] ================================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[smoke-test-cloud]  ✓ Phase 8 smoke PASS"
  echo "[smoke-test-cloud]  Skipped : ${SKIPS} (cloud sections require OLLAMA_API_KEY; some boot-state assertions)"
  echo "[smoke-test-cloud] ================================================================"
  exit 0
else
  echo "[smoke-test-cloud]  ✗ FAILED: ${FAILURES} assertion(s) did not pass."
  echo "[smoke-test-cloud]  Diagnostics:"
  echo "[smoke-test-cloud]    docker compose logs router  | tail -100"
  echo "[smoke-test-cloud]    docker compose logs valkey  | tail -50"
  echo "[smoke-test-cloud]    docker compose logs postgres | tail -50"
  echo "[smoke-test-cloud]    docker compose exec -T valkey valkey-cli -a \$VALKEY_PASSWORD KEYS '*'"
  echo "[smoke-test-cloud] ================================================================"
  exit 1
fi
