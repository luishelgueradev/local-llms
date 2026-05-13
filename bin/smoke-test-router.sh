#!/usr/bin/env bash
# bin/smoke-test-router.sh — end-to-end router verification for local-llms Phase 2
#
# What this script asserts (ROADMAP success criteria SC1–SC5):
#   SC1. POST /v1/chat/completions stream=true returns OpenAI-shape SSE chunks
#        terminated by data:[DONE], with usage in the final non-empty chunk.
#   SC2. POST /v1/chat/completions stream=false returns a ChatCompletion with usage.
#   SC3. Killing the curl mid-stream causes Ollama's /api/ps to drop the model
#        (or size_vram→0) within ~3 s — abort propagation works end-to-end.
#   SC4. /healthz returns 200 with no Authorization header; missing/wrong bearer
#        on /v1/* returns 401; models.yaml hot-reload picks up an added comment
#        within 1s (no router restart).
#   SC5. `docker compose logs router` contains zero matches for the bearer token
#        value or `authorization:[ ]*bearer` patterns after a representative session.
#
# Usage:  bash bin/smoke-test-router.sh [options]
# Flags:
#   -m MODEL | --model MODEL    Override model (default: llama3.2:3b-instruct-q4_K_M)
#   --router-url URL            Override router URL (default: http://127.0.0.1:3000)
#   -h | --help                 Print usage and exit 0
#
# Exit codes:
#   0  All assertions pass — router vertical slice proven end-to-end.
#   1  One or more assertions failed — diagnostic printed; see /v1/chat/completions
#      logs (`docker compose logs router`) for upstream-side details.
#
# Design notes:
#   - Mirrors bin/smoke-test-gpu.sh (Phase 1) — same FAILURES counter,
#     `set -uo pipefail`, sectioned output, exit 0/1 discipline.
#   - Reads ROUTER_BEARER_TOKEN from .env (same pattern as preflight-gpu.sh
#     lines 107–125 — caller env wins, then .env, then hard fail).
#   - Uses `docker compose exec -T ollama curl ...` (NOT host port) for any
#     direct-Ollama probe — Phase 2 D-A4 removes the host port (this plan).

set -uo pipefail

# Constants
readonly DEFAULT_MODEL="llama3.2:3b-instruct-q4_K_M"
readonly DEFAULT_ROUTER_URL="http://127.0.0.1:3000"
readonly OLLAMA_SVC="ollama"
readonly ROUTER_SVC="router"
readonly PROMPT_NONSTREAM="What is 2+2? Answer in one short sentence."
readonly PROMPT_STREAM="Write a long detailed story about a dragon."

# CLI
MODEL="${DEFAULT_MODEL}"
ROUTER_URL="${DEFAULT_ROUTER_URL}"

usage() {
  cat <<'USAGE'
Usage: bash bin/smoke-test-router.sh [options]

  -m MODEL | --model MODEL      Override model (default: llama3.2:3b-instruct-q4_K_M)
  --router-url URL              Override router URL (default: http://127.0.0.1:3000)
  -h | --help                   Print this help and exit 0

Purpose:
  End-to-end Phase 2 verification — asserts SC1..SC5 against the real Ollama
  backend on the GPU. Run after `docker compose up -d --build router`.

  Exit 0 = all 5 success criteria pass.
  Exit 1 = one or more assertions failed; actionable diagnostic printed.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)        MODEL="${2:?--model requires an argument}"; shift 2 ;;
    --router-url)      ROUTER_URL="${2:?--router-url requires an argument}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "[smoke-test-router] ERROR: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Locate repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Resolve ROUTER_BEARER_TOKEN — caller env > .env > hard fail (mirror preflight-gpu.sh)
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]]; then
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    # shellcheck disable=SC1090,SC1091
    set -a; source "${REPO_ROOT}/.env"; set +a
  fi
fi
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]]; then
  echo "[smoke-test-router] ERROR: ROUTER_BEARER_TOKEN is not set." >&2
  echo "[smoke-test-router]        Either export it in the shell or fill it in ${REPO_ROOT}/.env" >&2
  exit 1
fi

# Failure tracking
FAILURES=0
fail() { echo "[smoke-test-router] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-router] PASS: $*"; }

echo ""
echo "[smoke-test-router] ================================================================"
echo "[smoke-test-router]  local-llms — Phase 2 Router Verification"
echo "[smoke-test-router]  Router URL : ${ROUTER_URL}"
echo "[smoke-test-router]  Model      : ${MODEL}"
echo "[smoke-test-router] ================================================================"
echo ""

