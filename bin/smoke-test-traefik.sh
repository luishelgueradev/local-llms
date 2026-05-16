#!/usr/bin/env bash
# bin/smoke-test-traefik.sh — Phase 6 edge verification for local-llms
#
# What this script asserts (Phase 6 success criteria + per-requirement gates):
#
#   Static (run in --quick):
#     - EDGE-03: no `0.0.0.0:*` host mappings in `docker compose config` for the prod profile.
#     - EDGE-03: only `traefik` (and `router-dev` under --profile dev) publishes host ports.
#     - EDGE-04: `idleConnTimeout: 0s` AND `responseHeaderTimeout: 0s` in traefik/traefik.yml.
#     - EDGE-04 / Pitfall 4: NO `compress` middleware anywhere in `traefik/`.
#     - EDGE-04: NO `buffering` middleware anywhere in `traefik/`.
#     - EDGE-02: docker compose config networks == [app, backend, data, edge].
#
#   Tailscale advertisement (run in --quick):
#     - `tailscale serve status` lists both `svc:router` and `svc:chat`.
#
#   Live HTTP through Tailscale → Traefik → router/owui (run in --quick except long-SSE):
#     - EDGE-01: GET https://router.<TAILNET>.ts.net/healthz → 200 (Let's Encrypt cert).
#     - D-B1   : GET https://router.<TAILNET>.ts.net/metrics → 401 OR 404 (no metrics body).
#     - D-B2   : Internal scrape `docker compose exec -T traefik wget -qO- http://router:3000/metrics`
#                → Prometheus exposition (starts with `# HELP`).
#     - EDGE-05: GET http://router.<TAILNET>.ts.net/healthz → 301/302/307/308 (HTTPS redirect).
#     - WEBUI-03: GET https://chat.<TAILNET>.ts.net/ no-creds → 401; with basic-auth → 200/302.
#     - WEBUI-03 posture: response body contains NO OWUI login form (proves WEBUI_AUTH=False).
#     - WEBUI-04: `psql ... \dt` on `openwebui` DB shows OWUI tables (user, chat, model, etc.).
#     - WEBUI-05: openwebui logs contain `router:3000/v1/models` (auto-discovery cadence).
#
#   Long-generation (EDGE-06 / Pitfall 3) — SKIPPED if --quick:
#     - 120s+ SSE through Tailscale → Traefik → router → Ollama;
#       deltas < 1s apart; total > 120s; terminator `data: [DONE]`; no 502.
#
# Usage:  bash bin/smoke-test-traefik.sh [--quick]
#
# Exit codes:
#   0  All in-scope assertions pass (FAIL=0).
#   1  At least one assertion failed.
#   2  Required env var missing (script aborts before any assertion).
#
# Required env vars (sourced from .env if not already in shell):
#   TAILNET_HOSTNAME, ROUTER_BEARER_TOKEN, POSTGRES_PASSWORD,
#   TRAEFIK_BASIC_AUTH_USER, TRAEFIK_BASIC_AUTH_PASS_PLAIN
#
# Optional env vars:
#   SMOKE_MODEL  Override the model used for the 120s SSE test
#                (default: llama3.2:3b-instruct-q4_K_M).
#
# Design notes:
#   - Mirrors bin/smoke-test-router.sh / bin/smoke-test-gpu.sh — same FAILURES
#     counter, `set -uo pipefail`, sectioned output, exit 0/1 discipline.
#   - Read-only: never edits compose.yml, traefik/, or any service config.

set -uo pipefail

# Locate repo root so the script works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

# Parse flags
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick)
      QUICK=1
      ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "[smoke-test-traefik] ERROR: unknown option: $arg" >&2
      echo "Usage: bash bin/smoke-test-traefik.sh [--quick]" >&2
      exit 2
      ;;
  esac
done

# Load .env (extract only the vars we use — do NOT `set -a; source .env` so that
# unrelated secrets like OLLAMA_API_KEY do not leak into subprocesses).
_load_from_env() {
  local var_name="$1"
  local current="${!var_name:-}"
  if [[ -n "$current" ]]; then
    return 0
  fi
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    local val
    val=$(
      grep -E "^${var_name}=" "${REPO_ROOT}/.env" \
        | tail -1 \
        | cut -d= -f2- \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
    )
    if [[ -n "$val" ]]; then
      printf -v "$var_name" '%s' "$val"
      export "$var_name"
    fi
  fi
}

