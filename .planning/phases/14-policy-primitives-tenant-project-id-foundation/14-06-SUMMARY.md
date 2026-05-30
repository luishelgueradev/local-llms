---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "06"
subsystem: middleware
tags:
  - middleware
  - prehandler
  - fastify
  - pino
  - policy
dependency_graph:
  requires:
    - 14-03  # InvalidScopedIdError in envelope.ts
    - 14-05  # app.ts registration patterns established
  provides:
    - req.tenantId / req.projectId / req.workloadClass stamped on FastifyRequest
    - scopedIdsPreHandler registered before agentIdPreHandler in app.ts
    - pino .child() enriched with tenant_id/project_id/workload_class (D-20)
    - Pitfall-9 invariant: exactly ONE req.log = in production source
  affects:
    - 14-07  # DB row population reads req.tenantId/projectId/workloadClass
tech_stack:
  added: []
  patterns:
    - preHandler hook registered before sibling preHandler (hook-ordering dependency)
    - pino .child() extended at single site to include all scoped IDs (Pitfall-9)
    - FastifyRequest module augmentation for new req fields
    - execSync grep gate as vitest assertion (static source invariant)
key_files:
  created:
    - router/src/middleware/scopedIds.ts
    - router/src/middleware/__tests__/scopedIds.test.ts
    - router/src/middleware/__tests__/single-req-log.test.ts
  modified:
    - router/src/middleware/agentId.ts
    - router/src/app.ts
decisions:
  - "D-15: ID_RE reuses AGENT_ID_RE exactly — /^[A-Za-z0-9._:-]{1,128}$/"
  - "D-11/D-12: X-Workload-Class uses narrower WC_RE (/^[A-Za-z0-9._-]{1,64}$/), silent-NULL on absent or invalid"
  - "D-16/D-17: X-Tenant-ID and X-Project-ID throw InvalidScopedIdError on regex fail; absent → silent NULL"
  - "D-18: sibling module pattern — scopedIds.ts stamps fields, agentId.ts owns the single req.log.child() call"
  - "D-19: FastifyRequest module augmentation adds tenantId/projectId/workloadClass to FastifyRequest interface"
  - "D-20/Pitfall-9: one pino child assignment in production source, in agentId.ts only; grep gate enforced by vitest"
metrics:
  duration: 409s
  completed: "2026-05-30"
  tasks: 2
  files: 5
---

# Phase 14 Plan 06: scopedIds preHandler + Pitfall-9 invariant Summary

**One-liner:** X-Tenant-ID/X-Project-ID/X-Workload-Class header extraction preHandler with Pitfall-9 grep-gate invariant test enforcing single pino child assignment.

## What Was Built

### Task 1: scopedIdsPreHandler + agentId.ts patch + app.ts registration

**`router/src/middleware/scopedIds.ts`** (129 lines) — new sibling preHandler:
- Two regex constants: `ID_RE = /^[A-Za-z0-9._:-]{1,128}$/` (D-15 exact reuse) and `WC_RE = /^[A-Za-z0-9._-]{1,64}$/` (D-11)
- `extractScopedId()` internal helper: first-value-wins for arrays (RFC 9110 §5.3 per agentId.ts idiom)
- `scopedIdsPreHandler`: stamps `req.tenantId` / `req.projectId` / `req.workloadClass`; throws `InvalidScopedIdError` on invalid tenant/project IDs; silent-NULL on invalid workload class
- FastifyRequest module augmentation: adds `tenantId?`, `projectId?`, `workloadClass?` (D-19)
- Zero `req.log` mentions — Pitfall-9 invariant enforced by construction

**`router/src/middleware/agentId.ts`** (1 logical change):

Before:
```typescript
req.log = req.log.child({ agent_id: value });
```

After:
```typescript
req.log = req.log.child({
  agent_id: value,
  tenant_id: req.tenantId,
  project_id: req.projectId,
  workload_class: req.workloadClass,
});
```

Still exactly ONE `req.log =` assignment in router/src/ production source.

**`router/src/app.ts`** hook registration snippet:
```typescript
// Phase 14: scopedIds BEFORE agentId — agentId's .child() reads stamped fields
app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);  // line 303

// Plan 05-02: X-Agent-Id preHandler (unchanged)
app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);  // line 311
```

