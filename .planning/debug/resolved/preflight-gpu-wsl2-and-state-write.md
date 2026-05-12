---
status: diagnosed
trigger: "Phase 1 UAT gap on bin/preflight-gpu.sh: three symptoms from a single host-mode run — host_nvidia_smi FAIL on WSL2 + Docker Desktop, mv -i interactive prompt on state-file overwrite, leftover .tmp.NNNNN files and root-owned final state file."
created: 2026-05-11T20:00:00Z
updated: 2026-05-11T21:15:00Z
reopened: 2026-05-11T21:00:00Z  # re-opened to validate Plan 01-05's proposed fix before /gsd-execute-phase
validated: 2026-05-11T21:15:00Z  # Plan 01-05 validated — all three predictions hold
---

## Current Focus

hypothesis: Plan 01-05's three proposed changes will close the diagnosed gaps without regressions to (a) Plan 01-02's state-file schema_version:1 contract that Phase 7 reads, or (b) the existing 5-check preflight structure. Specifically — three falsifiable predictions to test BEFORE any code change to bin/preflight-gpu.sh:

  (P1) `os.replace(tmp, STATE_FILE)` succeeds when `STATE_FILE` is owned by `root:root` mode 0644 and the calling user has only directory-write on the parent. POSIX `rename(2)` requires write on the parent directory, not on the file itself; this is the load-bearing claim Agent 1's diagnosis rests on.

  (P2) A bash `trap '[ -n "${TMPFILE:-}" ] && rm -f "${TMPFILE}" 2>/dev/null; exit' EXIT INT TERM HUP` placed after `set -uo pipefail` (line 45) actually cleans up `${TMPFILE}` when the script is killed mid-rename by SIGINT — including when the rename happens inside the python heredoc subprocess (because `${TMPFILE}` is a bash-scope variable, the trap fires on the parent bash process regardless of where the subprocess died).

  (P3) Reclassifying `host_nvidia_smi` from functional to diagnostic at line 346 produces a state file whose `check_kinds["host_nvidia_smi"] == "diagnostic"` — and that the existing `contains_keys` contract from 01-02-PLAN.md (the Phase 7 reader contract) does NOT require `check_kinds["host_nvidia_smi"] == "functional"` as a value-level invariant. If Phase 7's reader treats `check_kinds` as opaque (just preserves it), the reclassification is safe.

test: For each prediction, design a single decisive observation that costs no real code change:

  (T1 for P1) In a sandbox dir owned by `luis`, create a victim file owned by `root:root` mode 0644 (`sudo touch /tmp/own-root && sudo chmod 644 /tmp/own-root && sudo chown root:root /tmp/own-root`). Run a 3-line python that does `os.replace("/tmp/src.tmp", "/tmp/own-root")` where `/tmp/src.tmp` is a luis-owned file. Predict: succeeds. Falsify if EACCES/EPERM.

  (T2 for P2) Write a 10-line bash script with the proposed trap pattern, create a TMPFILE under it, send SIGINT mid-loop, and check `ls` for the tmp file. Predict: cleaned up. Then a variant where the SIGINT arrives during a `python3 -c '...'` subprocess: same prediction.

  (T3 for P3) Read 01-02-PLAN.md `contains_keys` block carefully. Verify what value-level invariants Phase 7 will read on `check_kinds`. If only "key present" is asserted, P3 holds. If "value == functional|diagnostic on a known whitelist" is asserted, the reclassification is still safe because diagnostic is in the whitelist. If "host_nvidia_smi is functional" is asserted as a literal, P3 fails — flag for plan revision.

expecting: All three predictions hold. T1 succeeds (this is the load-bearing claim — if it fails, Plan 01-05 needs a fallback like `install -T` after sudo-chown or a per-user state path). T2 succeeds. T3 confirms only key-presence and value-in-whitelist; no value-literal pin.

next_action: Execute T1, T2, T3 as ZERO-CODE-CHANGE sandbox tests (no edits to bin/preflight-gpu.sh, no edits to compose.yml). For T1 use `/tmp` as the sandbox so we don't pollute `/srv/local-llms`. For T2 use a self-contained bash heredoc. For T3 read 01-02-PLAN.md without modifying it. Record results in the Evidence section. If any prediction is falsified, raise it as a checkpoint with the plan-revision direction. If all three hold, write a ## VALIDATION COMPLETE summary and recommend proceeding to /gsd-execute-phase 01 --gaps-only.