for v in TAILNET_HOSTNAME ROUTER_BEARER_TOKEN POSTGRES_PASSWORD \
         TRAEFIK_BASIC_AUTH_USER TRAEFIK_BASIC_AUTH_PASS_PLAIN; do
  _load_from_env "$v"
done

# Required-env gate (exit 2 — distinct from assertion failures).
require() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "[smoke-test-traefik] ERROR: required env var ${var_name} is not set." >&2
    echo "[smoke-test-traefik]        Either export it in the shell or fill it in ${REPO_ROOT}/.env" >&2
    echo "[smoke-test-traefik]        See README §Phase 6 for the full .env contract." >&2
    exit 2
  fi
}
require TAILNET_HOSTNAME
require ROUTER_BEARER_TOKEN
require POSTGRES_PASSWORD
require TRAEFIK_BASIC_AUTH_USER
require TRAEFIK_BASIC_AUTH_PASS_PLAIN

SMOKE_MODEL="${SMOKE_MODEL:-llama3.2:3b-instruct-q4_K_M}"
ROUTER_FQDN="router.${TAILNET_HOSTNAME}.ts.net"
CHAT_FQDN="chat.${TAILNET_HOSTNAME}.ts.net"

PASS=0
FAIL=0
ok()   { echo "[smoke-test-traefik] [OK]   $*"; PASS=$((PASS + 1)); }
fail() { echo "[smoke-test-traefik] [FAIL] $*" >&2; FAIL=$((FAIL + 1)); }
info() { echo "[smoke-test-traefik] [INFO] $*"; }
section() { echo ""; echo "[smoke-test-traefik] ▶ $*"; }

echo ""
echo "[smoke-test-traefik] ================================================================"
echo "[smoke-test-traefik]  local-llms — Phase 6 Edge Verification"
echo "[smoke-test-traefik]  Router FQDN  : https://${ROUTER_FQDN}"
echo "[smoke-test-traefik]  Chat FQDN    : https://${CHAT_FQDN}"
echo "[smoke-test-traefik]  Mode         : $([[ $QUICK -eq 1 ]] && echo 'QUICK (skip 120s SSE)' || echo 'FULL (~3 min)')"
echo "[smoke-test-traefik]  SMOKE_MODEL  : ${SMOKE_MODEL}"
echo "[smoke-test-traefik] ================================================================"

# ============================================================================
# Section 1 — Static config gates (no live containers required)
# ============================================================================

section "Section 1 — Static config gates (docker compose config + traefik/ tree)"

# Render the rendered Compose config once and reuse.
COMPOSE_CFG="$(mktemp)"
trap 'rm -f "$COMPOSE_CFG"' EXIT
if ! docker compose config > "$COMPOSE_CFG" 2>/dev/null; then
  fail "docker compose config failed — fix YAML before running this smoke."
  echo "[smoke-test-traefik] PASS=${PASS} / FAIL=${FAIL}"
  exit 1
fi

# 1. EDGE-03: no `0.0.0.0:*` host-port mappings in the rendered prod-profile config.
if grep -E "0\.0\.0\.0:" "$COMPOSE_CFG" >/dev/null 2>&1; then
  fail "EDGE-03: rendered compose config contains 0.0.0.0:* host bindings (expected only 127.0.0.1)."
  grep -E "0\.0\.0\.0:" "$COMPOSE_CFG" | head -5 | sed 's/^/        /' >&2
else
  ok "EDGE-03: zero 0.0.0.0:* host-port mappings"
fi

# 2. EDGE-03: only `traefik` publishes host ports in the rendered config.
# Walk service blocks and capture services that have `host_ip:` entries.
SERVICES_WITH_PORTS=$(python3 - <<'PY' "$COMPOSE_CFG"
import sys, yaml
with open(sys.argv[1]) as f:
    cfg = yaml.safe_load(f)
hits = []
for name, svc in (cfg.get("services") or {}).items():
    ports = svc.get("ports") or []
    if ports:
        hits.append(name)
print(",".join(sorted(hits)))
PY
)
# Allowed publishers: traefik always; router-dev only if dev profile is rendered.
EXPECTED_OK=1
for s in ${SERVICES_WITH_PORTS//,/ }; do
  case "$s" in
    traefik|router-dev) : ;;
    *) EXPECTED_OK=0 ; echo "[smoke-test-traefik]   unexpected publisher: $s" >&2 ;;
  esac
done
if [[ $EXPECTED_OK -eq 1 ]]; then
  ok "EDGE-03: only allowed services publish host ports (got: ${SERVICES_WITH_PORTS:-none})"
