---
quick_id: 260510-v8z
phase: phase-01
plan: 01
type: execute
wave: 1
files_modified:
  - bin/preflight-gpu.sh
  - bin/bootstrap-host.sh
  - bin/gpu-init-libcuda.sh
  - bin/smoke-test-gpu.sh
  - .gitignore
commit_hash: 20d57d2
commit_strategy: single_atomic_commit
completed_at: "2026-05-10"
status: complete
---

# Quick Task 260510-v8z: Phase-01 Script Cleanup Summary

Applied 9 source edits + 1 verified-already-resolved across 5 files in a single
atomic commit. All 10 non-blocking findings from
`.planning/phases/01-gpu-compose-foundation/01-REVIEW.md` are now closed.

## Per-finding Outcome

| ID    | File                        | Outcome              | Notes                                                                                                                                                                |
| ----- | --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WR-01 | `bin/preflight-gpu.sh`      | **changed**          | HOST_DATA_ROOT priority inverted: caller env var > .env > compiled-in default. Caller `${HOST_DATA_ROOT:-/srv/local-llms}` now wins, with `.env` consulted only when the value equals the default. |
| WR-02 | `bin/preflight-gpu.sh`      | **changed**          | Removed dead `local v` declaration and its redundant `nvidia-smi --query-gpu=driver_version` call from `capture_cuda_version()`. The awk pipeline is preserved.       |
| WR-03 | `bin/gpu-init-libcuda.sh`   | **changed**          | `TARGET_DIR` now derived from `uname -m` (`/usr/lib/$(uname -m)-linux-gnu`), with fallback to the hardcoded `x86_64-linux-gnu` path when the derived dir is absent.   |
| WR-04 | `bin/bootstrap-host.sh`     | **changed**          | Replaced `_create_dirs()` + duplicated `sudo mkdir -p ...` block with a single `DIRS=( ... )` array consumed by both branches. Seven entries preserved exactly.      |
| WR-05 | `bin/smoke-test-gpu.sh`     | **verified-no-change** | Confirmed via `git log -- bin/smoke-test-gpu.sh` that commit `5264e9e` ("fix(01-04): pass JSON to python via env vars, not source interpolation (CR-02)") already adopted the `_SMOKE_*` env-var pattern with single-quoted `python3 -c '...'`. No edit needed. |
| WR-06 | `bin/preflight-gpu.sh`      | **changed**          | Fallback (non-Python) JSON path now wraps the final `mv` in an `if/else`: on failure it logs `WARNING: failed to move ${TMPFILE} to ${STATE_FILE}` and removes the orphan tmp file, matching the Python path's `rm -f` style.     |
| WR-07 | `bin/smoke-test-gpu.sh`     | **changed**          | Introduced `GPU_RESIDENCY_DETAIL` initialized before Step 4 and set in both the python-parser pass branch and the grep-fallback pass branch. The final success banner now reflects which path produced the verdict. |
| IN-01 | `.gitignore`                | **changed**          | Replaced the one-line comment with a four-line block explaining that the canonical write target lives OUTSIDE the repo and the pattern is defensive only.            |
| IN-02 | `bin/preflight-gpu.sh`      | **changed**          | Added a four-line block comment above the in-container `run_check "container_nvidia_smi" check_host_nvidia_smi` line documenting the name-vs-function divergence. Function NOT renamed (called from three sites — comment-only is the right call). |
| IN-03 | `bin/gpu-init-libcuda.sh`   | **changed**          | Added a five-line comment block immediately after the `#!/bin/sh` shebang documenting the `dash`-on-Ubuntu / `busybox-ash`-on-Alpine runtime assumption and the `ldconfig` graceful-degradation.   |

## Spot-Check Results

All 10 grep-based spot-checks from the plan's `<verification>` block pass:

```
WR-01 (caller env > .env): 1  (want 1)
WR-02 (dead v removed):    0  (want 0)
WR-03 (uname -m):          2  (want >=1)
WR-04 (_create_dirs gone): 0  (want 0)
WR-04 (DIRS array):        1  (want 1)
WR-04 (DIRS[@] usage):     2  (want 2)
WR-06 (mv WARNING):        1  (want 1)
WR-07 (GPU_RESIDENCY_DETAIL): 4 (want >=4)
WR-07 (old hardcode gone): 0  (want 0)
IN-01 (.gitignore comment): 1 (want 1)
IN-02 (annotation):        1  (want >=1)
IN-03 (shebang comment):   3  (want >=1)
```

## Verification Output

### Syntax checks (all pass)

```
bash -n bin/preflight-gpu.sh   → 0
bash -n bin/bootstrap-host.sh  → 0
sh   -n bin/gpu-init-libcuda.sh → 0
bash -n bin/smoke-test-gpu.sh  → 0
```

### Host-side `bash bin/preflight-gpu.sh`

