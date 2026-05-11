---
status: diagnosed
trigger: "Phase 1 UAT gap on bin/preflight-gpu.sh: three symptoms from a single host-mode run — host_nvidia_smi FAIL on WSL2 + Docker Desktop, mv -i interactive prompt on state-file overwrite, leftover .tmp.NNNNN files and root-owned final state file."
created: 2026-05-11T20:00:00Z
updated: 2026-05-11T20:30:00Z
---

## Current Focus

hypothesis: All three symptoms are one coherent diagnosis. (1) `host_nvidia_smi` is wrongly classified `functional` for the Docker Desktop on Windows + WSL2 case where the Windows-side `nvidia-smi.exe` is reachable from WSL only via projected paths (`/usr/lib/wsl/lib/`, `/mnt/c/Windows/System32/`), not via the WSL distro's `PATH`. (2) The `mv` prompt is NOT caused by an alias (`type mv` returns `/usr/bin/mv` in this shell); it's caused by the target file being owned by `root:root` with mode `0644`. POSIX `mv` (GNU coreutils) prompts when the destination exists, the calling process cannot unlink/replace it, and stdin is a terminal — regardless of `-i`. (3) The leftover `.tmp.NNNNN` files exist because the failed `mv` aborts the script silently mid-rename and there is no `trap` registered to clean up `${TMPFILE}` on abort. The root-owned final state file is owned by root because the in-container `gpu-preflight` service (compose.yml lines 57–85) runs the same script as PID 1 inside the container = uid 0, and bind-mounts `${HOST_DATA_ROOT}` write-back to the host — so the file inherits root ownership on disk.

test: Read bin/preflight-gpu.sh source for check kind table (line 339–349), state-write code path (lines 451–574), and trap registration (none); read compose.yml gpu-preflight service definition (lines 57–85) to confirm root execution context; verify mv aliasing in user environment (`type mv` → `/usr/bin/mv`, no alias).

expecting: All three symptoms collapse onto one structural pattern — Phase 1 Defect 2 (functional/diagnostic split) was only applied to `nvidia_ctk` and `daemon_json`, leaving `host_nvidia_smi` in the gating set even though it has the exact same WSL2-host-shape problem; and the state-write path was never made robust to the in-container vs host-mode ownership split it itself creates.

next_action: Return ROOT CAUSE FOUND with three separate root-cause statements and three Suggested Fix Directions — each citing exact line numbers — so plan-phase --gaps can plan precise changes. Do NOT apply fixes.

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