# Pre-flight: router + ollama must be running
echo "[smoke-test-router] Pre-flight: checking ${ROUTER_SVC} + ${OLLAMA_SVC} services are running..."
cd "${REPO_ROOT}"

RUNNING_SERVICES=$(docker compose ps --services --filter status=running 2>/dev/null || true)
for svc in "${ROUTER_SVC}" "${OLLAMA_SVC}"; do
  if ! echo "${RUNNING_SERVICES}" | grep -q "^${svc}$"; then
    fail "${svc} service is not running. Run: docker compose up -d --build ${svc}"
    echo ""
    echo "[smoke-test-router] Cannot proceed without a running ${svc}. Aborting."
    exit 1
  fi
done
pass "${ROUTER_SVC} + ${OLLAMA_SVC} services are running"

echo "[smoke-test-router] Pre-flight: waiting for ${ROUTER_URL}/healthz..."
for i in $(seq 1 30); do
  if curl -fsS "${ROUTER_URL}/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "${ROUTER_URL}/healthz" >/dev/null 2>&1; then
  fail "router /healthz is not reachable at ${ROUTER_URL}/healthz after 30s. Check \`docker compose logs router\`."
  exit 1
fi
pass "router /healthz reachable"

# SC4 (auth half): /healthz unauth + 401 on /v1/* missing/wrong bearer
echo ""
echo "[smoke-test-router] SC4 (auth half): /healthz unauth + 401 on /v1/* missing bearer..."
HEALTHZ_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz" || true)
[[ "${HEALTHZ_CODE}" == "200" ]] && pass "GET /healthz unauth -> 200" || fail "GET /healthz unauth -> ${HEALTHZ_CODE} (expected 200)"

NOAUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "${ROUTER_URL}/v1/chat/completions" || true)
[[ "${NOAUTH_CODE}" == "401" ]] && pass "POST /v1/chat/completions no bearer -> 401" || fail "POST /v1/chat/completions no bearer -> ${NOAUTH_CODE} (expected 401)"

WRONGAUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer wrong-token-value' -H 'Content-Type: application/json' -d '{}' "${ROUTER_URL}/v1/chat/completions" || true)
[[ "${WRONGAUTH_CODE}" == "401" ]] && pass "POST /v1/chat/completions wrong bearer -> 401" || fail "POST /v1/chat/completions wrong bearer -> ${WRONGAUTH_CODE} (expected 401)"

# SC2: non-stream chat completion with usage
echo ""
echo "[smoke-test-router] SC2: POST /v1/chat/completions stream=false ..."
REQUEST_BODY=$(_SMOKE_MODEL="${MODEL}" _SMOKE_PROMPT="${PROMPT_NONSTREAM}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": os.environ.get("_SMOKE_PROMPT", "")}],
  "stream": False,
}))
')
NONSTREAM_RESP=$(curl -fsS -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "${REQUEST_BODY}" 2>/dev/null || true)

if [[ -z "${NONSTREAM_RESP}" ]]; then
  fail "SC2: non-stream POST returned no response"
else
  USAGE_CHECK=$(NONSTREAM_RESP="${NONSTREAM_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ.get("NONSTREAM_RESP", ""))
  pt = d["usage"]["prompt_tokens"]; ct = d["usage"]["completion_tokens"]; tt = d["usage"]["total_tokens"]
  content = d["choices"][0]["message"]["content"]
  assert pt > 0 and ct > 0 and tt == pt + ct, f"bad usage: pt={pt} ct={ct} tt={tt}"
  assert content, "empty content"
  print(f"OK pt={pt} ct={ct} tt={tt} content_len={len(content)}")
except Exception as e:
  print(f"BAD:{e}")
')
  case "${USAGE_CHECK}" in
    OK*)  pass "SC2: non-stream returned ChatCompletion with usage (${USAGE_CHECK#OK })" ;;
    BAD:*) fail "SC2: ${USAGE_CHECK#BAD:} — raw: ${NONSTREAM_RESP:0:200}" ;;
    *)     fail "SC2: unexpected python output: ${USAGE_CHECK}" ;;
  esac
fi

