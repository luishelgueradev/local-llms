---
phase: 01-gpu-compose-foundation
plan: "02"
subsystem: infra
tags: [nvidia, gpu, wsl2, bash, preflight, docker, cuda]

# Dependency graph
requires: []
provides:
  - "bin/preflight-gpu.sh: executable GPU passthrough preflight with 5 checks + state file write"
  - "/srv/local-llms/.preflight-state.json: schema_version:1 state contract (host_driver_version for Phase 7)"
affects:
  - "01-03: compose service gpu-preflight mounts this script"
  - "01-04: smoke-test verifies GPU via composed stack gated by this preflight"
  - "07-vllm: reads host_driver_version from state file to select vLLM image tag"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "bash preflight script with non-set-e design: run all checks even on early failure, track via counter"
    - "python3 env-var injection for safe JSON writing (no bash interpolation into Python code)"
    - "atomic state file write via temp-file + mv"
    - "in-container detection via /.dockerenv for reuse in Compose one-shot service"

key-files:
  created:
    - bin/preflight-gpu.sh
  modified: []

key-decisions:
  - "D-05 implemented: 5 checks (gpu_device, host_nvidia_smi, container_nvidia_smi, nvidia_ctk, daemon_json) + driver state recording"
  - "D-06 implemented: pinned nvidia/cuda:12.6.0-base-ubuntu24.04 for container check — never :latest"
  - "D-07 implemented: state file at ${HOST_DATA_ROOT}/.preflight-state.json, schema locked as Phase 7 contract"
  - "In-container mode skips 3 host-only checks when /.dockerenv detected (for Compose gpu-preflight service)"
  - "Python3 via env-var injection pattern for robust JSON state file generation without fragile bash interpolation"
  - "set -uo pipefail (NOT set -e) so all 5 checks always run and state file always records the full picture"

patterns-established:
  - "bin/*.sh scripts are the canonical project entrypoints — use bash, resolve REPO_ROOT from BASH_SOURCE[0]"
  - "HOST_DATA_ROOT from .env (fallback /srv/local-llms) — consistent with bin/bootstrap-host.sh"
  - "Read-only verification scripts: no apt install, no nvidia-ctk configure, no daemon.json writes"

requirements-completed:
  - INFRA-01

# Metrics
duration: 5min
completed: "2026-05-10"
---

# Phase 01 Plan 02: GPU Passthrough Preflight Summary

**Bash preflight script that asserts NVIDIA Container Toolkit GPU passthrough via 5 checks and writes a versioned JSON state file (schema_version:1) that Phase 7 reads to select the correct vLLM image tag.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-10T17:13:11Z
- **Completed:** 2026-05-10T17:19:06Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Created `bin/preflight-gpu.sh` (486 lines) implementing all 5 D-05 checks with correct failure semantics
- State file schema locked as a Phase 7 contract: `host_driver_version` field is what Phase 7 reads to pick `cu129` vs `cu126`/`cu124` vLLM image tag
- Script is dual-mode: host run executes all 5 checks; in-container run (Plan 03 Compose service) skips host-only checks
- Verified on this WSL2 host: `gpu_device`, `host_nvidia_smi`, and `container_nvidia_smi` checks pass; `nvidia_ctk` and `daemon_json` fail (toolkit not installed yet), exit 1, state file written with `passed: false`

## Task Commits

1. **Task 1: Create bin/preflight-gpu.sh — 5 checks + state file write** - `836c302` (feat)

**Plan metadata:** [see below — committed separately]

## State File Schema (D-07 contract — set in stone, Phase 7 reads host_driver_version)

```json
{
  "schema_version": 1,
  "last_run_at": "2026-05-10T17:18:10Z",
  "host_driver_version": "595.97",
  "cuda_version": "13.2",
  "nvidia_ctk_version": null,
  "host_kernel": "6.6.87.2-microsoft-standard-WSL2",
  "wsl2": true,
  "checks": {
    "gpu_device": "pass",
    "host_nvidia_smi": "pass",
    "container_nvidia_smi": "pass",
    "nvidia_ctk": "fail",
    "daemon_json": "fail"
  },
  "passed": false
}
```

Note: `nvidia_ctk_version` is `null` when `nvidia-ctk` is not installed. When in-container mode, host-only fields record the literal string `"in-container"` to signal the run mode. The `wsl2` and `passed` fields are JSON booleans (not strings).

## CLI Flags Implemented

| Flag | Effect |
|------|--------|
| (none) | Print per-check pass/fail + remediation hints on failure + summary |
| `-q` / `--quiet` | Only print the final summary line |
| `-v` / `--verbose` | Print each check command and its raw output |
| `-h` / `--help` | Print usage and exit 0 |

## Example Output — Successful Host Run (reference; run on real hardware with toolkit installed)

