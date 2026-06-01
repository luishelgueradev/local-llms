---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 06
subsystem: smoke-test
tags: [smoke, observability, prometheus, cardinality, responses-api, tools, wave-3]

# Dependency graph
requires:
  - plan: 19-03
    provides: Route refactor — responses route in place
  - plan: 19-04
    provides: Composition root — production wiring
  - plan: 19-05
    provides: check-prometheus-cardinality.ts --live flag + stdin support
provides:
  - Phase 19 smoke section (lines 2541-2613 in bin/smoke-test-router.sh)
  - OBSV-02-LIVE gate (live /metrics cardinality scrape)
  - RESS-WITH-TOOLS gate (live cloud function-call SSE round-trip)
  - 5 cite-only banners for OBSV-01 slices + EMBP-02 regression + EMBP-01 vitest
  - Updated final summary banner (/18 → /18/19)
affects:
  - plan: 19-07 (docs + milestone wrap-up — unblocked)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "curl pipe into node script: curl ... | node router/scripts/check-prometheus-cardinality.ts --live -"
    - "Soft-skip pattern: OLLAMA_API_KEY absent || model not in models.yaml → skip"
    - "mktemp temp file + trap EXIT cleanup for SSE capture"
    - "SSE body grep assertions: event: response.function_call_arguments.delta + response.completed"

key-files:
  modified:
    - bin/smoke-test-router.sh

key-decisions:
  - "Used if/then/else pattern for OBSV-02-LIVE instead of && echo OK || echo FAIL (more robust per CONTEXT D-15 note)"
  - "RESS_TOOLS_FILE uses mktemp + trap EXIT for cleanup — avoids temp file leaks across smoke runs"
  - "Soft-skip RESS-WITH-TOOLS on absent OLLAMA_API_KEY or missing gpt-oss:20b-cloud in models.yaml"
  - "Only 1 minus-line in diff (summary banner) — all other changes are purely additive"

requirements-completed: [OBSV-01, OBSV-02]

# Metrics
duration: 5min
completed: 2026-06-01
---

# Phase 19 Plan 06: Smoke Phase 19 section — OBSV-02-LIVE + RESS-WITH-TOOLS + cite lines Summary

**Phase 19 smoke section inserted: OBSV-02-LIVE live cardinality gate + RESS-WITH-TOOLS cloud function-call SSE gate + 5 cite lines + summary banner updated to /18/19**

## Performance

- **Duration:** ~5 min
- **Completed:** 2026-06-01
- **Tasks:** 1/1
- **Files modified:** 1

## Accomplishments

- Inserted new Phase 19 section (lines 2541–2613) in `bin/smoke-test-router.sh` between the Phase 18 close banner and the final summary banner
- `OBSV-02-LIVE` gate: pipes live `/metrics` output through `node router/scripts/check-prometheus-cardinality.ts --live -` — passes when exit 0 (no `/_id$/` labels), fails otherwise; catches runtime-only label drift the CI in-band test cannot see
- `RESS-WITH-TOOLS` gate: live SSE round-trip with `gpt-oss:20b-cloud` + `get_time` function tool; asserts `response.function_call_arguments.delta` events present and final `response.completed` with `"status":"incomplete"` + `"reason":"tool_calls"`; soft-skips on absent `OLLAMA_API_KEY` or model not declared in `router/models.yaml`
- 5 cite-only banners satisfying OBSV-01 slices: MCP (D-16 → Phase 15), Session (D-19 → Phase 17), RESS-no-tools (Phase 16), EMBP-02 regression (Phase 7 + Phase 12), EMBP-01 vitest conformance
- Final summary banner updated: `Phase 2/3/4/5/7/8/12/13/15/16/17/18 router verification: COMPLETE.` → `Phase 2/3/4/5/7/8/12/13/15/16/17/18/19 router verification: COMPLETE.`

## Key Line Ranges