# SC1: stream chat completion — chunks + [DONE] + usage
echo ""
echo "[smoke-test-router] SC1: POST /v1/chat/completions stream=true ..."
STREAM_BODY=$(_SMOKE_MODEL="${MODEL}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": "List 5 fruits as a numbered list."}],
  "stream": True,
}))
')
STREAM_OUT=$(mktemp)
curl -N -fsS -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "${STREAM_BODY}" \
  --max-time 60 > "${STREAM_OUT}" 2>/dev/null || true

if ! grep -q '^data: ' "${STREAM_OUT}"; then
  fail "SC1: no data: lines in stream response (raw size: $(wc -c < "${STREAM_OUT}") bytes)"
elif ! grep -q '\[DONE\]' "${STREAM_OUT}"; then
  fail "SC1: stream did not terminate with [DONE]"
else
  SC1_CHECK=$(STREAM_OUT_PATH="${STREAM_OUT}" python3 -c '
import os, re
txt = open(os.environ["STREAM_OUT_PATH"]).read()
m = re.search(r"\"usage\":\{\"prompt_tokens\":(\d+),\"completion_tokens\":(\d+),\"total_tokens\":(\d+)", txt)
if not m:
  print("BAD:no usage chunk found")
else:
  pt, ct, tt = int(m.group(1)), int(m.group(2)), int(m.group(3))
  if pt <= 0 or ct <= 0 or tt != pt + ct:
    print(f"BAD:bad usage pt={pt} ct={ct} tt={tt}")
  else:
    n = len(re.findall(r"^data: ", txt, re.MULTILINE))
    print(f"OK chunks={n} pt={pt} ct={ct} tt={tt}")
')
  case "${SC1_CHECK}" in
    OK*)  pass "SC1: stream emits chunks + usage + [DONE] (${SC1_CHECK#OK })" ;;
    BAD:*) fail "SC1: ${SC1_CHECK#BAD:}" ;;
    *)     fail "SC1: unexpected python output: ${SC1_CHECK}" ;;
  esac
fi
rm -f "${STREAM_OUT}"

# SC3: kill curl mid-stream + poll Ollama /api/ps for VRAM drop
echo ""
echo "[smoke-test-router] SC3: kill curl mid-stream + poll Ollama /api/ps for VRAM drop ..."
SC3_BODY=$(_SMOKE_MODEL="${MODEL}" _SMOKE_PROMPT="${PROMPT_STREAM}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": os.environ.get("_SMOKE_PROMPT", "")}],
  "stream": True,
}))
')

curl -N -s -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "${SC3_BODY}" \
  --max-time 30 > /tmp/sc3-stream.txt 2>/dev/null &
CURL_PID=$!
sleep 2
kill "${CURL_PID}" 2>/dev/null || true
wait "${CURL_PID}" 2>/dev/null || true

# Deterministic SC3 check (RESEARCH WARNING-2 fix):
#   Ollama refreshes `expires_at = now + keep_alive` on every generation step.
#   While the model is generating, `expires_at` advances between snapshots.
#   After a successful abort, generation stops and `expires_at` becomes static.
#
#   PASS conditions (any one):
#     (a) snapshot1.expires_at == snapshot2.expires_at        → static → abort propagated
#     (b) model absent in snapshot2 (size_vram=0 or DROPPED)  → unloaded → abort propagated
#   FAIL condition:
#     snapshot2.expires_at > snapshot1.expires_at + slack     → still generating → abort FAILED
#
# Distinguishes "abort propagated, keep_alive resident" from "abort never propagated".
# Note: Ollama image (ollama/ollama:0.5.7) does not ship curl. Use router container's
# Node.js fetch (backend network) to probe Ollama /api/ps (D-A4 + Phase 2 fix).
_ollama_ps_snapshot() {
  docker compose exec -T "${ROUTER_SVC}" node -e \
    "fetch('http://ollama:11434/api/ps').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" \
    2>/dev/null || true
}

SNAP1=$(_ollama_ps_snapshot)
sleep 1.5
SNAP2=$(_ollama_ps_snapshot)

