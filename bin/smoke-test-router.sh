#!/usr/bin/env bash
# bin/smoke-test-router.sh — end-to-end router verification for local-llms Phases 2–5
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
#   --profile prod|dev          Pick the router profile (default: dev, backward compat).
#                               `dev` keeps host-loopback probes (http://127.0.0.1:3000).
#                               `prod` routes router probes via `docker compose exec -T router curl ...`
#                               because Phase 6 (Plan 02) removed the prod router's host port.
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
PROFILE="dev"   # default = dev (backward compat — Phase 2-5 callers do not pass --profile)

usage() {
  cat <<'USAGE'
Usage: bash bin/smoke-test-router.sh [options]

  -m MODEL | --model MODEL      Override model (default: llama3.2:3b-instruct-q4_K_M)
  --router-url URL              Override router URL (default: http://127.0.0.1:3000)
  --profile prod|dev            Router profile (default: dev).
                                  dev  — probes via host loopback (http://127.0.0.1:3000;
                                         router-dev keeps its host port).
                                  prod — probes via `docker compose exec -T router curl ...`
                                         because Plan 06-02 removed the prod router's
                                         host port (Pitfall 11). External-via-Tailscale
                                         smoke lives in bin/smoke-test-traefik.sh.
  -h | --help                   Print this help and exit 0

Purpose:
  End-to-end Phase 2–5 verification — asserts SC1..SC5 (Phase 2), multi-backend
  dispatch (Phase 3), Anthropic surface + vision (Phase 4), Postgres + Observability (Phase 5).
  Run after `docker compose up -d --build router` (dev) or `docker compose up -d` (prod).

  Examples:
    bash bin/smoke-test-router.sh                    # default — dev profile
    bash bin/smoke-test-router.sh --profile dev      # explicit
    bash bin/smoke-test-router.sh --profile prod     # Phase 6 prod path (Pitfall 11 fix)

  Exit 0 = all assertions pass.
  Exit 1 = one or more assertions failed; actionable diagnostic printed.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)        MODEL="${2:?--model requires an argument}"; shift 2 ;;
    --router-url)      ROUTER_URL="${2:?--router-url requires an argument}"; shift 2 ;;
    --profile)
      PROFILE="${2:?--profile requires an argument (prod|dev)}"
      case "$PROFILE" in
        prod|dev) ;;
        *) echo "[smoke-test-router] ERROR: --profile must be 'prod' or 'dev', got: $PROFILE" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "[smoke-test-router] ERROR: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Profile-derived dispatch mode (Pitfall 11 fix).
#   ROUTER_PROBE_MODE=host : curl directly at $ROUTER_URL (dev — router-dev:3000:3000 host port)
#   ROUTER_PROBE_MODE=exec : curl inside the router container via `docker compose exec -T router curl ...`
#                            (prod — Plan 06-02 removed the host port)
if [[ "$PROFILE" == "prod" ]]; then
  ROUTER_PROBE_MODE="exec"
  # In exec mode, all router-bound curl calls target localhost INSIDE the router
  # container. Rewrite ROUTER_URL so each call site's URL is correct unchanged.
  if [[ "$ROUTER_URL" == "$DEFAULT_ROUTER_URL" ]]; then
    ROUTER_URL="http://localhost:3000"
  fi
else
  ROUTER_PROBE_MODE="host"
fi

# router_curl — wrapper used (in `prod` mode) to route curl through the router
# container. Dev mode is a passthrough. Kept as an explicit helper so any new
# call site added in future plans can opt in.
#
# Usage: router_curl <curl args...>
# In exec mode, URLs MUST be http://localhost:3000/... (inside-container).
# The default $ROUTER_URL is rewritten above to the in-container form, so the
# existing curl call sites that pass "${ROUTER_URL}/..." need no per-call edits.
router_curl() {
  if [[ "$ROUTER_PROBE_MODE" == "exec" ]]; then
    docker compose exec -T "${ROUTER_SVC}" curl "$@"
  else
    curl "$@"
  fi
}

# In prod mode, install a `curl` shell function that intercepts router-bound
# invocations (detected by the presence of $ROUTER_URL in the argv) and routes
# them through `docker compose exec -T router curl ...`. Non-router curls
# (e.g. probing Ollama directly) pass through to the binary unchanged via
# `command curl`. The router_curl helper above remains the canonical opt-in
# path; this shadow function makes the existing ~40 ${ROUTER_URL}/... call
# sites work in prod mode without per-call rewrites.
if [[ "$ROUTER_PROBE_MODE" == "exec" ]]; then
  curl() {
    local needs_exec=0
    local arg
    for arg in "$@"; do
      case "$arg" in
        "${ROUTER_URL}"*) needs_exec=1; break ;;
      esac
    done
    if [[ $needs_exec -eq 1 ]]; then
      docker compose exec -T "${ROUTER_SVC}" curl "$@"
    else
      command curl "$@"
    fi
  }
fi

# Locate repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Resolve ROUTER_BEARER_TOKEN — caller env > .env > hard fail.
#
# WR-05: previously this used `set -a; source .env; set +a` which exports EVERY
# variable in .env into the script's environment — including secrets unrelated
# to this test (OLLAMA_API_KEY, future cloud keys, etc.). Those secrets would
# then inherit into every subprocess the script spawns (docker compose exec,
# curl, python3). Extract ONLY the variable we actually need.
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  # Grep the single VAR=value line (last wins if duplicated), strip the prefix,
  # and trim a single layer of surrounding double or single quotes. The pipeline
  # never sources the file so unrelated secrets stay in .env.
  ROUTER_BEARER_TOKEN=$(
    grep -E '^ROUTER_BEARER_TOKEN=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
  export ROUTER_BEARER_TOKEN
fi
if [[ -z "${ROUTER_BEARER_TOKEN:-}" ]]; then
  echo "[smoke-test-router] ERROR: ROUTER_BEARER_TOKEN is not set." >&2
  echo "[smoke-test-router]        Either export it in the shell or fill it in ${REPO_ROOT}/.env" >&2
  exit 1
fi

# Failure / skip tracking
FAILURES=0
SKIPS=0
fail() { echo "[smoke-test-router] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-router] PASS: $*"; }
skip() { echo "[smoke-test-router] SKIP: $*"; SKIPS=$((SKIPS + 1)); }

echo ""
echo "[smoke-test-router] ================================================================"
echo "[smoke-test-router]  local-llms — Phase 2-5 Router Verification"
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
# WR-03 fix: strip the canary line so re-running the smoke test does not
# permanently pollute models.yaml. Fixed prefix matches any prior runs' canaries
# (different timestamps) so leftovers from before this fix also get cleaned up.
grep -v '^# smoke-test-router hot-reload canary ' "${REPO_ROOT}/router/models.yaml" \
  > "${REPO_ROOT}/router/models.yaml.tmp" \
  && mv "${REPO_ROOT}/router/models.yaml.tmp" "${REPO_ROOT}/router/models.yaml"
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
  # WR-03 fix: use -F for the token portion so ERE metacharacters in the token
  # don't abort the script or silently match wrong lines. Fall back to a separate
  # -iE grep for the token-shaped pattern only if the literal search misses.
  FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -F "${ROUTER_BEARER_TOKEN}" | head -1)
  if [[ -z "${FIRST_MATCH}" ]]; then
    FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -iE 'bearer [A-Za-z0-9._+/=-]{16,}|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._+/=-]{16,}' | head -1)
  fi
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

  # Assertion A3: /readyz body has per-backend statuses — ollama alive + llamacpp down
  # UAT 2026-05-18 fix: relaxed from "exactly 1 alive + 1 down" to "ollama is
  # alive AND llamacpp is down" — vllm/vllm-embed/ollama-cloud entries land in
  # alive[] under the standard --profile vllm setup which is the v0.9.0 default.
  # The Phase 2-era exact-count assertion was written when the registry only
  # had two backends (ollama + llamacpp).
  READYZ_BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
  if echo "${READYZ_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
alive_urls = [b['url'] for b in d['backends'] if b['status'] == 'alive']
down_urls = [b['url'] for b in d['backends'] if b['status'] in ('down', 'stale')]
ollama_alive = any('ollama:' in u or 'ollama.com' in u for u in alive_urls if 'ollama:' in u)
llamacpp_down = any('llamacpp' in u for u in down_urls)
if ollama_alive and llamacpp_down:
    sys.exit(0)
else:
    print(f'alive_urls={alive_urls}, down_urls={down_urls}', file=sys.stderr)
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
  #
  # Hardware-dependent: cold-loading a 4.7GB GGUF on llamacpp can exceed
  # the service `start_period` (60s in compose.yml) on WSL2/slower hosts,
  # making `up --wait` time out even when the eventual load succeeds.
  # Operators on such hosts can opt out via SKIP_LLAMACPP=1 — Phase 3.B is
  # skipped entirely (SKIPS bumped, FAILURES untouched) and Phase 4 + 5
  # still run because they re-establish --profile ollama state.
  if [[ "${SKIP_LLAMACPP:-0}" == "1" ]]; then
    skip "Phase 3.B (SKIP_LLAMACPP=1): llamacpp profile + SC1-half-2 (qwen2.5) + BCKND-02 GPU residency skipped"
  else
    echo ""
    echo "[smoke-test-router] Phase 3.B: bringing up --profile llamacpp..."
    LLAMACPP_HEALTHY=true
    if docker compose --profile llamacpp up -d --wait 2>&1 | tail -5; then
      pass "compose --profile llamacpp up -d --wait succeeded"
    else
      # On WSL2 / slower hosts a 4.7GB GGUF can take >60s start_period to
      # cold-load. Don't cascade: downgrade to SKIP for downstream assertions
      # that depend on llamacpp being healthy, and keep going so Phase 4 + 5
      # still run (after the Phase 4 setup block restores --profile ollama).
      fail "compose --profile llamacpp up -d --wait failed (GGUF load may exceed 60s start_period on this host — set SKIP_LLAMACPP=1 to skip Phase 3.B explicitly)"
      LLAMACPP_HEALTHY=false
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

  # WR-02 fix: Guard B1/B2/B3 on LLAMACPP_HEALTHY. If compose --profile llamacpp
  # up -d --wait failed above, LLAMACPP_HEALTHY=false and the fail() already told
  # the operator what went wrong. Running B-section assertions anyway would cascade
  # false failures (empty curl output → python parse error → inflated FAILURES count)
  # that obscure the real signal. Skip all three assertions instead.
  if [[ "${LLAMACPP_HEALTHY}" != "true" ]]; then
    skip "Phase 3.B assertions B1/B2/B3: skipped because compose --profile llamacpp up -d --wait failed"
  else

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
  # UAT 2026-05-18 fix: relaxed from "exactly 1 alive + 1 down" — same rationale
  # as A3 above (vllm/cloud entries land in alive[] under the v0.9.0 default).
  READYZ_BODY_2=$(curl -s "${ROUTER_URL}/readyz" || true)
  if echo "${READYZ_BODY_2}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
