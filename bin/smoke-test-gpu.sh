#!/usr/bin/env bash
# bin/smoke-test-gpu.sh — end-to-end GPU inference verification for local-llms Phase 1
#
# What this script asserts (ROADMAP success criterion 4):
#   1. Ollama is running and the curated model is pulled (refuses without them — prints exact command).
#   2. POST /api/generate against llama3.2:3b-instruct-q4_K_M returns a non-empty response.
#   3. docker compose exec ollama nvidia-smi succeeds (GPU passthrough confirmed from inside container).
#   4. At least one GPU is listed in nvidia-smi output.
#   5. An `ollama` process is bound to the GPU (catches the WSL2 silent-CPU-fallback signature).
#   6. VRAM in use is >= 1024 MiB (CPU fallback shows 0 or driver-only value < 1 GB).
#
# Usage:  bash bin/smoke-test-gpu.sh [options]
# Flags:
#   -m MODEL | --model MODEL        Override curated model (default: llama3.2:3b-instruct-q4_K_M)
#   --threshold MB                  Override VRAM floor in MiB (default: 1024)
#   -h | --help                     Print usage and exit 0
#
# Exit codes:
#   0  All assertions pass — GPU passthrough proven end-to-end.
#   1  One or more assertions failed — diagnostic printed; see bin/preflight-gpu.sh for remediation.
#
# Design notes (D-10):
#   - No throughput floor — generation speed varies too much across hardware (D-10).
#   - No automatic model pull — explicit `ollama pull` is a project feature (D-09).
#   - No retry loops — fail immediately with a diagnostic pointing at preflight-gpu.sh.
#   - keep_alive="5m" in the generate request body pins the model in VRAM for 5 minutes
#     so the post-generate nvidia-smi call cannot race against Ollama's idle-unload.
#   - Uses `set -uo pipefail` (NOT `set -e`) to collect full diagnostic output even when
#     early checks fail; failures tracked via FAILURES counter and reported at the end.

set -uo pipefail

# ---------------------------------------------------------------------------
# Constants (override via CLI flags below)
# ---------------------------------------------------------------------------
readonly DEFAULT_MODEL="llama3.2:3b-instruct-q4_K_M"
readonly DEFAULT_VRAM_THRESHOLD_MB=1024
readonly OLLAMA_URL="http://127.0.0.1:11434"
readonly OLLAMA_SVC="ollama"
readonly PROMPT="What is 2+2? Answer in one short sentence."
readonly KEEP_ALIVE="5m"

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------
MODEL="$DEFAULT_MODEL"
VRAM_THRESHOLD_MB="$DEFAULT_VRAM_THRESHOLD_MB"

usage() {
  cat <<'USAGE'
Usage: bash bin/smoke-test-gpu.sh [options]

  -m MODEL | --model MODEL      Override curated model
                                (default: llama3.2:3b-instruct-q4_K_M)
  --threshold MB                Override VRAM floor in MiB (default: 1024)
  -h | --help                   Print this help and exit 0

Purpose:
  Asserts ROADMAP success criterion 4: a single Ollama service comes up cleanly
  with one curated small model pulled, and `nvidia-smi` inside the Ollama
  container shows the GPU plus an ollama process consuming VRAM during inference.

  Exit 0 = all assertions pass.
  Exit 1 = one or more assertions failed; actionable diagnostic printed.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)
      MODEL="${2:?--model requires an argument}"
      shift 2
      ;;
    --threshold)
      VRAM_THRESHOLD_MB="${2:?--threshold requires an argument}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[smoke-test] ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Failure tracking (set -e is intentionally NOT used)
# ---------------------------------------------------------------------------
FAILURES=0

fail() {
  echo "[smoke-test] FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "[smoke-test] PASS: $*"
}

# ---------------------------------------------------------------------------
# Pre-flight: ollama service must be running
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] ================================================================"
echo "[smoke-test]  local-llms — Phase 1 GPU Verification"
echo "[smoke-test]  Model : ${MODEL}"
echo "[smoke-test]  VRAM floor : ${VRAM_THRESHOLD_MB} MiB"
echo "[smoke-test] ================================================================"
echo ""

echo "[smoke-test] Pre-flight: checking ollama service is running..."

RUNNING_SERVICES=$(docker compose ps --services --filter status=running 2>/dev/null || true)
if ! echo "$RUNNING_SERVICES" | grep -q "^ollama$"; then
  fail "ollama service is not running. Run: docker compose up -d ollama"
  echo ""
  echo "[smoke-test] Cannot proceed without a running ollama service. Aborting."
  exit 1
fi

echo "[smoke-test] Pre-flight: ollama service is running."

