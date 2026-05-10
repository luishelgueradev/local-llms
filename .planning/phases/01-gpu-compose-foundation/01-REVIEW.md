---
phase: 01-gpu-compose-foundation
reviewed: 2026-05-10T00:00:00Z
depth: deep
files_reviewed: 8
files_reviewed_list:
  - bin/bootstrap-host.sh
  - bin/preflight-gpu.sh
  - bin/smoke-test-gpu.sh
  - bin/gpu-init-libcuda.sh
  - compose.yml
  - .env.example
  - .gitignore
  - README.md
findings:
  critical: 2
  warning: 7
  info: 3
  total: 12
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-05-10
**Depth:** deep
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Phase 1 delivers a sound GPU-and-Compose foundation: the `x-gpu` anchor, four-network topology, `gpu-preflight` gating, and the `gpu-init-libcuda.sh` entrypoint wrapper are all structurally correct. The single-user threat model is respected throughout. The major concerns are a state-file contract violation that will silently corrupt Phase 7 data (`host_driver_version: "in-container"` overwrites the real host driver version every time `docker compose up` is run), a shell-variable-to-Python interpolation path in `smoke-test-gpu.sh` that can cause false-failure or injection depending on LLM output content, and a documented-but-inverted priority order for `HOST_DATA_ROOT` resolution in `preflight-gpu.sh`. All three are fixable with small, targeted changes.

---

## Critical Issues

### CR-01: State file `host_driver_version` is overwritten with `"in-container"` on every `docker compose up`

**File:** `bin/preflight-gpu.sh:377-381`

**Issue:** When `preflight-gpu.sh` detects it is running inside a container (`/.dockerenv` exists), it unconditionally sets `HOST_DRIVER_VERSION="in-container"` (line 378) and then writes that string to the Phase 7 contract field `host_driver_version` in `.preflight-state.json`. The `gpu-preflight` Compose service runs this script on every `docker compose up`. This means the sequence:

1. `bash bin/preflight-gpu.sh` on the host → state file correctly records `"host_driver_version": "555.42.02"`.
2. `docker compose up` → `gpu-preflight` runs the same script inside a container → state file is overwritten with `"host_driver_version": "in-container"`.

Phase 7 is documented to read `host_driver_version` from the state file to choose between `cu129`/`cu126`/`cu124` vLLM image tags. After any `docker compose up`, that field contains the string `"in-container"`, breaking Phase 7 before it starts.

The fix is trivial: `nvidia-smi --query-gpu=driver_version` IS available inside the `gpu-preflight` container (the container has GPU passthrough via the `x-gpu` anchor). The `in-container` guard exists to skip checks that can't work in-container, but capturing the driver version via `nvidia-smi` is equally valid inside the container.

**Fix:**
```bash
# Replace lines 377-392 with:
if [ "$IN_CONTAINER" = "true" ]; then
  HOST_DRIVER_VERSION=$(capture_host_driver_version)   # nvidia-smi works in-container too
  HOST_DRIVER_VERSION="${HOST_DRIVER_VERSION:-null}"
  CUDA_VERSION=$(capture_cuda_version)
  CUDA_VERSION="${CUDA_VERSION:-null}"
  NVIDIA_CTK_VERSION="in-container"   # only this field is meaningfully absent
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
```

---

### CR-02: Shell variable interpolation into Python `"""` heredoc breaks on LLM response content containing triple-quotes

**File:** `bin/smoke-test-gpu.sh:206-214` (also `155-162`)

**Issue:** The script injects raw shell variable content into Python `"""` triple-quoted string literals via unquoted heredoc expansion:

```bash
# Line 206-214
RESPONSE_TEXT=$(python3 - <<PYEOF
import json, sys
try:
    data = json.loads("""${GENERATE_RESPONSE}""")   # <-- raw expansion
    ...
PYEOF
)
```

`PYEOF` is NOT a quoted heredoc terminator (it is `<<PYEOF`, not `<<'PYEOF'`), so bash expands `${GENERATE_RESPONSE}` before Python sees the code. If the Ollama model returns a response containing three consecutive double-quotes (`"""`), the triple-quoted Python string is terminated early, resulting in a `SyntaxError`. The `try/except` at line 207 catches `SyntaxError` (it catches all exceptions) and silently prints an empty string, causing the smoke test to report `FAIL: 'response' field is empty or missing` — a misleading false failure that gives no indication the content itself caused the parse error.

