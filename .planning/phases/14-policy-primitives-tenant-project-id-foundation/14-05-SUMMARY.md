---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "05"
subsystem: routes-policy-gate
tags:
  - routes
  - policy
  - integration-test
  - migration-apply
  - pol-01
  - pol-02
  - pol-05
  - p8-02
dependency_graph:
  requires:
    - 14-01  # migration 0005 SQL tuple
    - 14-02  # RegistrySchema with policies + policy fields
    - 14-04  # applyPolicyGate helper
  provides:
    - applyPolicyGate wired at canonical position in all 5 routes
    - BuildAppOpts.breaker injection seam for test spying
    - Migration 0005 applied to live Postgres request_log
    - 10-test integration suite covering POL-01/02/05/P8-02/cross-route parity
  affects:
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts
    - router/src/routes/v1/rerank.ts
    - router/src/routes/v1/responses.ts
    - router/src/app.ts
    - router/src/routes/__tests__/policy-gate-integration.test.ts
tech_stack:
  added: []
  patterns:
    - Policy gate insertion: applyPolicyGate(snapshot.policies, entry, body.model) at canonical D-09 position
    - BuildAppOpts injection seam: optional breaker?: CircuitBreaker (opts.breaker ?? existing construction)
    - Direct SQL apply via docker compose exec for migration (drizzle journal registered at boot)
    - vi.fn() breaker spy pattern for POL-05 assertion
    - MSW cloudCalls array spy for POL-02 no-outbound-call assertion
key_files:
  created:
    - router/src/routes/__tests__/policy-gate-integration.test.ts
  modified:
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts
    - router/src/routes/v1/rerank.ts
    - router/src/routes/v1/responses.ts
    - router/src/app.ts
decisions:
  - "Gate position non-negotiable (D-09/P8-01 BLOCK): applyPolicyGate after capability gate, before breaker.check in all 5 routes"
  - "Migration 0005 applied via direct SQL: docker compose exec -T postgres psql -U app -d router < 0005_request_log_scoped_ids.sql"
  - "P8-02 tests reframed: schemas use .passthrough() by design; security property is gate reads registry, not body — tests 9-10 prove body policy:{} field has zero effect on 403 outcome"
  - "Task 2 has no git commit (runtime DB operation only)"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-30"
  tasks_completed: 3
  tasks_total: 3
  files_created: 1
  files_modified: 6
---

# Phase 14 Plan 05: Policy Gate Route Wiring Summary

**One-liner:** applyPolicyGate wired at canonical position (AFTER capability gate, BEFORE breaker.check) in all 5 model-bound routes, with optional breaker injection seam in BuildAppOpts and 10-test integration suite proving POL-01/02/05 + P8-02 body-override immunity.

## What Was Built

### Task 1: Route insertions + BuildAppOpts breaker seam

Five routes patched with 5-line insertion each + gate.js import:

| Route | Insertion line | Before breaker.check line |
|-------|---------------|--------------------------|
| `chat-completions.ts` | line 225 | line 331 |
| `messages.ts` | line 228 | line 285 |
| `embeddings.ts` | line 236 | line 240 |
| `rerank.ts` | line 140 | line 142 |
| `responses.ts` | line 369 | line 371 |

All insertions follow the exact pattern:
```typescript
// Phase 14 (v0.11.0 — POL-01 / POL-02 / P8-01 BLOCK): policy gate fires
// AFTER capability gate, BEFORE the breaker check, so a policy 403 never
// mutates the breaker counter (P8-01). Snapshot fetched here — registry.get()
// is the existing seam; hot-reload swaps the snapshot atomically.
applyPolicyGate(opts.registry.get().policies, entry, body.model);
```

`BuildAppOpts.breaker?: CircuitBreaker` added to `router/src/app.ts` at line ~130, adjacent to `agentIdPreHandler?`. Breaker construction site updated to `opts.breaker ?? (existing valkey+env construction)`.

### Task 2: Migration 0005 applied to live Postgres

**Apply command used:** Direct SQL injection:
```bash
docker compose exec -T postgres psql -U app -d router < router/db/migrations/0005_request_log_scoped_ids.sql
```

Output:
```
ALTER TABLE
ALTER TABLE
ALTER TABLE
COMMENT
COMMENT
COMMENT
```

**Post-apply `\d request_log` output (relevant section):**
```
 tenant_id           | text                     |           |          |
 project_id          | text                     |           |          |
 workload_class      | text                     |           |          |
```

Verify command result:
```
docker compose exec -T postgres psql -U app -d router -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='request_log' AND column_name IN ('tenant_id','project_id','workload_class') ORDER BY column_name" \
  | tr '\n' ',' | grep "project_id,tenant_id,workload_class,"
→ VERIFY: PASS
```

Pre-existing columns (`agent_id`, `cost_cents`, `idempotency_key`, all others) unchanged.

Note: `drizzle.__drizzle_migrations` table is updated at next router boot via the `runMigrations()` call in `router/src/db/migrate.ts` (boot-time migrator automatically registers the journal idx=5 entry).

### Task 3: Integration test (10 scenarios)

File: `router/src/routes/__tests__/policy-gate-integration.test.ts`