SC3_VERDICT=$(MODEL="${MODEL}" SNAP1="${SNAP1}" SNAP2="${SNAP2}" python3 -c '
import json, os, datetime, sys
target = os.environ.get("MODEL", "")
def find(raw):
  try: data = json.loads(raw)
  except Exception: return ("PARSE_ERROR", None, None)
  for m in data.get("models", []):
    if m.get("name") == target or m.get("model") == target:
      return ("PRESENT", m.get("expires_at"), m.get("size_vram", 0))
  return ("DROPPED", None, None)
s1 = find(os.environ.get("SNAP1", ""))
s2 = find(os.environ.get("SNAP2", ""))
# PASS (b): unloaded
if s2[0] == "DROPPED" or (s2[0] == "PRESENT" and s2[2] == 0):
  print("PASS:unloaded"); sys.exit(0)
# PASS (a): expires_at static OR not advancing more than the wallclock delta
if s1[0] == "PRESENT" and s2[0] == "PRESENT" and s1[1] and s2[1]:
  def parse(ts):
    # Ollama emits RFC3339 with nanoseconds; strip trailing fractional precision Python cant parse
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00").split(".")[0] + "+00:00") if "." in ts else datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
  try:
    d1 = parse(s1[1]); d2 = parse(s2[1])
    delta_s = (d2 - d1).total_seconds()
    # Allow 0.5 s of slack for clock jitter; anything > slack means the model is still generating.
    if abs(delta_s) <= 0.5:
      print(f"PASS:static expires_at delta={delta_s:.2f}s"); sys.exit(0)
    else:
      print(f"FAIL:expires_at advanced {delta_s:.2f}s between snapshots — abort did NOT propagate to Ollama"); sys.exit(1)
  except Exception as e:
    print(f"INDETERMINATE:expires_at parse error {e}"); sys.exit(2)
print(f"INDETERMINATE:s1={s1[0]} s2={s2[0]}"); sys.exit(2)
')
SC3_EXIT=$?

case "${SC3_EXIT}" in
  0)
    pass "SC3: abort propagated to Ollama (${SC3_VERDICT})"
    ;;
  1)
    fail "SC3: abort did NOT propagate (${SC3_VERDICT}). Check req.raw.on('close') → controller.abort() → SDK signal chain in router/src/routes/v1/chat-completions.ts."
    ;;
  *)
    # INDETERMINATE — Ollama did not respond or expires_at was unparseable.
    # Refuse to silently PASS; force the operator to investigate.
    fail "SC3: indeterminate (${SC3_VERDICT}). Re-run after \`docker compose restart ollama router\` or check Ollama 0.5.x compat for /api/ps expires_at field."
    ;;
esac
rm -f /tmp/sc3-stream.txt

# SC4 (hot-reload half): edit models.yaml — router logs reload within 1s
echo ""
echo "[smoke-test-router] SC4 (hot-reload half): edit router/models.yaml + watch for reload log..."
HOTRELOAD_MARKER="# smoke-test-router hot-reload canary $(date +%s%N)"
PRE_LINES=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | wc -l)
echo "${HOTRELOAD_MARKER}" >> "${REPO_ROOT}/router/models.yaml"
sleep 1.0
POST_LINES=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | wc -l)
NEW_LINE_COUNT=$((POST_LINES - PRE_LINES + 5))
[[ "${NEW_LINE_COUNT}" -lt 1 ]] && NEW_LINE_COUNT=10
NEW_LINES=$(docker compose logs --no-color --tail "${NEW_LINE_COUNT}" "${ROUTER_SVC}" 2>&1 || true)
if echo "${NEW_LINES}" | grep -q 'registry reloaded'; then
  pass "SC4 hot-reload: router logged 'registry reloaded' within 1s of models.yaml edit"
else
  fail "SC4 hot-reload: no 'registry reloaded' log line within 1s of edit. Last log lines: $(echo "${NEW_LINES}" | tail -5)"
fi