alive_urls = [b['url'] for b in d['backends'] if b['status'] == 'alive']
down_urls = [b['url'] for b in d['backends'] if b['status'] in ('down', 'stale')]
llamacpp_alive = any('llamacpp' in u for u in alive_urls)
ollama_down = any('ollama:' in u for u in down_urls)
if llamacpp_alive and ollama_down:
    sys.exit(0)
else:
    print(f'alive_urls={alive_urls}, down_urls={down_urls}', file=sys.stderr)
    sys.exit(1)
"; then
    pass "/readyz body shows llamacpp alive + ollama down (inverse of subsection A -- profile swap took effect)"
  else
    fail "/readyz body shape wrong under --profile llamacpp; body=${READYZ_BODY_2}"
  fi

  # Assertion B3: BCKND-02 -- llamacpp is using GPU (nvidia-smi shows the process)
  # Tier 1: nvidia-smi inside the container (works on bare-metal Linux)
  if docker compose --profile llamacpp exec -T llamacpp sh -c "command -v nvidia-smi >/dev/null && nvidia-smi --query-compute-apps=name --format=csv,noheader" 2>/dev/null | grep -qiE 'llama|llamacpp|llama-server'; then
    pass "llamacpp container shows GPU process via nvidia-smi (BCKND-02 -- GPU-resident inference)"
  else
    # Tier 2: host-side nvidia-smi --query-compute-apps (works on bare-metal Linux)
    if command -v nvidia-smi >/dev/null && nvidia-smi --query-compute-apps=name --format=csv,noheader 2>/dev/null | grep -qiE 'llama|llamacpp|llama-server'; then
      pass "llamacpp visible in host nvidia-smi --query-compute-apps (BCKND-02)"
    else
      # Tier 3: parse container logs for GPU offload signal.
      # WSL2 projects CUDA into containers but does NOT expose compute-app enumeration
      # via nvidia-smi --query-compute-apps, so tiers 1+2 fail even when CUDA is working.
      # Grepping for 'load_tensors: offloaded N/N layers to GPU' in the startup log is
      # reliable on all hosts where CUDA initialized successfully (including WSL2).
      # The \1 backreference enforces that ALL layers were offloaded (N/N), so a partial
      # CPU fallback like '15/29 layers' correctly fails this check.
      if docker compose --profile llamacpp logs llamacpp 2>/dev/null | grep -qE 'load_tensors: offloaded ([1-9][0-9]*)/\1 layers to GPU'; then
        pass "llamacpp logs confirm full GPU offload (load_tensors N/N layers to GPU) -- BCKND-02 via log-parse (WSL2 path)"
      else
        fail "could not verify llamacpp GPU residency via nvidia-smi or log-parse (BCKND-02)"
      fi
    fi
  fi

  fi  # end LLAMACPP_HEALTHY guard

  # Tear down
  docker compose --profile llamacpp down --remove-orphans 2>&1 | tail -2

  fi  # end SKIP_LLAMACPP / else
fi  # end "if GGUF present"

echo ""
echo "[smoke-test-router] === Phase 3 section complete ==="

# =============================================================================
# Phase 4 section — Anthropic surface + tool calling + vision (Plan 04-05)
# =============================================================================
#
# SC-P4-A: POST /v1/messages stream=false      — non-stream Anthropic Message
# SC-P4-B: POST /v1/messages stream=true       — SSE event sequence (NO [DONE])
# SC-P4-C: POST /v1/messages/count_tokens      — input_tokens + header
# SC-P4-D: POST /v1/messages vision happy path — URL form, llama3.2-vision
# SC-P4-E: POST /v1/messages vision cap-gate   — non-vision model + image → 400
#
# Tracking — SKIPS counter for vision section when model isn't pulled / env
# disables network. FAILURES is the existing counter from Phase 2.
# (skip() + SKIPS=0 are defined at the top alongside fail()/pass() — WR-01 fix.)

VISION_MODEL="llama3.2-vision:11b-instruct-q4_K_M"

echo ""
echo "[smoke-test-router] === Phase 4 section: Anthropic surface + vision (SC-P4-A..E) ==="

# Phase 3's --profile llamacpp teardown left the stack down. Phase 4 + 5
# expect `--profile ollama` state (postgres + pg-backup + router + ollama).
# Bring it back up idempotently before running the Anthropic section.
echo "[smoke-test-router] Phase 4: ensuring --profile ollama stack is up..."
if ! docker compose --profile ollama up -d --wait 2>&1 | tail -3; then
  fail "Phase 4 setup: --profile ollama up -d --wait failed; remaining Phase 4 + 5 sections will be unreliable"
fi
sleep 2

# ── SC-P4-A: /v1/messages non-stream ────────────────────────────────────────
echo ""
echo "[smoke-test-router] SC-P4-A: POST /v1/messages stream=false ..."
SCP4A_BODY=$(_SMOKE_MODEL="${MODEL}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "max_tokens": 100,
  "messages": [{"role": "user", "content": "Reply with one short sentence."}],
}))
')
SCP4A_RESP=$(curl -fsS -X POST "${ROUTER_URL}/v1/messages" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "${SCP4A_BODY}" 2>/dev/null || true)
if [[ -z "${SCP4A_RESP}" ]]; then
  fail "SC-P4-A: empty response from /v1/messages"
else
  SCP4A_CHECK=$(SCP4A_RESP="${SCP4A_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ["SCP4A_RESP"])
  msg_id = d.get("id") or ""
  msg_type = d.get("type") or ""
  tokens_in = d.get("usage", {}).get("input_tokens", 0)
  tokens_out = d.get("usage", {}).get("output_tokens", 0)
  assert msg_id.startswith("msg_"), "id does not start with msg_: " + msg_id
  assert msg_type == "message", "type is not message: " + msg_type
  assert tokens_in > 0, "input_tokens not > 0"
  assert tokens_out > 0, "output_tokens not > 0"
  print("OK id=" + msg_id[:14] + "... in=" + str(tokens_in) + " out=" + str(tokens_out))
except Exception as e:
  print("BAD:" + str(e))
')
  case "${SCP4A_CHECK}" in
    OK*)   pass "SC-P4-A: /v1/messages non-stream (${SCP4A_CHECK#OK })" ;;
    BAD:*) fail "SC-P4-A: ${SCP4A_CHECK#BAD:} — raw: ${SCP4A_RESP:0:200}" ;;
    *)     fail "SC-P4-A: unexpected python output: ${SCP4A_CHECK}" ;;
  esac
fi

# ── SC-P4-B: /v1/messages stream ────────────────────────────────────────────
echo ""
echo "[smoke-test-router] SC-P4-B: POST /v1/messages stream=true ..."
SCP4B_BODY=$(_SMOKE_MODEL="${MODEL}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "max_tokens": 80,
  "messages": [{"role": "user", "content": "List 3 fruits."}],
  "stream": True,
}))
')
SCP4B_OUT=$(mktemp)
curl -N -fsS -X POST "${ROUTER_URL}/v1/messages" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "${SCP4B_BODY}" \
  --max-time 60 > "${SCP4B_OUT}" 2>/dev/null || true

if [[ ! -s "${SCP4B_OUT}" ]]; then
  fail "SC-P4-B: empty stream response"
else
  MISSING_EVENTS=()
  for ev in message_start content_block_delta message_delta message_stop; do
    grep -q "^event: ${ev}\$" "${SCP4B_OUT}" || MISSING_EVENTS+=("${ev}")
  done
  if [[ ${#MISSING_EVENTS[@]} -gt 0 ]]; then
    fail "SC-P4-B: missing SSE events: ${MISSING_EVENTS[*]}"
  elif grep -q '\[DONE\]' "${SCP4B_OUT}"; then
    fail "SC-P4-B: Anthropic SSE must NOT emit [DONE]; found one"
  else
    pass "SC-P4-B: /v1/messages stream emits all 4 typed events; no [DONE]"
  fi
fi
rm -f "${SCP4B_OUT}"

# ── SC-P4-C: /v1/messages/count_tokens ──────────────────────────────────────
echo ""
echo "[smoke-test-router] SC-P4-C: POST /v1/messages/count_tokens ..."
SCP4C_BODY=$(_SMOKE_MODEL="${MODEL}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": "Count my tokens please, friend."}],
}))
')
SCP4C_HEADERS_FILE=$(mktemp)
SCP4C_BODY_RESP=$(curl -fsS -D "${SCP4C_HEADERS_FILE}" -X POST "${ROUTER_URL}/v1/messages/count_tokens" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "${SCP4C_BODY}" 2>/dev/null || true)

if [[ -z "${SCP4C_BODY_RESP}" ]]; then
  fail "SC-P4-C: empty count_tokens response"
else
  SCP4C_CHECK=$(SCP4C_BODY_RESP="${SCP4C_BODY_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ["SCP4C_BODY_RESP"])
  tok = d.get("input_tokens")
  assert isinstance(tok, int) and tok > 0, "bad input_tokens: " + str(d)
  print("OK input_tokens=" + str(tok))
except Exception as e:
  print("BAD:" + str(e))
')
  case "${SCP4C_CHECK}" in
    OK*)
      # Header check (case-insensitive)
      if grep -qi '^X-Token-Count-Method:[[:space:]]*gpt-tokenizer/cl100k_base' "${SCP4C_HEADERS_FILE}"; then
        pass "SC-P4-C: count_tokens (${SCP4C_CHECK#OK }) + X-Token-Count-Method header present"
      else
        fail "SC-P4-C: input_tokens OK but X-Token-Count-Method header missing/incorrect"
      fi
      ;;
    BAD:*) fail "SC-P4-C: ${SCP4C_CHECK#BAD:} — raw: ${SCP4C_BODY_RESP:0:200}" ;;
    *)     fail "SC-P4-C: unexpected python output: ${SCP4C_CHECK}" ;;
  esac
fi
rm -f "${SCP4C_HEADERS_FILE}"

# ── SC-P4-D: vision happy path via URL ──────────────────────────────────────
# NOTE: the image URL choice is intentional —
#   https://raw.githubusercontent.com/ollama/ollama/main/docs/ollama.png
# is a small (~10 KB) public HTTPS image on a stable GitHub raw path. It tests
# the full D-C4 URL-fetch pipeline (HTTPS scheme → DNS lookup → 10 MB cap →
# image/* content-type → bare base64 forwarded to /api/chat). If the smoke
# environment has no outbound network, set SKIP_URL=1 to skip this section.
echo ""
echo "[smoke-test-router] SC-P4-D: POST /v1/messages vision URL happy path ..."
# UAT 2026-05-18: pre-flight VRAM check. The vision model is ~7.8 GiB and the
# one-backend-hot pattern (PROJECT.md) means it cannot coexist with vllm +
# vllm-embed which together hold ~10 GiB on a 16 GiB GPU. If insufficient VRAM
# is free, skip with a clear operator action instead of hanging the request.
VISION_NEED_MIB=8500   # ~7.8 GiB + headroom for KV cache
VRAM_FREE_MIB=$(docker compose exec -T ollama nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | tr -d '[:space:]' || echo 0)
# UAT-surfaced flake: retry transient empty exec output (see Phase 7 P7_OLLAMA_LIST).
SCP4D_OLLAMA_LIST=""
for _ in 1 2 3; do
  SCP4D_OLLAMA_LIST=$(docker compose exec -T ollama ollama list 2>/dev/null || true)
  [[ -n "${SCP4D_OLLAMA_LIST}" ]] && break
  sleep 1
