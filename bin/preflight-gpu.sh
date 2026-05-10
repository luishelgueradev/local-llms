#!/usr/bin/env bash
# bin/preflight-gpu.sh — GPU passthrough preflight for local-llms
#
# Asserts that GPU passthrough is FUNCTIONAL (a container can run nvidia-smi)
# before any GPU service starts. Runs 5 checks split into two kinds, and
# records driver state to:
#   ${HOST_DATA_ROOT}/.preflight-state.json
#
# Check kinds:
#   functional  — gates the exit code. The operational requirement is that
#                 a container can access the GPU. Failures here cause exit 1.
#   diagnostic  — recorded + displayed, but does NOT gate exit. Diagnostic
#                 failures help explain a failed functional check; on Docker
#                 Desktop on Windows / WSL2 the host-side toolkit artifacts
#                 (nvidia-ctk, /etc/docker/daemon.json) are intentionally
#                 absent yet GPU passthrough still works.
#
# Host-mode check matrix:
#   gpu_device           functional   /dev/dxg or /dev/nvidia* present
#   host_nvidia_smi      functional   nvidia-smi works on host
#   container_nvidia_smi functional   nvidia-smi works inside a container — authoritative
#   nvidia_ctk           diagnostic   nvidia-ctk binary present (advisory)
#   daemon_json          diagnostic   /etc/docker/daemon.json has nvidia runtime (advisory)
#
# Implements decisions:
#   D-05: 5 checks + record driver state (refined: functional vs diagnostic split)
#   D-06: pinned nvidia/cuda:12.6.0-base-ubuntu24.04 for the container nvidia-smi check
#   D-07: state file at ${HOST_DATA_ROOT}/.preflight-state.json (Phase 7 contract).
#         Schema gains `check_kinds` field alongside existing `checks`.
#
# Usage:
#   ./bin/preflight-gpu.sh          # default: print pass/fail per check + summary
#   ./bin/preflight-gpu.sh -q       # quiet: only print the summary line
#   ./bin/preflight-gpu.sh -v       # verbose: print check command + its output
#
# Exit codes:
#   0 — all functional checks passed (diagnostic failures are non-gating)
#   1 — one or more functional checks failed
#
# Forbidden: this script NEVER installs anything, modifies daemon.json, or changes .env.
# It is READ-ONLY verification. No --fix flag, no remediation.

# NOTE: do NOT use `set -e` — we want to run all checks even if early ones fail,
# so the state file records the full picture. Track failures via a counter.
set -uo pipefail

# ─── Constants ───────────────────────────────────────────────────────────────

PINNED_CUDA_IMAGE="nvidia/cuda:12.6.0-base-ubuntu24.04"

# ─── CLI flags ───────────────────────────────────────────────────────────────

QUIET=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    -q|--quiet)   QUIET=true ;;
    -v|--verbose) VERBOSE=true ;;
    -h|--help)
      echo "Usage: $0 [-q|--quiet] [-v|--verbose]"
      echo "  -q  Only print the final summary line"
      echo "  -v  Print each check command and its raw output"
      exit 0
      ;;
    *)
      echo "[preflight] Unknown flag: $arg" >&2
      echo "Usage: $0 [-q|--quiet] [-v|--verbose]" >&2
      exit 1
      ;;
  esac
done

# ─── Logging helpers ─────────────────────────────────────────────────────────

log() {
  if [ "$QUIET" = "false" ]; then
    echo "[preflight] $*"
  fi
}

log_verbose() {
  if [ "$VERBOSE" = "true" ]; then
    echo "[preflight][verbose] $*"
  fi
}

log_always() {
  echo "[preflight] $*"
}

# ─── Resolve SCRIPT_DIR + REPO_ROOT ──────────────────────────────────────────

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── Read HOST_DATA_ROOT from .env, default to /srv/local-llms ───────────────
# Priority: .env file > environment variable > compiled-in default.
# In a real deployment, .env is always present (set by bin/bootstrap-host.sh).