# SC5: zero matches for the actual bearer-token value, or for an Authorization
# header carrying a token-shaped suffix, in router logs.
#
# Why this regex shape (was loosened after smoke-test #1):
#   The previous form `bearer [a-z0-9_]+|authorization:[[:space:]]*bearer`
#   false-matched the auth-failure log MESSAGE TEXT — strings like
#   "missing or malformed bearer header" trip `bearer [a-z]+`. The router
#   intentionally emits that message on 401 paths; it does NOT contain a token.
#
#   The robust check is two-pronged:
#     1) Grep for the literal ROUTER_BEARER_TOKEN value (zero false positives).
#     2) Grep for a token-SHAPED suffix after `bearer ` / `authorization: bearer ` —
#        require >= 16 chars of token-typical characters so descriptive English words
#        like "header" / "token" never match. Real bearer tokens are 32+ chars.
echo ""
echo "[smoke-test-router] SC5: scanning router logs for bearer/authorization leaks..."
SC5_LOGS=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 || true)
# Prong 1: literal token value (definitive)
LITERAL_LEAKS=$(printf '%s\n' "${SC5_LOGS}" | grep -cF "${ROUTER_BEARER_TOKEN}" || true)
# Prong 2: token-shaped suffix after bearer/authorization
SHAPED_LEAKS=$(printf '%s\n' "${SC5_LOGS}" | grep -ciE 'bearer [A-Za-z0-9._+/=-]{16,}|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._+/=-]{16,}' || true)
LEAK_COUNT=$(( LITERAL_LEAKS + SHAPED_LEAKS ))
if [[ "${LEAK_COUNT}" -ne 0 ]]; then
  FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -iE "${ROUTER_BEARER_TOKEN}|bearer [A-Za-z0-9._+/=-]{16,}|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._+/=-]{16,}" | head -1)
  fail "SC5: found ${LEAK_COUNT} bearer-token leak line(s) (literal=${LITERAL_LEAKS}, shaped=${SHAPED_LEAKS}, expected 0). First match: ${FIRST_MATCH}"
else
  pass "SC5: zero bearer-token leaks in router logs after a full session"
fi

# ============================================================================
# Phase 3 — Multi-Backend Dispatch (SC1 verification)
# ============================================================================
# Proves the registry-driven backend selection is the actual abstraction:
# switching `model` in the request body routes to a different backend with
# zero router-code change between the two backends.
#
# Per CONTEXT D-F1 and ROADMAP Phase 3 SC1.
# ============================================================================

echo ""
echo "[smoke-test-router] === Phase 3: Multi-backend dispatch ==="
echo "[smoke-test-router] (this section tears down + restarts compose with --profile swaps; takes ~2 min)"

PHASE3_BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${PHASE3_BASE_DIR}" || { fail "could not cd to project root"; exit 1; }

# --- Pre-flight: confirm Compose version supports `required: false` (>= 2.20.2)
COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "0.0.0")
echo "[smoke-test-router] docker compose version: ${COMPOSE_VER}"
# Use sort -V to compare versions
if printf '%s\n%s\n' "2.20.2" "${COMPOSE_VER}" | sort -V -C; then
  pass "Compose version >= 2.20.2 (depends_on required:false supported)"
else
  fail "Compose version ${COMPOSE_VER} < 2.20.2; depends_on required:false may not work; profile swap will fail"
fi

# --- Pre-flight: confirm the GGUF file exists on host (D-A2 — manual download required)
GGUF_PATH="${HOST_DATA_ROOT:-/srv/local-llms}/models-gguf/gguf/Qwen2.5-7B-Instruct-Q4_K_M.gguf"
if [[ -f "${GGUF_PATH}" ]]; then
  GGUF_SIZE=$(stat -c %s "${GGUF_PATH}" 2>/dev/null || stat -f %z "${GGUF_PATH}" 2>/dev/null || echo "0")
  # Expected ~4.68 GB +/- 100 MB
  if (( GGUF_SIZE > 4500000000 && GGUF_SIZE < 5000000000 )); then
    pass "GGUF present at ${GGUF_PATH} (size ${GGUF_SIZE} bytes)"
  else
    fail "GGUF size unexpected: ${GGUF_SIZE} bytes (expected ~4.68 GB)"
  fi
else
  fail "GGUF missing at ${GGUF_PATH}; run: hf download bartowski/Qwen2.5-7B-Instruct-GGUF Qwen2.5-7B-Instruct-Q4_K_M.gguf --local-dir ${HOST_DATA_ROOT:-/srv/local-llms}/models-gguf/gguf"
  echo "[smoke-test-router] Skipping Phase 3 section — GGUF missing"
  # Continue without further P3 assertions; FAILURES already incremented
fi