The same pattern occurs at line 155-162 for `${TAGS_RESPONSE}`, but that path is partially mitigated because a JSON validity pre-check (line 141) aborts before the heredoc is reached. Valid JSON cannot contain literal unescaped `"""`, so the TAGS_RESPONSE path is safe in practice.

The `${GENERATE_RESPONSE}` path at line 209 is more dangerous: the model response field content is not JSON-embedded at that point (it is already decoded text), and the `try/except Exception` only prevents a crash — it does not surface a diagnostic. The correct fix is to pass the response through an environment variable (the pattern already used correctly at line 283 for `/api/ps`).

**Fix:**
```bash
# Replace lines 206-215 with:
RESPONSE_TEXT=$(GENERATE_RESPONSE="$GENERATE_RESPONSE" python3 -c "
import json, os, sys
raw = os.environ.get('GENERATE_RESPONSE', '')
try:
    data = json.loads(raw)
    text = data.get('response', '')
    print(text.strip())
except Exception:
    print('')
")
```

Apply the same fix to the TAGS_RESPONSE heredoc at line 155-162:
```bash
MODEL_FOUND=$(MODEL="$MODEL" TAGS_RESPONSE="$TAGS_RESPONSE" python3 -c "
import json, os, sys
raw = os.environ.get('TAGS_RESPONSE', '')
target = os.environ.get('MODEL', '')
try:
    data = json.loads(raw)
    models = data.get('models', [])
    found = any(m.get('name','').startswith(target) or m.get('model','').startswith(target) for m in models)
    print('yes' if found else 'no')
except Exception:
    print('no')
")
```

---

## Warnings

### WR-01: `HOST_DATA_ROOT` priority is documented as "env var > .env" but code implements the opposite

**File:** `bin/preflight-gpu.sh:97-115`

**Issue:** The comment at line 98 states "Priority: .env file > environment variable > compiled-in default." The code's intent (per line 103-106) is to honor an environment variable set by the caller. But the code sets `HOST_DATA_ROOT="/srv/local-llms"` unconditionally on line 101, then checks `if [ -n "${HOST_DATA_ROOT:-}" ]` — which is always true at that point because line 101 just set it. The block is a no-op. The `.env` block (lines 109-115) then overwrites whatever value exists.

Result: if a user runs `HOST_DATA_ROOT=/custom bash bin/preflight-gpu.sh`, the `.env` value silently overwrites their override, and the state file lands in the wrong directory. In the Compose context (where `HOST_DATA_ROOT` is passed as an env var and `.env` is absent), this happens to work correctly because `REPO_ROOT` resolves to `/` and `/.env` doesn't exist.

**Fix:**
```bash
# Replace lines 101-115 with:
# Priority: caller environment > .env file > compiled-in default
HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"   # env var wins if set

# .env file supplements only when HOST_DATA_ROOT was NOT already set by caller
if [ "${HOST_DATA_ROOT}" = "/srv/local-llms" ] && [ -f "${REPO_ROOT}/.env" ]; then
  _val=$(grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$_val" ]; then
    HOST_DATA_ROOT="$_val"
  fi
fi
```

---

### WR-02: `capture_cuda_version` contains a dead assignment (variable `v` is computed but never used)

**File:** `bin/preflight-gpu.sh:239-243`

**Issue:** The function `capture_cuda_version` (lines 236-244) assigns to a local variable `v` on line 240 but never uses it. The function's actual output comes from the `nvidia-smi | grep | awk` pipeline on line 242. The dead assignment runs a redundant `nvidia-smi --query-gpu=driver_version` call and misleads readers into thinking `v` factors into the output.

```bash
capture_cuda_version() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    local v
    v=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)  # dead
    # Extract CUDA Version from the table header section
    nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' | head -1 | awk '{print $3}'
  fi
}
```

**Fix:** Remove lines 239-240:
```bash
capture_cuda_version() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' | head -1 | awk '{print $3}'
  fi
}
```

---

### WR-03: `gpu-init-libcuda.sh` hardcodes `x86_64-linux-gnu` target directory — silently fails on arm64

**File:** `bin/gpu-init-libcuda.sh:54-56`

**Issue:** The script hardcodes `/usr/lib/x86_64-linux-gnu` as the symlink target directory:

```sh
TARGET_DIR=/usr/lib/x86_64-linux-gnu
ln -sf "$WSL_LIBCUDA" "$TARGET_DIR/libcuda.so.1"
```

