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
_ollama_ps_snapshot() {
  docker compose exec -T "${OLLAMA_SVC}" curl -fsS http://localhost:11434/api/ps 2>/dev/null || true
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

# SC5: zero matches for bearer/authorization in router logs
echo ""
echo "[smoke-test-router] SC5: scanning router logs for bearer/authorization leaks..."
LEAK_COUNT=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | grep -ciE 'bearer [a-z0-9_]+|authorization:[[:space:]]*bearer' || true)
if [[ "${LEAK_COUNT}" -ne 0 ]]; then
  fail "SC5: found ${LEAK_COUNT} potential bearer-token log leak lines (expected 0). First match: $(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | grep -iE 'bearer [a-z0-9_]+|authorization:[[:space:]]*bearer' | head -1)"
else
  pass "SC5: zero bearer/authorization matches in router logs after a full session"
fi

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
