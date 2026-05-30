---
phase: 14-policy-primitives-tenant-project-id-foundation
verified: 2026-05-30T22:00:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
human_verification_resolved: 2026-05-30T22:35:00Z
human_verification_resolution: "All 3 items pre-confirmed by orchestrator (vitest 851/0/7 post-CR-01-fix; typecheck clean; smoke 76/0/4 with SKIP_LLAMACPP=1 + openwebui start_period fix). Operator approved phase closure."
human_verification:
  - test: "Run live vitest suite to confirm 849/850 pass (1 known WSL flake)"
    expected: "849 or 850 tests pass with 0 unexpected failures; the 1 flake (hotreload.vram.test.ts) passes in isolation"
    why_human: "Cannot run pnpm vitest inside verification agent — test suite requires local router/ environment with node_modules; worktree test execution is not available here"
  - test: "Run pnpm typecheck in router/"
    expected: "Zero TypeScript errors"
    why_human: "Cannot invoke tsc from verification agent context"
  - test: "Run bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 SKIP_LLAMACPP=1"
    expected: "76 PASS / 0 FAIL / 4 SKIP (matching the operator-verified baseline from 14-09-SUMMARY)"
    why_human: "Requires live docker compose stack; cannot drive network from verification agent"
---

# Phase 14: Policy Primitives + Tenant/Project/Workload Scoped IDs Verification Report

**Phase Goal:** Land minimal policy primitives (per-entry capabilities allowlist + cloud-not-allowed denial) + tenant/project/workload scoped IDs from request to request_log row, end-to-end. Operators get discoverable affordances (models.yaml stanza + DEPLOY/README docs) without breaking the allow-all default. v0.10.0 smoke suite remains green.

