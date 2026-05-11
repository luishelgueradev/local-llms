---
status: diagnosed
phase: 01-gpu-compose-foundation
source:
  - 01-01-SUMMARY.md
  - 01-02-SUMMARY.md
  - 01-03-SUMMARY.md
  - 01-04-SUMMARY.md
started: 2026-05-11T17:50:00Z
updated: 2026-05-11T18:25:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: From `docker compose down --remove-orphans` then `docker compose up -d`, `gpu-preflight` exits 0 and is gone, `ollama` reaches `(healthy)` within ~10 s, `docker compose ps` shows ollama Up/healthy with no other services in error.
result: pass

### 2. GPU Preflight script (SC1)
expected: Running `bash bin/preflight-gpu.sh` on the host exits 0 when GPU passthrough is functional. Functional checks pass (`/dev/dxg` or `/dev/nvidia*`, host `nvidia-smi`, container `nvidia-smi`). Diagnostic checks (`nvidia-ctk --version`, `daemon.json` runtime entry) are recorded as INFO and do not gate exit. State file `${HOST_DATA_ROOT}/.preflight-state.json` written with `schema_version: 1`.
result: issue
reported: |
  [preflight] Mode: host
  [preflight]   gpu_device                     PASS
  [preflight]   host_nvidia_smi                FAIL
  [preflight]   container_nvidia_smi           PASS
  [preflight]   nvidia_ctk                     INFO (diagnostic, not gating)
  [preflight]   daemon_json                    INFO (diagnostic, not gating)
  [preflight] HINT [host_nvidia_smi]: Install / verify the host NVIDIA driver.
  [preflight] HINT [host_nvidia_smi]: On WSL2, this is on Windows (not inside the WSL distro).
  mv: replace '/srv/local-llms/.preflight-state.json', overriding mode 0644 (rw-r--r--)?
severity: blocker

### 3. compose.yml shape (SC2)
expected: `docker compose config` shows every GPU service references the same `x-gpu` YAML anchor (driver: nvidia, count: all, capabilities include `gpu`). No service uses the legacy `runtime: nvidia` form. No service uses `:latest`. Verify with: `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 0.
result: issue
reported: |
  `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 3, not 0. All 3 matches are header comments documenting the anti-patterns (lines 9, 18, 19) — substantively the config is clean: `docker compose config` shows pinned images (`nvidia/cuda:12.6.0-base-ubuntu24.04`, `ollama/ollama:0.5.7`), modern `deploy.resources.reservations.devices` syntax, the `x-gpu` anchor merged into both `gpu-preflight` and `ollama` services. Same false-positive pattern Phase 1 already fixed twice in scripts.
severity: minor

