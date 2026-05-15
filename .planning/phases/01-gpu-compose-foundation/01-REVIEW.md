---
phase: 01-gpu-compose-foundation
reviewed: 2026-05-15T23:30:00Z
depth: standard
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
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 01: Code Review Report (Refresh + Fix Cycle)

**Reviewed:** 2026-05-15
**Depth:** standard
**Files Reviewed:** 8
**Status:** clean — all findings resolved

## Fix Cycle Complete (2026-05-15)

All 4 findings from the 2026-05-15 refresh pass were resolved across 3 atomic commits:

| Finding | Commit | Resolution |
|---------|--------|------------|
| CR-01 — bootstrap-host DIRS vs compose.yml mismatch | `0fb0b2a` | Renamed `postgres/` → `postgres-data/`, added `postgres-backups/`; targeted per-subtree chown; pre-chown postgres dirs to uid 70:70 |
| IN-01 — Stale FUTURE FOOTGUN comment | `0fb0b2a` | Removed (combined with CR-01 commit) |
| WR-01 — `${MODEL}` unquoted in TAGS_RESPONSE heredoc | `af7f243` | Replaced unquoted heredoc with env-var + single-quoted `python3 -c '...'` (matches CR-02 pattern from `5264e9e`) |
| IN-02 — Ollama "Alpine-style minimal" misframing | `d064cf8` | Replaced with factually correct wording ("ships no curl, wget, or python") |

**Validation:** `bash -n` clean on all 4 scripts; `docker compose config --quiet` passes.

---

# Prior Refresh Findings (now all resolved — kept for traceability)

**Status (historical):** issues_found

**Refresh history:**
- Prior pass: 2026-05-10 — 2 critical, 7 warning, 3 info (12 total)
- This pass: 2026-05-15 — re-review against HEAD after fix commits

---

## Closed since prior pass

All findings from the 2026-05-10 pass were addressed by the following commits:

| Finding | Fix commit | Notes |
|---------|-----------|-------|
| CR-01: `host_driver_version` written as `"in-container"` on every `compose up` | `a9b49ce` | `nvidia-smi` called unconditionally; in-container sets only `nvidia_ctk_version` to null |
| CR-02: `GENERATE_RESPONSE` and `REQUEST_BODY` heredoc/interpolation injection | `5264e9e` | Both paths now pass values via environment variables to single-quoted `python3 -c '...'` |
| WR-01: `HOST_DATA_ROOT` priority inverted (env var silently overridden by `.env`) | `20d57d2` | `${HOST_DATA_ROOT:-/srv/local-llms}` now correctly honors caller env var first |
| WR-02: Dead `nvidia-smi` call + unused `v` variable in `capture_cuda_version` | `20d57d2` | Redundant assignment removed; function now runs the correct pipeline once |
| WR-03: `gpu-init-libcuda.sh` hardcoded `x86_64-linux-gnu` target dir | `20d57d2` | `TARGET_DIR="/usr/lib/$(uname -m)-linux-gnu"` with fallback added |
| WR-04: Duplicate directory list in bootstrap sudo path (dead code if list changes) | `20d57d2` | Refactored to `DIRS=()` array consumed by both branches |
| WR-05: `REQUEST_BODY` Python `python3 -c "..."` injected `${MODEL}`, `${PROMPT}` | `5264e9e` | Now uses `_SMOKE_MODEL`, `_SMOKE_PROMPT`, `_SMOKE_KEEP_ALIVE` env vars; single-quoted source |
| WR-06: Bare `mv` left orphaned `${TMPFILE}` on failure; no error handling | `27ee9eb` | Replaced with `os.replace()` (Python path) and `install -T` (fallback); trap added |
| WR-07: Success banner hard-coded `"confirmed via /api/ps (size_vram > 0)"` regardless of which codepath ran | `20d57d2` | `GPU_RESIDENCY_DETAIL` variable now propagated from each branch to the banner |
| IN-01: `.gitignore` entry for `.preflight-state.json` misleadingly suggests it could be in-repo | — | Comment added in `20d57d2`; no code change needed |
| IN-02: `container_nvidia_smi` check mapped to `check_host_nvidia_smi` function name (naming confusion) | — | Pattern documented inline with comment; no rename pending |
| IN-03: `/bin/sh` caveat for Alpine busybox in `gpu-init-libcuda.sh` | — | Intentional; `ldconfig 2>/dev/null || true` already handles absence |

