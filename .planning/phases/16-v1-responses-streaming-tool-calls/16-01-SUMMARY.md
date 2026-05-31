---
phase: 16-v1-responses-streaming-tool-calls
plan: 01
subsystem: testing
tags: [phase-16, ress, wave-0, scaffold, golden-fixtures, vitest, sse, responses-api]

# Dependency graph
requires:
  - phase: 13-v0.10.0-canonical-responses
    provides: "Non-streaming /v1/responses route, ResponsesRequestSchema, responsesToCanonical/canonicalToResponses translators, existing tests/routes/responses.test.ts harness"
  - phase: 04-canonical-translation
    provides: "CanonicalStreamEvent union (canonical.ts:215-226), tests/translation/openai-out.test.ts analog file"
provides:
  - "router/tests/translation/responses-stream.test.ts — translator unit-suite skeleton (28 it.todo stubs across 6 describe blocks)"
  - "router/tests/translation/golden/responses-stream/01..06-*.json — 6 golden fixture placeholders with locked shape { name, description, opts, canonical_events: [], expected_sse: [] }"
  - "router/tests/routes/responses-stream.test.ts — route integration suite skeleton (15 it.todo stubs across 4 describe blocks; R1..R15)"
  - "router/tests/routes/golden/responses-nonstream-v0.10.0.json — P9-02 regression fixture placeholder (__placeholder: true)"
  - "router/tests/routes/golden/README.md — documents the new route-level golden convention"
affects: [phase-16-02-translator, phase-16-03-route-wiring, phase-16-04-phase-wrap-up]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Route-level golden snapshots — tests/routes/golden/<scenario>.json loaded by sibling test, asserted toEqual against fresh app.inject body with deterministic ids (vi.setSystemTime(new Date(0)) + opts.idOverride). FIRST instance in the repo."
    - "Wave-0 test scaffold — it.todo stubs carry exact case names from the research-phase test matrix so subsequent waves flip todo → real test with no rename churn"
    - "Intentionally-failing import as Wave-0 signal — translator unit suite imports canonicalToResponsesSse from a path that does not exist yet; vitest exits non-zero with 'Cannot find module', surfacing the Plan 16-02 gap rather than silently skipping"

key-files:
  created:
    - "router/tests/translation/responses-stream.test.ts"
    - "router/tests/translation/golden/responses-stream/01-simple-text.json"
    - "router/tests/translation/golden/responses-stream/02-tool-call.json"
    - "router/tests/translation/golden/responses-stream/03-text-then-tool.json"
    - "router/tests/translation/golden/responses-stream/04-multi-delta-text.json"
    - "router/tests/translation/golden/responses-stream/05-failed-mid-stream.json"
    - "router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json"
    - "router/tests/routes/responses-stream.test.ts"
    - "router/tests/routes/golden/responses-nonstream-v0.10.0.json"
    - "router/tests/routes/golden/README.md"
  modified: []

key-decisions:
  - "Translator unit-suite import (canonicalToResponsesSse) intentionally fails until Plan 16-02 — keeps the Nyquist gate honest (verification harness existed before code)."
  - "Golden fixtures carry name + description + opts only; canonical_events/expected_sse arrays stay empty in Wave 0. Plan 16-02 captures the live translator output and fills them in (avoids hard-coding placeholder values that would become a maintenance trap)."
  - "P9-02 regression fixture carries explicit __placeholder: true flag so Plan 16-04 can assert 'not still a placeholder' as part of phase wrap-up (T-16-01-T mitigation in threat model)."
  - "Route integration suite imports buildApp + registry helpers eagerly + voids them so TypeScript is happy while bodies remain stubbed — Plan 16-03 deletes the voids when beforeEach + assertions land."

patterns-established:
  - "Route-level golden snapshot convention (tests/routes/golden/) — captures wire-body fixtures for regression tests; UPDATE_GOLDEN=1 env var sigil for intentional regeneration; first introduced in Phase 16 (P9-02)."
  - "Wave-0 scaffold pattern — describe blocks + it.todo with exact case names from the test matrix; intentionally-failing imports surface missing modules as a build signal rather than a silent skip."

requirements-completed: []  # Plan 16-01 creates the validation harness only. RESS-01..05 verification waits on Plans 16-02 / 16-03 / 16-04 (this plan's requirements list is the harness-scaffolding for RESS-01..05, not their closure).

# Metrics
duration: 4 min
completed: 2026-05-31
---

# Phase 16 Plan 01: Wave-0 Scaffold — Test Skeletons + Golden Fixture Placeholders Summary

