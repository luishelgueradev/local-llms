#!/usr/bin/env bash
# bin/smoke-test-vllm-coldstart.sh — Phase 7 Plan 07-00 Wave 0 gate
#
# Pitfall V-1 verification: does the locked vLLM image
#   vllm/vllm-openai:v0.21.0-cu129
# actually run on this host's GPU (RTX 5060 Ti, Blackwell sm_120, WSL2)?
#
# This script is INTENTIONALLY standalone — it does NOT touch compose.yml,
# the router source, or any .planning/ artifact. It bypasses Compose entirely
# and invokes `docker run --rm --gpus all` directly so that:
#   1. Plan 07-00 (which OWNS this script) does not depend on Plan 07-01's
#      compose.yml mutations that have not landed yet.
#   2. A failed cold-start does not leave the stack in a half-up state.
#
# Behavior:
#   - Pulls the locked image (vllm/vllm-openai:v0.21.0-cu129) once.
#   - Runs Qwen/Qwen2.5-7B-Instruct-AWQ with a deliberately small footprint
#     (--max-model-len 1024, --max-num-seqs 1, --gpu-memory-utilization 0.45)
#     so the cold start is as fast as possible.
#   - Polls http://localhost:<probe-port>/health for up to 900s (15-min budget
#     per Pitfall V-2: vLLM JIT compile + CUDA graphs).
#   - On health: sends one max_tokens=4 chat request; asserts non-empty content.
#   - Asserts nvidia-smi inside the container shows a vllm/python process
#     consuming VRAM.
#   - Tears down the container.
#
# Exit codes (decision tree for Plan 07-01):
#   0  PASS                — OUTCOME: locked
#                             → Plan 07-01 uses the verbatim 07-RESEARCH
#                               §"Validated Code Snippets" vllm Compose block
#                               with --quantization=awq_marlin and no extra
#                               env overrides beyond defensive VLLM_FLASH_ATTN_VERSION=2.
#   1  setup/pull failure  — pre-Docker / pre-run problem; not a kernel issue
#   2  kernel-incompat     — "no kernel image is available" / "sm_120 not compatible"
#                             → re-run with VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1
#                               (env-var fallback). On success the script then prints
#                               OUTCOME: fallback-env.
#   3  no-gpu-process      — health passed but nvidia-smi shows no vllm process
#                             → re-run with env-var fallback (likely CPU fallback)
#   4  chat semantic fail  — response was non-200 or empty content
#                             → escalate to VLLM_QUANT_OVERRIDE=awq (quant fallback).
#                               On success the script prints OUTCOME: fallback-quant.
#   5  timeout             — never reached health in 900s
#
# Re-run modes (read from the environment):
#   VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1 — env-var fallback (Pitfall V-1 B).
#     If success, prints OUTCOME: fallback-env.
#   VLLM_QUANT_OVERRIDE=awq                          — quant fallback (Pitfall V-1 C).
#     If success, prints OUTCOME: fallback-quant.
#
# Usage:
#   bash bin/smoke-test-vllm-coldstart.sh
#   VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1 bash bin/smoke-test-vllm-coldstart.sh
#   VLLM_QUANT_OVERRIDE=awq bash bin/smoke-test-vllm-coldstart.sh

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

VLLM_IMAGE="vllm/vllm-openai:v0.21.0-cu129"
MODEL="Qwen/Qwen2.5-7B-Instruct-AWQ"
PROBE_PORT="${VLLM_PROBE_PORT:-18000}"   # host-side mapped port; avoid 8000 clash
CONTAINER_NAME="local-llms-vllm-smoke-$$"
HEALTH_TIMEOUT_SECS=900                  # 15-min budget per Pitfall V-2
HEALTH_INTERVAL_SECS=10

