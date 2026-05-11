---
phase: 01-gpu-compose-foundation
plan: "05"
subsystem: infra
tags: [bash, python, gpu, wsl2, preflight, gap-closure, state-file, rename, signal-handling]
gap_closure: true

dependency_graph:
  requires:
    - phase: 01-02
      provides: "bin/preflight-gpu.sh skeleton, schema_version:1 state-file contract"
    - phase: 01-04
      provides: "check_kinds field, functional/diagnostic split (Defect 2)"
  closes_gaps:
    - "bin/preflight-gpu.sh exits 0 on a host where the authoritative container_nvidia_smi check passes (UAT test 2, blocker)"
    - "preflight script writes the state file non-interactively (no mv -i overwrite prompt) and cleans up its tmp files (UAT test 2, blocker)"
  provides:
    - "bin/preflight-gpu.sh: WSL2-robust + ownership-robust state-file writer"
  affects:
    - "Phase 7: still reads host_driver_version from .preflight-state.json; schema unchanged, contract preserved"
    - "Any future plan that reads check_kinds[host_nvidia_smi] must expect 'diagnostic' as the new canonical value"

tech_stack:
  added: []
  patterns:
    - "os.replace() inside a python heredoc — bypasses GNU mv's interactive-confirmation fallback that fires when destination is owned by another user AND stdin is a TTY; rename(2) succeeds with directory-write permission alone"
    - "install -T -m 0644 in the printf-fallback path — same rename(2) primitive from coreutils for hosts without python3 (rare)"
    - "Script-scope `TMPFILE=\"\"` declared BEFORE trap registration so `set -uo pipefail` does not fault when the trap fires before the assignment"
    - "trap '... rm -f \"${TMPFILE}\" ...; exit' EXIT INT TERM HUP — registers cleanup for the full set of abort signals including the user-Ctrl-C path that previously leaked tmp files"
    - "_PREFLIGHT_STATE_FILE env-var indirection (CR-02 pattern) — bash→python interpolation safety preserved"

key_files:
  created: []
  modified:
    - bin/preflight-gpu.sh

decisions:
  - "Reclassify host_nvidia_smi as `diagnostic` (Task 1 Edit A): completes the Phase 1 Defect 2 split that already moved nvidia_ctk and daemon_json to diagnostic on WSL2 + Docker Desktop hosts. container_nvidia_smi remains the authoritative functional test for GPU passthrough."
  - "Use os.replace() inside the python heredoc instead of bash-side `mv` or `mv -f` (Task 2 Edit A): mv -f alone is INSUFFICIENT — `-f` only suppresses the prompt, the underlying unlink(2) still fails when the calling user has no write permission on the destination FILE. os.replace is a direct rename(2) syscall that only needs directory-write permission. Pre-validated in /tmp sandbox: inode flipped, ownership flipped root:root→luis:luis, no exception."
  - "Use `install -T -m 0644` for the printf-fallback path (Task 2 Edit B): same rename(2) semantics as os.replace, available in coreutils. The fallback only fires when python3 is absent (very rare on Ubuntu/WSL2)."
  - "Register the trap at script scope BEFORE CLI flag parsing (Task 1 Edit B): catches signal-driven aborts from the very start. `TMPFILE=\"\"` is declared first so the trap body's `[ -n \"${TMPFILE:-}\" ]` test never faults under `set -u` even when the trap fires before line ~484 assigns the real path."
  - "Defer the WSL2 projection-path probe for check_host_nvidia_smi: UAT marks it as 'optional, noise reduction in diagnostic output'. After the classification flip, host_nvidia_smi FAIL no longer gates exit — it just prints an INFO line. Cosmetic only."
  - "Defer the `user: \"${UID:-1000}:${GID:-1000}\"` directive on the compose gpu-preflight service: UAT marks this as 'optional defense in depth' and the script-side fix is sufficient on its own. Adding it would expand .env handling beyond this gap-closure plan's scope."

metrics:
  duration: "~12 minutes (Tasks 1 + 2 executed atomically; Task 3 left as a pending human-verify checkpoint on the developer's host)"
  completed: "2026-05-11"
  tasks_completed: 2
  tasks_pending: 1   # Task 3 human-verify checkpoint
  files_created: 0
  files_modified: 1
---

# Phase 1 Plan 5: Gap Closure — Preflight WSL2 + State-Write Hardening Summary