HOST_DATA_ROOT="/srv/local-llms"

# Honor HOST_DATA_ROOT from the calling environment as a base (Compose override)
if [ -n "${HOST_DATA_ROOT:-}" ]; then
  : # keep the caller's value
fi

# .env file overrides the environment (it is the canonical deployment config)
if [ -f "${REPO_ROOT}/.env" ]; then
  # Extract HOST_DATA_ROOT ignoring comments and blank lines
  _val=$(grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$_val" ]; then
    HOST_DATA_ROOT="$_val"
  fi
fi

STATE_FILE="${HOST_DATA_ROOT}/.preflight-state.json"

# ─── Detect run mode: host vs in-container ───────────────────────────────────

IN_CONTAINER=false
if [ -e "/.dockerenv" ]; then
  IN_CONTAINER=true
fi

# ─── Check implementations ───────────────────────────────────────────────────

# Check 1 — /dev/dxg (WSL2) OR /dev/nvidia* (native Linux) exists
check_gpu_device() {
  log_verbose "Checking GPU device node (/dev/dxg or /dev/nvidia*)..."
  if [ -e /dev/dxg ]; then
    log_verbose "  Found /dev/dxg (WSL2 GPU paravirtualization device)"
    return 0
  fi
  if ls /dev/nvidia* >/dev/null 2>&1; then
    log_verbose "  Found /dev/nvidia* (native Linux GPU device)"
    return 0
  fi
  return 1
}

# Check 2 — host nvidia-smi works and reports a GPU
check_host_nvidia_smi() {
  log_verbose "Checking host nvidia-smi..."
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  local gpu_name
  gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  log_verbose "  GPU reported: ${gpu_name:-<none>}"
  echo "$gpu_name" | grep -q '.' || return 1
  return 0
}

# Check 3 — container nvidia-smi works (proves NVIDIA Container Toolkit is functional)
# MUST use the pinned nvidia/cuda:12.6.0-base-ubuntu24.04 image (D-06)
check_container_nvidia_smi() {
  log_verbose "Checking container nvidia-smi using pinned image ${PINNED_CUDA_IMAGE}..."
  command -v docker >/dev/null 2>&1 || return 1
  local output
  output=$(docker run --rm --gpus all "${PINNED_CUDA_IMAGE}" nvidia-smi 2>/dev/null)
  log_verbose "  Container nvidia-smi output (first line): $(echo "$output" | head -1)"
  echo "$output" | grep -q 'NVIDIA-SMI' || return 1
  return 0
}

# Check 4 — nvidia-ctk --version works
check_nvidia_ctk() {
  log_verbose "Checking nvidia-ctk --version..."
  command -v nvidia-ctk >/dev/null 2>&1 || return 1
  local ver
  ver=$(nvidia-ctk --version 2>/dev/null | head -1)
  log_verbose "  nvidia-ctk version: ${ver:-<empty>}"
  echo "$ver" | grep -qiE 'version|nvidia-ctk' || return 1
  return 0
}

# Check 5 — /etc/docker/daemon.json has the nvidia runtime entry
check_daemon_json() {
  local f=/etc/docker/daemon.json
  log_verbose "Checking ${f} for nvidia runtime entry..."
  [ -f "$f" ] || return 1
  # The runtime entry is registered by: nvidia-ctk runtime configure --runtime=docker
  # Look for a "nvidia" key inside a "runtimes" object.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
  d = json.load(open('$f'))
  sys.exit(0 if 'nvidia' in (d.get('runtimes') or {}) else 1)
except Exception:
  sys.exit(1)
" 2>/dev/null && return 0
  fi
  # Fallback to grep if python3 is not available
  grep -qE '"nvidia"\s*:' "$f" && return 0
  return 1
}

# ─── Remediation hints (printed on failure) ──────────────────────────────────

remediation_hint() {
  local check="$1"
  case "$check" in
    gpu_device)
      log_always "  HINT [gpu_device]: On WSL2, ensure the Windows-side NVIDIA driver is installed."
      log_always "  HINT [gpu_device]: NEVER install a Linux NVIDIA driver inside the WSL distro."
      ;;
    host_nvidia_smi)
      log_always "  HINT [host_nvidia_smi]: Install / verify the host NVIDIA driver."
      log_always "  HINT [host_nvidia_smi]: On WSL2, this is on Windows (not inside the WSL distro)."
      ;;
    container_nvidia_smi)
      log_always "  HINT [container_nvidia_smi]: Install NVIDIA Container Toolkit, then register the nvidia"
      log_always "  HINT [container_nvidia_smi]: runtime with Docker and restart the Docker daemon."
      log_always "  HINT [container_nvidia_smi]: See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      ;;
    nvidia_ctk)
      log_always "  HINT [nvidia_ctk]: Install the nvidia-container-toolkit package."
      log_always "  HINT [nvidia_ctk]: See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      ;;
    daemon_json)
      log_always "  HINT [daemon_json]: Register the nvidia runtime with Docker and restart the Docker daemon."
      log_always "  HINT [daemon_json]: Run: nvidia-ctk runtime configure, then restart Docker."
      log_always "  HINT [daemon_json]: See: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      ;;
  esac
}

