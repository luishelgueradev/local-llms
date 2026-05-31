---
phase: 15-mcp-host-router-as-mcp-server
plan: 11
subsystem: api
tags: [policy-filter, http-models, request-log, metrics, integration, single-lens, dual-surface]

# Dependency graph
requires:
  - phase: 15
    provides: registerListModelsTool with D-10 filter + cloud_allowed annotation (Plan 15-10); chat_completion + 4 other MCP tools wired into buildServerForRequest; routerMcpToolCallsTotal + routerMcpActiveSessions metrics; bufferedWriter.push row writes from MCP tool handlers (Plan 15-06)
  - phase: 14
    provides: ModelEntry.policy.cloud_allowed; RegistrySchema.policies.default.model_allowlist; scopedIdsPreHandler (tenant/project/workload); agentIdPreHandler (agent); POL-06 cardinality discipline
provides:
  - HTTP /v1/models + /v1/models/:id widened with D-10 allowlist filter + D-11 cloud_allowed annotation (single lens with MCP list_models)
  - GET /v1/models/:id treats allowlist-excluded entries as 404 + model_not_found
  - Integration test for D-10/D-11 dual-surface parity (MCP vs HTTP)
  - Integration test for D-05/D-06 request_log row population + scoped IDs propagation
  - Integration test for D-07 /metrics gauge + counter live values + POL-06 invariant re-verified
affects: [phase-16-mcp-client-wave — consumers can rely on single-lens projection on both surfaces; phase-19-OBSV — MCP smoke tests can lean on the cross-cutting integration coverage shipped here]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inline filterAndProject helper that lists fields explicitly (no spread of ModelEntry) — T-3-A2 anti-leak by construction"
    - "Single-lens dual-surface filter: HTTP /v1/models and MCP list_models read the same `policies.default.model_allowlist` and emit the same `policy.cloud_allowed` annotation"
    - "GET /v1/models/:id 404 semantics widened: allowlist-excluded entries are treated as not-found, matching the list endpoint's filtered view"
    - "Integration test pattern for MCP wire round-trip: initialize → notifications/initialized → tools/call, with extractFirstJsonRpcFrame supporting both JSON-body and SSE-framed responses"

key-files:
  created:
    - router/tests/integration/list-models-policy-filter.integration.test.ts
    - router/tests/integration/mcp-request-log.integration.test.ts
    - router/tests/integration/mcp-metrics.integration.test.ts
  modified:
    - router/src/routes/v1/models.ts
    - router/tests/integration/models.test.ts

key-decisions:
  - "Inline filterAndProject helper, not exported. The MCP list_models tool has its own twin projection inside list-models.ts; both are five-field literal-projection blocks (~10 lines each). A shared helper would have to live above either the routes layer or the registry layer — both are awkward and add an import edge for almost no code savings. Keeping them inline preserves single-file readability for the T-3-A2 anti-leak invariant."
  - "Test 3 of the request_log suite asserts error_code='unknown_model' (not 'model_not_found'). The OpenAI envelope code shown to clients IS 'model_not_found', but the request_log.error_code column carries the internal taxonomy from mapErrorToCode (recordOutcome.ts:167 maps RegistryUnknownModelError → 'unknown_model'). Aligning the test with the actual taxonomy avoids encoding a fake invariant — the plan said 'or whichever class is derived', so this is the correct expectation."
  - "Inert adapter stub in list-models test buildAppWithPolicy() override. The cloud entry in the 3-entry YAML triggers a background liveness probe that calls factory.ts and throws 'requires cloudApiKey'. Without the override the test still passes (5/5) but emits 5 unhandled rejections to the test output. Providing a no-op makeAdapter() keeps the test output clean and signals that list-models is a pure projection surface (adapter is never invoked on the happy path)."
  - "Test 6 (POL-06 invariant) implementation re-validates the cardinality discipline at /metrics rather than at registry.ts. The plan's threat T-15-11-CARD said 'Task 4 Test 6 reruns POL-06 cardinality discipline against live /metrics text' — a regex over the raw output catches both the metrics registry surface AND any prom-client transformation, which is stricter than testing labelNames alone."

patterns-established:
  - "Single-lens projection across protocols: when a registry-derived surface is exposed on both HTTP and MCP, both surfaces MUST read the same registry filter and emit the same annotation. Drift is caught by a dual-surface parity integration test."
  - "/v1/models/:id 404 widening: an allowlist-excluded entry returns 404 + model_not_found from the retrieve route — invisible on the list endpoint means invisible on the retrieve endpoint."
  - "MCP wire integration test scaffolding: initialize → notifications/initialized → tools/call, with an extractFirstJsonRpcFrame helper that accepts BOTH JSON-mode body AND SSE-framed body. Reusable across phases — already in mcp-host.integration.test.ts (Plan 15-10), 3 new tests here use the same shape."

requirements-completed: [MCPS-03, MCPS-04, MCPS-05]

# Metrics
duration: 7min
completed: 2026-05-31
---

# Phase 15 Plan 11: Widen HTTP /v1/models with allowlist filter + cloud_allowed annotation + 3 cross-cutting MCP integration tests Summary