done
if ! printf '%s\n' "${SCP4D_OLLAMA_LIST}" | grep -q "${VISION_MODEL}"; then
  skip "SC-P4-D: vision model not pulled; run: docker compose exec ollama ollama pull ${VISION_MODEL}"
elif [[ "${SKIP_URL:-}" == "1" ]]; then
  skip "SC-P4-D: SKIP_URL=1; smoke env has no outbound network for image fetch"
elif [[ -n "${VRAM_FREE_MIB}" ]] && [[ "${VRAM_FREE_MIB}" =~ ^[0-9]+$ ]] && (( VRAM_FREE_MIB < VISION_NEED_MIB )); then
  skip "SC-P4-D: insufficient VRAM (${VRAM_FREE_MIB} MiB free, need ${VISION_NEED_MIB} MiB). Stop vllm/vllm-embed first (one-backend-hot pattern): docker compose --profile vllm stop vllm vllm-embed"
else
  SCP4D_BODY=$(python3 -c '
import json
print(json.dumps({
  "model": "llama3.2-vision:11b-instruct-q4_K_M",
  "max_tokens": 200,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image", "source": {"type": "url",
        "url": "https://raw.githubusercontent.com/ollama/ollama/main/docs/ollama.png"}},
      {"type": "text", "text": "Describe this image in one sentence."}
    ]
  }]
}))
')
  SCP4D_RESP=$(curl -fsS -X POST "${ROUTER_URL}/v1/messages" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H 'Content-Type: application/json' \
    -H 'anthropic-version: 2023-06-01' \
    --max-time 120 \
    -d "${SCP4D_BODY}" 2>/dev/null || true)
  if [[ -z "${SCP4D_RESP}" ]]; then
    fail "SC-P4-D: empty vision response (router or model unreachable)"
  else
    # Pre-check: if the response is an error envelope citing model_not_found /
    # not loaded, treat as skip (operator did not pull the vision model) rather
    # than fail — mirrors the pre-flight ollama-list check above.
    SCP4D_PREFLIGHT=$(SCP4D_RESP="${SCP4D_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ["SCP4D_RESP"])
  if isinstance(d, dict) and d.get("type") == "error":
    err = d.get("error") or {}
    etype = err.get("type") or ""
    emsg = (err.get("message") or "").lower()
    if etype == "model_not_found" or "not found" in emsg or "not loaded" in emsg or "pull" in emsg:
      print("SKIP_MODEL_NOT_PULLED")
    else:
      print("OK")
  else:
    print("OK")
except Exception:
  print("OK")
')
    if [[ "${SCP4D_PREFLIGHT}" == "SKIP_MODEL_NOT_PULLED" ]]; then
      skip "SC-P4-D: vision model returned model_not_found from router; run: docker compose exec ollama ollama pull ${VISION_MODEL}"
    else
      SCP4D_CHECK=$(SCP4D_RESP="${SCP4D_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ["SCP4D_RESP"])
  text = d["content"][0]["text"]
  assert len(text) > 10, "response too short: " + str(len(text)) + " chars"
  print("OK text_len=" + str(len(text)))
except Exception as e:
  print("BAD:" + str(e))
')
      case "${SCP4D_CHECK}" in
        OK*)   pass "SC-P4-D: vision URL → /api/chat happy path (${SCP4D_CHECK#OK })" ;;
        BAD:*) fail "SC-P4-D: ${SCP4D_CHECK#BAD:} — raw: ${SCP4D_RESP:0:200}" ;;
        *)     fail "SC-P4-D: unexpected python output: ${SCP4D_CHECK}" ;;
      esac
    fi
  fi
fi

# ── SC-P4-E: vision capability gate (image + non-vision model → 400) ────────
echo ""
echo "[smoke-test-router] SC-P4-E: POST /v1/messages vision capability gate ..."
SCP4E_BODY=$(_SMOKE_MODEL="${MODEL}" python3 -c '
import json, os
# A tiny base64-encoded 1x1 transparent PNG.
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "max_tokens": 100,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}},
      {"type": "text", "text": "?"}
    ]
  }]
}))
')
SCP4E_TMP=$(mktemp)
SCP4E_STATUS=$(curl -s -o "${SCP4E_TMP}" -w '%{http_code}' -X POST "${ROUTER_URL}/v1/messages" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "${SCP4E_BODY}" 2>/dev/null || true)
SCP4E_BODY_RESP=$(cat "${SCP4E_TMP}" 2>/dev/null || true)
rm -f "${SCP4E_TMP}"
if [[ "${SCP4E_STATUS}" != "400" ]]; then
  fail "SC-P4-E: expected 400 (capability gate), got ${SCP4E_STATUS} — body: ${SCP4E_BODY_RESP:0:200}"
else
  SCP4E_CHECK=$(SCP4E_BODY_RESP="${SCP4E_BODY_RESP}" python3 -c '
import json, os
try:
  d = json.loads(os.environ["SCP4E_BODY_RESP"])
  env_type = d.get("type") or ""
  err_type = (d.get("error") or {}).get("type") or ""
  err_msg = (d.get("error") or {}).get("message") or ""
  assert env_type == "error", "envelope type: " + env_type
  assert err_type == "invalid_request_error", "error.type: " + err_type
  assert "vision" in err_msg.lower(), "message missing vision: " + err_msg
  print("OK")
except Exception as e:
  print("BAD:" + str(e))
')
  case "${SCP4E_CHECK}" in
    OK*)   pass "SC-P4-E: vision-on-non-vision-model → 400 + invalid_request_error envelope (VISION-02)" ;;
    BAD:*) fail "SC-P4-E: ${SCP4E_CHECK#BAD:} — raw: ${SCP4E_BODY_RESP:0:200}" ;;
    *)     fail "SC-P4-E: unexpected python output: ${SCP4E_CHECK}" ;;
  esac
fi

echo ""
echo "[smoke-test-router] === Phase 4 section complete (SKIPS=${SKIPS}) ==="

# ============================================================================
# Phase 5 — Postgres + Observability seam (Plan 05-04)
# ============================================================================
# Closes SC2 (non-blocking buffered writes survive pause-pg-5s) + SC5
# (X-Agent-Id surfaced + every service healthy) + DATA-04 (usage_daily) +
# OBS-05 (real healthchecks).
#
# Portability note: this section uses `date +%s%3N` (GNU coreutils) for
# millisecond timestamps. On macOS without coreutils-prefixed gdate, the
# inter-delta timing in SC-P5-C will return a literal '%3N' string and the
# arithmetic gap check is best-effort (soft-fallback to delta-count). The
# stack is Linux-first (single-host Docker Compose on bare metal or WSL2)
# so this is the right tradeoff.
# ============================================================================

echo ""
echo "[smoke-test-router] === Phase 5: Postgres + Observability ==="
echo "[smoke-test-router] (postgres + pg-backup must be up; ${MODEL} must be loaded in ollama)"

# Safety net: ensure the --profile ollama stack is still up. Phase 4's
# `setup` block (above) brought it up, but if any earlier section failed
# in a way that took the stack down, this re-establishes it.
if ! curl -fsS -m 2 "${ROUTER_URL}/healthz" >/dev/null 2>&1; then
  echo "[smoke-test-router] Phase 5: router not reachable, bringing --profile ollama up..."
  docker compose --profile ollama up -d --wait 2>&1 | tail -3 || true
  sleep 2
fi

# ── SC-P5-A: GET /metrics unauth returns 200 + 5 custom HELP lines ──────────
echo ""
echo "[smoke-test-router] SC-P5-A: GET /metrics unauth returns 200 + 5 custom metrics ..."
METRICS_TMP=$(mktemp)
METRICS_CODE=$(curl -s -o "${METRICS_TMP}" -w '%{http_code}' "${ROUTER_URL}/metrics" || echo "000")
[[ "${METRICS_CODE}" == "200" ]] && pass "GET /metrics unauth -> 200" || fail "GET /metrics unauth -> ${METRICS_CODE} (expected 200)"
CUSTOM_COUNT=$(grep -cE '^# HELP router_(requests_total|request_duration_seconds|ttft_seconds|tokens_total|log_buffer_dropped_total) ' "${METRICS_TMP}" 2>/dev/null || echo 0)
[[ "${CUSTOM_COUNT}" -ge 5 ]] && pass "/metrics contains 5 custom router_* HELP lines (${CUSTOM_COUNT})" || fail "/metrics only contains ${CUSTOM_COUNT}/5 custom HELP lines"
DEFAULT_COUNT=$(grep -cE '^# HELP (process|nodejs)_' "${METRICS_TMP}" 2>/dev/null || echo 0)
[[ "${DEFAULT_COUNT}" -ge 1 ]] && pass "/metrics contains Node default metrics (${DEFAULT_COUNT} lines)" || fail "/metrics missing Node default metrics"
rm -f "${METRICS_TMP}"

# ── SC-P5-B: X-Agent-Id round-trip lands in request_log ─────────────────────
echo ""
echo "[smoke-test-router] SC-P5-B: X-Agent-Id round-trip → DB row ..."
AGENT_ID="claude-code:smoke-${RANDOM}"
AGENT_REQ_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "X-Agent-Id: ${AGENT_ID}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":10}" \
  "${ROUTER_URL}/v1/chat/completions" || echo "000")
if [[ "${AGENT_REQ_CODE}" != "200" ]]; then
  fail "SC-P5-B: request with X-Agent-Id returned ${AGENT_REQ_CODE} (expected 200)"
else
  # Buffered writer flushes every 1s or 200 rows — sleep > 1s before reading
  sleep 3
  DB_AGENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
    "SELECT agent_id FROM request_log WHERE agent_id = '${AGENT_ID}' ORDER BY ts DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]')
  if [[ "${DB_AGENT}" == "${AGENT_ID}" ]]; then
    pass "SC-P5-B: X-Agent-Id round-trip — DB row has agent_id='${DB_AGENT}'"
  else
    fail "SC-P5-B: DB has agent_id='${DB_AGENT}', expected '${AGENT_ID}'"
  fi
fi