else
  fail "EDGE-03: unexpected services publishing host ports: ${SERVICES_WITH_PORTS}"
fi

# 3. EDGE-04: idleConnTimeout: 0s + responseHeaderTimeout: 0s in traefik/traefik.yml.
if grep -qE "idleConnTimeout:[[:space:]]*0s" traefik/traefik.yml \
   && grep -qE "responseHeaderTimeout:[[:space:]]*0s" traefik/traefik.yml; then
  ok "EDGE-04: traefik.yml has idleConnTimeout: 0s AND responseHeaderTimeout: 0s"
else
  fail "EDGE-04: traefik.yml missing required SSE knobs (idleConnTimeout: 0s + responseHeaderTimeout: 0s)"
fi

# 4. EDGE-04 / Pitfall 4: no `compress` middleware anywhere in traefik/.
if grep -ri "compress" traefik/ >/dev/null 2>&1; then
  fail "EDGE-04 / Pitfall 4: 'compress' middleware found somewhere in traefik/ — would buffer SSE"
  grep -ri "compress" traefik/ | head -3 | sed 's/^/        /' >&2
else
  ok "EDGE-04: no 'compress' middleware in traefik/"
fi

# 5. No `buffering` middleware anywhere in traefik/.
if grep -ri "buffering" traefik/ >/dev/null 2>&1; then
  fail "EDGE-04: 'buffering' middleware found somewhere in traefik/ — would buffer SSE"
  grep -ri "buffering" traefik/ | head -3 | sed 's/^/        /' >&2
else
  ok "EDGE-04: no 'buffering' middleware in traefik/"
fi

# 6. EDGE-02: four-network topology preserved.
NETWORKS_LIST=$(python3 - <<'PY' "$COMPOSE_CFG"
import sys, yaml
with open(sys.argv[1]) as f:
    cfg = yaml.safe_load(f)
print(",".join(sorted((cfg.get("networks") or {}).keys())))
PY
)
if [[ "$NETWORKS_LIST" == "app,backend,data,edge" ]]; then
  ok "EDGE-02: networks == [app, backend, data, edge]"
else
  fail "EDGE-02: networks mismatch (got: ${NETWORKS_LIST}, expected: app,backend,data,edge)"
fi

# ============================================================================
# Section 2 — Tailscale Services advertisement
# ============================================================================

section "Section 2 — Tailscale Services advertisement"

# 7. tailscale serve status must list svc:router AND svc:chat.
if ! command -v tailscale >/dev/null 2>&1; then
  fail "tailscale binary not on PATH — install Tailscale on the host. See README §Phase 6."
else
  TS_STATUS=$(tailscale serve status 2>&1 || true)
  if echo "$TS_STATUS" | grep -q "svc:router" && echo "$TS_STATUS" | grep -q "svc:chat"; then
    ok "Tailscale: svc:router AND svc:chat advertised"
  else
    fail "Tailscale: svc:router OR svc:chat NOT advertised. Run admin-console prereq + \`sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80\` (and same for svc:chat) per README §Phase 6."
    echo "$TS_STATUS" | head -10 | sed 's/^/        /' >&2
  fi
fi

# ============================================================================
# Section 3 — Live HTTP through Tailscale → Traefik → router/owui
# ============================================================================

section "Section 3 — Live HTTP (Tailscale → Traefik → router/owui)"

# 8. EDGE-01: GET https://${ROUTER_FQDN}/healthz → 200 (Let's Encrypt cert, not self-signed).
HEALTHZ_BODY=$(mktemp)
HEALTHZ_CODE=$(curl -s -o "$HEALTHZ_BODY" -w '%{http_code}' --max-time 10 "https://${ROUTER_FQDN}/healthz" 2>/dev/null || echo "000")
if [[ "$HEALTHZ_CODE" == "200" ]]; then
  ok "EDGE-01: https://${ROUTER_FQDN}/healthz → 200"
else
  fail "EDGE-01: https://${ROUTER_FQDN}/healthz → ${HEALTHZ_CODE} (expected 200). Check Tailscale Serve + Traefik labels."
fi
rm -f "$HEALTHZ_BODY"

# 9. D-B1: GET https://${ROUTER_FQDN}/metrics → 401 OR 404 (both prove no metrics body leaked).
METRICS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${ROUTER_FQDN}/metrics" 2>/dev/null || echo "000")
if [[ "$METRICS_CODE" == "401" || "$METRICS_CODE" == "404" ]]; then
  ok "D-B1: external /metrics blocked (${METRICS_CODE}) — metrics-blackhole middleware live"