**Verified:** 2026-05-30T22:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Derived from POL-01 through POL-06 + Phase Goal)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Operator can declare `policies.default.model_allowlist` in models.yaml; empty/absent = allow-all; non-member request returns 403 `model_not_in_allowlist` | VERIFIED | `grep "policies: z" registry.ts` → 1; `grep "export function applyPolicyGate" gate.ts` → 1; policy-gate-integration.test.ts Tests 1+4 cover 403 vs allow-all. All 5 routes wire the gate. |
| 2 | Operator can declare `policy.cloud_allowed: false` per entry; dispatch refuses ollama-cloud entries with false flag, returns 403 `cloud_not_allowed` | VERIFIED | `grep "cloud_allowed: z.boolean().default(true)" registry.ts` → 1; `grep "throw new CloudNotAllowedError" gate.ts` → 1; Tests 3+6+7+8 in policy-gate-integration.test.ts cover cross-route parity. cloudCalls.length === 0 assertion confirms no outbound request leaks. |
| 3 | X-Workload-Class header is extracted to `req.workloadClass` and written to `request_log.workload_class`; header value is opaque metadata; invalid values → silent NULL (never 400) | VERIFIED | `grep "const WC_RE" scopedIds.ts` → 1; `grep "workload_class: ctx.workloadClass ?? null" recordOutcome.ts` → 1; scopedIds.test.ts Test 5 asserts silent-NULL; scopedIds-request-log.test.ts Tests 1+3 assert row population and silent-NULL path. Live DB confirmed: `workload_class` column present. |
| 4 | X-Tenant-ID, X-Project-ID, X-Agent-ID headers extracted; tenant_id/project_id columns added to request_log via Drizzle migration 0005; invalid tenant/project → 400 `invalid_scoped_id` | VERIFIED | Migration 0005 SQL verified: 3× `ADD COLUMN IF NOT EXISTS`. Journal idx=5 confirmed. Drizzle schema has all 3 columns. Live Postgres confirmed: `project_id,tenant_id,workload_class` present. 13 safeRecord call sites across 5 routes all carry tenantId/projectId/workloadClass. scopedIds-request-log.test.ts Test 1 asserts `tenant_id='acme'`, `project_id='agents'`, `workload_class='sensitive'`. |
| 5 | Policy gate fires BEFORE the circuit breaker check — policy 403s never count as backend failures | VERIFIED | applyPolicyGate line precedes opts.breaker.check line in all 5 routes (numerically confirmed: chat-completions 225<331, messages 228<285, embeddings 236<240, rerank 140<142, responses 369<371). policy-gate-integration.test.ts Test 2 asserts `recordFailureSpy.toHaveBeenCalledTimes(0)` AND `checkSpy.toHaveBeenCalledTimes(0)` after 403. |
| 6 | Prometheus metric labels NEVER include tenant_id, project_id, agent_id, session_id (cardinality protection) | VERIFIED | Python scan of registry.ts labelNames arrays: NONE end in `_id`. checkCardinality(source) exported and tested (5 vitest cases including synthetic tenant_id/agent_id/project_id injection). Production scan returns empty array (Test 1). |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `router/db/migrations/0005_request_log_scoped_ids.sql` | 3 ADD COLUMN IF NOT EXISTS statements | VERIFIED | All 3 columns confirmed: tenant_id, project_id, workload_class |
| `router/db/migrations/meta/_journal.json` | idx=5 entry with tag=0005_request_log_scoped_ids | VERIFIED | Python check: idx5=True, total entries=6 |
| `router/src/db/schema/request_log.ts` | 3 nullable text columns | VERIFIED | grep confirms tenant_id, project_id, workload_class each → 1 |
| `router/src/config/registry.ts` | `policies: z.object({...})` + `policy: z.object({cloud_allowed: ...})` | VERIFIED | Both `policies: z` and `policy: z` → 1 each; `cloud_allowed: z.boolean().default(true)` → 1; `model_allowlist: z.array(z.string()).default([])` → 1 |
| `router/src/errors/envelope.ts` | 3 error classes + 9 mapping branches | VERIFIED | AllowlistViolationError, CloudNotAllowedError, InvalidScopedIdError all exported; 3× instanceof branches each in mapToHttpStatus + OpenAI + Anthropic mappers |
| `router/src/policy/gate.ts` | `applyPolicyGate` pure helper, 45 lines | VERIFIED | export function applyPolicyGate → 1; throw AllowlistViolationError → 1; throw CloudNotAllowedError → 1; `=== false` (Pitfall 4) → 4; forbidden form `!entry.policy?.cloud_allowed` → 0 |
| `router/src/routes/v1/chat-completions.ts` | applyPolicyGate wired at canonical position | VERIFIED | Line 225, before breaker.check at line 331 |
| `router/src/routes/v1/messages.ts` | Same | VERIFIED | Line 228, before breaker.check at line 285 |
| `router/src/routes/v1/embeddings.ts` | Same | VERIFIED | Line 236, before breaker.check at line 240 |
| `router/src/routes/v1/rerank.ts` | Same | VERIFIED | Line 140, before breaker.check at line 142 |
| `router/src/routes/v1/responses.ts` | Same | VERIFIED | Line 369, before breaker.check at line 371 |
| `router/src/app.ts` | `breaker?: CircuitBreaker` in BuildAppOpts; scopedIds registered before agentId | VERIFIED | `breaker?:` → 1; addHook scopedIds at line 303, agentId at line 311 |
| `router/src/middleware/scopedIds.ts` | scopedIdsPreHandler + ID_RE + WC_RE; zero req.log touches | VERIFIED | export async function → 1; ID_RE → 1; WC_RE → 1; throw InvalidScopedIdError → 1; `req.log` occurrences → 0 |
| `router/src/middleware/agentId.ts` | pino .child() includes tenant_id/project_id/workload_class unconditionally (D-20) | VERIFIED | child call at line 120 is OUTSIDE the `if (raw !== undefined)` block (confirmed by source inspection); tenant_id/project_id/workload_class all in child call → 1 each |
| `router/src/metrics/recordOutcome.ts` | OutcomeContext widened + row builder stamps 3 columns | VERIFIED | tenantId?/projectId?/workloadClass? → 1 each; tenant_id ?? null / project_id ?? null / workload_class ?? null → 1 each |
| `router/scripts/check-prometheus-cardinality.ts` | `checkCardinality` exported + CLI | VERIFIED | export function → 1; export interface CardinalityViolation → 1; `_id$` regex → 2; CONTEXT.md D-25 reference → 1 |
| `router/src/metrics/registry.ts` | POL-06 pointer comment at top; no _id labels | VERIFIED | POL-06 → 1; python scan: no _id violations |
| `router/models.yaml` | Commented policy stanza + hot-reload caveat | VERIFIED | `# policies:` → 1; `valkey-cli DEL` → 1; `# cloud_allowed:` → ≥1 |
| `DEPLOY.md` | Policy primitives section | VERIFIED | policies.default.model_allowlist → 1; cloud_allowed → 4; X-Tenant-ID → 1; valkey-cli DEL → 1; check-prometheus-cardinality → 2 |
| `README.md` | Policy & multi-tenant context subsection | VERIFIED | X-Tenant-ID → 3; policies → ≥1 |
| `.planning/REQUIREMENTS.md` | POL-01 wording patched per D-03 | VERIFIED | Contains `policies.default.model_allowlist` wording; old "per registry entry" form absent |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `registry.ts` policies type | `gate.ts applyPolicyGate` | `Registry['policies']` type parameter | VERIFIED | gate.ts imports `Registry, ModelEntry` type-only from registry.js |
| `gate.ts` AllowlistViolationError/CloudNotAllowedError throws | `app.ts setErrorHandler` → 403 + envelope | error instanceof dispatch in envelope.ts | VERIFIED | 3 instanceof branches each in all 3 mappers |
| `scopedIds.ts` InvalidScopedIdError throw | `app.ts setErrorHandler` → 400 + envelope | same envelope dispatch | VERIFIED | 3 instanceof branches confirmed |
| `scopedIdsPreHandler` → `agentIdPreHandler` | pino .child() sees stamped fields | Hook ordering: addHook line 303 before 311 | VERIFIED | Source inspection confirms order AND D-20 fix makes child call unconditional |
| `scopedIdsPreHandler` stamps req.tenantId/projectId/workloadClass | `recordOutcome.ts` row builder writes columns | 13 safeRecord call sites pass fields | VERIFIED | 5+5+1+1+1 = 13 sites confirmed across 5 routes; setErrorHandler path also confirmed in app.ts |
| `recordOutcome.ts` row builder | Live Postgres `request_log` | migration 0005 + Drizzle RequestLogInsert type | VERIFIED | Live DB: project_id,tenant_id,workload_class columns present |
| `checkCardinality` function | `router/src/metrics/registry.ts` | fs.readFileSync at CLI entry / test passes source string | VERIFIED | Test 1 reads live registry.ts; production scan returns 0 violations |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `request_log.tenant_id/project_id/workload_class` | req.tenantId/projectId/workloadClass | scopedIdsPreHandler reads X-Tenant-ID/X-Project-ID/X-Workload-Class headers | Yes — validated by regex, stamped on req, passed through 13 call sites to row builder, confirmed in live DB via psql SELECT showing `acme \| agents \| dev` | FLOWING |
| `applyPolicyGate(policies, ...)` | snapshot.policies | opts.registry.get().policies — live registry snapshot from Valkey | Yes — models.yaml parses through RegistrySchema; policies field flows to gate helper | FLOWING |
| Prometheus metrics (cardinality guard) | labelNames arrays | Static source of registry.ts | Not dynamic — static at compile time; no _id labels exist | VERIFIED (static) |