On an arm64 host (or any future non-x86_64 target), this directory may not exist or may not be in the ldconfig search path. The `ln -sf` would succeed (creating a dangling symlink in a non-canonical path) but `ldconfig` would not pick it up, and `dlopen("libcuda.so.1")` would still fail. Since the script operates on `set -eu`, the `ln` to a non-existent directory would cause exit before `exec "$@"`, killing the container startup.

WSL2 on Windows is x86_64-only today, so this is not currently triggered. A future host change or reuse of this pattern for an arm64 build would silently fail in a hard-to-diagnose way.

**Fix:**
```sh
# Replace line 54 with:
TARGET_DIR=$(ldconfig -p 2>/dev/null | awk '/libm\.so\.6/ {print $NF}' | head -1 | xargs dirname 2>/dev/null)
TARGET_DIR="${TARGET_DIR:-/usr/lib/$(uname -m)-linux-gnu}"
```

Or at minimum, guard with an existence check:
```sh
TARGET_DIR=/usr/lib/x86_64-linux-gnu
if [ ! -d "$TARGET_DIR" ]; then
  TARGET_DIR="/usr/lib/$(uname -m)-linux-gnu"
fi
```

---

### WR-04: `bootstrap-host.sh` `_create_dirs()` function is dead code in the sudo path

**File:** `bin/bootstrap-host.sh:32-57`

**Issue:** The script defines `_create_dirs()` (lines 32-41) as a helper to create the directory tree, then in the non-sudo path calls `_create_dirs` (line 46). In the sudo path (lines 49-57), it inlines a duplicate of the same seven `mkdir -p` commands rather than calling `sudo _create_dirs` or extracting the list another way. This means any future change to the directory list must be made in two places. In Phase 2 or later when a new service directory needs to be added, one of the two lists will be forgotten.

**Fix:** Use `sudo bash -c` to call the function in sudo context, or restructure to avoid duplication:
```bash
DIRS=(
  "${HOST_DATA_ROOT}/models-gguf/gguf"
  "${HOST_DATA_ROOT}/models-gguf/ollama"
  "${HOST_DATA_ROOT}/models-hf"
  "${HOST_DATA_ROOT}/postgres"
  "${HOST_DATA_ROOT}/valkey"
  "${HOST_DATA_ROOT}/traefik/acme"
  "${HOST_DATA_ROOT}/traefik/logs"
)

if mkdir -p "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null; then
  rmdir "${HOST_DATA_ROOT}/.test_$$" 2>/dev/null || true
  mkdir -p "${DIRS[@]}"
else
  sudo mkdir -p "${DIRS[@]}"
fi
```

---

### WR-05: `REQUEST_BODY` JSON construction interpolates shell variables into a double-quoted `python3 -c` string without sanitization

**File:** `bin/smoke-test-gpu.sh:187-195`

**Issue:** The `REQUEST_BODY` is built by interpolating `${MODEL}`, `${PROMPT}`, and `${KEEP_ALIVE}` directly into the Python source code string:

```bash
REQUEST_BODY=$(python3 -c "
import json
print(json.dumps({
    'model': '${MODEL}',
    'prompt': '${PROMPT}',
    ...
}))
")
```

`PROMPT` is a `readonly` constant containing a single `?` character and is safe. `MODEL` and `KEEP_ALIVE` are also safe in the default case. However, `MODEL` can be overridden via `--model`, and a model name containing a single quote (`'`) would break the Python string literal. A name containing a newline could inject arbitrary Python code. The prior analysis shows current Python syntax validation prevents code execution, but this is a latent quality defect in an adversarial `--model` argument context.

The `/api/ps` section at lines 283-300 correctly avoids this by using environment variables. The `REQUEST_BODY` construction should follow the same pattern.

**Fix:**
```bash
REQUEST_BODY=$(MODEL="$MODEL" PROMPT="$PROMPT" KEEP_ALIVE="$KEEP_ALIVE" python3 -c "
import json, os
print(json.dumps({
    'model': os.environ['MODEL'],
    'prompt': os.environ['PROMPT'],
    'stream': False,
    'keep_alive': os.environ['KEEP_ALIVE']
}))
")
```

---

### WR-06: `preflight-gpu.sh` fallback JSON builder has no error handling on `mv` failure — orphaned tmp file on permission error

**File:** `bin/preflight-gpu.sh:555-558`

**Issue:** The fallback JSON path (Python unavailable) builds the state file via `printf ... > "${TMPFILE}"` then `mv "${TMPFILE}" "${STATE_FILE}"`. If `mv` fails (e.g., `HOST_DATA_ROOT` is on a read-only filesystem, or permissions changed between `mkdir -p` succeeding and `mv` running), the `TMPFILE` is left behind without cleanup. The Python path (lines 497-502) correctly calls `rm -f "${TMPFILE}"` on Python failure, but neither path handles `mv` failure.