# ─── Resolve HOST_DATA_ROOT (mirrors bin/preflight-gpu.sh logic) ─────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"
if [ "${HOST_DATA_ROOT}" = "/srv/local-llms" ] && [ -f "${REPO_ROOT}/.env" ]; then
  _val=$(grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  [ -n "$_val" ] && HOST_DATA_ROOT="$_val"
fi

HF_CACHE_DIR="${HOST_DATA_ROOT}/models-hf"

# ─── Quant flag selection ────────────────────────────────────────────────────
# Default: awq_marlin (the locked decision per 07-CONTEXT D-A3).
# Override: VLLM_QUANT_OVERRIDE=awq triggers the Pitfall V-1 fallback path C.

QUANT_FLAG="${VLLM_QUANT_OVERRIDE:-awq_marlin}"

# ─── Detect re-run mode ──────────────────────────────────────────────────────

RERUN_ENV_FALLBACK=false
RERUN_QUANT_FALLBACK=false
if [ "${VLLM_FLASH_ATTN_VERSION:-}" = "2" ] && [ "${VLLM_USE_TRITON_AWQ:-}" = "1" ]; then
  RERUN_ENV_FALLBACK=true
fi
if [ -n "${VLLM_QUANT_OVERRIDE:-}" ]; then
  RERUN_QUANT_FALLBACK=true
fi

# ─── Logging helpers ─────────────────────────────────────────────────────────

log() { echo "[smoke-vllm] $*"; }
log_err() { echo "[smoke-vllm] ERROR: $*" >&2; }

# ─── Cleanup trap ────────────────────────────────────────────────────────────

cleanup() {
  local rc=$?
  if docker ps -aq --filter "name=^${CONTAINER_NAME}$" | grep -q .; then
    log "Cleaning up container ${CONTAINER_NAME} (rc=${rc})..."
    docker kill "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM HUP

# ─── Preflight ───────────────────────────────────────────────────────────────

log ""
log "vLLM cold-start smoke — Pitfall V-1 verification gate"
log "======================================================="
log "Image:       ${VLLM_IMAGE}"
log "Model:       ${MODEL}"
log "Quant flag:  --quantization=${QUANT_FLAG}"
log "HF cache:    ${HF_CACHE_DIR}"
log "Probe port:  ${PROBE_PORT}"
log "Container:   ${CONTAINER_NAME}"
if [ "$RERUN_ENV_FALLBACK" = "true" ]; then
  log "Mode:        ENV-VAR FALLBACK (VLLM_FLASH_ATTN_VERSION=2 + VLLM_USE_TRITON_AWQ=1)"
elif [ "$RERUN_QUANT_FALLBACK" = "true" ]; then
  log "Mode:        QUANT FALLBACK (VLLM_QUANT_OVERRIDE=${VLLM_QUANT_OVERRIDE})"
else
  log "Mode:        LOCKED (no fallback env vars)"
fi
log ""

# Ensure HF cache dir exists (mkdir -p, current user)
if [ ! -d "${HF_CACHE_DIR}" ]; then
  log "Creating HF cache dir ${HF_CACHE_DIR}..."
  mkdir -p "${HF_CACHE_DIR}" 2>/dev/null || {
    log_err "Cannot create ${HF_CACHE_DIR}. Run bin/bootstrap-host.sh first."
    exit 1
  }
fi

# Docker availability
if ! command -v docker >/dev/null 2>&1; then
  log_err "docker CLI not found"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  log_err "docker daemon not reachable"
  exit 1
fi

# jq + curl required
for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log_err "${tool} not found on host PATH (used to validate response)"
    exit 1
  fi
done

# ─── Pull the image ──────────────────────────────────────────────────────────

log "Pulling ${VLLM_IMAGE} (may take 5–10 min on first run, ~5GB)..."
if ! docker pull "${VLLM_IMAGE}"; then
  log_err "Failed to pull ${VLLM_IMAGE}"
  exit 1
fi
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "${VLLM_IMAGE}" 2>/dev/null || echo "<unknown>")
log "Image digest: ${DIGEST}"

# ─── Assemble docker run flags ───────────────────────────────────────────────

declare -a DOCKER_FLAGS=(
  --rm
  --detach
  --name "${CONTAINER_NAME}"
  --gpus all
  --ipc host
  --shm-size 16gb
  -p "${PROBE_PORT}:8000"
  -v "${HF_CACHE_DIR}:/root/.cache/huggingface"
)

# Pass through HUGGINGFACE_HUB_TOKEN if set (Qwen2.5-7B-Instruct-AWQ is public,
# but a token avoids anonymous rate limits).
if [ -n "${HUGGINGFACE_HUB_TOKEN:-}" ]; then
  DOCKER_FLAGS+=(-e "HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN}")
fi
if [ -n "${HF_TOKEN:-}" ]; then
  DOCKER_FLAGS+=(-e "HF_TOKEN=${HF_TOKEN}")
fi

# Pitfall V-1 env-var fallback: only forwarded when the caller exported them.
if [ -n "${VLLM_FLASH_ATTN_VERSION:-}" ]; then
  DOCKER_FLAGS+=(-e "VLLM_FLASH_ATTN_VERSION=${VLLM_FLASH_ATTN_VERSION}")
fi
if [ -n "${VLLM_USE_TRITON_AWQ:-}" ]; then
  DOCKER_FLAGS+=(-e "VLLM_USE_TRITON_AWQ=${VLLM_USE_TRITON_AWQ}")
fi

declare -a VLLM_ARGS=(
  --model "${MODEL}"
  --quantization "${QUANT_FLAG}"
  --max-model-len 1024
  --max-num-seqs 1
  --gpu-memory-utilization 0.45
  --host 0.0.0.0
  --port 8000
)

# ─── Cold start ──────────────────────────────────────────────────────────────

log "Starting vLLM in background (cold-start budget: ${HEALTH_TIMEOUT_SECS}s)..."
if ! docker run "${DOCKER_FLAGS[@]}" "${VLLM_IMAGE}" "${VLLM_ARGS[@]}" >/dev/null; then
  log_err "docker run failed to launch container"
  exit 1
fi

# ─── Health-poll loop ────────────────────────────────────────────────────────

log "Polling http://localhost:${PROBE_PORT}/health every ${HEALTH_INTERVAL_SECS}s..."
ELAPSED=0
HEALTH_OK=false
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT_SECS" ]; do
  # Check container is still alive
  if ! docker ps -q --filter "name=^${CONTAINER_NAME}$" | grep -q .; then
    log_err "Container exited prematurely at ${ELAPSED}s"
    LOGS=$(docker logs "${CONTAINER_NAME}" 2>&1 | tail -200 || true)
    echo "${LOGS}" | sed 's/^/[smoke-vllm] (logs) /'

    # Pitfall V-1 detection: classify the failure to guide the fallback choice.
    if echo "${LOGS}" | grep -qE "no kernel image is available|sm_120 is not compatible|CUDA capability sm_120 is not compatible"; then
      log_err ""
      log_err "DETECTED: Pitfall V-1 kernel incompatibility on sm_120."
      log_err "Re-run with the env-var fallback:"
      log_err "  VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1 bash bin/smoke-test-vllm-coldstart.sh"
      log_err "Exit 2: kernel-incompatibility detected (env-var fallback recommended)"
      exit 2
    fi
    if echo "${LOGS}" | grep -qE "CUDA error"; then
      log_err "DETECTED: generic CUDA error. Likely env-var fallback territory."
      log_err "Re-run with: VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1 bash bin/smoke-test-vllm-coldstart.sh"
      log_err "Exit 2: kernel-incompatibility detected (env-var fallback recommended)"
      exit 2
    fi
    log_err "Exit 1: container exited for an unclassified reason (see logs above)"
    exit 1
  fi

  if curl -fsS -o /dev/null --max-time 3 "http://localhost:${PROBE_PORT}/health" 2>/dev/null; then
    HEALTH_OK=true
    log "✓ Health endpoint OK at ${ELAPSED}s"
    break
  fi

  # Periodic progress print
  if [ $((ELAPSED % 60)) -eq 0 ] && [ "$ELAPSED" -gt 0 ]; then
    log "  ...still waiting (${ELAPSED}s / ${HEALTH_TIMEOUT_SECS}s). Recent log tail:"
    docker logs --tail 5 "${CONTAINER_NAME}" 2>&1 | sed 's/^/[smoke-vllm]    /' || true
  fi

  sleep "${HEALTH_INTERVAL_SECS}"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL_SECS))
