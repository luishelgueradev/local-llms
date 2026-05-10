#!/usr/bin/env bash
# bin/preflight-gpu.sh — GPU passthrough preflight for local-llms
#
# Asserts that NVIDIA Container Toolkit is correctly configured on this host (WSL2 or native Linux)
# before any GPU service starts. Runs 5 checks, records driver state to:
#   ${HOST_DATA_ROOT}/.preflight-state.json
#
# Implements decisions:
#   D-05: 5 checks + record driver state
#   D-06: pinned nvidia/cuda:12.6.0-base-ubuntu24.04 for the container nvidia-smi check
#   D-07: state file at ${HOST_DATA_ROOT}/.preflight-state.json (Phase 7 contract)
#
# Usage:
#   ./bin/preflight-gpu.sh          # default: print pass/fail per check + summary
#   ./bin/preflight-gpu.sh -q       # quiet: only print the summary line
#   ./bin/preflight-gpu.sh -v       # verbose: print check command + its output
#
# Exit codes:
#   0 — all non-skipped checks passed
#   1 — one or more checks failed
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

# Arrays to track check names and results
declare -a CHECK_NAMES=()
declare -a CHECK_RESULTS=()

FAILED_COUNT=0
FAILED_CHECKS=()

run_check() {
  local name="$1"
  local fn="$2"
  local skipped="${3:-false}"

  if [ "$skipped" = "true" ]; then
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("skipped")
    log "  $(printf '%-30s' "$name") SKIP"
    return
  fi

  if "$fn"; then
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("pass")
    log "  $(printf '%-30s' "$name") PASS"
  else
    CHECK_NAMES+=("$name")
    CHECK_RESULTS+=("fail")
    log "  $(printf '%-30s' "$name") FAIL"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    FAILED_CHECKS+=("$name")
  fi
}

log "Check                          Result"
log "--------------------------------------"

if [ "$IN_CONTAINER" = "true" ]; then
  # In-container: only check GPU device node + container nvidia-smi (which is just regular nvidia-smi here)
  run_check "gpu_device"            check_gpu_device
  run_check "host_nvidia_smi"       check_host_nvidia_smi  "true"   # skipped in-container
  run_check "container_nvidia_smi"  check_host_nvidia_smi          # in-container, use nvidia-smi directly
  run_check "nvidia_ctk"            check_nvidia_ctk       "true"   # skipped in-container
  run_check "daemon_json"           check_daemon_json      "true"   # skipped in-container
else
  # Host: run all 5 checks
  run_check "gpu_device"            check_gpu_device
  run_check "host_nvidia_smi"       check_host_nvidia_smi
  run_check "container_nvidia_smi"  check_container_nvidia_smi
  run_check "nvidia_ctk"            check_nvidia_ctk
  run_check "daemon_json"           check_daemon_json
fi

log ""

# ─── Print remediation hints for failed checks ───────────────────────────────

if [ "${#FAILED_CHECKS[@]}" -gt 0 ]; then
  log "Failed checks — remediation hints:"
  for fc in "${FAILED_CHECKS[@]}"; do
    remediation_hint "$fc"
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

# ─── Write state file atomically (temp + mv) (D-07) ─────────────────────────

# Ensure the directory exists (bootstrap-host.sh creates it, but be defensive)
if ! mkdir -p "${HOST_DATA_ROOT}" 2>/dev/null; then
  log_always "WARNING: Cannot create ${HOST_DATA_ROOT} — state file will not be written."
  log_always "         Run bin/bootstrap-host.sh first, or create the directory manually."
else
  CHECKS_JSON=$(build_checks_json)

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
      "${PASSED}" > "${TMPFILE}"

    mv "${TMPFILE}" "${STATE_FILE}"
    log "State written to ${STATE_FILE}"
  fi
fi

# ─── Final summary ───────────────────────────────────────────────────────────

log ""
if [ "$FAILED_COUNT" -eq 0 ]; then
  log_always "All checks passed. State written to ${STATE_FILE}"
  exit 0
else
  log_always "${FAILED_COUNT} check(s) FAILED. Fix the issues above and re-run this script."
  log_always "State (with failure details) written to ${STATE_FILE}"
  exit 1
fi