# ── SC-P5-C: SC2 regression — pause postgres 5s mid-stream ──────────────────
# Load-bearing: this proves the bufferedWriter D-A1..D-A7 invariants survive
# a real Postgres outage. SSE deltas MUST keep arriving (max inter-delta gap
# < 2000ms) AND log_buffer_dropped_total MUST stay at 0 (10k cap >> 5s × max
# throughput) AND the row MUST land in request_log within 30s of unpause.
echo ""
echo "[smoke-test-router] SC-P5-C: SC2 regression — pause postgres 5s mid-stream ..."
PRE_DROPPED=$(curl -s "${ROUTER_URL}/metrics" 2>/dev/null | grep -E '^router_log_buffer_dropped_total ' | awk '{print $2}' | head -1)
PRE_DROPPED=${PRE_DROPPED:-0}

# Pre-count of recent request_log rows so we can verify a fresh one lands
PRE_RECENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  "SELECT count(*) FROM request_log WHERE ts > now() - interval '5 minutes'" 2>/dev/null | tr -d '[:space:]')
PRE_RECENT=${PRE_RECENT:-0}

# Spawn pause/unpause sequence in background
( sleep 1 && docker compose pause postgres >/dev/null 2>&1 && sleep 5 && docker compose unpause postgres >/dev/null 2>&1 ) &
PAUSER_PID=$!

# Start streaming request; capture each `data:` line with a millisecond timestamp.
# `date +%s%3N` is GNU coreutils; if it returns literal '%3N', the gap check
# is degraded but the delta-count assertion still passes.
SSE_OUT=$(mktemp)
SSE_TS_OUT=$(mktemp)
curl -sN -m 60 -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"count slowly to 30, one per line\"}],\"stream\":true,\"max_tokens\":200}" \
  > "${SSE_OUT}" 2>/dev/null &
CURL_PID=$!

# Tail timestamps in parallel — read each data: line as it arrives.
( while IFS= read -r line; do
    if [[ "${line}" =~ ^data: ]]; then
      echo "$(date +%s%3N) ${line}" >> "${SSE_TS_OUT}"
    fi
  done < <(tail -n +1 -F "${SSE_OUT}" 2>/dev/null) ) &
TAIL_PID=$!

wait "${CURL_PID}" 2>/dev/null || true
wait "${PAUSER_PID}" 2>/dev/null || true
sleep 0.5
kill "${TAIL_PID}" 2>/dev/null || true
wait "${TAIL_PID}" 2>/dev/null || true

# Assertion 1: at least N SSE deltas arrived
DELTAS=$(wc -l < "${SSE_TS_OUT}" 2>/dev/null | tr -d '[:space:]')
DELTAS=${DELTAS:-0}
if [[ "${DELTAS}" -ge 5 ]]; then
  pass "SC-P5-C: streamed ${DELTAS} SSE deltas across the pause-unpause window"
else
  fail "SC-P5-C: only ${DELTAS} SSE deltas captured (expected >= 5)"
fi

# Assertion 2: max inter-delta gap < 2000ms (only run if timestamps look numeric)
FIRST_TS=$(head -1 "${SSE_TS_OUT}" 2>/dev/null | awk '{print $1}')
if [[ "${FIRST_TS}" =~ ^[0-9]+$ ]] && [[ "${DELTAS}" -ge 2 ]]; then
  MAX_GAP=$(awk 'NR>1 {gap = $1 - prev; if (gap > max) max = gap} { prev = $1 } END { print max+0 }' "${SSE_TS_OUT}" 2>/dev/null || echo 0)
  if [[ "${MAX_GAP}" -lt 2000 ]]; then
    pass "SC-P5-C: max inter-delta gap ${MAX_GAP}ms < 2000ms (stream did not stall on pg pause)"
  else
    fail "SC-P5-C: max inter-delta gap ${MAX_GAP}ms exceeds 2000ms threshold (stream likely paused mid-stream)"
  fi
else
  echo "[smoke-test-router] SC-P5-C: skipping gap check — non-numeric timestamps (date +%s%3N unsupported)"
fi

# Assertion 3: a request_log row landed since the test started (within ~30s of unpause)
sleep 5
POST_RECENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  "SELECT count(*) FROM request_log WHERE ts > now() - interval '5 minutes'" 2>/dev/null | tr -d '[:space:]')
POST_RECENT=${POST_RECENT:-0}
if [[ "${POST_RECENT}" -gt "${PRE_RECENT}" ]]; then
  pass "SC-P5-C: row(s) landed in request_log after unpause (recent rows: ${PRE_RECENT} -> ${POST_RECENT})"
else
  fail "SC-P5-C: no new request_log rows after pause-pg cycle (pre=${PRE_RECENT} post=${POST_RECENT})"
fi

# Assertion 4: router_log_buffer_dropped_total unchanged (invariant gate)
POST_DROPPED=$(curl -s "${ROUTER_URL}/metrics" 2>/dev/null | grep -E '^router_log_buffer_dropped_total ' | awk '{print $2}' | head -1)
POST_DROPPED=${POST_DROPPED:-0}
if [[ "${POST_DROPPED}" == "${PRE_DROPPED}" ]]; then
  pass "SC-P5-C: router_log_buffer_dropped_total unchanged (${PRE_DROPPED}) — 10k cap held during pause"
else
  fail "SC-P5-C: log buffer dropped rows: pre=${PRE_DROPPED} post=${POST_DROPPED} (buffer overflow during pause-pg)"
fi
rm -f "${SSE_OUT}" "${SSE_TS_OUT}"

# ── SC-P5-D: row-count assertion after N=3 requests ─────────────────────────
echo ""
echo "[smoke-test-router] SC-P5-D: request_log row-count delta = N=3 ..."
PRE_ROWS=$(docker compose exec -T postgres psql -U app -d router -tAc "SELECT count(*) FROM request_log" 2>/dev/null | tr -d '[:space:]')
PRE_ROWS=${PRE_ROWS:-0}
for i in 1 2 3; do
  REQ_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "X-Agent-Id: rowcount-test" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"req $i\"}],\"max_tokens\":10}" \
    "${ROUTER_URL}/v1/chat/completions" || echo "000")
  [[ "${REQ_CODE}" != "200" ]] && fail "SC-P5-D: request $i returned ${REQ_CODE} (expected 200)"
done
sleep 5
POST_ROWS=$(docker compose exec -T postgres psql -U app -d router -tAc "SELECT count(*) FROM request_log" 2>/dev/null | tr -d '[:space:]')
POST_ROWS=${POST_ROWS:-0}
DIFF=$((POST_ROWS - PRE_ROWS))
if [[ "${DIFF}" == "3" ]]; then
  pass "SC-P5-D: row-count delta == 3 (pre=${PRE_ROWS} post=${POST_ROWS})"
else
  fail "SC-P5-D: row-count delta == ${DIFF} (pre=${PRE_ROWS} post=${POST_ROWS}; expected 3)"
fi