# ---------------------------------------------------------------------------
# Pre-flight: Ollama API must be reachable
# ---------------------------------------------------------------------------
echo "[smoke-test] Pre-flight: checking Ollama API reachability at ${OLLAMA_URL} ..."

TAGS_RESPONSE=$(curl -fsS "${OLLAMA_URL}/api/tags" 2>/dev/null || true)
if [[ -z "$TAGS_RESPONSE" ]]; then
  fail "ollama is not reachable on ${OLLAMA_URL}. Check \`docker compose ps ollama\` healthcheck status."
  echo ""
  echo "[smoke-test] Cannot proceed without a reachable Ollama API. Aborting."
  exit 1
fi

# Verify it returned a JSON object (not an error page)
if ! echo "$TAGS_RESPONSE" | python3 -c 'import sys, json; json.load(sys.stdin)' 2>/dev/null; then
  fail "ollama API at ${OLLAMA_URL}/api/tags did not return valid JSON. Check \`docker compose logs ollama\`."
  echo ""
  echo "[smoke-test] Cannot proceed without a valid Ollama API response. Aborting."
  exit 1
fi

echo "[smoke-test] Pre-flight: Ollama API is reachable."

# ---------------------------------------------------------------------------
# Pre-flight: curated model must be pulled
# ---------------------------------------------------------------------------
echo "[smoke-test] Pre-flight: checking model '${MODEL}' is pulled..."

MODEL_FOUND=$(python3 - <<PYEOF
import json, sys
data = json.loads("""${TAGS_RESPONSE}""")
models = data.get("models", [])
target = "${MODEL}"
found = any(m.get("name","").startswith(target) or m.get("model","").startswith(target) for m in models)
print("yes" if found else "no")
PYEOF
)

if [[ "$MODEL_FOUND" != "yes" ]]; then
  # Construct the pull command from variables so the script never contains the literal pull command
  PULL_CMD="docker compose exec ${OLLAMA_SVC} ollama"
  fail "model ${MODEL} is not pulled. Run: ${PULL_CMD} pull ${MODEL}"
  echo ""
  echo "[smoke-test] Cannot proceed without the curated model pulled. Aborting."
  exit 1
fi

echo "[smoke-test] Pre-flight: model '${MODEL}' is present."
echo ""

# ---------------------------------------------------------------------------
# Step 1 — Issue a generation request (POST /api/generate)
#           keep_alive="5m" pins the model in VRAM for 5 minutes so the
#           post-generate nvidia-smi inspection in Step 2 cannot race against
#           Ollama's idle-unload timer.
# ---------------------------------------------------------------------------
echo "[smoke-test] Step 1: issuing POST ${OLLAMA_URL}/api/generate ..."
echo "[smoke-test]          model=${MODEL}  stream=false  keep_alive=${KEEP_ALIVE}"