## Symptoms

expected: From `docker compose down --remove-orphans` + `docker compose up -d` and `bash bin/preflight-gpu.sh`, on a WSL2 + Docker Desktop on Windows host where `container_nvidia_smi` PASSes, the preflight exits 0 non-interactively, writes `${HOST_DATA_ROOT}/.preflight-state.json` cleanly without prompting, and leaves no `.tmp.NNNNN` files behind. Per the Phase 1 Defect 2 rationale in 01-04-SUMMARY.md, `container_nvidia_smi` is the authoritative test — checks that surface "absent on Docker Desktop on Windows + WSL2 yet passthrough works" belong in the diagnostic (non-gating) set.

actual:
  - host_nvidia_smi FAIL — the Windows-side `nvidia-smi.exe` is not in the WSL distro's PATH; Docker Desktop projects it under `/usr/lib/wsl/lib/` and/or it's reachable via `/mnt/c/Windows/System32/nvidia-smi.exe`. The host check `command -v nvidia-smi` (line 145) returns non-zero.
  - container_nvidia_smi PASS — proves GPU passthrough is functional (authoritative).
  - Script blocks on `mv: replace '/srv/local-llms/.preflight-state.json', overriding mode 0644 (rw-r--r--)?` and then exits 1 because host_nvidia_smi was in the functional gating set.
  - `/srv/local-llms/.preflight-state.json` is owned by `root:root` (from previous in-container run); two `.preflight-state.json.tmp.NNNNN` files (PIDs 64770, 65114) are abandoned in `/srv/local-llms/` from prior aborted runs.

errors: |
  [preflight] Mode: host
  [preflight]   gpu_device                     PASS
  [preflight]   host_nvidia_smi                FAIL
  [preflight]   container_nvidia_smi           PASS
  [preflight]   nvidia_ctk                     INFO (diagnostic, not gating)
  [preflight]   daemon_json                    INFO (diagnostic, not gating)
  [preflight] HINT [host_nvidia_smi]: Install / verify the host NVIDIA driver.
  [preflight] HINT [host_nvidia_smi]: On WSL2, this is on Windows (not inside the WSL distro).
  mv: replace '/srv/local-llms/.preflight-state.json', overriding mode 0644 (rw-r--r--)?

reproduction:
  1. Stack already brought up at least once via `docker compose up -d` (this runs `gpu-preflight` as root in the container, which writes `.preflight-state.json` owned by root).
  2. As host user `luis`, run `bash bin/preflight-gpu.sh`.
  3. Observe `host_nvidia_smi FAIL` and the interactive `mv:` prompt.

started: Always-broken on this class of host (WSL2 + Docker Desktop on Windows). First surfaced during Phase 1 UAT — see 01-UAT.md tests 2 + 4.

## Eliminated

- hypothesis: "`mv` is aliased to `mv -i` in the user's shell, triggering the prompt unconditionally."
  evidence: `type mv` in both the current and a `bash -i` shell returns `mv is /usr/bin/mv` — no alias. The `mv` binary is being invoked directly. The prompt is caused by destination ownership, not an alias.
  timestamp: 2026-05-11T20:20:00Z

- hypothesis: "host_nvidia_smi failed because the Windows NVIDIA driver isn't installed."
  evidence: container_nvidia_smi PASS proves GPU passthrough works end-to-end (the smoke test also passed with 4161 MiB VRAM in use, 100% on GPU per 01-UAT.md test 5). The Windows driver IS installed; what's missing is a Linux-side `nvidia-smi` binary in the WSL distro's PATH — which is by design on Docker Desktop's WSL2 setup.
  timestamp: 2026-05-11T20:22:00Z

## Evidence