# ── SC-P5-E: /readyz reflects postgres pause/unpause ────────────────────────
# Gates on body.postgres.status (not the overall HTTP code) so the assertion
# works correctly under --profile ollama where llamacpp is permanently down
# and /readyz always returns 503 from the overall not_ready gate.
echo ""
echo "[smoke-test-router] SC-P5-E: /readyz transitions on postgres pause/unpause ..."
READYZ_BEFORE_BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
READYZ_BEFORE_PG=$(echo "${READYZ_BEFORE_BODY}" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  print((d.get("postgres") or {}).get("status") or "")
except Exception:
  print("")
')
if [[ "${READYZ_BEFORE_PG}" == "alive" ]]; then
  pass "SC-P5-E: postgres.status=alive (healthy stack)"
else
  fail "SC-P5-E: postgres.status=${READYZ_BEFORE_PG} at start (expected alive) — body: ${READYZ_BEFORE_BODY:0:200}"
fi

docker compose pause postgres >/dev/null 2>&1
# Wait up to 25s (≈ 2 × scheduler interval) for the probe to mark postgres down
READYZ_PAUSED_PG="unknown"
for attempt in $(seq 1 25); do
  sleep 1
  _BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
  READYZ_PAUSED_PG=$(echo "${_BODY}" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  print((d.get("postgres") or {}).get("status") or "")
except Exception:
  print("")
')
  [[ "${READYZ_PAUSED_PG}" == "down" ]] && break
done
if [[ "${READYZ_PAUSED_PG}" == "down" ]]; then
  pass "SC-P5-E: postgres.status -> down within ${attempt}s of postgres pause"
else
  fail "SC-P5-E: postgres.status still '${READYZ_PAUSED_PG}' after 25s of postgres pause (expected down)"
fi
READYZ_PAUSED_BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
if echo "${READYZ_PAUSED_BODY}" | grep -q '"postgres":'; then
  pass "SC-P5-E: /readyz response includes \"postgres\" field"
else
  fail "SC-P5-E: /readyz response missing postgres field — body: ${READYZ_PAUSED_BODY:0:200}"
fi

docker compose unpause postgres >/dev/null 2>&1
READYZ_UNPAUSED_PG="unknown"
for attempt in $(seq 1 25); do
  sleep 1
  _BODY=$(curl -s "${ROUTER_URL}/readyz" || true)
  READYZ_UNPAUSED_PG=$(echo "${_BODY}" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  print((d.get("postgres") or {}).get("status") or "")
except Exception:
  print("")
')
  [[ "${READYZ_UNPAUSED_PG}" == "alive" ]] && break
done
if [[ "${READYZ_UNPAUSED_PG}" == "alive" ]]; then
  pass "SC-P5-E: postgres.status -> alive within ${attempt}s of postgres unpause"
else
  fail "SC-P5-E: postgres.status still '${READYZ_UNPAUSED_PG}' after 25s of postgres unpause (expected alive)"
fi

# ── OBS-05 final check: every long-running service is healthy ───────────────
echo ""
echo "[smoke-test-router] OBS-05: every service has a real healthcheck reporting healthy ..."
UNHEALTHY_LINES=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -vE 'healthy|gpu-preflight|pg-backup' || true)
# UAT 2026-05-18 fix: `... | grep -c . || echo 0` emitted "0\n0" for empty
# input (grep -c outputs "0" + exits 1 -> the || appends another "0"). The
# resulting two-line string broke `[[ ... == "0" ]]` and triggered a spurious
# fail with message "OBS-05: 0\n0 service(s) not healthy". Single-source the
# count by short-circuiting on empty LINES.
if [[ -z "${UNHEALTHY_LINES}" ]]; then
  UNHEALTHY_COUNT=0
else
  UNHEALTHY_COUNT=$(printf '%s\n' "${UNHEALTHY_LINES}" | grep -c .)
fi
if [[ "${UNHEALTHY_COUNT}" == "0" ]]; then
  pass "OBS-05: all long-running services healthy (gpu-preflight + pg-backup excluded by design — see Plan 01 D-G1 + Plan 03 D-F2)"
else
  fail "OBS-05: ${UNHEALTHY_COUNT} service(s) not healthy"
  docker compose ps --format '{{.Name}} {{.Health}}' 2>&1 | head -20
fi

echo ""
echo "[smoke-test-router] === Phase 5 section complete ==="

# ─────────────────────────────────────────────────────────────────────────────
# Phase 7 — /v1/embeddings + request_log
# ─────────────────────────────────────────────────────────────────────────────
# Covers EMBED-01 + OAI-02 + BCKND-03 + Phase SC5 (request_log distinct rows).
#
#   1. bge-m3 present in Ollama (idempotent pull)
#   2. bge-m3-ollama   → 1024-dim happy path
#   3. capability gate — chat-only model on /v1/embeddings → 400
#   4. zod gate       — empty input → 400 (Pitfall E-1)
#   5. bge-m3-vllm    → 1024-dim happy path (gated on --profile vllm)
#   6. request_log    — distinct backend rows for route='/v1/embeddings'
#
# Phase 2-6 sections above are UNCHANGED. This section is appended.
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[smoke-test-router] === Phase 7 — /v1/embeddings + request_log ==="

# 1. Ensure bge-m3 is present in Ollama (idempotent pull).
# UAT-surfaced flake: `docker compose exec ... ollama list` can return empty
# transiently right after stack-up. Retry up to 3 times before falling through
# to an unnecessary `ollama pull`.
P7_OLLAMA_LIST=""
for _ in 1 2 3; do
  P7_OLLAMA_LIST=$(docker compose exec -T "${OLLAMA_SVC}" ollama list 2>/dev/null || true)
  [[ -n "${P7_OLLAMA_LIST}" ]] && break
  sleep 1
done
if printf '%s\n' "${P7_OLLAMA_LIST}" | grep -q '^bge-m3'; then
  pass "Phase 7: bge-m3 already present in Ollama (skip pull)"
else
  echo "[smoke-test-router] Pulling bge-m3 into Ollama (first-run only — may take a few minutes)..."
  if docker compose exec -T "${OLLAMA_SVC}" ollama pull bge-m3 >/dev/null 2>&1; then
    pass "Phase 7: bge-m3 pulled into Ollama"
  else
    fail "Phase 7: ollama pull bge-m3 failed — check: docker compose logs ollama"
  fi
fi

# 2. Ollama /v1/embeddings happy path — dimensions == 1024.
EMBED_OLLAMA_RESP=$(curl -fsS \
  -X POST "${ROUTER_URL}/v1/embeddings" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3-ollama","input":"Hola mundo desde local-llms"}' 2>/dev/null || echo "")
if [[ -z "${EMBED_OLLAMA_RESP}" ]]; then
  fail "Phase 7: bge-m3-ollama /v1/embeddings request failed (empty response)"
else
  DIM_OLLAMA=$(echo "${EMBED_OLLAMA_RESP}" | jq '.data[0].embedding | length' 2>/dev/null || echo "0")
  if [[ "${DIM_OLLAMA}" == "1024" ]]; then
    pass "Phase 7: bge-m3-ollama → 1024-dim (OAI-02 + EMBED-01 happy path)"
  else
    fail "Phase 7: bge-m3-ollama dimensions=${DIM_OLLAMA} (expected 1024); body head: $(echo "${EMBED_OLLAMA_RESP}" | head -c 200)"
  fi
fi

# 3. Capability gate — chat-only model on /v1/embeddings must return 400.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${ROUTER_URL}/v1/embeddings" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-7b-instruct-awq","input":"x"}' 2>/dev/null || echo "000")
if [[ "${STATUS}" == "400" ]]; then
  pass "Phase 7: capability gate — chat-only model returns 400 (registry-enforced)"
else
  fail "Phase 7: capability gate returned ${STATUS} (expected 400)"
fi

# 4. Zod gate — empty input must return 400 (Pitfall E-1: prevents upstream 500).
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${ROUTER_URL}/v1/embeddings" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3-ollama","input":""}' 2>/dev/null || echo "000")
if [[ "${STATUS}" == "400" ]]; then
  pass "Phase 7: zod gate — empty input rejected at request boundary (400)"
else
  fail "Phase 7: empty input returned ${STATUS} (expected 400)"
fi

# 5. vLLM-embed happy path — gated on --profile vllm being active.
#    Detected via `docker compose ps vllm-embed` showing State=running.
VLLM_EMBED_EXERCISED=0
if docker compose ps vllm-embed --format '{{.State}}' 2>/dev/null | grep -q '^running$'; then
  EMBED_VLLM_RESP=$(curl -fsS \
    -X POST "${ROUTER_URL}/v1/embeddings" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"model":"bge-m3-vllm","input":"Hola mundo desde local-llms"}' 2>/dev/null || echo "")
  if [[ -z "${EMBED_VLLM_RESP}" ]]; then
    fail "Phase 7: bge-m3-vllm /v1/embeddings request failed (empty response) — vllm-embed is running but the request did not succeed"
  else
    DIM_VLLM=$(echo "${EMBED_VLLM_RESP}" | jq '.data[0].embedding | length' 2>/dev/null || echo "0")
    if [[ "${DIM_VLLM}" == "1024" ]]; then
      pass "Phase 7: bge-m3-vllm → 1024-dim (BCKND-03 vLLM-embed happy path)"
      VLLM_EMBED_EXERCISED=1
    else
      fail "Phase 7: bge-m3-vllm dimensions=${DIM_VLLM} (expected 1024); body head: $(echo "${EMBED_VLLM_RESP}" | head -c 200) — Pitfall E-2 (bge-m3 must serve dense, not sparse/colbert)"
    fi
  fi
else
  skip "Phase 7: vllm-embed not running — skipping bge-m3-vllm check (run with --profile vllm to include it)"
fi

# 6. request_log distinct backend rows for route='/v1/embeddings' (Phase SC5).
#    Wait ~3s for the Phase 5 D-B4 buffered writer (1-2s flush interval + slack).
sleep 3
ROWS=$(docker compose exec -T postgres psql -U app -d router -tA -c \
  "SELECT backend, COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend ORDER BY backend;" 2>/dev/null || echo "")
if [[ -z "${ROWS}" ]]; then
  fail "Phase 7: request_log query returned empty — recordRequestOutcome may not be wired (check Plan 07-04)"
else
  # 07-REVIEW WR-06: parse psql -tA's pipe-separated output explicitly rather
  # than rely on the `[1-9][0-9]*$` regex. The old regex rejected `ollama|0`
  # with a confusing "missing ollama rows" FAIL when the actual condition is
  # "row exists but count is 0". Extract count via awk and assert >= 1 so the
  # diagnostic message matches the actual failure mode.
  OLLAMA_COUNT=$(echo "${ROWS}" | awk -F'|' '$1 == "ollama" { print $2; exit }')
  if [[ -n "${OLLAMA_COUNT}" && "${OLLAMA_COUNT}" -ge 1 ]]; then
    pass "Phase 7: request_log has ${OLLAMA_COUNT} row(s) for backend=ollama on /v1/embeddings"
  elif [[ -n "${OLLAMA_COUNT}" ]]; then
    fail "Phase 7: request_log ollama row present but count=${OLLAMA_COUNT} (expected >=1) — buffered writer may not have flushed; raise sleep"
  else
    fail "Phase 7: request_log missing ollama rows for /v1/embeddings — got:\n${ROWS}"
  fi
  if [[ "${VLLM_EMBED_EXERCISED}" == "1" ]]; then
    VLLM_EMBED_COUNT=$(echo "${ROWS}" | awk -F'|' '$1 == "vllm-embed" { print $2; exit }')
    if [[ -n "${VLLM_EMBED_COUNT}" && "${VLLM_EMBED_COUNT}" -ge 1 ]]; then
      pass "Phase 7: request_log has ${VLLM_EMBED_COUNT} row(s) for backend=vllm-embed on /v1/embeddings"
    elif [[ -n "${VLLM_EMBED_COUNT}" ]]; then
      fail "Phase 7: request_log vllm-embed row present but count=${VLLM_EMBED_COUNT} (expected >=1)"
    else
      fail "Phase 7: request_log missing vllm-embed rows for /v1/embeddings (vLLM happy path succeeded) — got:\n${ROWS}"
    fi
  else
    skip "Phase 7: vllm-embed row check (vLLM not exercised this run)"
  fi
  echo "[smoke-test-router] request_log distinct rows for embedding dispatch:"
  echo "${ROWS}" | sed 's/^/[smoke-test-router]   /'
fi

echo ""
echo "[smoke-test-router] === Phase 7 section complete ==="

# ─────────────────────────────────────────────────────────────────────────────
# Phase 8 — Resilience + Cloud + Telemetry
# ─────────────────────────────────────────────────────────────────────────────
#
# Plan 08-10 / Task 1 — appended to the canonical smoke so an operator running
# this single script gets full Phase 8 coverage WITHOUT having to invoke
# bin/smoke-test-cloud.sh separately. The cloud-specific (live OLLAMA_API_KEY-
# requiring) sections 2 + 3 of the dedicated cloud smoke remain in
# bin/smoke-test-cloud.sh — this block mirrors the local-only assertions
# (Sections 1, 4, 5, 6, 7, 8, 9 from smoke-test-cloud.sh).
#
# Verified surface (10 Phase-8 requirement IDs, 7 sections):
#
#   ROUTE-10 — Section 1: X-Model-Backend header on chat / messages / embeddings.
#   CLOUD-04 — Section 4: max_tokens > CLOUD_MAX_TOKENS_CAP (16384) → 400 +
#                          code=cloud_max_tokens_exceeded BEFORE any upstream call.
#   CLOUD-03 — Section 5: per-backend circuit breaker via Valkey direct write →
#                          503 + code=backend_circuit_open + Retry-After.
#   ROUTE-11 — Section 6: per-bearer-token rate limit via Valkey direct write →
#                          429 + code=rate_limit_exceeded + Retry-After.
#   ROUTE-12 — Section 7: Idempotency-Key multiplexer → 3 concurrent same-key
#                          requests return byte-identical bodies + 1 distinct
#                          upstream_message_id in request_log.
#   CLOUD-05 — Section 8: cloud_spend_daily Postgres view exists and is queryable.
#   DATA-06  — Section 9: Valkey registry cache key populated + TTL ∈ [1, 300].
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[smoke-test-router] === Phase 8 — Resilience + Cloud + Telemetry ==="

# ── Phase 8 helper: resolve VALKEY_PASSWORD from .env (single-var grep) ──────
if [[ -z "${VALKEY_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  VALKEY_PASSWORD=$(
    grep -E '^VALKEY_PASSWORD=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
  export VALKEY_PASSWORD
fi

PHASE_8_VALKEY_OK=0
if [[ -n "${VALKEY_PASSWORD:-}" ]] \
   && docker compose ps valkey --format '{{.State}}' 2>/dev/null | grep -q '^running$' \
   && docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" --no-auth-warning PING 2>/dev/null | grep -q '^PONG$'; then
  PHASE_8_VALKEY_OK=1
fi

if [[ "${PHASE_8_VALKEY_OK}" -ne 1 ]]; then
  skip "Phase 8: valkey service unavailable or VALKEY_PASSWORD unset — skipping Phase 8 block (bring up valkey + set VALKEY_PASSWORD in .env to exercise)"
else
  # ─── ROUTER_RATE_LIMIT_RPM (default 600) ────────────────────────────────────
  P8_RPM=600
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    P8_RPM_FROM_ENV=$(
      grep -E '^ROUTER_RATE_LIMIT_RPM=' "${REPO_ROOT}/.env" \
        | tail -1 \
        | cut -d= -f2- \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
    )
    if [[ -n "${P8_RPM_FROM_ENV}" ]]; then P8_RPM="${P8_RPM_FROM_ENV}"; fi
  fi

  # CLOUD_MAX_TOKENS_CAP per router/src/config/constants.ts.
  P8_CAP=16384
  P8_CLOUD_MODEL="${CLOUD_CHAT_MODEL:-gpt-oss:20b-cloud}"
  P8_CLOUD_BACKEND="ollama-cloud"

  p8_valkey_cli() {
    docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" --no-auth-warning "$@"
  }
  p8_psql() {
    docker compose exec -T postgres psql -U app -d router -tA -c "$1"
  }
  p8_extract_header() {
    local raw="$1"
    echo "$raw" | grep -i '^x-model-backend:' | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n'
  }

  # ─── Section 1: X-Model-Backend response header ────────────────────────────
  echo "[smoke-test-router] Phase 8 / Section 1: X-Model-Backend response header (ROUTE-10)"
  P8_CHAT_HEADERS=$(curl -fsS -D - -o /dev/null \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
    2>/dev/null || echo "")
  P8_CHAT_BACKEND=$(p8_extract_header "${P8_CHAT_HEADERS}")
  if [[ -n "${P8_CHAT_BACKEND}" ]]; then
    pass "Phase 8: X-Model-Backend on /v1/chat/completions = '${P8_CHAT_BACKEND}'"
  else
    fail "Phase 8: X-Model-Backend missing on /v1/chat/completions"
  fi

  P8_MSG_HEADERS=$(curl -fsS -D - -o /dev/null \
    -X POST "${ROUTER_URL}/v1/messages" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"${MODEL}\",\"max_tokens\":4,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    2>/dev/null || echo "")
  P8_MSG_BACKEND=$(p8_extract_header "${P8_MSG_HEADERS}")
  if [[ -n "${P8_MSG_BACKEND}" ]]; then
    pass "Phase 8: X-Model-Backend on /v1/messages = '${P8_MSG_BACKEND}'"
  else
    fail "Phase 8: X-Model-Backend missing on /v1/messages"
  fi

  # UAT-surfaced flake: retry transient empty exec output (see Phase 7 above).
  P8_OLLAMA_LIST=""
  for _ in 1 2 3; do
    P8_OLLAMA_LIST=$(docker compose exec -T "${OLLAMA_SVC}" ollama list 2>/dev/null || true)
    [[ -n "${P8_OLLAMA_LIST}" ]] && break
    sleep 1
  done
  if printf '%s\n' "${P8_OLLAMA_LIST}" | grep -q '^bge-m3'; then
    P8_EMB_HEADERS=$(curl -fsS -D - -o /dev/null \
      -X POST "${ROUTER_URL}/v1/embeddings" \
      -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
      -H "Content-Type: application/json" \
      --max-time 60 \
      -d '{"model":"bge-m3-ollama","input":"hi"}' \
      2>/dev/null || echo "")
    P8_EMB_BACKEND=$(p8_extract_header "${P8_EMB_HEADERS}")
    if [[ -n "${P8_EMB_BACKEND}" ]]; then
      pass "Phase 8: X-Model-Backend on /v1/embeddings = '${P8_EMB_BACKEND}'"
    else
      fail "Phase 8: X-Model-Backend missing on /v1/embeddings"
    fi
  else
    skip "Phase 8: /v1/embeddings X-Model-Backend (bge-m3 not pulled)"
  fi

  # ─── Section 4: max_tokens cap on cloud → 400 (CLOUD-04) ───────────────────
  echo "[smoke-test-router] Phase 8 / Section 4: max_tokens cap on cloud → 400 (CLOUD-04)"
  P8_OVER_CAP=$(( P8_CAP + 1 ))
  P8_CAP_FILE=$(mktemp)
  P8_CAP_STATUS=$(curl -s -o "${P8_CAP_FILE}" -w '%{http_code}' \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 30 \
    -d "{\"model\":\"${P8_CLOUD_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":${P8_OVER_CAP},\"stream\":false}" \
    2>/dev/null || echo "000")
  if [[ "${P8_CAP_STATUS}" == "400" ]]; then
    pass "Phase 8: max_tokens=${P8_OVER_CAP} → 400 (cap=${P8_CAP})"
  else
    fail "Phase 8: max_tokens=${P8_OVER_CAP} → ${P8_CAP_STATUS} (expected 400)"
  fi
  P8_CAP_CODE=$(jq -r '.error.code // empty' "${P8_CAP_FILE}" 2>/dev/null)
  if [[ "${P8_CAP_CODE}" == "cloud_max_tokens_exceeded" ]]; then
    pass "Phase 8: envelope code = 'cloud_max_tokens_exceeded'"
  else
    fail "Phase 8: envelope code = '${P8_CAP_CODE}' (expected 'cloud_max_tokens_exceeded')"
  fi
  rm -f "${P8_CAP_FILE}"

  # ─── Section 5: Circuit breaker via Valkey direct write (CLOUD-03) ─────────
  echo "[smoke-test-router] Phase 8 / Section 5: circuit breaker via Valkey direct write (CLOUD-03)"
  P8_BREAKER_STATE="breaker:${P8_CLOUD_BACKEND}:state"
  P8_BREAKER_PROBE="breaker:${P8_CLOUD_BACKEND}:probe_at"
  P8_BREAKER_FAILS="breaker:${P8_CLOUD_BACKEND}:fail_count"
  P8_NOW_MS=$(date +%s%3N 2>/dev/null || echo "$(( $(date +%s) * 1000 ))")
  P8_PROBE_AT=$(( P8_NOW_MS + 60000 ))
  p8_valkey_cli SET "${P8_BREAKER_STATE}" "open" EX 90 >/dev/null
  p8_valkey_cli SET "${P8_BREAKER_PROBE}" "${P8_PROBE_AT}" EX 90 >/dev/null
  P8_BREAKER_FILE=$(mktemp)
  P8_BREAKER_HFILE=$(mktemp)
  P8_BREAKER_STATUS=$(curl -s -o "${P8_BREAKER_FILE}" -D "${P8_BREAKER_HFILE}" -w '%{http_code}' \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d "{\"model\":\"${P8_CLOUD_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
    2>/dev/null || echo "000")
  if [[ "${P8_BREAKER_STATUS}" == "503" ]]; then
    pass "Phase 8: circuit-open → HTTP 503"
  else
    fail "Phase 8: circuit-open → ${P8_BREAKER_STATUS} (expected 503)"
  fi
  P8_BREAKER_CODE=$(jq -r '.error.code // empty' "${P8_BREAKER_FILE}" 2>/dev/null)
  if [[ "${P8_BREAKER_CODE}" == "backend_circuit_open" ]]; then
    pass "Phase 8: envelope code = 'backend_circuit_open'"
  else
    fail "Phase 8: envelope code = '${P8_BREAKER_CODE}' (expected 'backend_circuit_open')"
  fi
  P8_BREAKER_RETRY=$(grep -i '^retry-after:' "${P8_BREAKER_HFILE}" | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n')
  if [[ -n "${P8_BREAKER_RETRY}" ]] && [[ "${P8_BREAKER_RETRY}" =~ ^[0-9]+$ ]]; then
    pass "Phase 8: Retry-After on breaker = ${P8_BREAKER_RETRY}s"
  else
    fail "Phase 8: Retry-After on breaker missing or non-numeric ('${P8_BREAKER_RETRY}')"
  fi
  p8_valkey_cli DEL "${P8_BREAKER_STATE}" "${P8_BREAKER_PROBE}" "${P8_BREAKER_FAILS}" >/dev/null
  rm -f "${P8_BREAKER_FILE}" "${P8_BREAKER_HFILE}"

  # ─── Section 6: rate limit 429 via Valkey direct write (ROUTE-11) ──────────
  echo "[smoke-test-router] Phase 8 / Section 6: rate limit 429 via Valkey direct write (ROUTE-11) — RPM=${P8_RPM}"
  curl -fsS -o /dev/null \
    -X POST "${ROUTER_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 30 \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
    >/dev/null 2>&1 || true
  P8_RL_KEY=$(p8_valkey_cli --scan --pattern 'ratelimit:*' 2>/dev/null | tail -1)
  if [[ -z "${P8_RL_KEY}" ]]; then
    fail "Phase 8: no ratelimit:* keys present — rate-limit middleware may not be wired"
  else
    # UAT 2026-05-18 fix: pre-seed BOTH minute N and N+1 keys to defeat the
    # minute-boundary flake (warm-up curl can take >60s under model swap;
    # without the second key, the probe lands in minute N+1 fresh and 429
    # doesn't fire). Mirrors the smoke-test-cloud.sh §6 fix.
    P8_RL_HASH=$(printf '%s' "${P8_RL_KEY}" | awk -F: '{print $2}')
    P8_RL_CUR_MIN=$(printf '%s' "${P8_RL_KEY}" | awk -F: '{print $3}')
    P8_RL_NEXT_MIN=$(( P8_RL_CUR_MIN + 1 ))
    P8_OVER_RPM=$(( P8_RPM + 1 ))
    for P8_MIN in "${P8_RL_CUR_MIN}" "${P8_RL_NEXT_MIN}"; do
      P8_K="ratelimit:${P8_RL_HASH}:${P8_MIN}"
      p8_valkey_cli SET "${P8_K}" "${P8_OVER_RPM}" KEEPTTL >/dev/null 2>&1 \
        || p8_valkey_cli SET "${P8_K}" "${P8_OVER_RPM}" EX 90 >/dev/null
    done
    P8_RL_FILE=$(mktemp)
    P8_RL_HFILE=$(mktemp)
    P8_RL_STATUS=$(curl -s -o "${P8_RL_FILE}" -D "${P8_RL_HFILE}" -w '%{http_code}' \
      -X POST "${ROUTER_URL}/v1/chat/completions" \
      -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
      -H "Content-Type: application/json" \
      --max-time 15 \
      -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4,\"stream\":false}" \
      2>/dev/null || echo "000")
    if [[ "${P8_RL_STATUS}" == "429" ]]; then
      pass "Phase 8: over-budget → HTTP 429 (counter pre-seeded to ${P8_OVER_RPM} > RPM=${P8_RPM})"
    else
      fail "Phase 8: over-budget → ${P8_RL_STATUS} (expected 429)"
    fi
    P8_RL_CODE=$(jq -r '.error.code // empty' "${P8_RL_FILE}" 2>/dev/null)
    if [[ "${P8_RL_CODE}" == "rate_limit_exceeded" ]]; then
      pass "Phase 8: envelope code = 'rate_limit_exceeded'"
    else
      fail "Phase 8: envelope code = '${P8_RL_CODE}' (expected 'rate_limit_exceeded')"
    fi
    P8_RL_RETRY=$(grep -i '^retry-after:' "${P8_RL_HFILE}" | head -1 | awk -F': *' '{print $2}' | tr -d '\r\n')
    if [[ -n "${P8_RL_RETRY}" ]] && [[ "${P8_RL_RETRY}" =~ ^[0-9]+$ ]]; then
      pass "Phase 8: Retry-After on 429 = ${P8_RL_RETRY}s"
    else
      fail "Phase 8: Retry-After on 429 missing or non-numeric ('${P8_RL_RETRY}')"
    fi
    for P8_MIN in "${P8_RL_CUR_MIN}" "${P8_RL_NEXT_MIN}"; do
      p8_valkey_cli DEL "ratelimit:${P8_RL_HASH}:${P8_MIN}" >/dev/null
    done
    rm -f "${P8_RL_FILE}" "${P8_RL_HFILE}"
  fi

  # ─── Section 7: idempotency mux dedup via concurrent same-key (ROUTE-12) ───
  echo "[smoke-test-router] Phase 8 / Section 7: idempotency mux dedup (ROUTE-12)"
  P8_IDEM_KEY="smoke-$(date +%s)-$(head -c 8 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || echo $$)"
  P8_R1=$(mktemp); P8_R2=$(mktemp); P8_R3=$(mktemp)
  p8_fire() {
    curl -fsS \
      -X POST "${ROUTER_URL}/v1/chat/completions" \
      -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
      -H "Idempotency-Key: ${P8_IDEM_KEY}" \
      -H "Content-Type: application/json" \
      --max-time 60 \
      -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say only the word OK\"}],\"max_tokens\":8,\"stream\":false}" \
      > "$1" 2>/dev/null || echo '{"error":"curl_failed"}' > "$1"
  }
  p8_fire "${P8_R1}" &
  P8_P1=$!
  p8_fire "${P8_R2}" &
  P8_P2=$!
  p8_fire "${P8_R3}" &
  P8_P3=$!
  wait "${P8_P1}" "${P8_P2}" "${P8_P3}" 2>/dev/null || true
  P8_M1=$(md5sum "${P8_R1}" 2>/dev/null | awk '{print $1}')
  P8_M2=$(md5sum "${P8_R2}" 2>/dev/null | awk '{print $1}')
  P8_M3=$(md5sum "${P8_R3}" 2>/dev/null | awk '{print $1}')
  if [[ -z "${P8_M1}" || -z "${P8_M2}" || -z "${P8_M3}" ]]; then
    fail "Phase 8: idempotent responses missing — md5: '${P8_M1}' '${P8_M2}' '${P8_M3}'"
  elif [[ "${P8_M1}" == "${P8_M2}" && "${P8_M2}" == "${P8_M3}" ]]; then
    pass "Phase 8: 3 concurrent Idempotency-Key responses byte-identical (md5=${P8_M1})"
  else
    fail "Phase 8: 3 concurrent responses differ — md5: '${P8_M1}' '${P8_M2}' '${P8_M3}'"
  fi
  sleep 3
  P8_DISTINCT=$(p8_psql "SELECT COUNT(DISTINCT upstream_message_id) FROM request_log WHERE idempotency_key = '${P8_IDEM_KEY}';" 2>/dev/null | tr -d '[:space:]')
  P8_ROWS=$(p8_psql "SELECT COUNT(*) FROM request_log WHERE idempotency_key = '${P8_IDEM_KEY}';" 2>/dev/null | tr -d '[:space:]')
  if [[ "${P8_ROWS}" == "3" && "${P8_DISTINCT}" == "1" ]]; then
    pass "Phase 8: request_log = 3 rows, 1 distinct upstream_message_id"
  elif [[ "${P8_ROWS}" == "3" ]]; then
    fail "Phase 8: request_log = 3 rows but ${P8_DISTINCT} distinct upstream_message_ids (expected 1)"
  elif [[ -z "${P8_ROWS}" || "${P8_ROWS}" == "0" ]]; then
    fail "Phase 8: request_log has 0 rows for Idempotency-Key '${P8_IDEM_KEY}'"
  else
    fail "Phase 8: request_log = ${P8_ROWS} rows (expected 3)"
  fi
  rm -f "${P8_R1}" "${P8_R2}" "${P8_R3}"

  # ─── Section 8: cloud_spend_daily Postgres view (CLOUD-05) ─────────────────
  echo "[smoke-test-router] Phase 8 / Section 8: cloud_spend_daily Postgres view (CLOUD-05)"
  P8_VIEW=$(p8_psql "SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'cloud_spend_daily';" 2>/dev/null | tr -d '[:space:]')
  if [[ "${P8_VIEW}" == "cloud_spend_daily" ]]; then
    pass "Phase 8: cloud_spend_daily view exists"
  else
    fail "Phase 8: cloud_spend_daily view NOT found in pg_views"
  fi
  P8_PROJ=$(p8_psql "SELECT COUNT(*) FROM cloud_spend_daily;" 2>/dev/null | tr -d '[:space:]')
  if [[ "${P8_PROJ}" =~ ^[0-9]+$ ]]; then
    pass "Phase 8: cloud_spend_daily SELECT COUNT(*) = ${P8_PROJ}"
  else
    fail "Phase 8: cloud_spend_daily projection non-numeric ('${P8_PROJ}')"
  fi

  # ─── Section 9: Valkey registry cache populated (DATA-06) ──────────────────
  echo "[smoke-test-router] Phase 8 / Section 9: Valkey registry cache (DATA-06)"
  curl -fsS -o /dev/null \
    -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
    "${ROUTER_URL}/v1/models" 2>/dev/null || true
  P8_REG_KEY="registry:models-yaml:cache:v1"
  P8_REG_BLOB=$(p8_valkey_cli GET "${P8_REG_KEY}" 2>/dev/null)
  if [[ -z "${P8_REG_BLOB}" ]]; then
    skip "Phase 8: registry cache key '${P8_REG_KEY}' empty (populates on router restart; try 'docker compose restart router')"
  else
    if echo "${P8_REG_BLOB}" | jq -e '.models | length > 0' >/dev/null 2>&1 \
       || echo "${P8_REG_BLOB}" | head -c 1 | grep -q '^{$'; then
      pass "Phase 8: registry cache key populated (${#P8_REG_BLOB} bytes; JSON-shaped)"
    else
      fail "Phase 8: registry cache key present but not JSON — head: $(echo "${P8_REG_BLOB}" | head -c 80)"
    fi
    P8_REG_TTL=$(p8_valkey_cli TTL "${P8_REG_KEY}" 2>/dev/null | tr -d '[:space:]')
    if [[ "${P8_REG_TTL}" =~ ^[0-9]+$ ]] && (( P8_REG_TTL >= 1 && P8_REG_TTL <= 300 )); then
      pass "Phase 8: registry cache TTL = ${P8_REG_TTL}s (expected 1..300)"
    else
      fail "Phase 8: registry cache TTL = '${P8_REG_TTL}' (expected 1..300)"
    fi
  fi
fi

echo ""
echo "[smoke-test-router] === Phase 8 section complete ==="

# -----------------------------------------------------------------------------
# Phase 12 — Embeddings hardening: cache + dims + Prometheus metrics (EMB-H01..06)
# -----------------------------------------------------------------------------
# Live verification:
#   1. cache miss/hit — two identical /v1/embeddings calls; second one increments
#      router_embeddings_cache_total{result="hit"} by +1.
#   2. metrics present — cache_total, batch_size, dims_total all visible in /metrics.
#   3. dims_total — model+dims labels populated correctly (bge-m3 → 1024).
#
# Skipped if bge-m3 is not loaded (preflight already covered the model in Phase 7).
echo ""
echo "[smoke-test-router] === Phase 12 — Embeddings cache + dims + metrics (EMB-H01..06) ==="

# Use a deterministic input string so two runs of the smoke against a persistent
# Valkey produce predictable hit-on-second-call behavior. Unique per script
# invocation so previous smoke runs don't pre-warm the cache and turn the first
# call into a hit.
P12_UNIQUE="phase-12-smoke-$(date +%s%N)"

P12_REQ_BODY=$(printf '{"model":"%s","input":"%s"}' "bge-m3-ollama" "${P12_UNIQUE}")

# 1. Scrape baseline metrics.
P12_METRICS_BEFORE=$(curl -fsS "${ROUTER_URL}/metrics" 2>/dev/null || echo "")
P12_HITS_BEFORE=$(echo "${P12_METRICS_BEFORE}" | grep -E '^router_embeddings_cache_total\{result="hit"\} ' | awk '{print $2}' | head -1)
P12_HITS_BEFORE=${P12_HITS_BEFORE:-0}
P12_MISSES_BEFORE=$(echo "${P12_METRICS_BEFORE}" | grep -E '^router_embeddings_cache_total\{result="miss"\} ' | awk '{print $2}' | head -1)
P12_MISSES_BEFORE=${P12_MISSES_BEFORE:-0}

# 2. First call — should MISS (unique input).
P12_R1=$(curl -fsS -X POST "${ROUTER_URL}/v1/embeddings" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -d "${P12_REQ_BODY}" 2>/dev/null || echo "")
P12_R1_DIM=$(echo "${P12_R1}" | python3 -c 'import sys, json; d=json.load(sys.stdin); print(len(d["data"][0]["embedding"]))' 2>/dev/null || echo "")

if [[ "${P12_R1_DIM}" == "1024" ]]; then
  pass "Phase 12: first /v1/embeddings call → 1024-dim response (dims enforcement honored)"
else
  fail "Phase 12: first call returned dim=${P12_R1_DIM} (expected 1024); body head: $(echo "${P12_R1}" | head -c 200)"
fi

# 3. Second call — same body, should HIT.
P12_R2=$(curl -fsS -X POST "${ROUTER_URL}/v1/embeddings" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -d "${P12_REQ_BODY}" 2>/dev/null || echo "")
P12_R2_DIM=$(echo "${P12_R2}" | python3 -c 'import sys, json; d=json.load(sys.stdin); print(len(d["data"][0]["embedding"]))' 2>/dev/null || echo "")

if [[ "${P12_R2_DIM}" == "1024" ]]; then
  pass "Phase 12: second /v1/embeddings call → 1024-dim response (cache replay)"
else
  fail "Phase 12: second call returned dim=${P12_R2_DIM} (expected 1024); body head: $(echo "${P12_R2}" | head -c 200)"
fi

# Vector content byte-identical between the two calls (cache returned the same
# bytes the upstream first produced).
P12_R1_HEAD=$(echo "${P12_R1}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["embedding"][:5])' 2>/dev/null || echo "")
P12_R2_HEAD=$(echo "${P12_R2}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"][0]["embedding"][:5])' 2>/dev/null || echo "")
if [[ -n "${P12_R1_HEAD}" && "${P12_R1_HEAD}" == "${P12_R2_HEAD}" ]]; then
  pass "Phase 12: cache replay vector byte-identical to upstream's first response"
else
  fail "Phase 12: cache replay produced different vector head; r1=${P12_R1_HEAD} vs r2=${P12_R2_HEAD}"
fi

# 4. Scrape metrics again. cache_total{hit} should have incremented by >=1.
sleep 1  # give buffered writer + metric register a moment to settle
P12_METRICS_AFTER=$(curl -fsS "${ROUTER_URL}/metrics" 2>/dev/null || echo "")
P12_HITS_AFTER=$(echo "${P12_METRICS_AFTER}" | grep -E '^router_embeddings_cache_total\{result="hit"\} ' | awk '{print $2}' | head -1)
P12_HITS_AFTER=${P12_HITS_AFTER:-0}
P12_MISSES_AFTER=$(echo "${P12_METRICS_AFTER}" | grep -E '^router_embeddings_cache_total\{result="miss"\} ' | awk '{print $2}' | head -1)
P12_MISSES_AFTER=${P12_MISSES_AFTER:-0}

# Use python for float arithmetic (counters are float-formatted in prom-text).
P12_HIT_DELTA=$(python3 -c "print(int(float('${P12_HITS_AFTER}') - float('${P12_HITS_BEFORE}')))")
P12_MISS_DELTA=$(python3 -c "print(int(float('${P12_MISSES_AFTER}') - float('${P12_MISSES_BEFORE}')))")

if [[ "${P12_HIT_DELTA}" -ge 1 ]]; then
  pass "Phase 12: router_embeddings_cache_total{result=\"hit\"} incremented by ${P12_HIT_DELTA} (>=1)"
else
  fail "Phase 12: cache hit metric did NOT increment (before=${P12_HITS_BEFORE}, after=${P12_HITS_AFTER}); the second call should have been a cache hit"
fi

if [[ "${P12_MISS_DELTA}" -ge 1 ]]; then
  pass "Phase 12: router_embeddings_cache_total{result=\"miss\"} incremented by ${P12_MISS_DELTA} (>=1)"
else
  fail "Phase 12: cache miss metric did NOT increment (before=${P12_MISSES_BEFORE}, after=${P12_MISSES_AFTER}); the first call should have been a cache miss"
fi

# 5. All three Phase 12 metrics visible in /metrics output.
if echo "${P12_METRICS_AFTER}" | grep -qE '^router_embeddings_cache_total'; then
  pass "Phase 12: router_embeddings_cache_total visible in /metrics (EMB-H03)"
else
  fail "Phase 12: router_embeddings_cache_total NOT in /metrics"
fi
if echo "${P12_METRICS_AFTER}" | grep -qE '^router_embeddings_batch_size_bucket'; then
  pass "Phase 12: router_embeddings_batch_size_bucket visible in /metrics (EMB-H03)"
else
  fail "Phase 12: router_embeddings_batch_size_bucket NOT in /metrics"
fi
if echo "${P12_METRICS_AFTER}" | grep -qE '^router_embeddings_dims_total\{model="bge-m3-ollama",dims="1024"\}'; then
  pass "Phase 12: router_embeddings_dims_total{model=bge-m3-ollama,dims=1024} visible in /metrics (EMB-H03)"
else
  fail "Phase 12: dims_total{bge-m3-ollama,1024} NOT in /metrics — check that an embeddings call ran for this model"
fi

echo ""
echo "[smoke-test-router] === Phase 12 section complete ==="

# -----------------------------------------------------------------------------
# Phase 13 — Cost observability + /v1/responses (COST-01..04, RESP-01..04)
# -----------------------------------------------------------------------------
# Live verification:
#   1. /v1/responses happy path — Responses-shape body returned.
#   2. /v1/responses stream:true rejected with structured envelope.
#   3. /v1/responses capability gate — embeddings model → 400.
#   4. X-Cost-Cents header present on local chat call (when pricing declared) OR
#      absent (when no pricing). Smoke runs against the local model used elsewhere
#      so the header is expected absent for the local path.
#   5. request_log cost_cents column exists + nullable (DDL check).
#   6. cost_per_agent_daily view exists + is queryable.
echo ""
echo "[smoke-test-router] === Phase 13 — Cost + /v1/responses (COST-01..04, RESP-01..04) ==="

# 1. /v1/responses happy path against the local chat model.
P13_RESP=$(curl -fsS -X POST "${ROUTER_URL}/v1/responses" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -H "X-Agent-Id: smoke-phase-13" \
  -d "$(printf '{"model":"%s","input":"reply with the single word OK"}' "${MODEL}")" 2>/dev/null || echo "")
P13_RESP_OBJ=$(echo "${P13_RESP}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("object", "MISSING"))' 2>/dev/null || echo "PARSE_ERR")
if [[ "${P13_RESP_OBJ}" == "response" ]]; then
  pass "Phase 13: POST /v1/responses → 200 + object=\"response\" (RESP-01)"
else
  fail "Phase 13: /v1/responses returned object=${P13_RESP_OBJ}; body head: $(echo "${P13_RESP}" | head -c 300)"
fi

# Output shape: output[0].type=message, content[0].type=output_text.
P13_OUT_TYPE=$(echo "${P13_RESP}" | python3 -c 'import sys, json; d=json.load(sys.stdin); print(d["output"][0]["type"])' 2>/dev/null || echo "MISSING")
if [[ "${P13_OUT_TYPE}" == "message" ]]; then
  pass "Phase 13: /v1/responses output[0].type=\"message\" (RESP-01)"
else
  fail "Phase 13: /v1/responses output[0].type=${P13_OUT_TYPE}"
fi

P13_CONTENT_TYPE=$(echo "${P13_RESP}" | python3 -c 'import sys, json; d=json.load(sys.stdin); print(d["output"][0]["content"][0]["type"])' 2>/dev/null || echo "MISSING")
if [[ "${P13_CONTENT_TYPE}" == "output_text" ]]; then
  pass "Phase 13: /v1/responses output[0].content[0].type=\"output_text\" (RESP-01)"
else
  fail "Phase 13: /v1/responses content type=${P13_CONTENT_TYPE}"
fi

# 2. stream:true → 400 with responses_stream_unsupported code.
P13_STREAM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${ROUTER_URL}/v1/responses" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -d "$(printf '{"model":"%s","input":"x","stream":true}' "${MODEL}")")
if [[ "${P13_STREAM_STATUS}" == "400" ]]; then
  pass "Phase 13: /v1/responses stream:true → 400 (deferred to v0.11)"
else
  fail "Phase 13: /v1/responses stream:true returned ${P13_STREAM_STATUS} (expected 400)"
fi

# 3. Capability gate — embeddings-only model on /v1/responses → 400.
P13_CAP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${ROUTER_URL}/v1/responses" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"model":"bge-m3-ollama","input":"x"}')
if [[ "${P13_CAP_STATUS}" == "400" ]]; then
  pass "Phase 13: /v1/responses capability gate — embeddings-only model returns 400 (RESP-04)"
else
  fail "Phase 13: /v1/responses capability gate returned ${P13_CAP_STATUS} (expected 400)"
fi

# 4. X-Cost-Cents header behavior — local model (no pricing) should NOT have it.
P13_HEADERS=$(curl -sSi -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "content-type: application/json" \
  -d "$(printf '{"model":"%s","messages":[{"role":"user","content":"OK"}]}' "${MODEL}")" 2>/dev/null | head -50)
if echo "${P13_HEADERS}" | grep -qi '^x-cost-cents:'; then
  fail "Phase 13: local model emitted X-Cost-Cents header (expected absent for unpriced model)"
else
  pass "Phase 13: local model does NOT emit X-Cost-Cents header (COST-02 — header absent when pricing null)"
fi

# 5. request_log.cost_cents column exists (Postgres DDL check).
if docker compose ps postgres 2>/dev/null | grep -q 'Up\|running'; then
  P13_COL=$(docker compose exec -T postgres psql -U app -d router -tA \
    -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='request_log' AND column_name='cost_cents';" 2>/dev/null || echo "")
  if echo "${P13_COL}" | grep -q 'cost_cents|numeric'; then
    pass "Phase 13: request_log.cost_cents column exists (NUMERIC type — COST-01 migration applied)"
  else
    fail "Phase 13: request_log.cost_cents column NOT found — migration 0003 may not have run; query returned: ${P13_COL}"
  fi

  # 6. cost_per_agent_daily view exists + queryable.
  P13_VIEW_ROWS=$(docker compose exec -T postgres psql -U app -d router -tA \
    -c "SELECT 1 FROM information_schema.views WHERE table_name='cost_per_agent_daily';" 2>/dev/null || echo "")
  if [[ "${P13_VIEW_ROWS}" == "1" ]]; then
    pass "Phase 13: cost_per_agent_daily view exists (COST-03 migration 0004 applied)"
  else
    fail "Phase 13: cost_per_agent_daily view NOT found — migration 0004 may not have run"
  fi
  # Verify the view is actually queryable (catches malformed view DDL even if it
  # exists in information_schema).
  if docker compose exec -T postgres psql -U app -d router -c "SELECT * FROM cost_per_agent_daily LIMIT 1;" >/dev/null 2>&1; then
    pass "Phase 13: cost_per_agent_daily view is queryable (COST-03)"
  else
    fail "Phase 13: cost_per_agent_daily view exists but SELECT failed — DDL malformed?"
  fi
else
  skip "Phase 13: postgres container not up — skipping DDL + view checks"
fi

echo ""
echo "[smoke-test-router] === Phase 13 section complete ==="

# Final summary
echo ""
echo "[smoke-test-router] ================================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[smoke-test-router]  Phase 2/3/4/5/7/8/12/13 router verification: COMPLETE."
  echo "[smoke-test-router]  Model used : ${MODEL}"
  echo "[smoke-test-router]  Router URL : ${ROUTER_URL}"
  echo "[smoke-test-router]  Skipped    : ${SKIPS:-0} (vision sections require llama3.2-vision pull + outbound HTTPS)"
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
