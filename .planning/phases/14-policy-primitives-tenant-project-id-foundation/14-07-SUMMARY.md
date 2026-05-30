---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "07"
subsystem: metrics-routing
tags:
  - recordOutcome
  - request_log
  - tenant-id
  - project-id
  - workload-class
  - postgres
dependency_graph:
  requires:
    - 14-01  # migration 0005 widened RequestLogInsert type
    - 14-06  # scopedIdsPreHandler stamps req.tenantId/projectId/workloadClass
  provides:
    - "OutcomeContext.tenantId/projectId/workloadClass optional fields"
    - "request_log row stamped with tenant_id/project_id/workload_class on every outcome"
    - "All 13 safeRecord call sites across 5 routes pass scoped IDs to OutcomeContext"
    - "setErrorHandler recordOutcome call passes scoped IDs (pre-resolve error path)"
    - "Integration test proves full round-trip: headers → request_log row (POL-04 SC3)"
  affects:
    - router/src/metrics/recordOutcome.ts
    - router/src/app.ts
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts
    - router/src/routes/v1/rerank.ts
    - router/src/routes/v1/responses.ts
    - router/src/routes/__tests__/scopedIds-request-log.test.ts
tech_stack:
  added: []
  patterns:
    - "OutcomeContext optional field widening (mirrors agentId? pattern)"
    - "Row builder ?? null coercion (mirrors agent_id: ctx.agentId ?? null)"
    - "setErrorHandler scoped-ID threading (pre-resolve error path)"
    - "bufferedWriter spy pattern for integration tests (mirrors recordOutcome.test.ts:149)"
    - "Fake BackendAdapter injection to avoid MSW complexity in integration tests"
key_files:
  created:
    - router/src/routes/__tests__/scopedIds-request-log.test.ts
  modified:
    - router/src/metrics/recordOutcome.ts
    - router/src/app.ts
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts
    - router/src/routes/v1/rerank.ts
    - router/src/routes/v1/responses.ts
decisions:
  - "Rule 2 auto-fix: added AllowlistViolationError, CloudNotAllowedError, InvalidScopedIdError to mapErrorToCode imports and dispatch for correct request_log.error_code taxonomy labeling (Phase 14 error types were missing from the original mapErrorToCode)"
  - "Used fake BackendAdapter (not MSW) for integration tests to avoid registering upstream HTTP handlers in a test that exercises the preHandler + recordOutcome data plane rather than the adapter layer"
  - "mapErrorToCode for AllowlistViolationError → 'model_not_in_allowlist', CloudNotAllowedError → 'cloud_not_allowed', InvalidScopedIdError → 'invalid_request' (mirrors InvalidAgentIdError taxonomy)"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-30"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 7
---

# Phase 14 Plan 07: Scoped IDs End-to-End Plumbing Summary

**One-liner:** Full round-trip wiring of `tenant_id`/`project_id`/`workload_class` from preHandler-stamped `req.*` fields through 13 safeRecord call sites into OutcomeContext and the Drizzle `request_log` row, proven by a 6-scenario bufferedWriter-spy integration test (POL-04 SC3).

## What Was Built

### Task 1: Widen OutcomeContext + Row Builder + setErrorHandler

**`router/src/metrics/recordOutcome.ts`** — Two targeted patches:

1. `OutcomeContext` interface widened (after `agentId?: string`):
   ```typescript
   tenantId?: string;
   projectId?: string;
   workloadClass?: string;
   ```

2. Row builder extended (immediately after `agent_id: ctx.agentId ?? null,`):
   ```typescript
   tenant_id: ctx.tenantId ?? null,
   project_id: ctx.projectId ?? null,
   workload_class: ctx.workloadClass ?? null,
   ```

3. Phase 14 error types added to `mapErrorToCode` imports and dispatch:
   - `AllowlistViolationError` → `'model_not_in_allowlist'`
   - `CloudNotAllowedError` → `'cloud_not_allowed'`
   - `InvalidScopedIdError` → `'invalid_request'` (mirrors `InvalidAgentIdError`)

**`router/src/app.ts`** — `setErrorHandler` recordOutcome call extended:
```typescript
agentId: req.agentId,
// Phase 14: pre-resolve errors still get scoped-ID context if scopedIdsPreHandler ran before the error.
tenantId: req.tenantId,
projectId: req.projectId,
workloadClass: req.workloadClass,
```

### Task 2: Fan-out Across 13 safeRecord Call Sites

All 13 `agentId: req.agentId,` sites in 5 route files received three sibling lines immediately after:

```typescript
tenantId: req.tenantId,
projectId: req.projectId,
workloadClass: req.workloadClass,
```

**Actual line numbers found post-Plan 05 (shifted from RESEARCH.md predictions):**

| Route File | Sites | Line numbers |
|-----------|-------|-------------|
| `chat-completions.ts` | 5 | 468, 549, 568, 708, 940 |
| `messages.ts` | 5 | 371, 459, 478, 608, 761 |
| `embeddings.ts` | 1 | 533 |
| `rerank.ts` | 1 | 253 |
| `responses.ts` | 1 | 505 |
| **Total** | **13** | |

### Task 3: Integration Test

**`router/src/routes/__tests__/scopedIds-request-log.test.ts`** (240 lines) — 6 scenarios:

