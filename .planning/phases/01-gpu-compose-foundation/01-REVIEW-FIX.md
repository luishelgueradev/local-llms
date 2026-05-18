---
phase: 01-gpu-compose-foundation
fixed_at: 2026-05-15T23:01:30Z
review_path: .planning/phases/01-gpu-compose-foundation/01-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-05-15T23:01:30Z
**Source review:** .planning/phases/01-gpu-compose-foundation/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4
- Fixed: 4
- Skipped: 0

## Fixed Issues

### CR-01: bootstrap-host.sh creates postgres/ and valkey/ but compose.yml mounts postgres-data/ and postgres-backups/

**Files modified:** `bin/bootstrap-host.sh`
**Commit:** `0fb0b2a`
**Applied fix:**
- Renamed `postgres/` → `postgres-data/` in DIRS array (matches compose.yml:345 bind mount)
- Added `postgres-backups/` to DIRS array (matches compose.yml:390 pg-backup sidecar)
- Updated the echo banner to print the corrected directory names
- Replaced blanket `chown -R $(id -u):$(id -g) ${HOST_DATA_ROOT}` with targeted per-subtree chown that explicitly skips `postgres-data/` and `postgres-backups/`
- Added `sudo chown 70:70` calls for both postgres dirs so the postgres:17-alpine container (uid 70) can write immediately on first `docker compose up`

### IN-01: bootstrap-host.sh FUTURE FOOTGUN comment describes a condition that has already arrived

**Files modified:** `bin/bootstrap-host.sh`
**Commit:** `0fb0b2a` (combined with CR-01 — same file, same fix)
**Applied fix:** Removed the stale FUTURE FOOTGUN comment block (lines 69-85) and replaced it with a comment explaining the now-active Phase 5 guard and the rationale for the targeted chown strategy. The described guard has been implemented, so the "warning about the future" is no longer appropriate.

### WR-01: TAGS_RESPONSE heredoc still interpolates ${MODEL} unquoted into Python source

**Files modified:** `bin/smoke-test-gpu.sh`
**Commit:** `af7f243`
**Applied fix:** Replaced the unquoted heredoc block (`python3 - <<PYEOF ... PYEOF`) with the same env-var pattern established for `REQUEST_BODY` and `GENERATE_RESPONSE` in commit 5264e9e. Values are now passed via `_SMOKE_TAGS` and `_SMOKE_MODEL` environment variables into a single-quoted `python3 -c '...'` invocation. The Python code handles parse errors with a try/except that returns "no" instead of propagating a SyntaxError.

### IN-02: compose.yml comment says Ollama image is "Alpine-style minimal" but the pinned image is Ubuntu-based

**Files modified:** `compose.yml`
**Commit:** `d064cf8`
**Applied fix:** Updated the healthcheck comment to remove "Alpine-style minimal" framing. The actual constraint (no curl, wget, or python in PATH) is preserved. New wording: "The ollama/ollama image ships no curl, wget, or python — use `ollama list` for the healthcheck..."

---

_Fixed: 2026-05-15T23:01:30Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