# ─── Capture driver state (defensive — never abort if a tool is absent) ──────

capture_host_driver_version() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1
  fi
}

capture_cuda_version() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    # Try structured query first
    local v
    v=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
    # Extract CUDA Version from the table header section
    nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' | head -1 | awk '{print $3}'
  fi
}

capture_nvidia_ctk_version() {
  if command -v nvidia-ctk >/dev/null 2>&1; then
    nvidia-ctk --version 2>/dev/null | head -1
  fi
}

capture_wsl2() {
  if [ -f /proc/version ] && grep -qiE 'microsoft|WSL' /proc/version 2>/dev/null; then
    echo "true"
  else
    echo "false"
  fi
}

# ─── Main execution ──────────────────────────────────────────────────────────

log ""
log "GPU Passthrough Preflight — local-llms"
log "======================================="

if [ "$IN_CONTAINER" = "true" ]; then
  log "Mode: in-container (skipping host-only checks)"
else
  log "Mode: host"
fi

log ""

# Arrays to track check names, results, and kinds.
# kind=functional → counted toward exit gate (operational requirement).
# kind=diagnostic → recorded + displayed, NOT counted toward exit gate.
#                   Diagnostic failures help explain a failed functional
#                   check; on Docker Desktop on Windows / WSL2 the host-side
#                   nvidia-ctk and /etc/docker/daemon.json are intentionally
#                   absent (Docker Desktop handles GPU passthrough), yet the
#                   functional checks (container_nvidia_smi) still pass.
declare -a CHECK_NAMES=()
declare -a CHECK_RESULTS=()
declare -a CHECK_KINDS=()

FAILED_COUNT=0          # functional failures only — gates exit
DIAG_FAILED_COUNT=0     # diagnostic failures — informational
FAILED_CHECKS=()        # functional fails (gets remediation hints)
DIAG_FAILED_CHECKS=()   # diagnostic fails (informational note only)

run_check() {
  local name="$1"
  local fn="$2"
  local kind="${3:-functional}"   # functional|diagnostic
  local skipped="${4:-false}"

  if [ "$skipped" = "true" ]; then
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("skipped")
    CHECK_KINDS+=("$kind")
    log "  $(printf '%-30s' "$name") SKIP"
    return
  fi

  if "$fn"; then
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("pass")
    CHECK_KINDS+=("$kind")
    log "  $(printf '%-30s' "$name") PASS"
  else
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("fail")
    CHECK_KINDS+=("$kind")
    if [ "$kind" = "functional" ]; then
      log "  $(printf '%-30s' "$name") FAIL"
      FAILED_COUNT=$((FAILED_COUNT + 1))
      FAILED_CHECKS+=("$name")
    else
      # diagnostic — print as INFO so output is not alarming when GPU is OK
      log "  $(printf '%-30s' "$name") INFO (diagnostic, not gating)"
      DIAG_FAILED_COUNT=$((DIAG_FAILED_COUNT + 1))
      DIAG_FAILED_CHECKS+=("$name")
    fi
  fi
}