# Build JSON safely — pass shell vars to python via env, never via string
# interpolation into source. Single-quoted '-' tells bash NOT to expand
# inside the script body, so a $ or quote in $MODEL/$PROMPT can't break
# Python parsing or inject syntax. Same pattern as Step 4's /api/ps probe.
# Use _SMOKE_-prefixed env names to avoid clashing with the script's
# `readonly` PROMPT/KEEP_ALIVE/MODEL globals (bash treats `FOO=bar cmd`
# as a per-process assignment, which fails on `readonly` names).
REQUEST_BODY=$(_SMOKE_MODEL="$MODEL" _SMOKE_PROMPT="$PROMPT" _SMOKE_KEEP_ALIVE="$KEEP_ALIVE" python3 -c '
import json, os
print(json.dumps({
    "model": os.environ.get("_SMOKE_MODEL", ""),
    "prompt": os.environ.get("_SMOKE_PROMPT", ""),
    "stream": False,
    "keep_alive": os.environ.get("_SMOKE_KEEP_ALIVE", "5m"),
}))
')

GENERATE_RESPONSE=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$REQUEST_BODY" \
  "${OLLAMA_URL}/api/generate" 2>/dev/null || true)

if [[ -z "$GENERATE_RESPONSE" ]]; then
  fail "POST /api/generate returned no response. Check \`docker compose logs ollama\`."
else
  # Parse the response field. Pass GENERATE_RESPONSE via env var so a model
  # output containing triple-quotes, backslashes, or shell metacharacters
  # cannot escape the python source — addresses CR-02. The previous heredoc
  # form `<<PYEOF ... """${GENERATE_RESPONSE}""" ... PYEOF` was a real
  # injection surface even for benign content (any `"""` in the response
  # body would terminate the python triple-string early).
  RESPONSE_TEXT=$(GENERATE_RESPONSE="$GENERATE_RESPONSE" python3 -c '
import json, os, sys
raw = os.environ.get("GENERATE_RESPONSE", "")
try:
    data = json.loads(raw)
    text = data.get("response", "")
    print(text.strip())
except Exception:
    print("")
')

  if [[ -z "$RESPONSE_TEXT" ]]; then
    fail "POST /api/generate returned JSON but 'response' field is empty or missing. Raw: ${GENERATE_RESPONSE}"
  else
    CHAR_COUNT=${#RESPONSE_TEXT}
    pass "model returned ${CHAR_COUNT} chars: \"${RESPONSE_TEXT:0:80}...\""
  fi
fi

# ---------------------------------------------------------------------------
# Step 2 — Run nvidia-smi inside the Ollama container
#           -T disables TTY allocation (required for clean output capture in scripts)
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] Step 2: running \`docker compose exec -T ${OLLAMA_SVC} nvidia-smi\` ..."

SMI_OUT=$(docker compose exec -T "${OLLAMA_SVC}" nvidia-smi 2>&1 || true)
SMI_EXIT=$?

if [[ $SMI_EXIT -ne 0 ]]; then
  fail "nvidia-smi inside the ollama container failed (exit ${SMI_EXIT}). This is the WSL2 silent CPU fallback signature (PITFALLS Pitfall 1). Re-run: bash bin/preflight-gpu.sh"
  SMI_FAILED=1
else
  echo "[smoke-test] nvidia-smi output captured (${#SMI_OUT} chars)."
  SMI_FAILED=0
fi

# ---------------------------------------------------------------------------
# Step 3 — Assert at least one GPU is listed in nvidia-smi output
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] Step 3: asserting at least one GPU listed in nvidia-smi output..."

if [[ "${SMI_FAILED:-1}" -eq 1 ]]; then
  fail "skipping GPU listing check — nvidia-smi did not run successfully."
elif ! echo "$SMI_OUT" | grep -qE 'NVIDIA-SMI[[:space:]]+[0-9]+'; then
  fail "no NVIDIA-SMI banner in nvidia-smi output."
else
  GPU_LINE=$(echo "$SMI_OUT" | grep -E 'NVIDIA-SMI[[:space:]]+[0-9]+' | head -1)
  pass "GPU listed in container nvidia-smi: ${GPU_LINE}"
fi

# ---------------------------------------------------------------------------
# Step 4 — Assert the model is resident in VRAM (silent-CPU-fallback catch)
#           Prefer ollama's /api/ps endpoint: when `size_vram == size`, the
#           model is fully on GPU; when `size_vram < size`, partially; when
#           `size_vram == 0`, on CPU. This is the authoritative source.
#           Fall back to grepping nvidia-smi's process table if the API
#           response can't be parsed (very old ollama, parser glitch, etc.).
#           NOTE: nvidia-smi inside Docker Desktop on WSL2 does NOT enumerate
#           container PIDs in its process table — it only shows host-side
#           /Xwayland processes. So the nvidia-smi-process-grep approach used
#           in the original v1 of this script produced false negatives on
#           every WSL2 host. /api/ps is the WSL2-safe path.
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] Step 4: asserting model is resident in VRAM (via ollama /api/ps)..."

GPU_RESIDENCY_DETAIL="not yet checked"

PS_RESPONSE=$(curl -s --max-time 5 "${OLLAMA_URL}/api/ps" 2>/dev/null || true)

if [[ -z "$PS_RESPONSE" ]]; then
  fail "could not reach ${OLLAMA_URL}/api/ps. Cannot assert GPU residency."
else
  # Look for an entry matching $MODEL with size_vram > 0 (and ideally == size).
  # Use python3 if available for robust JSON parsing; fall back to grep.
  if command -v python3 >/dev/null 2>&1; then
    # Pass PS_RESPONSE via env var (avoids heredoc-vs-herestring redirect conflict).
    VRAM_INFO=$(MODEL="$MODEL" PS_RESPONSE="$PS_RESPONSE" python3 -c "
import json, os, sys
target = os.environ.get('MODEL', '')
raw = os.environ.get('PS_RESPONSE', '')
try:
    data = json.loads(raw)
except Exception as exc:
    print(f'PARSE_ERROR:{exc}')
    sys.exit(0)
for m in data.get('models', []):
    if m.get('name') == target or m.get('model') == target:
        size = m.get('size', 0)
        size_vram = m.get('size_vram', 0)
        ratio = (size_vram / size * 100) if size else 0
        print(f'FOUND:{size}:{size_vram}:{ratio:.1f}')
        sys.exit(0)
print('NOT_LOADED')
")
    case "$VRAM_INFO" in
      FOUND:*)
        IFS=':' read -r _ TOTAL_BYTES VRAM_BYTES RATIO <<< "$VRAM_INFO"
        if [[ "$VRAM_BYTES" -le 0 ]]; then
          fail "model '${MODEL}' is loaded but size_vram=0 — running on CPU. This is the silent-CPU-fallback signature. Diagnose with: bash bin/preflight-gpu.sh"
        else
          # Convert bytes → MiB for human display
          VRAM_MIB=$((VRAM_BYTES / 1024 / 1024))
          TOTAL_MIB_PS=$((TOTAL_BYTES / 1024 / 1024))
          pass "model '${MODEL}' resident in VRAM: ${VRAM_MIB} MiB / ${TOTAL_MIB_PS} MiB total (${RATIO}% on GPU)"
          GPU_RESIDENCY_DETAIL="confirmed via /api/ps python parser (size_vram=${VRAM_MIB} MiB, ${RATIO}% on GPU)"
        fi
        ;;
      NOT_LOADED)
        fail "model '${MODEL}' did not appear in /api/ps after the inference call. Should still be resident with keep_alive=${KEEP_ALIVE}."
        ;;
      PARSE_ERROR:*)
        fail "could not parse /api/ps JSON: ${VRAM_INFO#PARSE_ERROR:}"
        ;;
      *)
        fail "unexpected /api/ps probe output: ${VRAM_INFO}"
        ;;
    esac
  else
    # Fallback without python3: crude grep — proves the model name is in the response.
    if echo "$PS_RESPONSE" | grep -q "\"size_vram\":[[:space:]]*[1-9]"; then
      pass "model resident in VRAM (grep fallback — install python3 for accurate %)"
      GPU_RESIDENCY_DETAIL="confirmed via /api/ps grep fallback (size_vram > 0; install python3 for accurate %)"
    else
      fail "size_vram appears to be zero in /api/ps response — running on CPU. Diagnose with: bash bin/preflight-gpu.sh"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 — Assert VRAM-in-use >= VRAM_THRESHOLD_MB
#           Parse "FB Memory Usage / Used" field from nvidia-smi text output.
#           The default text layout has rows like:
#             |   1843MiB /  16380MiB |      9%      |
#           We extract the first NNNMiB / NNNMiB match and take the "used" number.
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] Step 5: asserting VRAM in use >= ${VRAM_THRESHOLD_MB} MiB..."

if [[ "${SMI_FAILED:-1}" -eq 1 ]]; then
  fail "skipping VRAM threshold check — nvidia-smi did not run successfully."
else
  # Extract the first "NNNMiB / NNNMiB" pattern (used / total)
  VRAM_MATCH=$(echo "$SMI_OUT" | grep -oE '[0-9]+MiB[[:space:]]*/[[:space:]]*[0-9]+MiB' | head -1)

  if [[ -z "$VRAM_MATCH" ]]; then
    fail "could not parse VRAM usage from nvidia-smi output. Raw output snippet: $(echo "$SMI_OUT" | head -5)"
  else
    USED_MIB=$(echo "$VRAM_MATCH" | grep -oE '^[0-9]+')
    TOTAL_MIB=$(echo "$VRAM_MATCH" | grep -oE '[0-9]+$')

    if [[ -z "$USED_MIB" ]]; then
      fail "could not extract used MiB from VRAM match: '${VRAM_MATCH}'"
    elif [[ "$USED_MIB" -lt "$VRAM_THRESHOLD_MB" ]]; then
      fail "VRAM in use (${USED_MIB} MiB) is below the ${VRAM_THRESHOLD_MB} MiB threshold. CPU fallback would show 0 MiB or a tiny driver-only value. The /api/generate request was sent with keep_alive=${KEEP_ALIVE} so the model should still be resident — if VRAM is below threshold, suspect actual CPU fallback rather than a timing race."
    else
      pass "VRAM in use is ${USED_MIB} MiB / ${TOTAL_MIB} MiB total (threshold: ${VRAM_THRESHOLD_MB} MiB)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] ================================================================"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "[smoke-test]  Model used          : ${MODEL}"
  echo "[smoke-test]  GPU listed          : yes (nvidia-smi in container)"
  echo "[smoke-test]  GPU residency       : ${GPU_RESIDENCY_DETAIL}"
  echo "[smoke-test]  VRAM in use         : ${USED_MIB:-?} MiB (threshold: ${VRAM_THRESHOLD_MB} MiB)"
  echo "[smoke-test] ================================================================"
  echo ""
  echo "[smoke-test] Phase 1 GPU verification: COMPLETE."
  echo ""
  exit 0
else
  echo "[smoke-test]  FAILED: ${FAILURES} assertion(s) did not pass."
  echo "[smoke-test]  Run \`bash bin/preflight-gpu.sh\` for remediation hints."
  echo "[smoke-test] ================================================================"
  echo ""
  exit 1
fi