| Section | Lines |
|---------|-------|
| Phase 19 section open banner | 2541 |
| 5 cite-only banners | 2543–2547 |
| OBSV-02-LIVE gate | 2550–2556 |
| RESS-WITH-TOOLS soft-skip predicate | 2561–2563 |
| RESS-WITH-TOOLS curl + assertions | 2564–2609 |
| Phase 19 section close banner | 2613 |
| Updated final summary banner | 2619 |

## Grep Count Verification

| Criterion | Required | Actual |
|-----------|----------|--------|
| `=== Phase 19 — EmbeddingProvider` | ≥1 | 1 |
| `=== Phase 19 section complete` | ≥1 | 1 |
| `OBSV-02-LIVE` occurrences | ≥2 | 3 |
| `RESS-WITH-TOOLS` occurrences | ≥2 | 5 |
| `gpt-oss:20b-cloud` occurrences | ≥2 | 6 |
| `check-prometheus-cardinality.ts --live` | ≥1 | 1 |
| `Phase 2/3/4/5/7/8/12/13/15/16/17/18/19 router verification` | ≥1 | 1 |
| `OBSV-01 MCP slice: satisfied by Phase 15` | ≥1 | 1 |
| `OBSV-01 Session slice: satisfied by Phase 17` | ≥1 | 1 |
| `EMBP-02 regression: Phase 7 EMBED-01 + Phase 12` | ≥1 | 1 |
| `EMBP-01 conformance` | ≥1 | 1 |
| `OLLAMA_API_KEY absent` | ≥1 | 1 |

## Syntax Check

`bash -n bin/smoke-test-router.sh` → **exit 0** (syntax-clean)

## Regression Net

`git diff HEAD~1..HEAD -- bin/smoke-test-router.sh | grep '^-' | grep -v '^---'` returns exactly 1 minus-line:
```
-  echo "[smoke-test-router]  Phase 2/3/4/5/7/8/12/13/15/16/17/18 router verification: COMPLETE."
```
All other Phase 2..18 section content is byte-for-byte unchanged — confirmed additive-only diff.

## OLLAMA_API_KEY in Test Environment

`OLLAMA_API_KEY` was **NOT SET** in the test environment. RESS-WITH-TOOLS would soft-skip (not fail) when run without the key — correct behavior per the soft-skip predicate.

## Package Changes

`git diff router/package.json router/package-lock.json` → **empty** (no package changes).

## Task Commits

1. **Task 1: Insert Phase 19 smoke section + update summary banner** - `7ffbba3` (feat)

## Files Modified

- `bin/smoke-test-router.sh` — Phase 19 section inserted (76 insertions, 1 deletion)

## Decisions Made

- Used `if curl ... | node ...; then pass; else fail; fi` pattern for OBSV-02-LIVE (more robust than `&& echo OK || echo FAIL` which can have short-circuit ordering surprises, per CONTEXT D-15 note)
- Used `mktemp` + `trap EXIT rm` for the RESS_TOOLS_FILE to avoid temp file leaks across smoke runs
- JSON body in `curl -d '...'` wrapped in single quotes to prevent bash interpolation of `$` in the schema properties object
- Soft-skip on both `OLLAMA_API_KEY` absence AND model not in models.yaml — two independent escape hatches match Phase 8 cloud gate pattern

## Deviations from Plan

None — plan executed exactly as written. The OBSV-02-LIVE gate uses the `if/then/else` form (recommended in CONTEXT D-15 over `&& echo OK || echo FAIL`) which was the correct implementation choice per plan guidance.

## Known Stubs

None — no stubs introduced. Both active gates either pass, fail, or soft-skip deterministically.

## Threat Flags

None — this plan modifies only a shell script. No new network endpoints, auth paths, or schema changes.

## Self-Check: PASSED

- `bin/smoke-test-router.sh` modified: FOUND (76 insertions, 1 deletion)
- `bash -n bin/smoke-test-router.sh` exits 0: CONFIRMED
- Phase 19 section at lines 2541–2613: CONFIRMED
- Summary banner at line 2619 includes `/19`: CONFIRMED
- Commit `7ffbba3` exists: CONFIRMED
- `git diff router/package.json router/package-lock.json` empty: CONFIRMED
- Only 1 minus-line in diff (summary banner): CONFIRMED