| # | Scenario | HTTP Status | Key Assertion |
|---|----------|-------------|---------------|
| 1 | All 3 headers populated | 200 | `tenant_id='acme'`, `project_id='agents'`, `workload_class='sensitive'` (lowercased) |
| 2 | No headers | 200 | All 3 columns `null` (D-13/D-17) |
| 3 | Invalid `X-Workload-Class` (space) | 200 | `workload_class=null` silent-NULL (D-12) |
| 4 | Invalid `X-Tenant-ID` (slash) — DETERMINISTIC | 400 | `pushed.length===1`, all 3 columns `null`, `agent_id=null`, `error_code='invalid_request'` |
| 5 | Cross-route `/v1/messages` | 200 | `tenant_id='globex'`, `project_id='cortex'`, `workload_class='batch'`, `protocol='anthropic'` |
| 6 | Cross-route `/v1/embeddings` | 200 | `tenant_id='acme'`, `project_id='search'`, `workload_class='analytics'` |

**Example `pushed[0]` from Test 1:**
```json
{
  "tenant_id": "acme",
  "project_id": "agents",
  "workload_class": "sensitive",
  "agent_id": null,
  "status_class": "success",
  "http_status": 200
}
```

## Test Results

```
Test Files  79 passed (79)
     Tests  850 passed | 7 skipped (857)
  Start at  13:40:00
  Duration  8.53s
```

```
cd router && npx vitest run src/routes/__tests__/scopedIds-request-log.test.ts --reporter=dot

 ✓ 1. (POL-04) happy path — all 3 headers populated row
 ✓ 2. (POL-04) no headers → all three columns null (D-13/D-17)
 ✓ 3. (D-12) invalid X-Workload-Class (space) → silent-NULL + status 200
 ✓ 4. (D-16 DETERMINISTIC) invalid X-Tenant-ID → 400 + row with null scoped IDs
 ✓ 5. (POL-04 cross-route) /v1/messages records scoped IDs in row
 ✓ 6. (POL-04 cross-route) /v1/embeddings records scoped IDs in row

Tests  6 passed (6)
```

## Acceptance Criteria Results

| Check | Result |
|-------|--------|
| `grep -c "tenantId?: string" recordOutcome.ts` | 1 |
| `grep -c "projectId?: string" recordOutcome.ts` | 1 |
| `grep -c "workloadClass?: string" recordOutcome.ts` | 1 |
| `grep -c "tenant_id: ctx.tenantId ?? null" recordOutcome.ts` | 1 |
| `grep -c "project_id: ctx.projectId ?? null" recordOutcome.ts` | 1 |
| `grep -c "workload_class: ctx.workloadClass ?? null" recordOutcome.ts` | 1 |
| `grep -c "tenantId: req.tenantId" app.ts` | 1 |
| Total tenantId sites across routes | 13 |
| Total projectId sites across routes | 13 |
| Total workloadClass sites across routes | 13 |
| `pnpm typecheck` exits 0 | PASS |
| Full vitest suite (79 files, 850 tests) | PASS |
| Pitfall-9 invariant: `req.log = ` count in src/ | 1 (agentId.ts only) |

## Commits

| Task | Hash | Description |
|------|------|-------------|
| Task 1 | 36352a3 | `feat(14-07): widen OutcomeContext + row builder + setErrorHandler scoped IDs` |
| Task 2 | eafceaf | `feat(14-07): fan scoped IDs across 13 safeRecord call sites in 5 routes` |
| Task 3 | 85baa79 | `feat(14-07): integration test + mapErrorToCode Phase 14 errors` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Phase 14 error types missing from `mapErrorToCode`**
- **Found during:** Task 3 — writing Test 4 which asserts `pushed[0].error_code`
- **Issue:** `AllowlistViolationError`, `CloudNotAllowedError`, and `InvalidScopedIdError` were not imported into or dispatched by `mapErrorToCode` in `recordOutcome.ts`. Without these, `request_log.error_code` would show `'internal_error'` for policy violations and invalid scoped IDs — incorrect D-D2 taxonomy labeling.
- **Fix:** Added the three new Phase 14 error types to `mapErrorToCode` imports and dispatch:
  - `AllowlistViolationError` → `'model_not_in_allowlist'`
  - `CloudNotAllowedError` → `'cloud_not_allowed'`
  - `InvalidScopedIdError` → `'invalid_request'` (mirrors `InvalidAgentIdError` D-D2 bucket)
- **Files modified:** `router/src/metrics/recordOutcome.ts`
- **Commit:** 85baa79 (included in Task 3 commit)

## Known Stubs

None — all three scoped-ID columns are populated end-to-end. The `request_log` rows now carry `tenant_id`, `project_id`, and `workload_class` when the corresponding headers are sent. The bufferedWriter-spy test proves the data plane without requiring a live Postgres connection (the migration 0005 live Postgres application is Plan 05's responsibility, already completed).

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundaries introduced. This plan is purely additive plumbing of already-validated values (validated by `scopedIdsPreHandler` in Plan 06) into an existing data sink (the `request_log` row via `bufferedWriter`).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `router/src/routes/__tests__/scopedIds-request-log.test.ts` exists | FOUND |
| `router/src/metrics/recordOutcome.ts` has `tenantId?: string` | FOUND |
| `router/src/metrics/recordOutcome.ts` has `tenant_id: ctx.tenantId ?? null` | FOUND |
| Commit `36352a3` exists | FOUND |
| Commit `eafceaf` exists | FOUND |
| Commit `85baa79` exists | FOUND |
| 13 safeRecord sites widened | VERIFIED |
| Pitfall-9: exactly 1 `req.log = ` in src/ | PASS |
| Full 850-test suite | PASS |
| TypeScript typecheck | PASS |