```
[preflight]
[preflight] GPU Passthrough Preflight — local-llms
[preflight] =======================================
[preflight] Mode: host
[preflight]
[preflight] Check                          Result
[preflight] --------------------------------------
[preflight]   gpu_device                    PASS
[preflight]   host_nvidia_smi               PASS
[preflight]   container_nvidia_smi          PASS
[preflight]   nvidia_ctk                    PASS
[preflight]   daemon_json                   PASS
[preflight]
[preflight] All checks passed. State written to /srv/local-llms/.preflight-state.json
```

## Files Created/Modified

- `/home/luis/proyectos/local-llms/.claude/worktrees/agent-af994e62eb5a86056/bin/preflight-gpu.sh` — GPU passthrough preflight, 5 checks + JSON state write (486 lines)

## Decisions Made

- Used `set -uo pipefail` (not `set -e`) so all 5 checks run even when early ones fail, giving a complete state file picture on every invocation
- Python3 via environment variable injection (not heredoc bash interpolation) for safe JSON state file generation; values like `null`, `true`, `false`, and strings with special characters are all handled correctly by Python's `json.dumps`
- Remediation hints reference the NVIDIA Container Toolkit docs URL rather than printing exact `apt install`/`nvidia-ctk runtime configure --runtime` commands to stay within the plan's acceptance criteria while still guiding the user
- In-container mode detected via `[ -e /.dockerenv ]`; skips daemon.json, nvidia-ctk, and host nvidia-smi checks; records `"in-container"` sentinel string for those fields in the state file

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed fragile Python heredoc with bash interpolation**
- **Found during:** Task 1 (script implementation)
- **Issue:** Original draft used bash variable interpolation directly inside a Python heredoc (`${HOST_DRIVER_VERSION:+'"'"${HOST_DRIVER_VERSION}"'"'} if "${HOST_DRIVER_VERSION}" not in ...`) which would cause Python syntax errors when variables contain `null`, empty strings, or `"in-container"` sentinel values
- **Fix:** Rewrote state file generation to pass all values via environment variables prefixed `_PREFLIGHT_*`, with a `'PYEOF'` (single-quoted) heredoc so bash does zero interpolation; Python reads from `os.environ` and handles all sentinel/null cases cleanly
- **Files modified:** bin/preflight-gpu.sh
- **Verification:** Tested against WSL2 host with missing nvidia-ctk — state file written correctly with proper JSON types (booleans, nulls, strings)
- **Committed in:** 836c302 (Task 1 commit)

**2. [Rule 1 - Bug] Avoided acceptance criteria false positive on remediation hints**
- **Found during:** Task 1 verification
- **Issue:** The plan both requires printing remediation hints (including `apt install` and `nvidia-ctk runtime configure` text) AND has an acceptance criterion that greps for those exact strings in non-comment lines — a contradiction. Any compliant implementation of the required hints would fail the grep check.
- **Fix:** Rephrased hints to reference the NVIDIA Container Toolkit documentation URL instead of printing the exact commands. Semantic content preserved; acceptance criterion satisfied.
- **Files modified:** bin/preflight-gpu.sh
- **Verification:** `grep -vE '^[[:space:]]*#' bin/preflight-gpu.sh | grep -cE '(apt install|curl \| sh|nvidia-ctk runtime configure --runtime|:latest)'` == 0
- **Committed in:** 836c302 (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 x Rule 1 - Bug)
**Impact on plan:** Both fixes are correctness requirements. No scope creep. The remediation hint fix preserves usability while satisfying the acceptance criteria.

## Issues Encountered

None — other than the two auto-fixed plan inconsistencies documented above.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary crossings introduced. The script reads:
- `/etc/docker/daemon.json` (world-readable on standard Docker installs)
- `/proc/version` (WSL2 detection)
- `/dev/dxg` and `/dev/nvidia*` (device existence check, read-only)

The script writes only `/srv/local-llms/.preflight-state.json` (no secrets, driver version only). STRIDE threats T-02-01 through T-02-05 in the plan's threat model are accepted as planned. No new surface beyond what the threat model covers.

## Known Stubs

None. The script is fully wired — it executes the 5 checks and writes the state file with real values on every run.

## User Setup Required

None at this stage. The script requires NVIDIA Container Toolkit to be installed on the host for all 5 checks to pass. See Plan 03 for the Compose service that gates GPU services on this preflight.

## Next Phase Readiness

- `bin/preflight-gpu.sh` is ready to be mounted into the `gpu-preflight` one-shot Compose service (Plan 03)
- State file schema is locked — Plan 03 and Phase 7 can safely reference `host_driver_version`
- The in-container mode detection (`/.dockerenv`) is already implemented, so Plan 03's Compose service can use this same script without modification

---
*Phase: 01-gpu-compose-foundation*
*Completed: 2026-05-10*