---

## Critical Issues

### CR-01: `bootstrap-host.sh` creates `postgres/` and `valkey/` but `compose.yml` mounts `postgres-data/` and `postgres-backups/`

**File:** `bin/bootstrap-host.sh:34-42` + `compose.yml:345,390`

**Issue:** The `DIRS` array in `bootstrap-host.sh` creates these paths:

```
${HOST_DATA_ROOT}/postgres
${HOST_DATA_ROOT}/valkey
```

But `compose.yml` Phase 5 services mount these paths:

```yaml
# postgres service (compose.yml:345)
- ${HOST_DATA_ROOT:-/srv/local-llms}/postgres-data:/var/lib/postgresql/data

# pg-backup sidecar (compose.yml:390)
- ${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups:/backups
```

The `postgres` directory that bootstrap creates is never referenced by any Compose service. The `postgres-data` and `postgres-backups` directories that Postgres and pg-backup actually need are not created by bootstrap. Docker Engine will auto-create a bind-mount host path if it is missing — but it creates it as root (uid 0), which immediately causes the Postgres container (which runs as uid 70) to fail with a permission error on first `docker compose up postgres`.

The README Phase 5 section (lines 502-503) works around this with a manual `mkdir -p` instruction, but that bypasses bootstrap entirely and is a setup footgun: a user who runs `bash bin/bootstrap-host.sh` and then `docker compose up` as documented in Phase 1 will hit the permission error with no indication that bootstrap is out of sync.

Additionally, the FUTURE FOOTGUN comment block in `bootstrap-host.sh` (lines 69-84) warns that the blanket `chown -R` will clobber Postgres uid after Phase 5 lands. That phase has now shipped — the chown guard must be implemented now, not deferred.

**Fix:**

```bash
# In bin/bootstrap-host.sh, replace the DIRS array and add the chown guard:

DIRS=(
  "${HOST_DATA_ROOT}/models-gguf/gguf"
  "${HOST_DATA_ROOT}/models-gguf/ollama"
  "${HOST_DATA_ROOT}/models-hf"
  "${HOST_DATA_ROOT}/postgres-data"     # was: postgres (wrong name)
  "${HOST_DATA_ROOT}/postgres-backups"  # was: missing entirely
  "${HOST_DATA_ROOT}/valkey"
  "${HOST_DATA_ROOT}/traefik/acme"
  "${HOST_DATA_ROOT}/traefik/logs"
)

# ...after mkdir -p, replace the blanket chown with a targeted one:
# Chown only the dirs that are user-owned. Skip postgres-data and postgres-backups
# which must be owned by uid 70 (postgres:17-alpine) — a blanket chown -R clobbers
# the required ownership and breaks the next `docker compose up postgres`.
for dir in \
  "${HOST_DATA_ROOT}/models-gguf" \
  "${HOST_DATA_ROOT}/models-hf" \
  "${HOST_DATA_ROOT}/valkey" \
  "${HOST_DATA_ROOT}/traefik"; do
  if [ -d "$dir" ]; then
    chown_cmd="chown -R $(id -u):$(id -g) $dir"
    [ "$(stat -c '%u' "$dir" 2>/dev/null)" != "$(id -u)" ] && sudo $chown_cmd || true
  fi
done
# Postgres dirs: pre-create with uid 70 so the container can write immediately
sudo chown 70:70 "${HOST_DATA_ROOT}/postgres-data" 2>/dev/null || true
sudo chown 70:70 "${HOST_DATA_ROOT}/postgres-backups" 2>/dev/null || true
```

---

## Warnings