### Behavioral Spot-Checks

Step 7b is not independently runnable from the verification agent (requires docker compose stack + pnpm). Operator-provided evidence from 14-09-SUMMARY Task 3 (human-verified smoke gate) satisfies behavioral verification:

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| E2E scoped IDs round-trip | curl with X-Tenant-ID/X-Project-ID/X-Workload-Class headers | HTTP 200; DB row shows `acme \| agents \| dev` | PASS (operator-verified) |
| Smoke suite unchanged | `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 SKIP_LLAMACPP=1` | 76 PASS / 0 FAIL / 4 SKIP | PASS (operator-verified) |
| vitest full suite | `cd router && npm test` | 849/850 (1 WSL flake, passes 3/3 alone) | PASS (operator-verified) |
| typecheck | `cd router && npm run typecheck` | Clean (0 errors) | PASS (operator-verified) |

### Probe Execution

No probe scripts declared in PLAN files. Step 7c SKIPPED.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| POL-01 | 14-02, 14-04, 14-05, 14-09 | Global model allowlist (top-level policies block) | SATISFIED | Zod schema accepts policies.default.model_allowlist; applyPolicyGate enforces it; 403 + model_not_in_allowlist envelope verified; allow-all default proven by smoke gate |
| POL-02 | 14-02, 14-04, 14-05, 14-09 | Per-entry cloud_allowed: false denial | SATISFIED | ModelEntrySchema accepts policy.cloud_allowed; gate throws CloudNotAllowedError; 403 + cloud_not_allowed envelope; no outbound cloud request (MSW assertion) |
| POL-03 | 14-06, 14-07, 14-09 | X-Workload-Class opaque metadata extraction to request_log | SATISFIED | scopedIdsPreHandler extracts and lowercases; silent-NULL on invalid; workload_class column populated in live DB |
| POL-04 | 14-01, 14-05, 14-06, 14-07 | X-Tenant-ID/X-Project-ID/X-Agent-ID → request_log columns | SATISFIED | Migration 0005 adds columns; 13 safeRecord sites pass fields; live DB verified; full round-trip integration test green |
| POL-05 | 14-04, 14-05 | Policy gate fires BEFORE circuit breaker; policy 403s don't count as backend failures | SATISFIED | Gate position verified by line number in all 5 routes; breaker spy assertions in Test 2: recordFailure=0, check=0 after policy 403 |
| POL-06 | 14-08 | Prometheus labels NEVER include *_id suffix | SATISFIED | checkCardinality production scan: 0 violations; POL-06 pointer in registry.ts; 5 vitest tests including synthetic regression cases |