| # | Scenario | Assertion | Result |
|---|----------|-----------|--------|
| 1 | POL-01 — allowlist miss on /v1/chat/completions | 403 + `model_not_in_allowlist` + `policy_violation` | PASS |
| 2 | POL-05 — breaker spy after 403 | `recordFailure.mock.calls.length === 0` AND `check.mock.calls.length === 0` | PASS |
| 3 | POL-02 — cloud_allowed:false + no outbound | 403 + `cloud_not_allowed` + `cloudCalls.length === 0` | PASS |
| 4 | D-04 — absent policies → allow-all | 200 (regression guard) | PASS |
| 5 | POL-01 cross-route — /v1/messages Anthropic surface | 403 + `type:error` + `permission_error` | PASS |
| 6 | POL-02 cross-route — /v1/embeddings | 403 + `cloud_not_allowed` | PASS |
| 7 | POL-02 cross-route — /v1/rerank | 403 + `cloud_not_allowed` | PASS |
| 8 | POL-02 cross-route — /v1/responses | 403 + `cloud_not_allowed` | PASS |
| 9 | P8-02 BLOCK — chat-completions body `policy:{}` has zero effect | Still 403 (registry wins) + `cloudCalls.length === 0` | PASS |
| 10 | P8-02 BLOCK — messages body `policy:{}` has zero effect | Still 403 Anthropic `permission_error` + `cloudCalls.length === 0` | PASS |

**Zod error envelope shapes captured for Tests 9-10 (P8-02):**
- Route schemas use `.passthrough()` by design (forwards unknown fields to upstream).
- Security property: `applyPolicyGate` reads ONLY from `opts.registry.get().policies`, never from `body.policy`. Body field is silently forwarded to upstream or dropped.
- Tests 9-10 prove: even with `policy: { cloud_allowed: true }` in the body, `cloud_allowed: false` in the registry produces 403. A future change wiring `body.policy` into the gate would flip these tests from 403 to 200 — immediately visible regression.

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| `grep -c "applyPolicyGate(opts.registry.get().policies, entry, body.model)" chat-completions.ts` → 1 | PASS |
| Same for messages.ts, embeddings.ts, rerank.ts, responses.ts | PASS (1 each) |
| applyPolicyGate line number < opts.breaker.check line number in all 5 routes | PASS |
| `grep -c "from '../../policy/gate.js'" <route>.ts` → 1 for all 5 | PASS |
| `grep -c "breaker?:" src/app.ts` → 1 | PASS |
| `pnpm typecheck` exits 0 | PASS |
| Migration columns in live Postgres | PASS (`tenant_id`, `project_id`, `workload_class` as nullable text) |
| `pnpm vitest run src/routes/__tests__/policy-gate-integration.test.ts` → 10/10 | PASS |
| Full suite `pnpm vitest run --reporter=dot` | PASS (76 files, 837 tests, 7 skipped) |

## Deviations from Plan

### [Rule 2 - Security] P8-02 test redesign — schemas use .passthrough(), not .strict()

- **Found during:** Task 3 implementation
- **Issue:** Plan assumed ChatCompletionRequestSchema and AnthropicMessagesRouteBodySchema use `.strict()` to reject `policy: {...}` body fields. Actual code uses `.passthrough()` (by design — routes forward unknown fields to upstream; this is correct behavior for an OpenAI-compat proxy).
- **Fix:** Redesigned Tests 9-10 to prove the actual P8-02 security property: even with `policy: { cloud_allowed: true }` in the body, the gate reads only from `opts.registry.get().policies`. A registry `cloud_allowed: false` still produces 403. This is a stronger security proof than schema rejection — it proves the attack vector (body override) has zero effect on gate outcome.
- **Impact:** Tests 9-10 assert 403 (not 400 as plan expected). The security invariant is maintained. The test commentary clearly documents the P8-02 BLOCK intent and how a future regression would be caught (if body.policy were wired into gate, tests would flip to 200).
- **Files modified:** `policy-gate-integration.test.ts` (test intent + assertions redesigned)

### [Rule 3 - Blocking] node_modules symlink created for worktree

- **Found during:** Task 3 test run setup
- **Issue:** Worktree's `router/` directory lacked node_modules (same as Plan 04 deviation)
- **Fix:** `ln -s /home/luis/proyectos/local-llms/router/node_modules .../worktrees/agent-*/router/node_modules`
- **Files modified:** None (symlink only, not tracked by git)

### Task 2 has no git commit (expected)

- Task 2 is a runtime DB operation (no source file changes). Migration applied via direct SQL. The Drizzle migrator (`runMigrations()` in `src/db/migrate.ts`) will register the journal idx=5 entry at next router boot.

## Threat Surface Scan

No new network endpoints or auth paths introduced. Gate insertion is additive (throw path). BuildAppOpts.breaker seam is optional with no-op fallback. Integration test file is test-only (no production surface).

Migration apply does not introduce new columns accessible via API — columns are written by `recordOutcome` (Plans 06/07) and are not returned in any route response.

## Known Stubs

None.

## Self-Check: PASSED

- `router/src/routes/v1/chat-completions.ts` contains applyPolicyGate at line 225: FOUND
- `router/src/routes/v1/messages.ts` contains applyPolicyGate at line 228: FOUND
- `router/src/routes/v1/embeddings.ts` contains applyPolicyGate at line 236: FOUND
- `router/src/routes/v1/rerank.ts` contains applyPolicyGate at line 140: FOUND
- `router/src/routes/v1/responses.ts` contains applyPolicyGate at line 369: FOUND
- `router/src/app.ts` contains `breaker?:` field: FOUND
- `router/src/routes/__tests__/policy-gate-integration.test.ts` exists: FOUND
- Commit `5bfd3c7` (Task 1): FOUND
- Commit `6d63a3f` (Task 3): FOUND
- Migration columns present in live Postgres: VERIFIED
- All 10 tests pass: VERIFIED
- Full suite 76/76 files, 837/837 tests: VERIFIED