### WR-01: `TAGS_RESPONSE` heredoc still interpolates `${MODEL}` unquoted into Python source — partial residue of original CR-02

**File:** `bin/smoke-test-gpu.sh:185-192`

**Issue:** The original CR-02 fix (commit `5264e9e`) correctly converted the `GENERATE_RESPONSE` path and the `REQUEST_BODY` construction to use environment variables and single-quoted `python3 -c '...'`. However the `TAGS_RESPONSE` / `MODEL_FOUND` block was not updated:

```bash
MODEL_FOUND=$(python3 - <<PYEOF
import json, sys
data = json.loads("""${TAGS_RESPONSE}""")   # unquoted heredoc
models = data.get("models", [])
target = "${MODEL}"                          # unquoted shell expansion into Python string
found = any(...)
print("yes" if found else "no")
PYEOF
)
```

Two problems here:

1. `${TAGS_RESPONSE}` is expanded by bash before Python sees the code. Valid JSON cannot contain literal `"""` so the triple-quote termination path is not reachable in practice — the earlier python3 JSON-validity check (line 171) aborts if the response is not valid JSON. This half is low-risk today.

2. `${MODEL}` on line 189 IS interpolated into `target = "${MODEL}"`. If `--model` is passed with a value containing a double-quote (`"`), a backslash, or a newline, the Python string literal is broken. A model name like `foo"bar` would produce `target = "foo"bar"` which is a `SyntaxError`. The `python3 -` form has no `try/except`, so the `MODEL_FOUND` variable would be empty, and the script would exit 1 with a misleading "model not pulled" error rather than a syntax diagnostic.

The original review's fix suggestion for this block (applying the same env-var pattern as the other paths) was never applied.

**Fix:**

```bash
MODEL_FOUND=$(_SMOKE_TAGS="$TAGS_RESPONSE" _SMOKE_MODEL="$MODEL" python3 -c '
import json, os, sys
raw = os.environ.get("_SMOKE_TAGS", "")
target = os.environ.get("_SMOKE_MODEL", "")
try:
    data = json.loads(raw)
    models = data.get("models", [])
    found = any(
        m.get("name", "").startswith(target) or m.get("model", "").startswith(target)
        for m in models
    )
    print("yes" if found else "no")
except Exception:
    print("no")
')
```

---

## Info

### IN-01: `bootstrap-host.sh` FUTURE FOOTGUN comment describes a condition that has already arrived

**File:** `bin/bootstrap-host.sh:69-84`

**Issue:** The inline comment block at line 69 says "After Phase 5 (Postgres, postgres/ subdir) and Phase 8 (Valkey, valkey/ subdir) land, this script MUST be updated." Phase 5 has landed (commit `09ea7f5`). The comment accurately identifies the problem but the guard it describes has not been implemented. This is flagged as INFO here because the BLOCKER above (CR-01) covers the actionable fix; this is a reminder to also remove or update the comment once the fix is applied so future readers are not confused by a comment about a future that is now the present.

---

### IN-02: `compose.yml` comment says Ollama image is "Alpine-style minimal" but the pinned image is Ubuntu-based

**File:** `compose.yml:146-151`

**Issue:** The comment block says:

```yaml
# The ollama/ollama image is Alpine-style minimal — NO curl, NO wget, NO python.
```

The pinned image is `ollama/ollama:0.23.4`. Ollama images since 0.1.x have been based on Ubuntu 22.04 (or later), not Alpine. The comment's conclusion (no curl, no wget, no python) may still be accurate for 0.23.4 — Ollama does not ship these tools regardless of the base distro — but the "Alpine-style" framing is factually incorrect and could mislead future maintainers into believing the image is musl-based or has other Alpine constraints. The correct description is "minimal Ubuntu base" or simply "NO curl, NO wget, NO python in PATH."

**Fix:** Update the comment to remove "Alpine-style" while preserving the actual constraint being communicated:

```yaml
# The ollama/ollama image ships no curl, wget, or python — use `ollama list`
# for the healthcheck (it talks to the local API server internally).
```

---

_Reviewed: 2026-05-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
