---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "04"
subsystem: policy-gate
tags:
  - policy
  - helper
  - tdd
dependency_graph:
  requires:
    - 14-02  # Registry/ModelEntry types with policies + policy fields
    - 14-03  # AllowlistViolationError + CloudNotAllowedError error classes
  provides:
    - applyPolicyGate helper ready for Plan 05 (5 route insertions)
  affects:
    - router/src/policy/gate.ts
    - router/src/policy/__tests__/gate.test.ts
tech_stack:
  added: []
  patterns:
    - Pure helper module pattern (mirrors computeCostCents.ts)
    - TDD RED/GREEN cycle with atomic commits
key_files:
  created:
    - router/src/policy/gate.ts
    - router/src/policy/__tests__/gate.test.ts
  modified: []
decisions:
  - "Single-file approach (no types.ts) per D-19 — helper is small enough"
  - "node_modules symlink created in worktree router to run tests (worktree shares code but not deps)"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-30"
  tasks_completed: 1
  files_created: 2
---

# Phase 14 Plan 04: applyPolicyGate Helper Summary

**One-liner:** Pure policy gate helper with two hard-coded rules — allowlist check + cloud-not-allowed check — using strict `=== false` for Pitfall 4 safety.

## What Was Built

Created `router/src/policy/gate.ts` exporting `applyPolicyGate(policies, entry, requested_model): void`, the single source of truth for policy enforcement consumed by all 5 routes in Plan 05.

**gate.ts stats:**
- Line count: 45 (< 60 requirement met)
- Exports: 1 (`applyPolicyGate`)
- `throw new AllowlistViolationError` occurrences: 1
- `throw new CloudNotAllowedError` occurrences: 1
- `=== false` occurrences: 4 (comment + inline code)
- Forbidden `!entry.policy?.cloud_allowed` form: 0

## TDD Gate Compliance

- **RED commit** `487de49`: 10 failing tests (module not found — gate.ts absent)
- **GREEN commit** `8beb50e`: implementation; all 10 tests pass

## Test Cases — All 10 Green

| # | Description | Expected |
|---|-------------|----------|
| 1 | No policies block (allow-all) | No throw |
| 2 | Empty allowlist (allow-all) | No throw |
| 3 | Allowlist hit — model in allowlist | No throw |
| 4 | Allowlist miss — model not in allowlist | AllowlistViolationError (code=model_not_in_allowlist, modelName=big-cloud) |
| 5 | Cloud entry, policy undefined (defaults to allow) | No throw |
| 6 | Cloud entry, cloud_allowed=true | No throw |
| 7 | Cloud entry, cloud_allowed=false | CloudNotAllowedError (code=cloud_not_allowed, modelName=big-cloud) |
| 8 | LOCAL entry, cloud_allowed=false (vacuous, D-05) | No throw |
| 9 | Both violations — allowlist fires first | AllowlistViolationError (not CloudNotAllowedError) |
| 10 | Pitfall 4 — policy:undefined on cloud entry | No throw (strict === false correctly handles undefined) |

## Implementation Notes

- ESM `.js` import suffixes per `nodenext` moduleResolution convention
- Type-only imports (`import type`) for `Registry` and `ModelEntry` per `verbatimModuleSyntax`
- Fixture factories use `as unknown as ModelEntry` cast with comment explaining why (gate only reads `backend` + `policy?.cloud_allowed`)
- Gate position invariant documented in JSDoc: AFTER capability gate, BEFORE `breaker.check()` (D-09 P8-01 BLOCK)

## Deviations from Plan

**[Rule 3 - Blocking] Worktree lacked node_modules for test execution**
- **Found during:** RED phase vitest run
- **Issue:** Worktree's router directory had no `node_modules` — `npx vitest` resolved to the wrong location
- **Fix:** Created `router/node_modules -> /home/luis/proyectos/local-llms/router/node_modules` symlink in the worktree
- **Files modified:** None (symlink only, not tracked by git)
- **Impact:** Tests now run correctly from worktree path

None other — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The helper is pure (no I/O, no side effects except throwing). Threat mitigations T-14-01, T-14-PITFALL-04, T-14-CIRC-01 are all implemented as documented.

## Commits

| Hash | Message |
|------|---------|
| 487de49 | test(14-04): add failing tests for applyPolicyGate — 10-case matrix |
| 8beb50e | feat(14-04): implement applyPolicyGate pure helper |

## Self-Check: PASSED

- `router/src/policy/gate.ts` exists: YES
- `router/src/policy/__tests__/gate.test.ts` exists: YES
- Commits 487de49 and 8beb50e exist in git log: YES
- All 10 tests pass: YES (10/10)
- Full suite (75 files, 827 tests): PASS (0 regressions)
- typecheck exits 0: YES