**Empty translator unit-suite + 6 golden fixture placeholders + route integration suite skeleton + P9-02 regression fixture, establishing the tests/routes/golden/ directory convention — Nyquist gate met before any translator/route code lands.**

## Performance

- **Duration:** 4 min (231s)
- **Started:** 2026-05-31T20:15:29Z
- **Completed:** 2026-05-31T20:19:20Z
- **Tasks:** 2 / 2
- **Files created:** 10 (0 modified, 0 deleted)

## Accomplishments

- Translator unit-suite skeleton (`router/tests/translation/responses-stream.test.ts`) with 28 `it.todo` stubs across 6 describe blocks — names mirror 16-RESEARCH §"Recommended Test Matrix" cases #1..#25 so Plan 16-02 flips todo → real test with no rename churn.
- 6 golden-fixture placeholders under `router/tests/translation/golden/responses-stream/` — locked shape `{ name, description, opts, canonical_events: [], expected_sse: [] }`; Plan 16-02 captures and populates the canonical events + expected SSE.
- Route integration-suite skeleton (`router/tests/routes/responses-stream.test.ts`) with R1..R15 (15 `it.todo` stubs) across 4 describe blocks (happy path, tool-calls, reuse path, gates).
- P9-02 regression fixture placeholder (`router/tests/routes/golden/responses-nonstream-v0.10.0.json`) — carries explicit `__placeholder: true` flag for Plan 16-04 verification.
- `router/tests/routes/golden/` directory established as a NEW convention (first route-level golden snapshot in the repo per PATTERNS.md §"No Analog Found"), with adjacent README documenting the convention + `UPDATE_GOLDEN=1` regeneration sigil.

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold translator unit-suite skeleton with stubbed cases** — `c6e3da3` (test)
2. **Task 2: Scaffold 6 golden-fixture JSON placeholders + route integration-suite skeleton + P9-02 regression placeholder** — `57f7c90` (test)

**Plan metadata:** (to be set by the docs commit)

## Files Created/Modified

### Created (10)

- `router/tests/translation/responses-stream.test.ts` — translator unit-suite skeleton; 6 describes + 28 `it.todo`; imports `canonicalToResponsesSse` from a path that does not yet resolve (intentional Wave-0 signal).
- `router/tests/translation/golden/responses-stream/01-simple-text.json` — fixture #1 placeholder (3-delta text-only stream — RESS-01 + RESS-02 happy path).
- `router/tests/translation/golden/responses-stream/02-tool-call.json` — fixture #2 placeholder (single function_call — RESS-03).
- `router/tests/translation/golden/responses-stream/03-text-then-tool.json` — fixture #3 placeholder (FSM correctness gate — P3-02).
- `router/tests/translation/golden/responses-stream/04-multi-delta-text.json` — fixture #4 placeholder (sequence_number monotonicity stress — RESS-02).
- `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json` — fixture #5 placeholder (response.failed terminator — P3-03).
- `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json` — fixture #6 placeholder (signal.aborted — no terminator frame).
- `router/tests/routes/responses-stream.test.ts` — route integration-suite skeleton; 4 describes + 15 `it.todo` covering R1..R15.
- `router/tests/routes/golden/responses-nonstream-v0.10.0.json` — P9-02 regression fixture placeholder with `__placeholder: true` flag.
- `router/tests/routes/golden/README.md` — documents the new route-level golden convention + UPDATE_GOLDEN=1 sigil.

### Modified

- None — `git diff router/src/` returns empty across both commits; zero production code touched (per `<success_criteria>`).

## Decisions Made

- **Failed-import Wave-0 signal kept intentionally.** The unit suite imports `canonicalToResponsesSse` from `../../src/translation/responses-stream.js`, which does not exist yet. Vitest exits non-zero with "Cannot find module" — the intended Nyquist gate signal that the harness predates the code, not a silent skip. Plan 16-02 makes the import resolve. Avoided the temptation to add `// @ts-expect-error` or to wrap the import in a try/catch — the failure surface is the feature.
- **Empty fixture arrays in Wave 0.** The 6 golden fixtures carry only `name`, `description`, and `opts`. `canonical_events` and `expected_sse` are empty arrays. Hard-coding placeholder events now would create a maintenance trap once Plan 16-02 captures the real translator output. Acceptance criterion #2 only requires the keys to exist with empty arrays — verified.
- **P9-02 fixture uses `__placeholder: true` sentinel.** Plan 16-04 will assert that the flag is gone (replaced by a real captured body) before phase wrap-up — this is the T-16-01-T mitigation from the threat model.
- **Route integration suite voids unused imports.** Imports buildApp + registry helpers + bearer constants per `responses.test.ts:1-30`, then `void`s them so TypeScript doesn't flag unused while bodies remain stubbed. Plan 16-03 deletes the voids when `beforeEach` + assertions land — no import churn.
- **`it.todo` strings are the exact test-matrix case names.** Plan 16-02 and 16-03 will flip `it.todo` → `it(...)` with zero string rename — preserves grep-ability and audit traceability against 16-RESEARCH §"Recommended Test Matrix".

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Verification Results

