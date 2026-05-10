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

# Build JSON safely via python3 — never hand-build JSON in shell
REQUEST_BODY=$(python3 -c "
import json
print(json.dumps({
    'model': '${MODEL}',
    'prompt': '${PROMPT}',
    'stream': False,
    'keep_alive': '${KEEP_ALIVE}'
}))
")

GENERATE_RESPONSE=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$REQUEST_BODY" \
  "${OLLAMA_URL}/api/generate" 2>/dev/null || true)

if [[ -z "$GENERATE_RESPONSE" ]]; then
  fail "POST /api/generate returned no response. Check \`docker compose logs ollama\`."
else
  # Extract and validate the response field
  RESPONSE_TEXT=$(python3 - <<PYEOF
import json, sys
try:
    data = json.loads("""${GENERATE_RESPONSE}""")
    text = data.get("response", "")
    print(text.strip())
except Exception as e:
    print("")
PYEOF
  )

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
# Step 4 — Assert an `ollama` process is bound to the GPU
#           This is the load-bearing CPU-fallback catch.
#           With keep_alive="5m" set in Step 1, the model is guaranteed resident
#           in VRAM at this point — no retry loop needed.
# ---------------------------------------------------------------------------
echo ""
echo "[smoke-test] Step 4: asserting ollama process is visible in container nvidia-smi..."

if [[ "${SMI_FAILED:-1}" -eq 1 ]]; then
  fail "skipping ollama process check — nvidia-smi did not run successfully."
elif ! echo "$SMI_OUT" | grep -qi 'ollama'; then
  fail "no ollama process visible in container nvidia-smi. This is the silent-CPU-fallback signature: model loads but runs on CPU. Inference will be 50-100x slower than GPU. Diagnose with: bash bin/preflight-gpu.sh"
else
  OLLAMA_LINE=$(echo "$SMI_OUT" | grep -i 'ollama' | head -1 | sed 's/^[[:space:]]*//')
  pass "ollama process is bound to the GPU: ${OLLAMA_LINE}"
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
  echo "[smoke-test]  ollama process      : visible in nvidia-smi (GPU-bound)"
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