log "Check                          Result"
log "--------------------------------------"

if [ "$IN_CONTAINER" = "true" ]; then
  # In-container: only the GPU device node + container nvidia-smi are meaningful.
  run_check "gpu_device"            check_gpu_device           functional
  run_check "host_nvidia_smi"       check_host_nvidia_smi      functional   true   # skipped
  run_check "container_nvidia_smi"  check_host_nvidia_smi      functional          # in-container, use nvidia-smi directly
  run_check "nvidia_ctk"            check_nvidia_ctk           diagnostic   true   # skipped
  run_check "daemon_json"           check_daemon_json          diagnostic   true   # skipped
else
  # Host: 3 functional checks (gate exit) + 2 diagnostic checks (advisory).
  # The diagnostic pair is intentionally non-gating: Docker Desktop on
  # Windows + WSL2 has neither nvidia-ctk nor /etc/docker/daemon.json yet
  # exposes the GPU into containers correctly. The functional check
  # `container_nvidia_smi` is the authoritative test — if it passes, GPU
  # passthrough works regardless of how the toolkit got configured.
  run_check "gpu_device"            check_gpu_device           functional
  run_check "host_nvidia_smi"       check_host_nvidia_smi      functional
  run_check "container_nvidia_smi"  check_container_nvidia_smi functional
  run_check "nvidia_ctk"            check_nvidia_ctk           diagnostic
  run_check "daemon_json"           check_daemon_json          diagnostic
fi

log ""

# ─── Remediation hints (only for functional failures) ────────────────────────

if [ "${#FAILED_CHECKS[@]}" -gt 0 ]; then
  log "Failed checks — remediation hints:"
  for fc in "${FAILED_CHECKS[@]}"; do
    remediation_hint "$fc"
  done
  log ""
fi

# ─── Diagnostic-only failures: brief informational note ──────────────────────
# Only fires when functional checks all passed but the host-side toolkit
# artifacts are missing (typical Docker Desktop on WSL2 layout).

if [ "${#FAILED_CHECKS[@]}" -eq 0 ] && [ "${#DIAG_FAILED_CHECKS[@]}" -gt 0 ]; then
  log "Diagnostic-only failures (GPU passthrough is FUNCTIONAL):"
  for fc in "${DIAG_FAILED_CHECKS[@]}"; do
    log "  INFO [$fc]: not present, but container GPU access works — this is normal on Docker Desktop / WSL2."
  done
  log ""
fi

# ─── Capture driver state for state file ─────────────────────────────────────

if [ "$IN_CONTAINER" = "true" ]; then
  HOST_DRIVER_VERSION="in-container"
  CUDA_VERSION="in-container"
  NVIDIA_CTK_VERSION="in-container"
  HOST_KERNEL=$(uname -r 2>/dev/null || echo "unknown")
  WSL2=$(capture_wsl2)
else
  HOST_DRIVER_VERSION=$(capture_host_driver_version)
  HOST_DRIVER_VERSION="${HOST_DRIVER_VERSION:-null}"
  CUDA_VERSION=$(capture_cuda_version)
  CUDA_VERSION="${CUDA_VERSION:-null}"
  NVIDIA_CTK_VERSION=$(capture_nvidia_ctk_version)
  NVIDIA_CTK_VERSION="${NVIDIA_CTK_VERSION:-null}"
  HOST_KERNEL=$(uname -r 2>/dev/null || echo "unknown")
  WSL2=$(capture_wsl2)