Wave-end gate (from PLAN.md `<verification>`):

| Gate | Command | Expected | Actual | Result |
|------|---------|----------|--------|--------|
| Translator unit suite fails on missing import | `cd router && npx vitest run tests/translation/responses-stream.test.ts` | non-zero exit + "module not found" | exit non-zero; "Cannot find module '../../src/translation/responses-stream.js'" | PASS |
| Route integration suite reports skipped todos | `cd router && npx vitest run tests/routes/responses-stream.test.ts` | N skipped, no failed assertions, no crash | 15 todo (15); 0 failed; 0 crash | PASS |
| All scaffold files on disk | `ls` per task spec | 8 task files + README | 9 files present (8 + README) | PASS |
| All JSON parses cleanly | `JSON.parse(...)` on each | 7/7 parse | 7/7 OK | PASS |
| No production code modified | `git diff router/src/` | empty | empty | PASS |

Per-task acceptance criteria from PLAN.md:

| Task | Criterion | Result |
|------|-----------|--------|
| 1 | File `router/tests/translation/responses-stream.test.ts` exists | PASS |
| 1 | Exactly 6 describe blocks named per spec | PASS (grep count = 6) |
| 1 | ≥18 `it.todo` stubs | PASS (28 stubs) |
| 1 | Imports `canonicalToResponsesSse` from path that doesn't yet resolve | PASS |
| 1 | Top-of-file docstring present | PASS |
| 1 | Vitest exits non-zero with "module not found" | PASS |
| 2 | All 8 files exist on disk | PASS |
| 2 | All 7 JSON files parse with `JSON.parse` | PASS |
| 2 | Each translator golden file has keys `name`, `description`, `opts`, `canonical_events: []`, `expected_sse: []` | PASS |
| 2 | Route integration suite has ≥15 `it.todo` stubs across 4 describe blocks | PASS (15 todos, 4 describes) |
| 2 | `router/tests/routes/golden/README.md` exists and documents the convention | PASS |
| 2 | P9-02 placeholder includes `__placeholder: true` flag | PASS |

## Next Phase Readiness

Plan 16-02 ready to execute:

- Translator unit-suite skeleton in place at the canonical path — Plan 16-02 only needs to land `router/src/translation/responses-stream.ts` and flip `it.todo` → `it(...)` with real assertions; no test-file reshuffling required.
- 6 golden-fixture placeholders in place with locked shape — Plan 16-02's golden runner can read them and populate `canonical_events` + `expected_sse` via a fixture-update mode.
- Route integration-suite skeleton in place at the canonical path — Plan 16-03 only needs to wire `beforeEach(buildApp)` + flip R1..R15 todos to real tests; integration patterns documented in `responses.test.ts:1-30` already imported.
- P9-02 regression placeholder + `__placeholder: true` sentinel in place — Plan 16-04 will populate it with the captured v0.10.0 non-stream body and assert the flag is gone.

No blockers; no carry-over.

## Self-Check: PASSED

Files on disk (10/10):

- router/tests/translation/responses-stream.test.ts — FOUND
- router/tests/translation/golden/responses-stream/01-simple-text.json — FOUND
- router/tests/translation/golden/responses-stream/02-tool-call.json — FOUND
- router/tests/translation/golden/responses-stream/03-text-then-tool.json — FOUND
- router/tests/translation/golden/responses-stream/04-multi-delta-text.json — FOUND
- router/tests/translation/golden/responses-stream/05-failed-mid-stream.json — FOUND
- router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json — FOUND
- router/tests/routes/responses-stream.test.ts — FOUND
- router/tests/routes/golden/responses-nonstream-v0.10.0.json — FOUND
- router/tests/routes/golden/README.md — FOUND

Commits on git log (2/2):

- c6e3da3 — FOUND (test(16-01): scaffold translator unit-suite skeleton)
- 57f7c90 — FOUND (test(16-01): scaffold golden fixtures + route integration suite + P9-02 placeholder)

---
*Phase: 16-v1-responses-streaming-tool-calls*
*Completed: 2026-05-31*