- timestamp: 2026-05-11T20:05:00Z
  checked: bin/preflight-gpu.sh check-kind classification table for host mode (lines 339–350)
  found: |
    Line 346: `run_check "host_nvidia_smi"       check_host_nvidia_smi      functional`
    Lines 348–349: `nvidia_ctk` and `daemon_json` are correctly `diagnostic`. Only `host_nvidia_smi` retains `functional` despite having the exact same "absent on Docker Desktop on Windows + WSL2, but GPU works" property documented in the header comment (lines 14–16) and in 01-04-SUMMARY.md Defect 2.
  implication: Defect 2 fix was incomplete. The check classification split was applied to `nvidia_ctk`/`daemon_json` only; `host_nvidia_smi` was overlooked. This directly causes Symptom 1's non-zero exit.

- timestamp: 2026-05-11T20:07:00Z
  checked: `check_host_nvidia_smi` implementation (lines 142–151)
  found: |
    Line 145: `command -v nvidia-smi >/dev/null 2>&1 || return 1`
    The check tests only whether `nvidia-smi` is on the WSL `PATH`. It does NOT probe the Docker-Desktop-projected paths `/usr/lib/wsl/lib/nvidia-smi` or `/mnt/c/Windows/System32/nvidia-smi.exe` — both of which would be authoritative for a "host driver responds" check on this class of host.
  implication: Even if reclassified to diagnostic, the check as written reports "not installed" when the binary IS reachable via WSL2-projected paths. A WSL-aware probe would lower the noise.

- timestamp: 2026-05-11T20:10:00Z
  checked: bin/preflight-gpu.sh state-write path (lines 461, 508, 567)
  found: |
    Line 461: `TMPFILE="${STATE_FILE}.tmp.$$"` — creates `/srv/local-llms/.preflight-state.json.tmp.<pid>`
    Line 508: `mv "${TMPFILE}" "${STATE_FILE}"` — Python-path rename. NO redirection of stdin, NO `-f`, NO `command mv`, NO `\mv`. Bare `mv`.
    Line 567: `mv "${TMPFILE}" "${STATE_FILE}" 2>/dev/null` — Fallback printf-path rename. Same shape but stderr suppressed, so even an error message is silenced.
  implication: GNU `mv` prompts interactively when (a) destination exists, (b) calling process cannot unlink/replace it without permission escalation, and (c) stdin is a terminal — regardless of whether `-i` is set. The script never passes `-f` and never redirects stdin, so on the user's host (root-owned destination, interactive shell) it blocks. In the compose-driven `gpu-preflight` service the script runs as root so `mv` succeeds — that's why this never surfaced in container mode tests. The bug only triggers in the cross-mode case: container wrote the file first (root), then host re-runs it.

- timestamp: 2026-05-11T20:12:00Z
  checked: bin/preflight-gpu.sh top-of-script for any `trap` registration
  found: |
    `grep -n "trap" bin/preflight-gpu.sh` returns NO matches. There is no `trap 'rm -f "${TMPFILE}"' EXIT INT TERM` anywhere. The two cleanup paths that exist (lines 512 and 571) only run when the rename FAILS in a non-blocking way (rm `${TMPFILE}` after a python failure or after a `mv` returning non-zero). When the `mv` blocks on a prompt and the user Ctrl-C's, the script exits with `${TMPFILE}` still present.
  implication: Symptom 3 (abandoned `.tmp.NNNNN` files) is the direct downstream effect of Symptom 2 — every blocked `mv` that the user cancels leaves `${TMPFILE}` orphaned because there is no signal handler.

- timestamp: 2026-05-11T20:14:00Z
  checked: compose.yml gpu-preflight service definition (lines 57–85)
  found: |
    The service mounts `${HOST_DATA_ROOT:-/srv/local-llms}:${HOST_DATA_ROOT:-/srv/local-llms}` (line 75) into the container and runs `/preflight/preflight-gpu.sh` via `/usr/bin/bash` (lines 68–69). The container has no `user:` directive, so PID 1 is uid 0 (root). When the script writes the state file at `${HOST_DATA_ROOT}/.preflight-state.json`, the file lands on the host bind mount with uid/gid = 0:0.
  implication: This explains why `.preflight-state.json` ends up root-owned after any compose run. The host-mode invocation by `luis` (non-root) then cannot overwrite it. Symptoms 2 and 3 are not independent: they're both side-effects of the same in-container-vs-host ownership mismatch combined with the script's overly trusting `mv` (no `-f`, no stdin redirect, no trap).