done

if [ "$HEALTH_OK" != "true" ]; then
  log_err "Health endpoint never returned 200 in ${HEALTH_TIMEOUT_SECS}s"
  log_err "Final log tail:"
  docker logs --tail 80 "${CONTAINER_NAME}" 2>&1 | sed 's/^/[smoke-vllm] (logs) /' || true
  log_err "Exit 5: timeout"
  exit 5
fi

# ─── Chat smoke (one tiny request) ───────────────────────────────────────────

log "Sending one max_tokens=4 chat request..."
RESP_FILE=$(mktemp)
HTTP_CODE=$(curl -sS -o "${RESP_FILE}" -w '%{http_code}' \
  --max-time 60 \
  -X POST "http://localhost:${PROBE_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":4}" \
  2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  log_err "Chat request returned HTTP ${HTTP_CODE}"
  cat "${RESP_FILE}" | sed 's/^/[smoke-vllm] (body) /' || true
  rm -f "${RESP_FILE}"
  log_err "Exit 4: chat-request semantic failure (escalate to VLLM_QUANT_OVERRIDE=awq)"
  exit 4
fi

if ! jq -e '.choices[0].message.content | length > 0' "${RESP_FILE}" >/dev/null 2>&1; then
  log_err "Chat response had empty content"
  cat "${RESP_FILE}" | sed 's/^/[smoke-vllm] (body) /' || true
  rm -f "${RESP_FILE}"
  log_err "Exit 4: chat-request semantic failure (escalate to VLLM_QUANT_OVERRIDE=awq)"
  exit 4
