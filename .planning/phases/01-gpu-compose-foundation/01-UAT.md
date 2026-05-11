---
status: complete
phase: 01-gpu-compose-foundation
source:
  - 01-01-SUMMARY.md
  - 01-02-SUMMARY.md
  - 01-03-SUMMARY.md
  - 01-04-SUMMARY.md
started: 2026-05-11T17:50:00Z
updated: 2026-05-11T18:20:00Z
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
  artifacts: []
  missing: []
  debug_session: ""

- truth: "preflight script writes the state file non-interactively (no `mv -i` overwrite prompt) and cleans up its tmp files"
  status: failed
  reason: |
    User reported: state file write at `${HOST_DATA_ROOT}/.preflight-state.json` triggered `mv: replace '/srv/local-llms/.preflight-state.json', overriding mode 0644 (rw-r--r--)?` — an interactive prompt that blocks the script when an existing state file is present. This breaks the compose `gpu-preflight` one-shot service (which runs non-interactively) on the second and subsequent runs. Likely `mv` is aliased to `mv -i` in the user's environment, OR the script uses interactive options; either way, the script must force overwrite (`mv -f`, `cp -f`, `command mv`, or `\mv`).

    Downstream evidence (from `ls -la /srv/local-llms/` during test 4):
      - Existing `.preflight-state.json` is owned by `root` (left over from the container `gpu-preflight` run), so subsequent host-side `bin/preflight-gpu.sh` runs as user `luis` cannot overwrite it even without `mv -i`. Need either `sudo`-aware ownership handling or a per-user state path.
      - Two leftover `.preflight-state.json.tmp.NNNNN` files (PIDs 64770 and 65114) are abandoned in `/srv/local-llms/`. The tmp-then-rename pattern lacks a `trap` to clean up on early exit / cancelled mv.
  severity: blocker
  test: 2
  artifacts: []
  missing: []
  debug_session: ""

- truth: "SC2 acceptance grep returns 0 against compose.yml"
  status: failed
  reason: |
    `grep -cE '(:latest|runtime: nvidia|gpus: all)' compose.yml` returns 3, not 0. All 3 matches are header comments at lines 9, 18, 19 documenting the anti-patterns ("no :latest", "DO NOT use runtime: nvidia", "DO NOT use gpus: all"). The substantive config is clean: pinned image tags, modern `deploy.resources.reservations.devices` syntax, x-gpu anchor merged. Same false-positive pattern as Phase 1 Plan 02 and Plan 04 ("acceptance-criteria-vs-implementation contradiction"). Fix: either exclude comment lines in the grep (`grep -vE '^[[:space:]]*#' compose.yml | grep -cE ...`) or rephrase the comments to avoid the literal patterns.
  severity: minor
  test: 3
  artifacts: []
  missing: []
  debug_session: ""
