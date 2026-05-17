#!/usr/bin/env bash
# bin/smoke-test-observability.sh — Phase 7 observability smoke for local-llms
#
# Asserts that the observability stack is fully wired against a running compose
# stack. Specifically validates:
#
#   OBS-02 — Prometheus scrapes the inference + edge services:
#            up{job="router"}==1, up{job="prometheus"}==1, up{job="gpu"}==1
#            always; up{job="vllm"}==1 / up{job="llamacpp"}==1 when the
#            respective compose profile is active.
#
#   OBS-03 — nvidia_gpu_exporter is alive AND returning real samples:
#            `nvidia_smi_memory_used_bytes` query returns a numeric value
#            (Pitfall G-3 detection — silent CPU fallback in WSL2 would
#            produce no samples even though the container is "up").
#
#   OBS-04 — Grafana provisioning works end-to-end:
#            datasource uid `prometheus-default` is provisioned and named
#            "Prometheus"; dashboard uid `local-llms` is provisioned with
#            a non-empty title AND ≥6 panels (Plan 07-05 contract).
#
# Usage:
#   bash bin/smoke-test-observability.sh
#
# Prerequisites:
#   - Stack is already up (`docker compose up -d`, optionally with
#     `--profile vllm` and/or `--profile llamacpp`).
#   - GRAFANA_ADMIN_PASSWORD set in the environment or .env (see README §Phase 7
#     for the `openssl rand -hex 24` generation recipe).
#
# Exit codes:
#   0  All assertions pass — observability surface is healthy.
#   1  One or more assertions failed — diagnostic printed.
#
# Design notes:
#   - Mirrors bin/smoke-test-router.sh: `set -uo pipefail`, FAILURES counter,
#     pass/fail helpers, sectioned headers.
#   - `docker compose exec -T <svc> wget -qO-` is the canonical inter-service
#     HTTP call here. wget is in both the Prometheus and Grafana images;
#     this avoids depending on host-side curl reaching internal-only networks.
#   - GRAFANA_ADMIN_PASSWORD is read with the same pattern as
#     ROUTER_BEARER_TOKEN in smoke-test-router.sh — caller env wins, then
#     .env (single-line grep, no `set -a`), then hard fail with the
#     openssl recipe.

set -uo pipefail