**HTTP /v1/models + /v1/models/:id now mirror the MCP list_models tool exactly — same allowlist filter, same `policy.cloud_allowed` annotation, same single-lens 404 semantics — and 3 new integration tests lock D-05/D-06 request_log writes, D-07 /metrics observability, and D-10/D-11 dual-surface parity.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-05-31T06:08:35Z
- **Completed:** 2026-05-31T06:15:16Z
- **Tasks:** 4
- **Files modified/created:** 5 (1 source modified + 1 existing test modified + 3 integration tests created)

## Accomplishments

- HTTP `GET /v1/models` widened with `policies.default.model_allowlist` filter + `policy.cloud_allowed` annotation per entry (D-10/D-11). T-3-A2 anti-leak preserved by an inline `filterAndProject` helper that lists fields explicitly (no spread of ModelEntry).
- HTTP `GET /v1/models/:id` 404 condition widened: allowlist-excluded entries return `404 + model_not_found`, matching the filtered view of the list endpoint (single lens).
- Integration test `list-models-policy-filter.integration.test.ts` (5 tests): verifies HTTP and MCP surfaces return the same filtered set with the same projection shape, the cloud_allowed annotation behaves identically on both surfaces, and T-3-A2 anti-leak is enforced on both.
- Integration test `mcp-request-log.integration.test.ts` (5 tests): verifies one row per tool call (D-05), scoped-IDs propagation from outer POST /mcp (D-06), error-path row population with status_class=client_error + error_code=unknown_model, and the Pitfall-8 `X-Agent-Id`-absent → `agent_id: null` invariant.
- Integration test `mcp-metrics.integration.test.ts` (6 tests): verifies `router_mcp_active_sessions` gauge tracks live (0 → 1 → 0 on close), `router_mcp_tool_calls_total{tool,status_class}` increments per tool call (success + error classes), and POL-06 (no `_id`-suffixed labels) is preserved at the live `/metrics` output.
- Updated `tests/integration/models.test.ts` to expect the new `policy` field in the GET /v1/models + GET /v1/models/:id projections. All 11 pre-existing models.test cases still pass.

## Task Commits

Each task was committed atomically:

1. **Task 1: Widen GET /v1/models + GET /v1/models/:id with allowlist filter + cloud_allowed annotation** — `d561418` (feat)
2. **Task 2: Integration test — D-10/D-11 dual-surface filter parity** — `8cac8ee` (test)
3. **Task 3: Integration test — D-05/D-06 request_log row population for MCP tool calls** — `3a4648b` (test)
4. **Task 4: Integration test — D-07 metrics gauge + counter visibility** — `9680723` (test)

**Plan metadata:** (final docs commit follows this SUMMARY)

## Files Created/Modified

### Created
- `router/tests/integration/list-models-policy-filter.integration.test.ts` (388 lines) — D-10/D-11 dual-surface parity tests with `buildAppWithPolicy(yaml)` helper. Inert adapter stub to suppress background liveness-probe unhandled rejections from the cloud entry in the 3-entry YAML fixture.
- `router/tests/integration/mcp-request-log.integration.test.ts` (377 lines) — D-05/D-06 row population tests. Uses a `vi.fn()`-backed bufferedWriter so push captures can be inspected and a fake adapter stubs the chat_completion happy path.
- `router/tests/integration/mcp-metrics.integration.test.ts` (281 lines) — D-07 gauge + counter visibility + Test 6 POL-06 invariant verifier (scans every label name in the raw /metrics text for `_id`-suffixed labels).

### Modified
- `router/src/routes/v1/models.ts` — Added inline `filterAndProject(reg, created)` helper applying the D-10 allowlist filter and the D-11 `policy.cloud_allowed` annotation. T-3-A2 anti-leak preserved (explicit field list, no spread of ModelEntry). GET /v1/models/:id 404 condition widened to include allowlist-excluded entries (single lens with the list endpoint).
- `router/tests/integration/models.test.ts` — Updated Case 1 (list) and Case R1 (retrieve) field-key assertions to include the new `policy` field; both cases assert `policy.cloud_allowed === true` (the YAML fixture has no policy block on either entry, so the Phase 14 default fires).

## Decisions Made