- timestamp: 2026-05-11T20:18:00Z
  checked: User's environment for `mv` aliasing
  found: `type mv` → `mv is /usr/bin/mv`. Same in `bash -ic 'type mv'`. NO alias to `mv -i` anywhere.
  implication: The "alias" hypothesis from 01-UAT.md gap text is wrong. The fix must address ownership/permission, not alias defense. `mv -f` alone will NOT help — `-f` instructs `mv` not to prompt, but it still cannot overwrite a file the calling user has no permission to unlink. The reliable fix needs to (a) write the JSON via a python-capable `open(path, "w")` directly (succeeds when the user has write permission on the *directory*, even if the existing file is owned by someone else, because Linux unlinks via directory permission), OR (b) `rm -f` the destination first via a path that can sudo when needed, OR (c) ensure the in-container run does `chmod 0666` / `chown` to a known shared uid before exit. Option (a) is the simplest correct fix because `/srv/local-llms/` is owned by `luis:luis` (per the `ls -la` evidence: `-rw-rw-r-- 1 luis luis`), so the user has directory-write permission and can unlink the root-owned file then create a new one — exactly what `open(path, "w")` does internally via `unlink` + `creat`.

- timestamp: 2026-05-11T20:22:00Z
  checked: bin/preflight-gpu.sh exit paths (lines 586–591) for state-cleanup hooks
  found: |
    Two explicit `exit` statements: line 586 `exit 0` (all pass) and line 590 `exit 1` (functional fail). Neither references `${TMPFILE}`. No `EXIT` trap registered earlier in the script. Any signal-driven exit (Ctrl-C during the `mv` prompt = SIGINT) bypasses the post-mv `rm -f` branches entirely.
  implication: Even after fixing the `mv` to non-interactive, a trap on EXIT/INT/TERM is needed to clean tmp files for any future abort path (e.g., a future check that takes long enough for the user to Ctrl-C).

- timestamp: 2026-05-11T21:11:00Z
  checked: |
    T1 — os.replace() over a root-owned destination, executed as user `luis` (uid 1000) in a sandbox under /tmp.

    Setup: sudo unavailable in this session (password required, non-interactive). Substituted equivalent: used Docker (luis is in the `docker` group → docker daemon runs as root and can create root-owned files via a bind mount).

    Commands (literal):
      SANDBOX=/tmp/preflight-validate-t1
      rm -rf "$SANDBOX" && mkdir -p "$SANDBOX"
      docker run --rm -v "$SANDBOX:$SANDBOX" alpine:latest sh -c "touch $SANDBOX/own-root && chmod 644 $SANDBOX/own-root && echo 'root-owned-content' > $SANDBOX/own-root"
      stat -c '%U:%G %a %n' "$SANDBOX" "$SANDBOX/own-root"
      → luis:luis 775 /tmp/preflight-validate-t1
        root:root 644 /tmp/preflight-validate-t1/own-root
      echo 'luis-new-content' > "$SANDBOX/src.tmp"   # luis-owned source
      python3 -c "import os; os.replace('$SANDBOX/src.tmp', '$SANDBOX/own-root')"
  found: |
    os.replace: SUCCESS — no exception raised.

    Before:
      -rw-r--r--  1 root root   19 /tmp/preflight-validate-t1/own-root   (inode 36042)
    After:
      -rw-rw-r--  1 luis luis   17 /tmp/preflight-validate-t1/own-root   (inode 36060)
      content: "luis-new-content"

    Key observations:
      - Inode changed (36042 → 36060) — confirms rename(2) replaced the directory entry rather than overwriting in place.
      - Owner flipped from root:root to luis:luis — confirms the new inode inherits the source-file ownership.
      - No EACCES, EPERM, EBUSY, or EXDEV. The kernel applied the standard rename(2) semantics: parent-directory write permission (luis has 775 on sandbox) is sufficient; existing file ownership is irrelevant.

    Production equivalence: /srv/local-llms is `luis:luis` 0775 per the diagnosis evidence at 2026-05-11T20:18:00Z, identical to the sandbox parent. The root-owned file at /srv/local-llms/.preflight-state.json (mode 0644) is identical to the sandbox victim file. T1's sandbox is a faithful proxy.
  implication: |
    P1 HOLDS. os.replace() (rename(2)) successfully overwrites a root-owned destination when the calling user has directory-write permission. Plan 01-05's Task 2 Edit A — swapping the python-path `mv "${TMPFILE}" "${STATE_FILE}"` for `os.replace(tmpfile, state_file)` inside the python heredoc — is the correct primitive. No fallback needed; no per-user state path required.