# Only run the profile-swap tests if GGUF is present
if [[ -f "${GGUF_PATH}" ]]; then

  # ========================================================================
  # Subsection A: --profile ollama active
  # ========================================================================
  echo ""
  echo "[smoke-test-router] Phase 3.A: bringing up --profile ollama..."
  docker compose --profile ollama down --remove-orphans 2>&1 | tail -2
  docker compose --profile llamacpp down --remove-orphans 2>&1 | tail -2
  if docker compose --profile ollama up -d --wait 2>&1 | tail -5; then
    pass "compose --profile ollama up -d --wait succeeded"
  else
    fail "compose --profile ollama up -d --wait failed"
  fi

  # Wait for router /healthz
  for i in $(seq 1 30); do
    _p3_code=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz" || echo "000")
    if [[ "${_p3_code}" == "200" ]]; then break; fi
    sleep 1
  done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz")" == "200" ]] \
    && pass "router /healthz reachable under --profile ollama" \
    || fail "router /healthz did not respond under --profile ollama"

  # Assertion A1: /v1/models lists BOTH registry models (D-C4 — listing is decoupled from probes)
  MODELS_BODY=$(curl -sf -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" "${ROUTER_URL}/v1/models" || true)
  if echo "${MODELS_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [m['id'] for m in d['data']]
sys.exit(0 if ('llama3.2:3b-instruct-q4_K_M' in ids and 'qwen2.5-7b-instruct-q4km' in ids) else 1)
"; then
    pass "/v1/models lists both ollama AND llamacpp models under --profile ollama (D-C4)"
  else
    fail "/v1/models did not list both models; body=${MODELS_BODY}"
  fi

  # Assertion A2: /readyz returns 503 (the llamacpp backend's URL is unreachable under profile ollama)
  READYZ_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/readyz" || true)
  if [[ "${READYZ_CODE}" == "503" ]]; then
    pass "/readyz returns 503 under --profile ollama (D-D5 — by design; llamacpp URL unreachable)"
  else
    fail "/readyz returned ${READYZ_CODE} under --profile ollama (expected 503; D-D5)"
  fi

  # Assertion A3: /readyz body has per-backend statuses — exactly one alive + one down
  READYZ_BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
  if echo "${READYZ_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
alive = [b for b in d['backends'] if b['status'] == 'alive']
down = [b for b in d['backends'] if b['status'] in ('down', 'stale')]
if len(alive) == 1 and len(down) == 1 and 'ollama' in alive[0]['url'] and 'llamacpp' in down[0]['url']:
    sys.exit(0)
else:
    print(f'alive={alive}, down={down}', file=sys.stderr)
    sys.exit(1)
"; then
    pass "/readyz body shows ollama alive + llamacpp down (D-D4)"
  else
    fail "/readyz body shape wrong; body=${READYZ_BODY}"
  fi

  # Assertion A4 (SC1 -- half 1): POST /v1/chat/completions with the ollama model serves tokens
  CHAT_BODY=$(curl -sf -X POST \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"Say hello in exactly two words"}],"stream":false,"max_tokens":20}' \
    "${ROUTER_URL}/v1/chat/completions" || true)
  if echo "${CHAT_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['choices'][0]['message']['content']