fi

LAST_RUN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Determine overall passed status
if [ "$FAILED_COUNT" -eq 0 ]; then
  PASSED="true"
else
  PASSED="false"
fi

# ─── Build checks JSON object (one key per check) ────────────────────────────

build_checks_json() {
  # Output the checks as a JSON object using the CHECK_NAMES / CHECK_RESULTS arrays
  local json="{"
  local first=true
  for i in "${!CHECK_NAMES[@]}"; do
    if [ "$first" = "true" ]; then
      first=false
    else
      json="${json},"
    fi
    local name="${CHECK_NAMES[$i]}"
    local result="${CHECK_RESULTS[$i]}"
    json="${json}\"${name}\": \"${result}\""
  done
  json="${json}}"
  echo "$json"
}

build_check_kinds_json() {
  # Output check kinds as a JSON object: { "name": "functional|diagnostic" }
  local json="{"
  local first=true
  for i in "${!CHECK_NAMES[@]}"; do
    if [ "$first" = "true" ]; then
      first=false
    else
      json="${json},"
    fi
    local name="${CHECK_NAMES[$i]}"
    local kind="${CHECK_KINDS[$i]}"
    json="${json}\"${name}\": \"${kind}\""
  done
  json="${json}}"
  echo "$json"
}

# ─── Write state file atomically (temp + mv) (D-07) ─────────────────────────

# Ensure the directory exists (bootstrap-host.sh creates it, but be defensive)
if ! mkdir -p "${HOST_DATA_ROOT}" 2>/dev/null; then
  log_always "WARNING: Cannot create ${HOST_DATA_ROOT} — state file will not be written."
  log_always "         Run bin/bootstrap-host.sh first, or create the directory manually."
else
  CHECKS_JSON=$(build_checks_json)
  CHECK_KINDS_JSON=$(build_check_kinds_json)

  TMPFILE="${STATE_FILE}.tmp.$$"

  if command -v python3 >/dev/null 2>&1; then
    # Pass all values via environment variables to avoid bash→Python interpolation pitfalls.
    # Python reads from os.environ; bash values that are "null" or "" → JSON null.
    _PREFLIGHT_LAST_RUN_AT="${LAST_RUN_AT}" \
    _PREFLIGHT_HOST_DRIVER_VERSION="${HOST_DRIVER_VERSION}" \
    _PREFLIGHT_CUDA_VERSION="${CUDA_VERSION}" \
    _PREFLIGHT_NVIDIA_CTK_VERSION="${NVIDIA_CTK_VERSION}" \
    _PREFLIGHT_HOST_KERNEL="${HOST_KERNEL}" \
    _PREFLIGHT_WSL2="${WSL2}" \
    _PREFLIGHT_CHECKS_JSON="${CHECKS_JSON}" \
    _PREFLIGHT_CHECK_KINDS_JSON="${CHECK_KINDS_JSON}" \
    _PREFLIGHT_PASSED="${PASSED}" \
    _PREFLIGHT_TMPFILE="${TMPFILE}" \
    python3 - <<'PYEOF'
import json, os, sys

def env_or_null(key):
    """Return env var value as string, or None if value is 'null' or empty."""
    v = os.environ.get(key, "")
    if v in ("null", ""):
        return None
    return v

state = {
    "schema_version": 1,
    "last_run_at": os.environ.get("_PREFLIGHT_LAST_RUN_AT", ""),
    "host_driver_version": env_or_null("_PREFLIGHT_HOST_DRIVER_VERSION"),
    "cuda_version": env_or_null("_PREFLIGHT_CUDA_VERSION"),
    "nvidia_ctk_version": env_or_null("_PREFLIGHT_NVIDIA_CTK_VERSION"),
    "host_kernel": os.environ.get("_PREFLIGHT_HOST_KERNEL", "unknown"),
    "wsl2": os.environ.get("_PREFLIGHT_WSL2", "false") == "true",
    "checks": json.loads(os.environ.get("_PREFLIGHT_CHECKS_JSON", "{}")),
    "check_kinds": json.loads(os.environ.get("_PREFLIGHT_CHECK_KINDS_JSON", "{}")),
    "passed": os.environ.get("_PREFLIGHT_PASSED", "false") == "true",
}