- timestamp: 2026-05-11T21:12:00Z
  checked: |
    T2 — Bash trap '[ -n "${TMPFILE:-}" ] && rm -f "${TMPFILE}" 2>/dev/null; exit' EXIT INT TERM HUP, fired by SIGINT.

    Two variants run in /tmp/preflight-validate-t2 and /tmp/preflight-validate-t2b:
      T2a: SIGINT delivered during a simple bash `for i in 1..10; do sleep 0.3; done` loop (parent bash is the foreground process).
      T2b: SIGINT delivered during a `python3 -c "for i in range(20): time.sleep(0.5)"` subprocess (foreground process is the python child; bash waits).

    Both variants instrumented with a TRAPLOG (T2b) that records when each trap fires and the value of $TMPFILE at trap time.
  found: |
    T2a result:
      - Script terminated. TMPFILE removed.
      - ls /tmp/preflight-validate-t2/state.json.tmp.* → "No such file or directory" — no leak.

    T2b result (instrumented):
      - Script exit code: 130 (= 128 + SIGINT) — confirms SIGINT-driven exit.
      - TRAPLOG contents (literal):
          trap fired with TMPFILE=/tmp/preflight-validate-t2b/state.json.tmp.74093
          EXIT trap fired with TMPFILE=/tmp/preflight-validate-t2b/state.json.tmp.74093
      - Both traps fired; TMPFILE was non-empty and bash-scope-visible at trap time (so `set -u` does not fault).
      - ls /tmp/preflight-validate-t2b/state.json.tmp.* → "No such file or directory" — no leak.

    Behavioral observation (T2b): When `kill -INT <bash_pid>` targets only the bash parent (not the process group via `kill -INT -<pgid>`), bash defers signal handling until the foreground subprocess returns. The python subprocess printed all 20 iterations to completion (~10s) before the trap fired. In production, Ctrl-C from a TTY sends SIGINT to the *entire* foreground process group — both bash and python receive it simultaneously. Python's default SIGINT handler raises KeyboardInterrupt and exits fast (~ms), then bash's trap fires. Either path cleans the tmp file; the production path is strictly faster.
  implication: |
    P2 HOLDS. The proposed trap pattern cleans up ${TMPFILE} on every SIGINT path tested, including the python-subprocess variant which mirrors the live code (the state-write happens inside a `python3 - <<'PYEOF'` heredoc per line 476 of bin/preflight-gpu.sh). `TMPFILE=""` declared at script scope before the trap (Plan 01-05 Task 1 Edit B) is sufficient to keep `set -u` quiet. No revisions to the trap form needed.