# Locate repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# ── Env resolution: GRAFANA_ADMIN_PASSWORD ───────────────────────────────────
# Caller env > .env > hard fail. Pattern matches smoke-test-router.sh WR-05.
if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  GRAFANA_ADMIN_PASSWORD=$(
    grep -E '^GRAFANA_ADMIN_PASSWORD=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
  export GRAFANA_ADMIN_PASSWORD
fi
if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  echo "[smoke-test-observability] ERROR: GRAFANA_ADMIN_PASSWORD is not set." >&2
  echo "[smoke-test-observability]        Generate one and write it to ${REPO_ROOT}/.env:" >&2
  echo "[smoke-test-observability]          echo \"GRAFANA_ADMIN_PASSWORD=\$(openssl rand -hex 24)\" >> .env" >&2
  # 07-REVIEW WR-07: single-quoted command name so bash does NOT command-
  # substitute the literal `docker compose up -d grafana` when emitting the
  # error message. The old double-quoted+backtick form actually executed the
  # command at echo time — the opposite of what an error message should do.
  echo "[smoke-test-observability]        Then re-run 'docker compose up -d grafana' so the new credential is picked up." >&2
  exit 1
fi

# ── Tool checks ──────────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-test-observability] ERROR: jq is required on the host (sudo apt-get install -y jq)." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "[smoke-test-observability] ERROR: docker is required on the host." >&2
  exit 1
fi

# 07-REVIEW WR-02: pre-flight wget capability probe inside the prometheus and
# grafana containers. The whole script depends on `docker compose exec -T <svc>
# wget` working — but grafana/grafana base images have flipped between busybox-
# wget, full-wget, and distroless variants across major versions. Without this
# probe, every Section assertion fails opaquely with "Could not fetch …" and
# leaves the operator without a clear remediation. Fail fast with a clear
# error so the operator knows to either downgrade the image, install wget, or
# rewrite the script to use curl.
for svc in prometheus grafana; do
  # `docker compose ps <svc>` returns nothing if the service isn't defined or
  # not running — skip the probe in that case (Section-level asserts will
  # report the actual missing service).
  if docker compose ps "${svc}" --format '{{.State}}' 2>/dev/null | grep -q '^running$'; then
    if ! docker compose exec -T "${svc}" sh -c 'command -v wget' >/dev/null 2>&1; then
      echo "[smoke-test-observability] ERROR: ${svc} container has no wget on PATH." >&2
      echo "[smoke-test-observability]        The image may have been upgraded past the busybox-wget version pinned." >&2
      echo "[smoke-test-observability]        Either pin an older tag with wget, install wget in a custom image," >&2
      echo "[smoke-test-observability]        or rewrite this script's HTTP calls to use curl." >&2
      exit 1
    fi
  fi
done

# ── Failure / skip tracking ──────────────────────────────────────────────────
FAILURES=0
SKIPS=0
fail() { echo "[smoke-test-observability] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-observability] PASS: $*"; }
skip() { echo "[smoke-test-observability] SKIP: $*"; SKIPS=$((SKIPS + 1)); }
info() { echo "[smoke-test-observability] INFO: $*"; }

# ── Helpers ──────────────────────────────────────────────────────────────────
# prom_query <job-name> → echoes the value of `up{job="<job-name>"}` (the
# scalar value from result[0].value[1]) or empty string if no series exists.
prom_query() {
  local job="$1"
  docker compose exec -T prometheus wget -qO- \
    "http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22${job}%22%7D" \
    | jq -r '.data.result[0].value[1] // ""'
}

# svc_running <compose-service> → returns 0 if the service exists and is in
# the "running" state, 1 otherwise. Used to gate profile-specific scrape
# assertions (vllm, vllm-embed, llamacpp).
svc_running() {
  local svc="$1"
  docker compose ps "${svc}" --format '{{.State}}' 2>/dev/null | grep -q '^running$'
}

echo "[smoke-test-observability] ================================================================"
echo "[smoke-test-observability]  Phase 7 observability smoke — OBS-02 + OBS-03 + OBS-04"
echo "[smoke-test-observability] ================================================================"
echo ""

# ── Section 1: Prometheus targets — active count ─────────────────────────────
echo "[smoke-test-observability] === Section 1: Prometheus active targets ==="
TARGETS_JSON=$(docker compose exec -T prometheus wget -qO- \
  'http://localhost:9090/api/v1/targets' 2>/dev/null || echo "")
if [[ -z "${TARGETS_JSON}" ]]; then
  fail "Could not fetch /api/v1/targets from Prometheus — is the service up?"
else
  HEALTHY_UP_COUNT=$(echo "${TARGETS_JSON}" | jq '[.data.activeTargets[] | select(.health == "up")] | length')
  if [[ "${HEALTHY_UP_COUNT}" =~ ^[0-9]+$ ]] && (( HEALTHY_UP_COUNT >= 3 )); then
    pass "Prometheus has ≥3 healthy scrape targets (got ${HEALTHY_UP_COUNT})"
  else
    fail "Prometheus has <3 healthy targets (got ${HEALTHY_UP_COUNT}); inspect: docker compose exec prometheus wget -qO- http://localhost:9090/api/v1/targets | jq"
  fi
fi
echo ""

# ── Section 2: Always-on up{job=X}==1 assertions ─────────────────────────────
echo "[smoke-test-observability] === Section 2: up{job=X}==1 for always-on targets ==="
for JOB in router gpu prometheus; do
  VAL=$(prom_query "${JOB}")
  if [[ "${VAL}" == "1" ]]; then
    pass "up{job=\"${JOB}\"} = 1"
  else
    fail "up{job=\"${JOB}\"} != 1 (got '${VAL:-<empty>}') — check: docker compose logs ${JOB}"
  fi
done
echo ""

# ── Section 3: Conditional up{job=X}==1 for profile-gated targets ────────────
echo "[smoke-test-observability] === Section 3: profile-gated targets (vllm, llamacpp) ==="
# vLLM chat — gated on --profile vllm
if svc_running vllm; then
  VAL=$(prom_query "vllm")
  if [[ "${VAL}" == "1" ]]; then
    pass "up{job=\"vllm\"} = 1 (vllm service is running)"
  else
    fail "up{job=\"vllm\"} != 1 (got '${VAL:-<empty>}') but vllm container is running — check prometheus.yml scrape_config"
  fi
else
  skip "vllm service not running — skipping up{job=\"vllm\"} check (run with --profile vllm to include it)"
fi
# llama.cpp — gated on --profile llamacpp
if svc_running llamacpp; then
  VAL=$(prom_query "llamacpp")
  if [[ "${VAL}" == "1" ]]; then
    pass "up{job=\"llamacpp\"} = 1 (llamacpp service is running)"
  else
    fail "up{job=\"llamacpp\"} != 1 (got '${VAL:-<empty>}') but llamacpp container is running — check prometheus.yml scrape_config"
  fi
else
  skip "llamacpp service not running — skipping up{job=\"llamacpp\"} check (run with --profile llamacpp to include it)"
fi
echo ""

# ── Section 4: GPU exporter returns real samples (OBS-03 + Pitfall G-3) ──────
echo "[smoke-test-observability] === Section 4: nvidia_gpu_exporter returns real samples ==="
GPU_VAL=$(docker compose exec -T prometheus wget -qO- \
  'http://localhost:9090/api/v1/query?query=nvidia_smi_memory_used_bytes' 2>/dev/null \
  | jq -r '.data.result[0].value[1] // ""')
if [[ -n "${GPU_VAL}" ]] && [[ "${GPU_VAL}" =~ ^[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?$ ]]; then
  pass "nvidia_smi_memory_used_bytes returns numeric sample: ${GPU_VAL}"
else
  fail "nvidia_smi_memory_used_bytes returned no numeric sample (got '${GPU_VAL:-<empty>}')"
  echo "[smoke-test-observability]   Pitfall G-3 hint (WSL2): if the exporter logs"
  echo "[smoke-test-observability]   'libnvidia-ml.so: cannot open shared object file',"
  echo "[smoke-test-observability]   uncomment the /usr/lib/wsl/lib bind-mount in"
  echo "[smoke-test-observability]   compose.yml under the nvidia_gpu_exporter service block"
  echo "[smoke-test-observability]   and run: docker compose up -d nvidia_gpu_exporter"
fi
echo ""

# ── Section 5: Grafana datasource provisioned (OBS-04 part 1) ────────────────
echo "[smoke-test-observability] === Section 5: Grafana datasource ==="
DS_JSON=$(docker compose exec -T grafana wget -qO- \
  --user "admin:${GRAFANA_ADMIN_PASSWORD}" \
  'http://localhost:3000/api/datasources/uid/prometheus-default' 2>/dev/null || echo "")
if [[ -z "${DS_JSON}" ]]; then
  fail "Could not fetch /api/datasources/uid/prometheus-default — is grafana up + GRAFANA_ADMIN_PASSWORD correct?"
else
  if echo "${DS_JSON}" | jq -e '.name == "Prometheus" and .uid == "prometheus-default"' >/dev/null 2>&1; then
    pass "Grafana datasource provisioned (uid=prometheus-default, name=Prometheus)"
  else
    fail "Grafana datasource shape unexpected — got: $(echo "${DS_JSON}" | jq -c '{name, uid, type}' 2>/dev/null || echo "<unparseable>")"
  fi
fi
echo ""

# ── Section 6: Grafana dashboard provisioned (OBS-04 part 2) ─────────────────
echo "[smoke-test-observability] === Section 6: Grafana dashboard 'local-llms' ==="
DASH_JSON=$(docker compose exec -T grafana wget -qO- \
  --user "admin:${GRAFANA_ADMIN_PASSWORD}" \
  'http://localhost:3000/api/dashboards/uid/local-llms' 2>/dev/null || echo "")
if [[ -z "${DASH_JSON}" ]]; then
  fail "Could not fetch /api/dashboards/uid/local-llms — is the dashboard provisioned (Plan 07-05)?"
else
  if echo "${DASH_JSON}" | jq -e '.dashboard.uid == "local-llms" and (.dashboard.title | length > 0) and (.dashboard.panels | length >= 6)' >/dev/null 2>&1; then
    PANEL_COUNT=$(echo "${DASH_JSON}" | jq '.dashboard.panels | length')
    TITLE=$(echo "${DASH_JSON}" | jq -r '.dashboard.title')
    pass "Grafana dashboard provisioned (uid=local-llms, title='${TITLE}', panels=${PANEL_COUNT})"
  else
    fail "Grafana dashboard shape unexpected — got: $(echo "${DASH_JSON}" | jq -c '{uid: .dashboard.uid, title: .dashboard.title, panel_count: (.dashboard.panels | length)}' 2>/dev/null || echo "<unparseable>")"
  fi
fi
echo ""

# ── Final summary ────────────────────────────────────────────────────────────
echo "[smoke-test-observability] ================================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[smoke-test-observability]  ✓ Phase 7 observability smoke PASS"
  echo "[smoke-test-observability]  Skipped : ${SKIPS} (profile-gated targets; pass --profile vllm/llamacpp to include)"
  echo "[smoke-test-observability] ================================================================"
  exit 0
else
  echo "[smoke-test-observability]  ✗ FAILED: ${FAILURES} assertion(s) did not pass."
  echo "[smoke-test-observability]  Diagnostics:"
  echo "[smoke-test-observability]    docker compose logs prometheus | tail -50"
  echo "[smoke-test-observability]    docker compose logs grafana    | tail -50"
  echo "[smoke-test-observability]    docker compose logs nvidia_gpu_exporter | tail -50"
  echo "[smoke-test-observability] ================================================================"
  exit 1
fi
