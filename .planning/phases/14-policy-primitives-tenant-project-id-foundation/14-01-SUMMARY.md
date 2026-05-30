---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "01"
subsystem: db-migration
tags:
  - drizzle
  - migration
  - postgres
  - request_log
  - tenant-id
  - project-id
  - workload-class
dependency_graph:
  requires: []
  provides:
    - "request_log.tenant_id nullable text column (migration 0005)"
    - "request_log.project_id nullable text column (migration 0005)"
    - "request_log.workload_class nullable text column (migration 0005)"
    - "Drizzle schema RequestLogInsert type widened with tenant_id/project_id/workload_class"
    - "_journal.json idx=5 entry registered for migration runner"
  affects:
    - router/src/db/schema/request_log.ts
    - router/db/migrations/meta/_journal.json
tech_stack:
  added: []
  patterns:
    - "Drizzle migration atomic tuple: SQL + schema + journal in one commit (D-23)"
    - "ADD COLUMN IF NOT EXISTS idempotent DDL (mirrors 0002 precedent)"
    - "COMMENT ON COLUMN documentation discipline (mirrors 0004 precedent)"
key_files:
  created:
    - router/db/migrations/0005_request_log_scoped_ids.sql
    - router/tests/migration0005.test.ts
  modified:
    - router/src/db/schema/request_log.ts
    - router/db/migrations/meta/_journal.json
decisions:
  - "D-14: workload_class ships in migration 0005 alongside tenant_id and project_id (three columns, one migration)"
  - "D-21: read _journal.json first to confirm idx=5 is next; verified at execution (idx 0..4 present)"
  - "D-22: file named 0005_request_log_scoped_ids.sql"
  - "D-23: Drizzle journal tuple atomicity — SQL + schema + journal in one commit so migrator does not silently skip"
  - "D-24: no new indexes in migration 0005"
metrics:
  duration: "~8 minutes"
  completed: "2026-05-30"
  tasks_completed: 1
  tasks_total: 1
  files_created: 2
  files_modified: 2
---

# Phase 14 Plan 01: Migration 0005 Atomic Tuple Summary

**One-liner:** Drizzle migration 0005 atomic tuple landing `tenant_id`, `project_id`, `workload_class` nullable TEXT columns on `request_log` with SQL DDL + schema patch + journal entry in a single commit (D-23, POL-04).

## What Was Built

Migration 0005 landed as an atomic three-file tuple (four files including the vitest integrity test):

| File | Role |
|------|------|
| `router/db/migrations/0005_request_log_scoped_ids.sql` | Idempotent `ADD COLUMN IF NOT EXISTS` DDL + `COMMENT ON COLUMN` for all 3 columns |
| `router/src/db/schema/request_log.ts` | Drizzle schema widened with `tenant_id`, `project_id`, `workload_class` after `cost_cents` |
| `router/db/migrations/meta/_journal.json` | `idx=5` entry appended: `tag=0005_request_log_scoped_ids`, `version=7`, `breakpoints=true`, `when=1780142072840` |
| `router/tests/migration0005.test.ts` | Vitest integrity test asserting tuple completeness (10 assertions) |

### Column shapes

- `tenant_id text` — source: `X-Tenant-ID`, regex `/^[A-Za-z0-9._:-]{1,128}$/`, invalid → 400 (D-16), missing → NULL (D-17)
- `project_id text` — source: `X-Project-ID`, same regex as tenant_id (shared with X-Agent-Id per D-15)
- `workload_class text` — source: `X-Workload-Class`, regex `/^[A-Za-z0-9._-]{1,64}$/` lowercased, invalid → silent NULL (D-12), opaque metadata (Frame-04)

No new indexes (D-24). All columns nullable — existing INSERT paths unaffected until Wave 2 recordOutcome plumbing lands.

## Vitest Proof

```
cd router && node_modules/.bin/vitest run tests/migration0005.test.ts --reporter=dot

 RUN  v4.1.6 /home/luis/proyectos/local-llms/.claude/worktrees/agent-a9b98b3292b0c513b/router

··········

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  12:00:03
   Duration  310ms
```

## Acceptance Criteria Results

| Check | Result |
|-------|--------|
| `grep -c 'ADD COLUMN IF NOT EXISTS "tenant_id"' ...0005*.sql` | 1 |
| `grep -c 'ADD COLUMN IF NOT EXISTS "project_id"' ...0005*.sql` | 1 |
| `grep -c 'ADD COLUMN IF NOT EXISTS "workload_class"' ...0005*.sql` | 1 |
| `grep -c '0005_request_log_scoped_ids' _journal.json` | 1 |
| `python3` journal check: idx=5 + 6 total entries | PASS |
| `grep -c "tenant_id: text('tenant_id')" request_log.ts` | 1 |
| `grep -c "project_id: text('project_id')" request_log.ts` | 1 |
| `grep -c "workload_class: text('workload_class')" request_log.ts` | 1 |
| `pnpm vitest run tests/migration0005.test.ts` | 10/10 pass |
| `tsc --noEmit` (excluding pre-existing TDD stubs from plans 14-02/03) | 0 new errors |

## Commits

| Commit | Hash | Files |
|--------|------|-------|
| `test(14-01): add failing tests for migration 0005 atomic tuple integrity` | e98ca6d | `router/tests/migration0005.test.ts` |
| `feat(14-01): migration 0005 — request_log scoped-ID + workload_class columns (POL-04, atomic tuple)` | a42ae82 | `router/db/migrations/0005_request_log_scoped_ids.sql`, `router/src/db/schema/request_log.ts`, `router/db/migrations/meta/_journal.json` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test file path moved from `src/db/__tests__/` to `tests/`**
- **Found during:** Task 1 setup
- **Issue:** `vitest.config.ts` `include` pattern is `tests/**/*.test.ts`. The plan specified `router/src/db/__tests__/migration0005.test.ts` which would be silently ignored by the test runner (never executed).
- **Fix:** Placed test at `router/tests/migration0005.test.ts` to match vitest.config.ts. Added note in test file header documenting the deviation.
- **Files modified:** `router/tests/migration0005.test.ts` (location only — content identical to plan spec)
- **Note:** The `src/**/__tests__/**/*.test.ts` include was added to vitest.config.ts by a parallel agent (plan 14-02) after the plan was written; even so, using `tests/` is the canonical location for this project.

## TypeScript Typecheck Note

`tsc --noEmit` exits with errors in `src/config/__tests__/registry.policies.test.ts` and `src/errors/__tests__/policy-envelopes.test.ts` — these are pre-existing TDD RED phase test stubs committed by plans 14-02 and 14-03 respectively. They reference `policies`, `AllowlistViolationError`, `CloudNotAllowedError`, `InvalidScopedIdError` not yet implemented. Zero new errors introduced by this plan's changes.

## Known Stubs

None — migration file, schema, and journal are complete artifacts. Live DB columns will be created when migration is applied (Plan 05 task, after Wave 2 wiring lands).

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. DDL-only migration.

## Self-Check: PASSED

- `router/db/migrations/0005_request_log_scoped_ids.sql` exists: FOUND
- `router/db/migrations/meta/_journal.json` has idx=5: FOUND
- `router/src/db/schema/request_log.ts` has tenant_id/project_id/workload_class: FOUND
- `router/tests/migration0005.test.ts` exists: FOUND
- Commit `e98ca6d` (test RED): FOUND
- Commit `a42ae82` (feat GREEN): FOUND