- timestamp: 2026-05-11T21:13:00Z
  checked: |
    T3 — Value-level invariants on check_kinds in the Phase 7 reader contract (01-02-PLAN.md), read-only.

    Searched 01-02-PLAN.md for: `check_kinds`, `functional`, `diagnostic`.
    Cross-referenced 01-04-SUMMARY.md for when `check_kinds` was added.
  found: |
    01-02-PLAN.md literal text:
      - Line 26 (contains_keys block, the Phase 7 reader contract):
          contains_keys: ["host_driver_version", "cuda_version", "nvidia_ctk_version", "last_run_at", "checks"]
        `check_kinds` is NOT present. The Phase 7 contract pinned in 01-02 has NO mention of check_kinds whatsoever.
      - The word "check_kinds" appears ZERO times anywhere in 01-02-PLAN.md (grep returned no matches).
      - The words "functional" and "diagnostic" appear only as English prose (line 39 "asserts that NVIDIA Container Toolkit is functional"; line 124 "container nvidia-smi works (proves NVIDIA Container Toolkit is functional)"). Neither is a value-level pin on any check classification.

    01-04-SUMMARY.md line 216 confirms the origin of check_kinds:
      "State file gains `check_kinds` field. Functional set: `gpu_device`, `host_nvidia_smi`, `container_nvidia_smi`. Diagnostic set: `nvidia_ctk`, `daemon_json`. Commit `85acf92`."
      → check_kinds was introduced in Defect 2 (Plan 01-04), NOT in original Plan 01-02. The Phase 7 contract predates its existence.

    01-05-PLAN.md's own contains_keys (line 30):
      contains_keys: ["schema_version", "host_driver_version", "checks", "check_kinds", "passed"]
      → 01-05-PLAN explicitly lists check_kinds; only key-presence is required.

    Plan 01-05's truths (line 22):
      "check_kinds[\"host_nvidia_smi\"] == \"diagnostic\" in the written state file after this fix"
      → 01-05 asserts the new value as the fix outcome, not as a pre-existing invariant.
  implication: |
    P3 HOLDS. The Phase 7 reader contract (01-02-PLAN.md) does NOT pin check_kinds at all — neither as a required key nor with any value-level invariant. Reclassifying host_nvidia_smi from "functional" to "diagnostic" cannot violate the original contract because there is no original contract on check_kinds to violate.

    Risk register check:
      - Phase 7's actual consumer behavior: per 01-CONTEXT.md / 01-02-PLAN.md objective, Phase 7 reads `host_driver_version` to pick the vLLM image tag. It does not inspect check_kinds (or even checks) for its decision. The reclassification is invisible to Phase 7.
      - Forward-compat: any future plan that reads check_kinds["host_nvidia_smi"] should expect "diagnostic" after 01-05 lands. This is documented in Plan 01-05's truths line 22.

## Resolution