tmpfile = os.environ.get("_PREFLIGHT_TMPFILE", "")
with open(tmpfile, "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")

sys.exit(0)
PYEOF
    PY_EXIT=$?
    if [ "$PY_EXIT" -eq 0 ]; then
      mv "${TMPFILE}" "${STATE_FILE}"
      log "State written to ${STATE_FILE}"
    else
      log_always "WARNING: python3 failed to write state file (exit ${PY_EXIT})"
      rm -f "${TMPFILE}"
    fi
  else
    # Fallback: hand-build JSON via printf (no awk/sed construction — fragile avoided)
    # Only reached if python3 is absent (very unusual on Ubuntu/WSL2)
    _hd="${HOST_DRIVER_VERSION}"
    _cv="${CUDA_VERSION}"
    _nv="${NVIDIA_CTK_VERSION}"

    _hd_json="null"
    _cv_json="null"
    _nv_json="null"
    [ "$_hd" != "null" ] && [ -n "$_hd" ] && _hd_json="\"${_hd}\""
    [ "$_cv" != "null" ] && [ -n "$_cv" ] && _cv_json="\"${_cv}\""
    [ "$_nv" != "null" ] && [ -n "$_nv" ] && _nv_json="\"${_nv}\""

    # Build checks lines
    CHECKS_LINES=""
    for i in "${!CHECK_NAMES[@]}"; do
      [ -n "$CHECKS_LINES" ] && CHECKS_LINES="${CHECKS_LINES},"$'\n'
      CHECKS_LINES="${CHECKS_LINES}    \"${CHECK_NAMES[$i]}\": \"${CHECK_RESULTS[$i]}\""
    done
    KINDS_LINES=""
    for i in "${!CHECK_NAMES[@]}"; do
      [ -n "$KINDS_LINES" ] && KINDS_LINES="${KINDS_LINES},"$'\n'
      KINDS_LINES="${KINDS_LINES}    \"${CHECK_NAMES[$i]}\": \"${CHECK_KINDS[$i]}\""
    done

    printf '{
  "schema_version": 1,
  "last_run_at": "%s",
  "host_driver_version": %s,
  "cuda_version": %s,
  "nvidia_ctk_version": %s,
  "host_kernel": "%s",
  "wsl2": %s,
  "checks": {
%s
  },
  "check_kinds": {
%s
  },
  "passed": %s
}
' \
      "${LAST_RUN_AT}" \
      "${_hd_json}" \
      "${_cv_json}" \
      "${_nv_json}" \
      "${HOST_KERNEL}" \
      "${WSL2}" \
      "${CHECKS_LINES}" \
      "${KINDS_LINES}" \
      "${PASSED}" > "${TMPFILE}"

    mv "${TMPFILE}" "${STATE_FILE}"
    log "State written to ${STATE_FILE}"
  fi
fi

# ─── Final summary ───────────────────────────────────────────────────────────

log ""
if [ "$FAILED_COUNT" -eq 0 ]; then
  if [ "${DIAG_FAILED_COUNT:-0}" -eq 0 ]; then
    log_always "All checks passed. State written to ${STATE_FILE}"
  else
    log_always "All functional checks passed (${DIAG_FAILED_COUNT} diagnostic check(s) absent — typical for Docker Desktop / WSL2)."
    log_always "State written to ${STATE_FILE}"
  fi
  exit 0
else
  log_always "${FAILED_COUNT} functional check(s) FAILED. Fix the issues above and re-run this script."
  log_always "State (with failure details) written to ${STATE_FILE}"
  exit 1
fi