**Fix:**
```bash
if mv "${TMPFILE}" "${STATE_FILE}" 2>/dev/null; then
  log "State written to ${STATE_FILE}"
else
  log_always "WARNING: Failed to move state file from ${TMPFILE} to ${STATE_FILE}"
  rm -f "${TMPFILE}"
fi
```

---

### WR-07: `smoke-test-gpu.sh` success banner references `GPU residency: confirmed via /api/ps` unconditionally, but Step 4 may have been skipped

**File:** `bin/smoke-test-gpu.sh:373`

**Issue:** The success banner at line 373 always prints `GPU residency: confirmed via /api/ps (size_vram > 0)`. This line is printed only when `FAILURES == 0`. However, the Step 4 check (lines 274-331) has a branch where `python3` is absent and falls back to a crude `grep` check. In the grep-fallback path at line 325, the pass message says "grep fallback" — but the success banner does not reflect this. More subtly, if `PS_RESPONSE` is empty (line 277 triggers `fail`), FAILURES would be > 0 and the banner is not shown; that case is fine. But if `PS_RESPONSE` has `size_vram > 0` via the grep fallback, the banner claims confirmation "via /api/ps (size_vram > 0)" — which is accurate but the Python path's exact match logic was not exercised.

This is a minor accuracy issue in diagnostic output. The real defect is that the success banner hard-codes text without reflecting the python3-absent codepath.

**Fix:** Track which path was used and adjust the banner text:
```bash
GPU_RESIDENCY_DETAIL="confirmed via /api/ps (size_vram > 0)"
# (set GPU_RESIDENCY_DETAIL="confirmed via /api/ps grep fallback" in the grep path)
echo "[smoke-test]  GPU residency       : ${GPU_RESIDENCY_DETAIL}"
```

---

## Info

### IN-01: `.gitignore` pattern `.preflight-state.json` is path-anchored to repo root only — the actual state file lives outside the repo

**File:** `.gitignore:9`

**Issue:** The `.gitignore` entry `.preflight-state.json` matches a file named exactly `.preflight-state.json` in the repo root or any subdirectory. The actual state file is written to `${HOST_DATA_ROOT}/.preflight-state.json` which defaults to `/srv/local-llms/.preflight-state.json` — outside the repo entirely. The gitignore entry would only matter if `HOST_DATA_ROOT` is set to the repo root itself (a misconfiguration). In normal deployment this pattern is harmless but misleading documentation.

No code change needed unless the team wants to add a comment explaining why the pattern is present despite the file living outside the repo.

---

### IN-02: `preflight-gpu.sh` in-container mode labels `container_nvidia_smi` but calls `check_host_nvidia_smi`

**File:** `bin/preflight-gpu.sh:334`

**Issue:** In in-container mode, the `container_nvidia_smi` check is registered with function `check_host_nvidia_smi` (which directly runs `nvidia-smi --query-gpu=name`). The intent is correct — inside the container, `nvidia-smi` runs directly — but the function name creates confusion: `check_host_nvidia_smi` running inside a container while mapped to the check named `container_nvidia_smi`. The state file will record `container_nvidia_smi: pass/fail` based on a function called "host", making code archaeology harder.

The fix is to either rename the function to `check_direct_nvidia_smi` (used by both the in-container and host checks for direct invocation) and keep `check_container_nvidia_smi` for the `docker run` variant, or add a dedicated `check_incontainer_nvidia_smi` function.

---

### IN-03: `gpu-init-libcuda.sh` uses `/bin/sh` shebang but runs inside an Ollama container where `/bin/sh` may be busybox

**File:** `bin/gpu-init-libcuda.sh:1`

**Issue:** The script uses `#!/bin/sh` shebang. The `ollama/ollama:0.5.7` image is based on Ubuntu 22.04 (not Alpine), so `/bin/sh` is `dash`, not busybox. The script uses POSIX-compatible constructs (`find`, `ln -sf`, `ldconfig`) and explicitly avoids bash-only features. This is intentional and correct for the current base image. It becomes a defect if a future phase reuses this wrapper for an Alpine-based image where `ldconfig` may not exist. The `ldconfig 2>/dev/null || true` on line 63 handles ldconfig absence gracefully.

This is informational: the current usage is correct; just note the Alpine caveat for future image changes.

---

_Reviewed: 2026-05-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