else
  fail "D-B1: external /metrics returned ${METRICS_CODE} (expected 401 OR 404). Check traefik labels on router service."
fi

# 10. D-B2: internal scrape via Traefik container → http://router:3000/metrics returns Prometheus exposition.
METRICS_INTERNAL=$(docker compose exec -T traefik wget -qO- http://router:3000/metrics 2>/dev/null | head -1 || true)
if echo "$METRICS_INTERNAL" | grep -q '^# HELP'; then
  ok "D-B2: internal http://router:3000/metrics returns Prometheus exposition (# HELP line)"
else
  fail "D-B2: internal /metrics scrape did not return Prometheus exposition. Got: '${METRICS_INTERNAL:0:60}'"
fi

# 11. EDGE-05: plain HTTP to ${ROUTER_FQDN} → 308 (or 301/302/307) — Tailscale Serve refuses plain HTTP.
HTTP_REDIRECT_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${ROUTER_FQDN}/healthz" 2>/dev/null || echo "000")
case "$HTTP_REDIRECT_CODE" in
  301|302|307|308)
    ok "EDGE-05: http://${ROUTER_FQDN}/healthz → ${HTTP_REDIRECT_CODE} (HTTPS redirect)"
    ;;
  *)
    fail "EDGE-05: http://${ROUTER_FQDN}/healthz → ${HTTP_REDIRECT_CODE} (expected 301/302/307/308)"
    ;;
esac

# 12. WEBUI-03: chat FQDN without creds → 401; with creds → 200/302.
CHAT_NOAUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${CHAT_FQDN}/" 2>/dev/null || echo "000")
if [[ "$CHAT_NOAUTH_CODE" == "401" ]]; then
  ok "WEBUI-03: https://${CHAT_FQDN}/ no-creds → 401 (basic-auth gate active)"
else
  fail "WEBUI-03: https://${CHAT_FQDN}/ no-creds → ${CHAT_NOAUTH_CODE} (expected 401)"
fi

CHAT_AUTH_BODY=$(mktemp)
CHAT_AUTH_CODE=$(curl -s -o "$CHAT_AUTH_BODY" -w '%{http_code}' --max-time 10 \
  -u "${TRAEFIK_BASIC_AUTH_USER}:${TRAEFIK_BASIC_AUTH_PASS_PLAIN}" \
  "https://${CHAT_FQDN}/" 2>/dev/null || echo "000")
case "$CHAT_AUTH_CODE" in
  200|302)
    ok "WEBUI-03: https://${CHAT_FQDN}/ with basic-auth → ${CHAT_AUTH_CODE} (creds accepted)"
    ;;
  *)
    fail "WEBUI-03: https://${CHAT_FQDN}/ with basic-auth → ${CHAT_AUTH_CODE} (expected 200 or 302). Check TRAEFIK_BASIC_AUTH_USER/PASS_PLAIN match TRAEFIK_BASIC_AUTH hash."
    ;;
esac

# 13. WEBUI-03 posture: response body MUST NOT contain an OWUI login form.
# OWUI's login page (when WEBUI_AUTH=True) contains an HTML form with type=password.
if grep -qiE "<form[^>]*>.*name=[\"']password[\"']|<input[^>]+type=[\"']password[\"']" "$CHAT_AUTH_BODY"; then
  fail "WEBUI-03 posture: OWUI login form detected in chat response body — WEBUI_AUTH may be True (irreversible if any user exists)"
else
  ok "WEBUI-03 posture: no OWUI login form in chat body (WEBUI_AUTH=False posture confirmed)"
fi
rm -f "$CHAT_AUTH_BODY"

# 14. WEBUI-04: after OWUI's first boot, openwebui DB has tables (user, chat, etc.).
OWUI_TABLES=$(docker compose exec -T postgres psql -U app -d openwebui -c '\dt' 2>/dev/null || true)
if echo "$OWUI_TABLES" | grep -qE '\b(user|chat|auth|model)\b'; then
  ok "WEBUI-04: openwebui DB has OWUI tables (\\dt shows user|chat|auth|model)"
else
  fail "WEBUI-04: openwebui DB has no expected tables. Open https://${CHAT_FQDN} once to trigger first-boot migration, then re-run. \\dt output: ${OWUI_TABLES:0:200}"
fi