sys.exit(0 if isinstance(content, str) and len(content) > 0 else 1)
"; then
    pass "POST /v1/chat/completions {model: llama3.2...} returned non-empty content under --profile ollama"
  else
    fail "POST /v1/chat/completions to ollama model failed or returned empty; body=${CHAT_BODY}"
  fi

  # Assertion A5: POST /v1/chat/completions to the llamacpp model returns 4xx/5xx (its backend is down)
  CHAT_LLAMACPP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"model":"qwen2.5-7b-instruct-q4km","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":5}' \
    "${ROUTER_URL}/v1/chat/completions" || true)
  if [[ "${CHAT_LLAMACPP_CODE}" =~ ^[45] ]]; then
    pass "POST {model: qwen2.5...} returns ${CHAT_LLAMACPP_CODE} under --profile ollama (backend unreachable; expected error)"
  else
    fail "POST {model: qwen2.5...} returned ${CHAT_LLAMACPP_CODE} (expected 4xx/5xx; backend should be unreachable)"
  fi

  # Tear down
  docker compose --profile ollama down --remove-orphans 2>&1 | tail -2

  # ========================================================================
  # Subsection B: --profile llamacpp active (the swap -- SC1 proof)
  # ========================================================================
  echo ""
  echo "[smoke-test-router] Phase 3.B: bringing up --profile llamacpp..."
  if docker compose --profile llamacpp up -d --wait 2>&1 | tail -5; then
    pass "compose --profile llamacpp up -d --wait succeeded"
  else
    fail "compose --profile llamacpp up -d --wait failed"
  fi

  # Wait for router /healthz (llamacpp cold-start can take ~60s)
  for i in $(seq 1 90); do
    _p3_code=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz" || echo "000")
    if [[ "${_p3_code}" == "200" ]]; then break; fi
    sleep 1
  done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz")" == "200" ]] \
    && pass "router /healthz reachable under --profile llamacpp" \
    || fail "router /healthz did not respond under --profile llamacpp"

  # llamacpp cold-start can take ~60s (start_period). Give it time before probing /readyz.
  echo "[smoke-test-router] waiting up to 90s for llamacpp /readyz to flip alive..."
  for i in $(seq 1 90); do
    _p3_body=$(curl -s "${ROUTER_URL}/readyz" || true)
    if echo "${_p3_body}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    llamacpp = [b for b in d['backends'] if 'llamacpp' in b['url']]
    sys.exit(0 if llamacpp and llamacpp[0]['status'] == 'alive' else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  # Assertion B1 (SC1 -- half 2): POST /v1/chat/completions with the llamacpp model serves tokens
  CHAT_BODY_2=$(curl -sf -X POST \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"model":"qwen2.5-7b-instruct-q4km","messages":[{"role":"user","content":"Say hi in two words"}],"stream":false,"max_tokens":20}' \
    "${ROUTER_URL}/v1/chat/completions" || true)
  if echo "${CHAT_BODY_2}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['choices'][0]['message']['content']
sys.exit(0 if isinstance(content, str) and len(content) > 0 else 1)
"; then
    pass "POST /v1/chat/completions {model: qwen2.5...} returned non-empty content under --profile llamacpp -- SC1 proven (same endpoint, no router code change between profiles)"
  else
    fail "POST /v1/chat/completions to llamacpp model failed or returned empty; body=${CHAT_BODY_2}"
  fi

  # Assertion B2: /readyz body now shows llamacpp alive + ollama down (inverse of A3)
  READYZ_BODY_2=$(curl -s "${ROUTER_URL}/readyz" || true)
  if echo "${READYZ_BODY_2}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
alive = [b for b in d['backends'] if b['status'] == 'alive']
down = [b for b in d['backends'] if b['status'] in ('down', 'stale')]
if len(alive) == 1 and len(down) == 1 and 'llamacpp' in alive[0]['url'] and 'ollama' in down[0]['url']:
    sys.exit(0)
else:
    print(f'alive={alive}, down={down}', file=sys.stderr)
    sys.exit(1)
"; then
    pass "/readyz body shows llamacpp alive + ollama down (inverse of subsection A -- profile swap took effect)"
  else
    fail "/readyz body shape wrong under --profile llamacpp; body=${READYZ_BODY_2}"
  fi

  # Assertion B3: BCKND-02 -- llamacpp is using GPU (nvidia-smi shows the process)
  if docker compose --profile llamacpp exec -T llamacpp sh -c "command -v nvidia-smi >/dev/null && nvidia-smi --query-compute-apps=name --format=csv,noheader" 2>/dev/null | grep -qiE 'llama|llamacpp|llama-server'; then
    pass "llamacpp container shows GPU process via nvidia-smi (BCKND-02 -- GPU-resident inference)"
  else
    # llamacpp image may not have nvidia-smi binary; fall back to host check
    if command -v nvidia-smi >/dev/null && nvidia-smi --query-compute-apps=name --format=csv,noheader 2>/dev/null | grep -qiE 'llama|llamacpp|llama-server'; then
      pass "llamacpp visible in host nvidia-smi --query-compute-apps (BCKND-02)"
    else
      fail "could not verify llamacpp GPU residency via nvidia-smi (BCKND-02)"
    fi
  fi

  # Tear down
  docker compose --profile llamacpp down --remove-orphans 2>&1 | tail -2

fi  # end "if GGUF present"

echo ""
echo "[smoke-test-router] === Phase 3 section complete ==="

# Final summary
echo ""
echo "[smoke-test-router] ================================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[smoke-test-router]  Phase 2 router verification: COMPLETE."
  echo "[smoke-test-router]  Model used : ${MODEL}"
  echo "[smoke-test-router]  Router URL : ${ROUTER_URL}"
  echo "[smoke-test-router] ================================================================"
  echo ""
  exit 0
else
  echo "[smoke-test-router]  FAILED: ${FAILURES} assertion(s) did not pass."
  echo "[smoke-test-router]  Run \`docker compose logs router\` for upstream-side details."
  echo "[smoke-test-router]  Re-run \`bash bin/preflight-gpu.sh\` if SC2/SC1/SC3 fail (the GPU may not be passthrough-functional)."
  echo "[smoke-test-router] ================================================================"
  echo ""
  exit 1
fi