fi

CONTENT=$(jq -r '.choices[0].message.content' "${RESP_FILE}")
log "✓ Chat OK. Response content: $(echo "${CONTENT}" | head -c 120)"
rm -f "${RESP_FILE}"

# ─── GPU process assertion ───────────────────────────────────────────────────

log "Checking nvidia-smi for vllm/python process..."
NVSMI_OUT=$(docker exec "${CONTAINER_NAME}" nvidia-smi \
  --query-compute-apps=pid,process_name,used_memory \
  --format=csv,noheader 2>/dev/null || true)
echo "${NVSMI_OUT}" | sed 's/^/[smoke-vllm] (nvidia-smi) /'

if ! echo "${NVSMI_OUT}" | grep -qE "(vllm|python|VLLM::EngineCore)"; then
  log_err "nvidia-smi shows NO vllm/python process consuming VRAM."
  log_err "Likely CPU fallback. Re-run with env-var fallback:"
  log_err "  VLLM_FLASH_ATTN_VERSION=2 VLLM_USE_TRITON_AWQ=1 bash bin/smoke-test-vllm-coldstart.sh"
  log_err "Exit 3: no GPU process detected"
  exit 3
fi
log "✓ vLLM process is consuming VRAM"

# ─── Done — print outcome label ──────────────────────────────────────────────

log ""
log "PASS — smoke succeeded end-to-end."
if [ "$RERUN_QUANT_FALLBACK" = "true" ]; then
  echo "OUTCOME: fallback-quant"
  log "Plan 07-01 must: swap --quantization=awq_marlin → --quantization=awq on the vllm service."
elif [ "$RERUN_ENV_FALLBACK" = "true" ]; then
  echo "OUTCOME: fallback-env"
  log "Plan 07-01 must: add VLLM_FLASH_ATTN_VERSION=2 + VLLM_USE_TRITON_AWQ=1 to vllm + vllm-embed env blocks."
else
  echo "OUTCOME: locked"
  log "Plan 07-01 uses the verbatim 07-RESEARCH §\"Validated Code Snippets\" vllm Compose block."
fi
log "Exit 0: PASS"
exit 0