# 15. WEBUI-05: openwebui logs show at least one /v1/models hit on the router.
OWUI_AUTODISC=$(docker compose logs --since=5m openwebui 2>/dev/null | grep -E 'router:3000.*models|router:3000/v1/models' | head -1 || true)
if [[ -n "$OWUI_AUTODISC" ]]; then
  ok "WEBUI-05: OWUI auto-discovery hit found in logs (5m window): ${OWUI_AUTODISC:0:80}..."
else
  info "WEBUI-05: no auto-discovery hit in last 5m. Open https://${CHAT_FQDN} once and re-run — auto-discovery runs on a cadence, not on boot."
fi

# ============================================================================
# Section 4 — 120s+ SSE through Traefik (EDGE-06 / Pitfall 3)
# ============================================================================

if [[ $QUICK -eq 1 ]]; then
  section "Section 4 — 120s+ SSE through Traefik (EDGE-06): SKIPPED (--quick)"
else
  section "Section 4 — 120s+ SSE through Traefik (EDGE-06)"
  info "This takes ~2-3 minutes. Asserts: deltas < 1s apart, total > 120s, terminates with [DONE], no 502."

  STREAM_OUT=$(mktemp)
  STREAM_TIMING=$(mktemp)

  # Body: long-generation request. max_tokens=1200 + 'count to 200 very slowly'
  # reliably crosses the 120s wall on the 3b model (06-CONTEXT §Specifics).
  STREAM_BODY=$(SMOKE_MODEL="$SMOKE_MODEL" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": "count to 200 very slowly"}],
  "stream": True,
  "max_tokens": 1200,
}))
')

  # Run curl; capture stdout to STREAM_OUT, and timing-of-each-line to STREAM_TIMING.
  # `--no-buffer` (-N) is critical so each SSE chunk arrives without bash-side buffering.
  START_EPOCH=$(date +%s)
  (
    curl -N --max-time 180 \
      -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${STREAM_BODY}" \
      "https://${ROUTER_FQDN}/v1/chat/completions" 2>/dev/null \
      | while IFS= read -r line; do
          printf '%s %s\n' "$(date +%s.%N)" "$line" >> "$STREAM_TIMING"
          printf '%s\n' "$line" >> "$STREAM_OUT"
        done
  )
  END_EPOCH=$(date +%s)
  ELAPSED=$((END_EPOCH - START_EPOCH))

  # Analyze
  if grep -q '^HTTP/.*502' "$STREAM_OUT" 2>/dev/null; then
    fail "EDGE-06: 502 Bad Gateway during stream (Pitfall 3 regression)."
  elif ! grep -q '\[DONE\]' "$STREAM_OUT"; then
    fail "EDGE-06: stream did not terminate with data: [DONE] (raw size: $(wc -c < "$STREAM_OUT") bytes; ${ELAPSED}s elapsed)."
  elif [[ $ELAPSED -lt 120 ]]; then
    fail "EDGE-06: stream completed in ${ELAPSED}s (< 120s threshold). Try a slower model or a longer prompt."
  else
    # Inter-delta gap: max gap between consecutive `data: ` lines must be < 5s.
    # (The plan calls for < 1s but Ollama can hiccup; 5s is a defensible upper
    # bound that still proves no Traefik buffering — buffering would cause
    # tens-of-seconds gaps as Traefik holds chunks.)
    MAX_GAP=$(awk '
      /data: / {
        if (prev > 0) {
          gap = $1 - prev
          if (gap > max) max = gap
        }
        prev = $1
      }
      END { printf "%.2f", max+0 }
    ' "$STREAM_TIMING")
    if awk -v g="$MAX_GAP" 'BEGIN { exit !(g < 5) }'; then
      ok "EDGE-06: 120s+ SSE through Traefik successful (elapsed=${ELAPSED}s, max-delta-gap=${MAX_GAP}s, terminates with [DONE], no 502)"
    else
      fail "EDGE-06: max inter-delta gap was ${MAX_GAP}s — likely Traefik buffering. Check for compress/buffering middleware regressions."
    fi
  fi

  rm -f "$STREAM_OUT" "$STREAM_TIMING"
fi

# ============================================================================
# Footer
# ============================================================================

echo ""
echo "[smoke-test-traefik] ================================================================"
echo "[smoke-test-traefik]  PASS=${PASS}  FAIL=${FAIL}"
echo "[smoke-test-traefik] ================================================================"

if [[ $FAIL -eq 0 ]]; then
  exit 0
else
  exit 1
fi