### 4. Volume layout on disk (SC3)
expected: Under `${HOST_DATA_ROOT}` (default `/srv/local-llms`), the layout is `models-gguf/gguf/`, `models-gguf/ollama/`, and `models-hf/` as separate top-level directories — never a single shared `/models` tree.
result: pass
note: |
  Layout is correct. Additional observations (logged under test 2's gap, not as test 4 failure): `.preflight-state.json` is owned by root (left over from container run), and two `.preflight-state.json.tmp.NNNNN` files are abandoned — both downstream side-effects of the `mv -i` blocker in test 2.

### 5. End-to-end GPU smoke test (SC4)
expected: `bash bin/smoke-test-gpu.sh` exits 0. Output shows: model generates a non-empty response (Step 1 PASS), container `nvidia-smi` shows the GPU (Step 3 PASS), model resident in VRAM via `/api/ps` with `size_vram > 0` (Step 4 PASS), and VRAM in use ≥ 1024 MiB (Step 5 PASS) — i.e. no silent CPU fallback.
result: pass
note: |
  All 5 steps PASS, exit 0. 4161 MiB VRAM in use, 100% on GPU. Tiny cosmetic log defect: Step 5 prints "VRAM in use is 4161 MiB /  MiB total (threshold: 1024 MiB)" — the `${VRAM_TOTAL}` placeholder is unexpanded between `/` and `MiB total`. Doesn't affect the assertion.

### 6. Compose dependency ordering (SC5)
expected: `compose.yml` shows `ollama.depends_on.gpu-preflight.condition: service_completed_successfully` (one-shot gate) and `ollama.healthcheck` uses `ollama list` (not curl). After `docker compose up -d`, `docker compose ps` shows `ollama` reaches `(healthy)`; killing the preflight functional set blocks ollama from starting.
result: pass
note: |
  Verified in user's `docker compose ps`: `local-llms-ollama  Up 14 minutes (healthy)  127.0.0.1:11434->11434/tcp`. depends_on + healthcheck shape verified earlier from `docker compose config`.

## Summary

total: 6
passed: 4
issues: 2
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "bin/preflight-gpu.sh exits 0 on a host where the authoritative container_nvidia_smi check passes"
  status: failed
  reason: |
    User reported: host_nvidia_smi FAILed on a WSL2 + Docker Desktop host even though container_nvidia_smi PASSed (the authoritative test per Phase 1 design). Since host_nvidia_smi is in the functional set, the script exits non-zero — directly contradicting the Phase 1 Defect 2 rationale ("split functional vs diagnostic so Docker Desktop on Windows + WSL2 works"). On WSL2 hosts, the Windows-side nvidia-smi is not reachable from the WSL distro's PATH, but GPU passthrough still works (proven by container_nvidia_smi PASS).
  severity: blocker
  test: 2
  root_cause: |
    `bin/preflight-gpu.sh` line 346 classifies `host_nvidia_smi` as `functional` while sibling `nvidia_ctk`/`daemon_json` (lines 348-349) are correctly `diagnostic`. The check implementation at lines 142-151 only probes `command -v nvidia-smi` in the WSL distro's PATH — it never probes the WSL2-specific projection paths `/usr/lib/wsl/lib/nvidia-smi` and `/mnt/c/Windows/System32/nvidia-smi.exe`. So on Docker Desktop on Windows + WSL2 the check fails on a host where GPU passthrough provably works, and because it's in the gating set the script exits 1. Defect 2 already moved the other two WSL2-fragile checks to diagnostic; this one was missed.
  artifacts:
    - path: "bin/preflight-gpu.sh"
      line: 346
      issue: "host_nvidia_smi registered as functional/gating; should be diagnostic on WSL2-class hosts where container_nvidia_smi is authoritative"
    - path: "bin/preflight-gpu.sh"
      lines: "142-151"
      issue: "check_host_nvidia_smi probes only PATH; misses /usr/lib/wsl/lib/nvidia-smi and /mnt/c/Windows/System32/nvidia-smi.exe (polish, not load-bearing)"
  missing:
    - "Reclassify host_nvidia_smi from functional to diagnostic at bin/preflight-gpu.sh line 346 (mirrors nvidia_ctk/daemon_json on lines 348-349)"
    - "(Optional) Extend check_host_nvidia_smi to probe WSL2 projection paths for noise reduction in diagnostic output"
  debug_session: ".planning/debug/preflight-gpu-wsl2-and-state-write.md"

- truth: "preflight script writes the state file non-interactively (no `mv -i` overwrite prompt) and cleans up its tmp files"
  status: failed
  reason: |
    User reported: state file write at `${HOST_DATA_ROOT}/.preflight-state.json` triggered `mv: replace '/srv/local-llms/.preflight-state.json', overriding mode 0644 (rw-r--r--)?` — an interactive prompt that blocks the script when an existing state file is present. This breaks the compose `gpu-preflight` one-shot service (which runs non-interactively) on the second and subsequent runs.

    Downstream evidence (from `ls -la /srv/local-llms/` during test 4):
      - Existing `.preflight-state.json` is owned by `root` (left over from the container `gpu-preflight` run), so subsequent host-side `bin/preflight-gpu.sh` runs as user `luis` cannot overwrite it even without `mv -i`. Need either `sudo`-aware ownership handling or a per-user state path.
      - Two leftover `.preflight-state.json.tmp.NNNNN` files (PIDs 64770 and 65114) are abandoned in `/srv/local-llms/`. The tmp-then-rename pattern lacks a `trap` to clean up on early exit / cancelled mv.
  severity: blocker
  test: 2
  root_cause: |
    The `mv -i` *alias* hypothesis from the UAT gap is wrong — `type mv` returns `/usr/bin/mv` with no alias in this environment. The actual cause is destination-ownership: GNU `mv` prompts when the destination exists, the calling user cannot unlink/replace it, AND stdin is a TTY — regardless of the `-i` flag, and `mv -f` alone is INSUFFICIENT because `-f` only suppresses the prompt; the underlying `unlink(2)` still fails when the user lacks write permission on the destination file.

    Two contributing code-level causes, both real:

    (a) Script-level: lines 461, 508, and 567 use a temp-file + bare `mv` pattern with no defense against root-owned existing targets. Lines 508 and 567 are the two mv calls (python-path rename and printf-fallback rename).

    (b) Script-level: NO `trap` is registered at script scope (`grep -n trap bin/preflight-gpu.sh` returns zero matches). `${TMPFILE}` is created on line 461 as `${STATE_FILE}.tmp.$$`; the `rm -f "${TMPFILE}"` calls on lines 512 and 571 only run when the rename returns non-zero. When `mv` blocks on a prompt and the user Ctrl-Cs, SIGINT bypasses those branches. Direct proof: two leftover `.tmp.64770` and `.tmp.65114` files observed in `/srv/local-llms/`.

    (c) Container-level: compose.yml lines 57-85 (the `gpu-preflight` service) has no `user:` directive, so the container runs as uid 0. The bind mount on line 75 writes the state file back to the host as `root:root`. A subsequent host run as `luis` then collides with that root-owned file via mv's rename path. Symptoms 2 and 3 are the same defect from two angles.

    The minimum correct fix exploits the fact that the parent directory `/srv/local-llms/` is owned by `luis:luis`: Python `os.replace(tmp, STATE_FILE)` uses `rename(2)` which succeeds with directory-write permission alone, irrespective of the existing file's owner. Replaces the tmp+mv pattern entirely.
  artifacts:
    - path: "bin/preflight-gpu.sh"
      lines: "461, 508, 567"
      issue: "Bare `mv` on tmp-then-rename does not survive a root-owned existing destination; needs os.replace() / install -T / direct truncate-and-write via directory write permission"
    - path: "bin/preflight-gpu.sh"
      lines: "43-45 (insertion point)"
      issue: "No `trap '...' EXIT INT TERM HUP` registered; tmp files leak on abort"
    - path: "bin/preflight-gpu.sh"
      lines: "121-124"
      issue: "IN_CONTAINER is detected but never used to adjust post-write file mode/ownership"
    - path: "compose.yml"
      lines: "57-85 (gpu-preflight service)"
      issue: "No `user:` directive; container PID 1 runs as root and writes the state file root-owned through the bind mount on line 75. Contributing cause, non-load-bearing if the script-side fix is applied."
  missing:
    - "Replace tmp+mv pattern in the python writer (lines 461, 475, 499-508) with `os.replace(tmp, STATE_FILE)` after `NamedTemporaryFile(dir=os.path.dirname(STATE_FILE), delete=False)`"
    - "Apply same `os.replace`/`install -T` treatment to the printf-fallback path (line 567)"
    - "Add `trap '[ -n \"${TMPFILE:-}\" ] && rm -f \"${TMPFILE}\" 2>/dev/null; exit' EXIT INT TERM HUP` after `set -uo pipefail` (line 45), before line 56's arg loop. Declare `TMPFILE=\"\"` at script scope first"
    - "Clean up the two leftover .preflight-state.json.tmp.NNNNN files in /srv/local-llms/ as part of the fix's verification (one-shot)"
    - "(Optional defense in depth) Add `user: \"${UID:-1000}:${GID:-1000}\"` to gpu-preflight in compose.yml so future in-container runs leave host-writable state — but the script-side fix is sufficient on its own"
  debug_session: ".planning/debug/preflight-gpu-wsl2-and-state-write.md"

- truth: "SC2 acceptance grep returns 0 against compose.yml"
  status: failed
  reason: |
    `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 3, not 0. All 3 matches are header comments at lines 9, 18, 19 documenting the anti-patterns ("no :latest", "DO NOT use runtime: nvidia", "DO NOT use gpus: all"). The substantive config is clean: pinned image tags, modern `deploy.resources.reservations.devices` syntax, x-gpu anchor merged. Same false-positive pattern as Phase 1 Plan 02 and Plan 04 ("acceptance-criteria-vs-implementation contradiction"). Fix: either exclude comment lines in the grep (`grep -vE '^[[:space:]]*#' compose.yml | grep -cE ...`) or rephrase the comments to avoid the literal patterns.
  severity: minor
  test: 3
  root_cause: |
    Phase 1's SC2 acceptance regex `(:latest|runtime: nvidia|gpus: all)` is not comment-aware. The current `compose.yml` correctly documents the standing anti-pattern list in its file header; three of those lines contain the exact literal strings the grep hunts for even though each clearly starts with `#`. Comment-excluded probe (`grep -vE '^[[:space:]]*#' compose.yml | grep -cE ...`) returns 0; the substantive config is clean.

    Precedent: Plans 02 and 04 hit the same false-positive class on `bin/preflight-gpu.sh` and `bin/smoke-test-gpu.sh`. They BOTH chose option (a) source-rephrase to remove the literal patterns from scanned text, AND Plan 02 ADDITIONALLY hardened its own grep to the comment-aware form (`01-02-PLAN.md` lines 235 and 246). The combined precedent — rephrase + harden — was never propagated to the SC2 grep when Plan 03 wrote it. The SC2 grep currently lives in 01-03-PLAN.md lines 354 and 382, 01-04-PLAN.md line 292, and 01-UAT.md lines 39+101. ROADMAP.md SC2 (line 33) is prose-only with no executable grep attached, so a fix does not touch ROADMAP.md.
  artifacts:
    - path: "compose.yml"
      lines: "9, 18, 19"
      issue: "Three header comments contain the literal banned substrings (`:latest`, `runtime: nvidia`, `gpus: all`) — source of the false positive"
    - path: ".planning/phases/01-gpu-compose-foundation/01-03-PLAN.md"
      lines: "354, 382"
      issue: "Canonical written-down form of the SC2 grep is not comment-aware — needs hardening"
    - path: ".planning/phases/01-gpu-compose-foundation/01-04-PLAN.md"
      line: 292
      issue: "Line-anchored variant of the same SC2 grep — needs same hardening"
    - path: ".planning/phases/01-gpu-compose-foundation/01-UAT.md"
      lines: "39, 101"
      issue: "UAT-side restatement of the SC2 grep — should match the hardened form post-fix"
  missing:
    - "Rephrase compose.yml line 9: `#   - pinned image tags (never use the floating \"latest\" form — INFRA-04)`"
    - "Rephrase compose.yml line 18: `# DO NOT use the legacy \"runtime nvidia\" Compose directive (on the standing rejection list).`"
    - "Rephrase compose.yml line 19: `# DO NOT use the \"gpus all\" shorthand (Compose-version-fragile).`"
    - "Update 01-03-PLAN.md lines 354 and 382 to use comment-aware form: `grep -vE '^[[:space:]]*#' compose.yml | grep -cE '(:latest|runtime: nvidia|gpus: all)'` returns 0"
    - "Update 01-04-PLAN.md line 292 the same way"
    - "Update 01-UAT.md lines 39 and 101 to match the hardened expected form (optional but consistent)"
    - "Leave 01-03-SUMMARY.md and 01-04-SUMMARY.md untouched — they are historical execution records"
  debug_session: ".planning/debug/sc2-grep-false-positive.md"