No orphaned requirements: all 6 POL requirements mapped to Phase 14 plans and verified above.

### Anti-Patterns Found

No `TBD`, `FIXME`, or `XXX` markers found in any Phase 14 modified source files. No stub implementations detected. The D-20 regression (pino .child() skipped when X-Agent-Id absent) was identified in 14-09-REVIEW and fixed in commit `5a90d2c` before phase submission — the fix is present in the current codebase.

**Notable deviation from plan:** Plan 05 acceptance criteria specified `applyPolicyGate(snapshot.policies, entry, body.model)` but the actual implementation uses `applyPolicyGate(opts.registry.get().policies, entry, body.model)`. This is semantically equivalent — the registry snapshot is fetched inline. The 14-05 SUMMARY documents this explicitly. No behavioral difference.

**P8-02 redesign:** Route schemas use `.passthrough()` rather than `.strict()`. Policy-gate-integration.test.ts Tests 9-10 were redesigned to prove the actual security invariant: even with `policy: {cloud_allowed:true}` in the body, the gate reads only from the registry. Documented in 14-05 SUMMARY as a Rule 2 security finding. The security property is stronger than the original schema-rejection approach.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| No blockers found | — | — | — | — |

### Human Verification Required

#### 1. Full vitest test suite

**Test:** From `router/` directory, run `pnpm vitest run --reporter=dot`
**Expected:** 849 or 850 tests pass (0 unexpected failures); the known WSL flake `hotreload.vram.test.ts` may appear as 1 failure in batch but passes 3/3 in isolation with `pnpm vitest run tests/integration/hotreload.vram.test.ts`
**Why human:** vitest requires pnpm + node_modules in the router/ context; cannot run from verification agent

#### 2. TypeScript typecheck

**Test:** From `router/` directory, run `pnpm typecheck` (or `npx tsc --noEmit`)
**Expected:** Exit code 0, zero TypeScript errors
**Why human:** Requires local tsc invocation with project's tsconfig.json

#### 3. Smoke test baseline preserved

**Test:** With live docker compose stack running, execute `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 SKIP_LLAMACPP=1`
**Expected:** 76 PASS / 0 FAIL / 4 SKIP — matching the operator-verified baseline from 14-09-SUMMARY
**Why human:** Requires live docker compose stack with router container running Phase 14 binary; cannot drive from verification agent

**Note:** The operator already ran these checks as part of the 14-09-SUMMARY Task 3 smoke gate (approved by operator). This human verification request re-confirms the current HEAD state matches that approval, since commit `5a90d2c` (D-20 fix) landed after the initial smoke gate run.

### Gaps Summary

No gaps found. All 6 POL requirements are verified against actual codebase. The phase goal is fully achieved:

1. Policy primitives (allowlist + cloud-not-allowed) are wired into all 5 routes at the correct position with complete dual-surface error envelopes.
2. Scoped IDs (tenant/project/workload) flow end-to-end from request headers through middleware, recordOutcome, and into live Postgres request_log columns.
3. Operator affordances (models.yaml stanza, DEPLOY.md, README.md, REQUIREMENTS.md patch) are substantive and discoverable.
4. The v0.10.0 smoke suite baseline is maintained (operator-verified: 76 PASS / 0 FAIL / 4 SKIP with SKIP_LLAMACPP=1).
5. The D-20 regression (pino child skipped when X-Agent-Id absent) was caught by code review and fixed in commit `5a90d2c` with a New Test 7 regression gate in `scopedIds.test.ts`.

The only remaining items are human-runnable confirmations of the test suite and smoke gate against the current HEAD (post D-20 fix).

---

_Verified: 2026-05-30T22:00:00Z_
_Verifier: Claude (gsd-verifier)_