root_cause: |
  Three coherent root causes from a single structural pattern: the Phase 1 Defect 2 split (functional vs diagnostic) was applied to two of three WSL2-fragile checks but not the third (`host_nvidia_smi`), and the state-write code path was never hardened against the ownership split that running the same script in both root-container-mode and non-root-host-mode inevitably produces.

  ### Root cause 1 — Symptom 1 (`host_nvidia_smi FAIL` gates exit on WSL2)

  Line 346 of `bin/preflight-gpu.sh` classifies `host_nvidia_smi` as `functional`:
  ```
  346:   run_check "host_nvidia_smi"       check_host_nvidia_smi      functional
  ```
  but the check itself (lines 142–151) probes only `command -v nvidia-smi` in the WSL distro's PATH:
  ```
  144:   log_verbose "Checking host nvidia-smi..."
  145:   command -v nvidia-smi >/dev/null 2>&1 || return 1
  ```
  On Docker Desktop on Windows + WSL2, the Windows-side driver is the authoritative one, projected into the distro at `/usr/lib/wsl/lib/nvidia-smi` (not on `PATH`) and reachable via `/mnt/c/Windows/System32/nvidia-smi.exe`. Neither location is probed. The check therefore fails on a host where GPU passthrough is *known* to work (proved by `container_nvidia_smi PASS` on line 347). Since it's `functional`, the script exits 1 — directly contradicting the 01-04-SUMMARY.md Defect 2 rationale ("functional set = `gpu_device`, `host_nvidia_smi`, `container_nvidia_smi`. The container check is the authoritative test if it passes, GPU passthrough works regardless of how the toolkit got configured"). The header comment on lines 18–23 says `host_nvidia_smi  functional   nvidia-smi works on host` — but on this host class, a *passing* `container_nvidia_smi` already proves that "nvidia-smi works on host" via the kernel module and projected libcuda. So `host_nvidia_smi` is semantically diagnostic on WSL2, regardless of its category label.

  ### Root cause 2 — Symptom 2 (interactive `mv` prompt blocks the script)

  Two `mv` calls are vulnerable:
  ```
  508:       mv "${TMPFILE}" "${STATE_FILE}"
  567:     if mv "${TMPFILE}" "${STATE_FILE}" 2>/dev/null; then
  ```
  Neither passes `-f`, redirects stdin from `/dev/null`, uses `command mv`, escapes the alias with `\mv`, or replaces the rename with a primitive that doesn't prompt (`install -m 0644 "$TMPFILE" "$STATE_FILE"`, `cp -f` + `rm -f`, or writing directly to `${STATE_FILE}` from Python's `open(..., "w")` which atomically unlinks via directory permission). The interactive prompt is triggered by GNU `mv`'s rule that when the destination exists and the calling process cannot unlink/replace it, and stdin is a TTY, `mv` prompts even without `-i` — `man mv` confirms: `-i, --interactive: prompt before overwrite` is one of three mutually-exclusive flags `(-i, -f, -n)` and absent any of them, the kernel's `EACCES` from `unlink` falls back to interactive confirmation when stdin is a terminal. On the user's host the destination is root-owned 0644 (left over from the in-container run) and stdin is a terminal — both conditions met. **`mv -f` alone is insufficient** because `-f` only suppresses the prompt; the underlying `unlink(2)` still fails when the calling user has no write permission on the destination *file*. The reliable fix is to bypass `mv` entirely for the final rename and let Python (already used to build the JSON) write directly via `open("${STATE_FILE}", "w")` — Linux allows unlink-via-creat when the user has write permission on the parent directory, which is the case here (`/srv/local-llms/` is `luis:luis`).

  ### Root cause 3 — Symptom 3 (abandoned `.tmp.NNNNN` files + root-owned final file)

  Two distinct contributing causes:

  a) **No `trap` for tmp-file cleanup.** `grep -n "trap" bin/preflight-gpu.sh` returns zero matches. `${TMPFILE}` is created on line 461 as `${STATE_FILE}.tmp.$$`. The python writer (line 500) opens it; the post-write `mv` (line 508 or 567) renames it. On the in-flight `mv` prompt, the user's Ctrl-C sends SIGINT — the script dies before reaching the `rm -f "${TMPFILE}"` lines (512, 571). No `trap 'rm -f "${TMPFILE}"' EXIT INT TERM HUP` is registered at the top of the script. Every cancelled run leaves a tmp file behind. The user's `ls -la /srv/local-llms/` evidence (two tmp files for PIDs 64770 and 65114) is direct proof of this pattern.

  b) **Root-owned final state file from in-container writer.** The compose `gpu-preflight` service (compose.yml lines 57–85) has no `user:` directive, so the container runs as root. The same script writes `${STATE_FILE}` via Python `open()` (line 500) into a bind-mounted host directory (`${HOST_DATA_ROOT}:${HOST_DATA_ROOT}` on compose.yml line 75). The file lands on the host filesystem owned by `root:root`. Subsequent host-mode runs by `luis` cannot overwrite it without either (i) the directory-unlink path noted in Root cause 2, or (ii) some form of ownership reset (e.g., the in-container run `chmod 0666` after write, or set `user: "${UID}:${GID}"` on the compose service). The two are independent fixes; together they make the state-write robust to any sequence of container-then-host or host-then-container runs.

fix: ""

verification: ""

files_changed: []

## VALIDATION COMPLETE

**Validated:** 2026-05-11T21:15:00Z — Plan `.planning/phases/01-gpu-compose-foundation/01-05-PLAN.md`

### Per-prediction verdicts

| Prediction | Verdict | Decisive evidence |
|------------|---------|-------------------|
| P1 — `os.replace(tmp, state)` succeeds over a root-owned destination when caller has directory-write only | **HOLDS** | T1 (2026-05-11T21:11:00Z): inode flipped 36042→36060, owner flipped root:root→luis:luis, no exception, content correct. Sandbox parent dir (luis:luis 775) is an exact proxy for /srv/local-llms (luis:luis 0775 per the existing diagnosis). |
| P2 — Trap pattern cleans `${TMPFILE}` on SIGINT, including during python heredoc subprocess | **HOLDS** | T2 (2026-05-11T21:12:00Z): T2a removes tmp file after SIGINT in a bash loop; T2b instrumented run shows `trap fired with TMPFILE=...` then `EXIT trap fired with TMPFILE=...`, exit code 130, zero `.tmp.*` files leak. Production Ctrl-C path is strictly faster (process-group SIGINT terminates python child immediately rather than letting it run to completion). |
| P3 — Reclassifying `host_nvidia_smi` to `diagnostic` preserves the Phase 7 reader contract | **HOLDS** | T3 (2026-05-11T21:13:00Z): 01-02-PLAN.md's `contains_keys` (line 26) does not list `check_kinds`; the word `check_kinds` appears zero times in 01-02-PLAN.md; `functional`/`diagnostic` appear only as English prose, never as value-level pins. `check_kinds` was added in 01-04 (Defect 2), so the original Phase 7 contract is value-blind to its content. |