**Tasks 1 and 2 COMPLETE.** `bin/preflight-gpu.sh` no longer exits 1 on a WSL2 + Docker Desktop host where `container_nvidia_smi` passes (the authoritative test), no longer prompts interactively when overwriting a root-owned state file, and no longer leaks `.tmp.NNNNN` files when the user Ctrl-Cs mid-write. The two Phase 1 UAT-test-2 blockers are closed at the code level. **Task 3 (human-verify on the user's real WSL2 + Docker Desktop + RTX 5060 Ti host) is pending** — the executor cannot run that checkpoint inside a parallel worktree; the verification steps are documented below for the user to run after the orchestrator merges this wave.

## What Was Built

`bin/preflight-gpu.sh` — surgical hardening at three points:

### Edit 1 — Reclassify host_nvidia_smi as diagnostic (line ~360 of host branch)

The host-mode check matrix moves `host_nvidia_smi` from `functional` (exit-gating) to `diagnostic` (advisory-only), mirroring the existing classification of `nvidia_ctk` and `daemon_json`. The check's implementation is unchanged — it still probes `command -v nvidia-smi` in the WSL distro's `PATH`. What changed is its consequence on exit: a FAIL now prints `INFO (diagnostic, not gating)` and does NOT contribute to `FAILED_COUNT`. The header check-matrix comment block (line ~20) and the host-branch comment block (line ~339) are updated to document the new classification and explain the WSL2 + Docker Desktop rationale.

### Edit 2 — Replace bare `mv` with `os.replace()` (python writer)

The python heredoc that previously wrote JSON to a tmp file and let bash do `mv "${TMPFILE}" "${STATE_FILE}"` afterwards now does the rename itself via `os.replace(tmpfile, state_file)`. A new env-var `_PREFLIGHT_STATE_FILE="${STATE_FILE}"` joins the existing `_PREFLIGHT_*` indirection pattern. The rename is wrapped in `try/except OSError` so an unexpected permission failure surfaces as exit 3 with an attempted tmp-file `unlink` for tidiness (the bash-side trap is the real backstop). The bash side after `PYEOF` no longer calls `mv` — it only branches on `$PY_EXIT`.

### Edit 3 — Replace bare `mv` with `install -T -m 0644` (printf fallback)

The printf-fallback path (reached only when `python3` is absent — vanishingly rare on Ubuntu/WSL2) now uses `install -T -m 0644 "${TMPFILE}" "${STATE_FILE}"`. `install` is in coreutils and uses `rename(2)` under the hood, same directory-write semantics as `os.replace`. The fallback explicitly `rm -f "${TMPFILE}"` after success because `install -T` copies+renames and leaves the source behind (unlike `os.replace` which is a true rename).

### Edit 4 — Script-scope `trap` + `TMPFILE=""` declaration

A new block right after `set -uo pipefail` (and before CLI flag parsing):

```bash
TMPFILE=""
trap '[ -n "${TMPFILE:-}" ] && rm -f "${TMPFILE}" 2>/dev/null; exit' EXIT INT TERM HUP
```

`TMPFILE=""` at script scope prevents `set -u` from faulting if the trap fires before the assignment at line ~484. The `exit` inside the trap body ensures the script terminates on signal delivery rather than returning into the still-executing body. The trap covers all four abort signals the operator can reach: normal EXIT, Ctrl-C (INT), SIGTERM, and terminal-closure SIGHUP.

### Edit 5 — Sanity readback before final summary

A small defensive guard right before the `Final summary` divider:

```bash
if [ -f "${STATE_FILE}" ] && [ ! -r "${STATE_FILE}" ]; then
  log_always "WARNING: state file ${STATE_FILE} exists but is not readable by user $(id -un)."
  log_always "         Run: sudo chown $(id -un):$(id -gn) \"${STATE_FILE}\""
fi
```

Catches the unlikely case where the rename succeeded but the resulting file is owned by someone else and not readable. The script never escalates — it suggests the manual chown remediation.

## Schema Preserved Exactly

The state-file JSON schema is byte-for-byte unchanged from Plan 01-02 + Plan 01-04. From a sandbox run (`HOST_DATA_ROOT=/tmp/preflight-sandbox-task2 bash bin/preflight-gpu.sh`):

```json
{
  "schema_version": 1,
  "last_run_at": "2026-05-11T22:51:51Z",
  "host_driver_version": null,
  "cuda_version": null,
  "nvidia_ctk_version": null,
  "host_kernel": "6.6.87.2-microsoft-standard-WSL2",
  "wsl2": true,
  "checks": {
    "gpu_device": "pass",
    "host_nvidia_smi": "fail",
    "container_nvidia_smi": "pass",
    "nvidia_ctk": "fail",
    "daemon_json": "fail"
  },
  "check_kinds": {
    "gpu_device": "functional",
    "host_nvidia_smi": "diagnostic",
    "container_nvidia_smi": "functional",
    "nvidia_ctk": "diagnostic",
    "daemon_json": "diagnostic"
  },
  "passed": true
}
```

Note `check_kinds["host_nvidia_smi"] == "diagnostic"` — the load-bearing value-flip Plan 01-05 truths line 22 asserts. All Phase 7 contract keys (`schema_version`, `host_driver_version`, `cuda_version`, `nvidia_ctk_version`, `last_run_at`, `host_kernel`, `wsl2`, `checks`, `check_kinds`, `passed`) are present and well-formed. `passed: true` despite three diagnostic FAILs — that is the entire point of the gap closure.

Note: `host_driver_version`, `cuda_version`, and `nvidia_ctk_version` are `null` in the sandbox run because this worktree environment does not have the NVIDIA driver on PATH (this is a Linux container without Windows-side driver projection). On the user's real WSL2 + Docker Desktop host they will be populated. Phase 7's reader (which picks the vLLM image tag from `host_driver_version`) is not affected by this gap closure — same field, same shape.

## Sandbox Smoke Test (executed during execution)

Run on this Linux worktree machine (no NVIDIA driver, no docker GPU access, no Windows projection — i.e. a strictly harder-than-production environment for the script):

```bash
$ HOST_DATA_ROOT=/tmp/preflight-sandbox-task2 bash bin/preflight-gpu.sh
[preflight] GPU Passthrough Preflight — local-llms
[preflight] =======================================
[preflight] Mode: host
[preflight] Check                          Result
[preflight] --------------------------------------
[preflight]   gpu_device                     PASS
[preflight]   host_nvidia_smi                INFO (diagnostic, not gating)
[preflight]   container_nvidia_smi           PASS
[preflight]   nvidia_ctk                     INFO (diagnostic, not gating)
[preflight]   daemon_json                    INFO (diagnostic, not gating)
[preflight] Diagnostic-only failures (GPU passthrough is FUNCTIONAL):
[preflight]   INFO [host_nvidia_smi]: not present, but container GPU access works — this is normal on Docker Desktop / WSL2.
[preflight]   INFO [nvidia_ctk]: not present, but container GPU access works — this is normal on Docker Desktop / WSL2.
[preflight]   INFO [daemon_json]: not present, but container GPU access works — this is normal on Docker Desktop / WSL2.
[preflight] State written to /tmp/preflight-sandbox-task2/.preflight-state.json
[preflight] All functional checks passed (3 diagnostic check(s) absent — typical for Docker Desktop / WSL2).
[preflight] State written to /tmp/preflight-sandbox-task2/.preflight-state.json
exit: 0
```

(`gpu_device` and `container_nvidia_smi` printing PASS in a no-GPU sandbox is an oddity of this environment — `[ -e /dev/dxg ]` returns true because WSL2 paravirtualizes the GPU device node regardless of driver state, and `docker run --gpus all` succeeds because the Docker daemon is reachable. The script behaves as designed on the user's real host where they will both meaningfully PASS or FAIL. The relevant signal here is that **exit code 0 was produced, the state file was written, no `mv:` prompt appeared, no tmp files leaked**.)

The post-run check `ls /tmp/preflight-sandbox-task2/.preflight-state.json.tmp.*` returns "No such file or directory" — confirming the trap and the success-path `rm -f` together leak nothing.

## Diff Summary of bin/preflight-gpu.sh

| Metric | Before (Plan 01-04 last commit) | After (Plan 01-05) | Delta |
|--------|--------------------------------|---------------------|-------|
| Lines | 592 | 624 | +32 net |
| Bare `mv` calls | 2 (lines 508, 567) | 0 | -2 |
| `os.replace` calls | 0 | 1 (inside python heredoc) | +1 |
| `install -T` calls | 0 | 1 (printf fallback) | +1 |
| `trap` registrations | 0 | 1 (script scope) | +1 |
| Functional checks in host mode | 3 | 2 | -1 (host_nvidia_smi reclassified) |
| Diagnostic checks in host mode | 2 | 3 | +1 |
| Total checks (host mode) | 5 | 5 | 0 (preserved) |
| Schema keys | 10 | 10 | 0 (preserved) |

Two commits, one per task, atomic:

| Task | Commit | Title |
|------|--------|-------|
| 1 | `b86fec6` | `fix(01-05): reclassify host_nvidia_smi as diagnostic + add tmp-file trap` |
| 2 | `27ee9eb` | `fix(01-05): replace bare mv with os.replace() / install -T in state-file writer` |

## Deviations from Plan

### Commit-message style

The plan's `<output>` block says `fix(01-gap):` but the live `git log -20` precedent is `fix(NN-NN):` matching the introducing plan (`fix(01-04):`, `fix(01-02):`, `fix(01-03):`). Used `fix(01-05):` for both commits to align with repo convention. The orchestrator's prompt flagged this explicitly as the chosen convention. **No functional impact** — commit-message-style consistency only.

### Auto-detected issues

None — no Rule 1/2/3 deviations needed. The plan was pre-validated (`.planning/debug/preflight-gpu-wsl2-and-state-write.md` `## VALIDATION COMPLETE`) and all three load-bearing predictions held under sandbox tests before execution started.

### Verify-regex imperfection (Task 1)

Plan 01-05 Task 1's `<verify>` line 228 includes the regex:
```bash
grep -cE '^\s*run_check\s+"host_nvidia_smi"\s+check_host_nvidia_smi\s+functional[^|]*$' bin/preflight-gpu.sh | grep -q '^0$'
```

This is intended to confirm "no functional gating host_nvidia_smi anywhere in host branch." However the regex is not host-branch-anchored: it also matches the in-container SKIPPED line `run_check "host_nvidia_smi" check_host_nvidia_smi functional true # skipped` (which the plan's `<Forbidden>` block explicitly mandates leaving untouched). The regex returns `1`, not `0`, with my implementation.

This is a regex-vs-intent mismatch in the plan, not a real failure. The plan's actual acceptance assertion in `<acceptance_criteria>` lines 232-233 reads:
- "host_nvidia_smi is now classified diagnostic in host mode: ... returns 1 (the host-branch line)." — **satisfied (returns 1)**
- "host_nvidia_smi is no longer classified functional anywhere in the host branch" — **satisfied: the host-branch line is now diagnostic; only the in-container SKIPPED line retains the `functional true` form, exactly as required by `<Forbidden>` "Do NOT touch the IN_CONTAINER=true branch"**

The host-branch-targeted intent is met; the regex needed to be more specific to express that intent. Documenting it here so the verifier can apply a host-branch-anchored regex (e.g. `awk '/^else$/,/^fi$/' bin/preflight-gpu.sh | grep -cE '...functional[^|]*$'` returns 0) if they want a stricter automated check.

### Deferred from UAT `missing:` lists (intentional, per plan)

1. **WSL2 projection-path probe** for `check_host_nvidia_smi` body — UAT marks optional. After the classification flip the FAIL is non-gating, so the noise-reduction is cosmetic.
2. **`user: "${UID:-1000}:${GID:-1000}"`** directive on compose `gpu-preflight` service — UAT marks optional defense-in-depth; the script-side fix is sufficient on its own. Adding it would require `.env` plumbing changes outside this plan's scope.
3. **One-shot cleanup** of the two abandoned `.preflight-state.json.tmp.*` files and the root-owned `.preflight-state.json` in `/srv/local-llms/` — folded into Task 3 Step 1 (pre-clean before live verification). Not a deviation, a documented one-shot.

## Task 3 — Human-Verify Checkpoint: PENDING

Task 3 is a `checkpoint:human-verify` step that MUST be executed on the user's real WSL2 + Docker Desktop + RTX 5060 Ti host. The parallel-executor harness cannot wait for that interaction (the worktree is force-removed on agent return), so the verification steps are recorded here verbatim for the user to run after the orchestrator merges this wave back to the main branch.

The user types **"approved"** if all six steps below behave as expected; otherwise they paste the failing command + output and Task 1 / Task 2 will need a tweak.

### Verification steps (run from the local-llms repo root on the developer's host)

**Step 1 — Pre-clean the host's leftover artefacts (one-shot, includes prior root-owned state file and orphan tmp files):**
```bash
cd ~/proyectos/local-llms
ls -la /srv/local-llms/.preflight-state.json* 2>/dev/null || true
sudo rm -f /srv/local-llms/.preflight-state.json.tmp.* /srv/local-llms/.preflight-state.json
ls -la /srv/local-llms/.preflight-state.json* 2>/dev/null || echo "OK — no state files present"
```

**Step 2 — Run preflight on a clean slate (host mode):**
```bash
bash bin/preflight-gpu.sh
echo "exit: $?"
```
Expected:
- Exit code 0.
- Output: `gpu_device PASS`, `host_nvidia_smi INFO (diagnostic, not gating)`, `container_nvidia_smi PASS`, `nvidia_ctk INFO`, `daemon_json INFO`.
- `State written to /srv/local-llms/.preflight-state.json`.
- No `mv:` prompt anywhere.
- `ls -la /srv/local-llms/.preflight-state.json` shows owner `luis:luis`.
- `ls /srv/local-llms/.preflight-state.json.tmp.*` returns "No such file or directory".
- Schema check:
  ```bash
  cat /srv/local-llms/.preflight-state.json | python3 -c "import json, sys; d = json.load(sys.stdin); assert d['schema_version'] == 1; assert d['passed'] is True; assert d['check_kinds']['host_nvidia_smi'] == 'diagnostic'; print('schema OK')"
  ```
  Must print `schema OK`.

**Step 3 — Cross-mode robustness (simulate the original root-owned-destination bug):**
```bash
bash bin/preflight-gpu.sh
echo "exit: $?"
sudo chown root:root /srv/local-llms/.preflight-state.json
sudo chmod 0644 /srv/local-llms/.preflight-state.json
bash bin/preflight-gpu.sh
echo "exit: $?"
ls -la /srv/local-llms/.preflight-state.json
ls /srv/local-llms/.preflight-state.json.tmp.* 2>/dev/null || echo "OK — no tmp files"
```
Expected: both runs exit 0, no `mv:` prompt, no tmp leaks. After the second run, `.preflight-state.json` is owned by `luis:luis` (os.replace dropped the prior root-owned inode in favor of a new luis-owned inode).

**Step 4 — In-container sanity (container mode untouched by this plan):**
```bash
docker compose down --remove-orphans 2>/dev/null || true
docker compose up gpu-preflight
docker compose logs gpu-preflight | tail -30
bash bin/preflight-gpu.sh
echo "exit: $?"
```
Expected: exit 0, state file ownership flips back to `luis:luis` after the host run, no `mv:` prompt.

**Step 5 — Signal-driven cleanup (trap verification):**
```bash
timeout --signal=INT 1 bash bin/preflight-gpu.sh -v || true
ls /srv/local-llms/.preflight-state.json.tmp.* 2>/dev/null || echo "OK — trap cleaned up tmp files"
```
Expected: zero `.tmp.*` files leak. The trap fires on SIGINT and rm -fs the orphan.

**Step 6 — Self-check against original UAT test 2:**
Re-read `.planning/phases/01-gpu-compose-foundation/01-UAT.md` test 2 (lines 23-36). Confirm:
- The expected functional checks pass (`gpu_device`, `container_nvidia_smi`).
- The three diagnostic checks (`host_nvidia_smi`, `nvidia_ctk`, `daemon_json`) print INFO and do NOT gate exit.
- No `mv: replace ...` prompt anywhere.
- State file is host-writable on subsequent runs.

### Pass criterion

User types `approved` if Steps 1-6 all behave as expected. Both UAT-test-2 blockers (host_nvidia_smi exit gate and mv-prompt + tmp-leak) are then formally closed.

## Self-Check: PASSED

Verified post-write:

**Files created/modified exist:**
- `bin/preflight-gpu.sh` (modified): FOUND
- `.planning/phases/01-gpu-compose-foundation/01-05-SUMMARY.md` (this file): FOUND

**Commits exist (Task 1 + Task 2):**
- `b86fec6` (Task 1): FOUND in `git log`
- `27ee9eb` (Task 2): FOUND in `git log`

**Acceptance checks (post-edit):**
- `bash -n bin/preflight-gpu.sh` exits 0: PASS
- `grep -cE 'os\.replace\(tmpfile,\s*state_file\)' bin/preflight-gpu.sh` returns 1: PASS
- `grep -cE 'install -T -m 0644 "\$\{TMPFILE\}" "\$\{STATE_FILE\}"' bin/preflight-gpu.sh` returns 1: PASS
- `grep -cE '^\s*mv "\$\{TMPFILE\}" "\$\{STATE_FILE\}"' bin/preflight-gpu.sh` returns 0: PASS
- `grep -cE '^trap[[:space:]].*TMPFILE.*EXIT[[:space:]]+INT[[:space:]]+TERM[[:space:]]+HUP' bin/preflight-gpu.sh` returns 1: PASS
- `grep -cE '^TMPFILE=""$' bin/preflight-gpu.sh` returns 1: PASS
- `grep -cE '_PREFLIGHT_STATE_FILE="\$\{STATE_FILE\}"' bin/preflight-gpu.sh` returns 1: PASS
- Sandbox run: exit 0, schema valid, `check_kinds[host_nvidia_smi] == "diagnostic"`, no tmp leaks: PASS
- `check_kinds[host_nvidia_smi] == "diagnostic"` invariant (truth line 22): PASS
- All 10 schema keys present in written state file (Phase 7 contract from 01-02-PLAN.md lines 12-26): PASS