Also added `scopedIdsPreHandler?: preHandlerAsyncHookHandler` seam to `BuildAppOpts`.

### Task 2: Tests

**`router/src/middleware/__tests__/scopedIds.test.ts`** (220 lines) — 6 scenarios:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | All headers absent | 200; tenantId/projectId/workloadClass all undefined (D-13/D-17) |
| 2 | Valid IDs + workload class SENSITIVE | 200; tenantId='acme', projectId='agents', workloadClass='sensitive' (D-11 lowercase) |
| 3 | Invalid X-Tenant-ID (space) | 400; error.code=invalid_scoped_id; error.param=X-Tenant-ID |
| 4 | Invalid X-Project-ID (slashes) | 400; error.code=invalid_scoped_id; error.param=X-Project-ID |
| 5 | Invalid X-Workload-Class (space) | 200; workloadClass=undefined (silent-NULL per D-12) |
| 6 | Hook ordering proof | pino log line contains all four IDs: tenant_id, project_id, workload_class, agent_id |

**`router/src/middleware/__tests__/single-req-log.test.ts`** (44 lines) — Pitfall-9 grep gate:
- `execSync("grep -rn 'req\\.log = ' ./src/ || true")` from router/ cwd
- Asserts exactly 1 line (excluding `__tests__`) matching `/middleware\/agentId\.ts/`

## Test Results

```
Test Files  1 passed (scopedIds.test.ts: 6/6)
            1 passed (single-req-log.test.ts: 1/1)
Full suite: 78 test files, 844 tests passing, 7 skipped
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Comments in scopedIds.ts contained `req.log =` text**
- **Found during:** Task 1 acceptance criteria verification
- **Issue:** The initial implementation included comments that mentioned `req.log =` literal text, which caused the Pitfall-9 grep gate (`grep -rn 'req\.log = ' router/src/ | grep -v '__tests__' | wc -l`) to return `6` instead of `1`
- **Fix:** Rewrote all comments in scopedIds.ts and agentId.ts to avoid the literal `req.log =` string pattern; plan acceptance criteria requires the grep gate to return exactly `1`
- **Files modified:** `router/src/middleware/scopedIds.ts`, `router/src/middleware/agentId.ts`, `router/src/app.ts`
- **Commit:** dfa615e (included in Task 1 commit after fix)

**2. [Rule 1 - Bug] Test 6 missing explicit log call in route handler**
- **Found during:** Task 2 first run
- **Issue:** Fastify's built-in `incoming request` log fires on `onRequest` (before preHandler), so the initial test using only the built-in log had no `.child()`-enriched line to assert on
- **Fix:** Added `req.log.info({ event: 'test-route-hit' }, 'test route handler ran')` in the stub route handler, which fires after agentIdPreHandler enriches `req.log` via `.child()`
- **Files modified:** `router/src/middleware/__tests__/scopedIds.test.ts`
- **Commit:** 3a6ceb3

## Known Stubs

None — plan goal fully achieved. `req.tenantId`, `req.projectId`, `req.workloadClass` are populated and tested end-to-end. Plan 07 will consume these fields for DB row population.

## Threat Flags

No new threat surface introduced. `scopedIdsPreHandler` applies regex gating before stamping — attacker-controlled header values that fail the bounded regex (`{1,128}` / `{1,64}`) are truncated at 32 chars and wrapped in `InvalidScopedIdError` (T-14-04 mitigation). `X-Workload-Class` invalid values are silently discarded, never logged raw (T-14-LOG-01). The Pitfall-9 grep gate is now a vitest assertion (T-14-05).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `router/src/middleware/scopedIds.ts` exists | FOUND |
| `router/src/middleware/__tests__/scopedIds.test.ts` exists | FOUND |
| `router/src/middleware/__tests__/single-req-log.test.ts` exists | FOUND |
| Commit `dfa615e` exists | FOUND |
| Commit `3a6ceb3` exists | FOUND |
| Pitfall-9 gate: grep count == 1 | PASS |
| Full vitest suite: 78 files, 844 tests passing | PASS |
| TypeScript typecheck: `tsc --noEmit` exits 0 | PASS |