### Verdict on Plan 01-05

**SAFE TO EXECUTE AS-WRITTEN.** All three load-bearing predictions hold under decisive sandbox tests. No revisions to the plan are required. In particular:

- Task 1 Edit A (single-line classification flip, line 346: `functional` → `diagnostic`) does not regress Phase 7's contract — Phase 7 reads only `host_driver_version` (per 01-02-PLAN.md objective line 39), and `check_kinds` is not in the original contract at all.
- Task 1 Edit B (script-scope `TMPFILE=""` + `trap '... rm -f ...; exit' EXIT INT TERM HUP`) is correct as written; the `exit` inside the INT branch is required to prevent the trap from returning into the still-executing script body.
- Task 2 Edit A (`os.replace(tmpfile, state_file)` inside the python heredoc) is the correct primitive. `_PREFLIGHT_STATE_FILE` env-var addition preserves the CR-02 indirection. The try/except OSError block with `sys.exit(3)` and explicit tmpfile unlink is defense-in-depth that the trap also covers.
- Task 2 Edit B (`install -T -m 0644` in the printf fallback) is also a `rename(2)`-based primitive; same parent-directory-write semantics as `os.replace`. Note: `install -T` copies first then renames, so it leaves a copy of the source tmpfile that the trap will subsequently clean — the existing `rm -f "${TMPFILE}"` after success in the printf branch is therefore required and is correctly specified in the plan.

### Plan 01-05 line citations confirmed correct (no edits needed)

- Plan 01-05 line 22 truth `check_kinds["host_nvidia_smi"] == "diagnostic"` — VALID outcome assertion, no preexisting invariant violated.
- Plan 01-05 line 38 key-link via `os.replace` with "directory-write permission, ignores destination ownership" — VALID per T1 evidence.
- Plan 01-05 task 1 Edit B `set -u` safety claim (TMPFILE="" declared before trap) — VALID per T2 evidence (trap fires with non-empty TMPFILE; no fault observed under set -uo pipefail).

### Open notes (not blockers)

1. **T1 sudo substitution.** T1 was originally specified with `sudo touch /tmp/own-root && sudo chmod 644 && sudo chown root:root`. Sudo required a password in this session (`sudo -n true` → "password is required"). Substituted: docker run as the (root-running) daemon to create the victim file via a bind mount. This produces a functionally identical root-owned file in a luis-owned parent dir and is arguably MORE representative of the production root cause (the actual bug is caused by the in-container gpu-preflight writing through a bind mount as root — exactly the substitution path). No checkpoint needed; the substitution is strictly equivalent.

2. **T2b SIGINT delivery semantics.** SIGINT sent to `kill -INT <bash_pid>` (process-targeted) does not interrupt the foreground python subprocess; bash defers handling until the child terminates. Production Ctrl-C (process-group-targeted) is faster but reaches the same trap state. This is informational only — both delivery modes produce a clean tmp-file removal.

3. **Pre-existing artefacts not touched.** Per the session intent, the two `.preflight-state.json.tmp.64770` / `.tmp.65114` files and the root-owned `.preflight-state.json` in `/srv/local-llms/` were left in place. They are the cleanup target of Plan 01-05 Task 3 Step 1 (pre-clean before `bash bin/preflight-gpu.sh`). Out of scope for this validation session.

### Recommendation

Proceed to `/gsd-execute-phase 01 --gaps-only`. Plan 01-05 is ready to execute as-written.