- **Inline `filterAndProject` helper (not exported, not shared).** The MCP `list_models` tool (Plan 15-10) and the HTTP `/v1/models` route share the same projection invariant (D-10 + D-11), but the actual code blocks are five-field literal projections (~10 lines each). Sharing them would require a helper above either `routes/` or `config/registry.ts` — both are awkward, and the import edge isn't worth the ~10 lines of code saved. Keeping the projection literal in each surface preserves single-file readability of the T-3-A2 anti-leak invariant (one grep over the file confirms no spread of ModelEntry).
- **Test 3 error_code assertion uses `'unknown_model'`, not `'model_not_found'`.** The OpenAI envelope code shown to clients IS `model_not_found`, but the `request_log.error_code` column carries the internal taxonomy from `mapErrorToCode` (`recordOutcome.ts:167`: `RegistryUnknownModelError → 'unknown_model'`). The plan said "or whichever class is derived"; aligning with the actual mapper avoids encoding a fake invariant.
- **Inert adapter stub in `list-models-policy-filter.integration.test.ts`.** The 3-entry YAML fixture includes a cloud entry. Without an `opts.makeAdapter` override, buildApp() starts a background liveness probe that constructs the cloud adapter via `factory.ts`, which throws `requires cloudApiKey`. The tests still pass (the surface under test is `list_models`, a pure registry projection), but unhandled rejections pollute the test output. The override returns the same inert adapter for every entry — list_models never calls it on the happy path.
- **Test 6 (POL-06) tests the live `/metrics` text, not the registry config.** The plan said "rerun POL-06 cardinality discipline against live /metrics text". A regex scan of the raw output (`/([A-Za-z_]+_id)="/g`) catches both the registry's labelNames arrays AND any prom-client transformation. Stricter than asserting against `metrics.routerMcpToolCallsTotal.labelNames` alone.

## Deviations from Plan

None — all 4 tasks executed as written. The plan's deferred questions ("planner suggested extracting shared helper") were resolved in favor of inline projections, documented in Decisions Made above.

**Total deviations:** 0
**Impact on plan:** None.

## Issues Encountered

- **Pre-existing typecheck errors in 4 backend adapter files** (`llamacpp-openai.ts`, `ollama-cloud.ts`, `ollama-openai.ts`, `vllm-openai.ts`): 4 TS2322 errors from a rogue `pnpm-lock.yaml` (148KB, untracked in the repo, NOT created by this plan) pulling `undici@7.26.0` while `@types/node`'s peer brings `undici-types@6.21.0`. Documented as pre-existing in Plan 15-10 SUMMARY's "Issues Encountered" section; **not introduced by Plan 15-11** (verified by `pnpm typecheck 2>&1 | grep -E "^src/.*error TS"` returning exactly 4 errors, none in files I modified). Out of scope per scope_boundary; recommended a housekeeping pnpm-lock-cleanup task in the deferred-items already (Plan 15-10).
- **Unhandled rejections from cloud-probe path** when a cloud entry appears in a test YAML without an `opts.makeAdapter` override. Treated as a test-hygiene fix (Rule 3 — auto-fix blocking issue): provided an inert adapter stub in `buildAppWithPolicy()` so the cloud probe gets a benign return. Not a code defect — it is the documented behavior of `assertCloudEnvIfConfigured` (operator MUST provide `OLLAMA_API_KEY` for cloud entries in production).

## Known Stubs

None. The `policy.cloud_allowed` field is wired all the way from `models.yaml` → registry → router projection → MCP tool projection. No placeholder data flows into UI; the field defaults to `true` when the YAML omits the policy block (Phase 14 default — documented as such and intentional).

## Threat Flags

None — no new security-relevant surface introduced. Existing T-3-A2 (backend leakage) and T-15-11-CARD (label cardinality) threats are now covered by integration tests at the live surface, strengthening the mitigation posture.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 15-12 unblocked:** HTTP and MCP now share a single projection lens — any downstream phase that consumes either surface gets consistent semantics.
- **Phase 19 (OBSV) ready:** Smoke tests can rely on the 3 cross-cutting integration tests landed here. The MCP-side observability invariants (D-05/D-06/D-07 + POL-06) are end-to-end verified — Phase 19's smoke script only needs to confirm the wire surface, not the internal taxonomy.
- **MCPS-03 (list_models) + MCPS-04 (cloud_allowed annotation) + MCPS-05 (metrics surface) closed:** All three requirements have integration-level coverage now. Phase 15 verifier can mark them ✓.

## Self-Check: PASSED

- File `router/src/routes/v1/models.ts` modified — FOUND (`grep -c "cloud_allowed"` = 5; `grep -c "model_allowlist"` = 4; no spread of ModelEntry)
- File `router/tests/integration/list-models-policy-filter.integration.test.ts` (388 lines, ≥ 100 min) — FOUND
- File `router/tests/integration/mcp-request-log.integration.test.ts` (377 lines, ≥ 80 min) — FOUND
- File `router/tests/integration/mcp-metrics.integration.test.ts` (281 lines, ≥ 60 min) — FOUND
- Commit `d561418` (Task 1 — feat: widen GET /v1/models) — FOUND
- Commit `8cac8ee` (Task 2 — test: dual-surface filter parity) — FOUND
- Commit `3a4648b` (Task 3 — test: request_log row population) — FOUND
- Commit `9680723` (Task 4 — test: /metrics gauge + counter visibility) — FOUND
- `pnpm vitest run` of all 4 plan-related files: 27/27 tests passing
- `pnpm vitest run tests/integration/mcp-host.integration.test.ts` (Plan 15-10 carryover): 7/7 still passing — no regression
- Pre-existing 4 backend-adapter TS errors unchanged (verified: 4 before, 4 after this plan)

---
*Phase: 15-mcp-host-router-as-mcp-server*
*Completed: 2026-05-31*