```
[preflight]   gpu_device                     PASS
[preflight]   host_nvidia_smi                FAIL
[preflight]   container_nvidia_smi           PASS
[preflight]   nvidia_ctk                     INFO (diagnostic, not gating)
[preflight]   daemon_json                    INFO (diagnostic, not gating)
[preflight] Failed checks — remediation hints:
[preflight]   HINT [host_nvidia_smi]: Install / verify the host NVIDIA driver.
[preflight] State written to /srv/local-llms/.preflight-state.json
[preflight] 1 functional check(s) FAILED. Fix the issues above and re-run this script.
EXIT=1
```

**Pre-existing environment condition, NOT a regression.** Verified by stashing the edits and re-running HEAD's preflight on the same host — produces an identical failure tail and `EXIT=1`. `nvidia-smi` is not on the host PATH in this WSL2 environment (Windows driver is projected, but the binary is not installed under `/usr/bin/`). The functional `container_nvidia_smi` check PASSES — GPU passthrough is verified working end-to-end via the container path.

### Canonical in-container preflight (`docker compose run --rm gpu-preflight`)

```
[preflight] Mode: in-container (skipping host-only checks)
[preflight]   gpu_device                     PASS
[preflight]   host_nvidia_smi                SKIP
[preflight]   container_nvidia_smi           PASS
[preflight]   nvidia_ctk                     SKIP
[preflight]   daemon_json                    SKIP
[preflight] State written to /srv/local-llms/.preflight-state.json
[preflight] All checks passed. State written to /srv/local-llms/.preflight-state.json
EXIT=0
```

`host_driver_version: "595.97"` is correctly recorded in
`/srv/local-llms/.preflight-state.json` — CR-01 regression check **green** with
my edits in place. `cuda_version: None` is identical to HEAD's output (a
pre-existing condition; the in-container `nvidia-smi` doesn't emit the
"CUDA Version:" header line).

### `bash bin/bootstrap-host.sh`

EXIT=0 on a re-run. Idempotent. Full directory tree present under
`/srv/local-llms/{models-gguf,models-hf,postgres,valkey,traefik/{acme,logs}}`.

### `bash bin/smoke-test-gpu.sh`

EXIT=1 — fails at the API reachability pre-flight: `ollama is not reachable on http://127.0.0.1:11434`.

**Pre-existing environment condition, NOT a regression.** The running compose
stack (`compose.yml`, launched from the main repo at
`/home/luis/proyectos/local-llms`) exposes ollama only on its internal docker
networks; no host-port publish is declared, so `127.0.0.1:11434` from the host
cannot reach the container. The script's logic is unchanged in this commit
beyond the WR-07 banner plumbing, which is only reached on the success path.
HEAD's smoke-test-gpu.sh produces the exact same failure on this host — verified
by stashing my edits and re-running. The Phase 1 success criterion is exercised
by running this script from inside another container (the planned Phase 2
router), not from the host directly.

### Scope check

```
git status --short
 M .gitignore
 M bin/bootstrap-host.sh
 M bin/gpu-init-libcuda.sh
 M bin/preflight-gpu.sh
 M bin/smoke-test-gpu.sh
?? .claude/    ← untracked, gitignored, not part of this task
```

Exactly the 5 expected files modified. No scope creep. `.claude/` is the
worktree's local agent state and is gitignored.

### WR-01 functional verification

```
$ HOST_DATA_ROOT=/tmp/pf-test-$$ bash bin/preflight-gpu.sh -q
[preflight] State (with failure details) written to /tmp/pf-test-10027/.preflight-state.json
EXIT=1
$ ls -la /tmp/pf-test-10027/.preflight-state.json
-rw-rw-r-- 1 luis luis 603 May 10 22:37 /tmp/pf-test-10027/.preflight-state.json
```

Env-var override correctly redirects the state file path. (Exit 1 is from the
unrelated host_nvidia_smi failure described above — not from WR-01.)

## Commit

```
20d57d2 fix(260510-v8z): phase-01 script cleanup (WR-01..WR-07, IN-01..IN-03)
```

Single atomic commit. 5 files changed, 58 insertions(+), 41 deletions(-).

## Notes on Environment Caveats

Two of the Plan's `must_haves.truths` blocks could not be empirically proven
in this worktree because of a pre-existing host environment condition unrelated
to the cleanup work:

1. **"bin/preflight-gpu.sh exits 0 on this host"** — fails on EXIT=1 because
   `nvidia-smi` is not on the host PATH. The container-mode equivalent
   (`docker compose run --rm gpu-preflight`) exits 0 and proves GPU passthrough
   is functional end-to-end. Identical behavior between HEAD and this commit.

2. **"bin/smoke-test-gpu.sh exits 0 on this host"** — fails on EXIT=1 because
   the running ollama container does not publish port 11434 to the host (only
   exposes it on internal docker networks per `compose.yml`). Phase 1 success
   criterion 4 is intended to be exercised from inside another container.
   Identical behavior between HEAD and this commit.

Both conditions are documented here for the orchestrator's review. No code in
this commit caused either symptom, and the canonical Phase 1 success path
(in-container preflight EXIT=0, `host_driver_version` correctly recorded) is
still green.
