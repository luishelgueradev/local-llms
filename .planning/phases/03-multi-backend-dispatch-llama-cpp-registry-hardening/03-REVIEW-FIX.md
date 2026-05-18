---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
fixed_at: 2026-05-15T23:15:30Z
review_path: .planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-05-15T23:15:30Z
**Source review:** `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (WR-02, WR-04, WR-05, IN-01, IN-02, IN-03, IN-04)
- Fixed: 7
- Skipped: 0

---

## Pre-fix Verification: Already-Closed Findings

### WR-05: skip() called before defined — CONFIRMED CLOSED (Phase 02 WR-01 fix, commit 45caa27)

Verified at current HEAD: `bin/smoke-test-router.sh` lines 104-109 define `SKIPS=0`, `fail()`, `pass()`, and `skip()` in the correct order, well before any phase section that calls `skip()`. No action required.

### WR-04: OLLAMA_URL parsed from env but never consumed — PARTIALLY CLOSED

The Phase 02 IN-01 fix (commit daa0ea5) removed `OLLAMA_URL` from `router/src/config/env.ts` `EnvSchema`. However, `compose.yml:217` still had `- OLLAMA_URL=http://ollama:11434/v1`. The compose.yml cleanup was applied as part of the IN-03 commit (`9eea876`) since both changes touch the same `router:` environment block.

---

## Fixed Issues

### WR-02: INTERVAL_MS in readyz.ts has no programmatic link to scheduler's intervalMs

**Files modified:** `router/src/config/constants.ts` (new), `router/src/routes/readyz.ts`, `router/src/app.ts`
**Commit:** `e12e9ef`
**Applied fix:** Created `router/src/config/constants.ts` exporting `LIVENESS_INTERVAL_MS = 10_000`. Updated `router/src/routes/readyz.ts` to import the constant (removing the local `INTERVAL_MS = 10_000` declaration and its stale comment) and use `LIVENESS_INTERVAL_MS` in both stale-detection formulas. Updated `router/src/app.ts` to import and use `LIVENESS_INTERVAL_MS` in `schedulerOpts.intervalMs`. Both consumers now share a single compile-time source of truth.

### IN-01: Hot-reload does not rebuild semaphore map for new backends

**Files modified:** `router/src/index.ts`
**Commit:** `a28b284`
**Applied fix:** Added a prominent comment block at the `onReload` callback site in `index.ts` explaining: (a) semaphoreMap is NOT rebuilt on hot-reload, (b) this is safe in Phase 3 because `LocalBackendEnum` restricts `backend` to `['ollama', 'llamacpp']` — both semaphores are always present at boot, (c) the exact failure mode if a future phase widens the enum without addressing this (500 for new backend type until restart), and (d) the two resolution paths before widening. The semaphore rebuild itself is deferred to Phase 7 per the reviewer's guidance.
**Status:** fixed: requires human verification (architectural — comment documents the gap; the actual rebuild is deferred to a future phase)

### IN-02: Smoke-test header and banner still say "Phase 2 Router Verification"

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** `2bddb93`
**Applied fix:** Updated three locations in the script:
- Line 2 (file-level comment): `"Phase 2"` → `"Phases 2–5"`
- Lines 58-62 (inside `usage()`): Updated Purpose block to describe Phase 2–5 scope, matching the final summary line
- Line 113 (runtime banner): `"Phase 2 Router Verification"` → `"Phase 2-5 Router Verification"`
Bash syntax check (`bash -n`) passes clean.

### IN-03: Production router service omits MODELS_YAML_PATH — relies on schema default

**Files modified:** `compose.yml`
**Commit:** `9eea876`
**Applied fix:** Added `- MODELS_YAML_PATH=/app/models.yaml` to the `router:` service environment block with an inline comment explaining "matches volume mount; explicit > implicit default". Also removed the dead `- OLLAMA_URL=http://ollama:11434/v1` line (WR-04 compose half) and replaced it with a comment referencing 03-REVIEW WR-04. `docker compose config --quiet` passes clean.

### IN-04: backends.base_url accepted by schema but silently ignored at runtime

**Files modified:** `router/src/config/registry.ts`, `router/models.yaml`
**Commit:** `f93f263`
**Applied fix:** Added a 4-line comment block above the `base_url` field in `BackendsSection` (registry.ts) explaining that it is accepted for documentation/operator readability only, with no runtime effect, and directing operators to per-model `backend_url` fields instead. Mirrors the pattern already used for per-model `concurrency` (D-B6 note). Also added matching single-line comments above the `base_url` entries in `models.yaml` for at-a-glance operator guidance.

---

## Skipped Issues

None — all findings were resolved.

---

## Validation Results

All post-fix validations passed:

| Check | Result |
|-------|--------|
| `bash -n bin/smoke-test-router.sh` | PASS |
| `tsc --noEmit` (router/) | PASS — 0 errors |
| `vitest run` (router/) | PASS — 40 files, 489 tests pass, 2 skipped (pre-existing) |
| `docker compose config --quiet` | PASS — no structural errors |

---

_Fixed: 2026-05-15T23:15:30Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
