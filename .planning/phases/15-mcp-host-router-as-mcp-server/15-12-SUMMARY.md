---
phase: 15-mcp-host-router-as-mcp-server
plan: 12
subsystem: api
tags: [smoke, docs, golden-snapshot, shutdown, disabled-mode, stdio-grep-gate, phase-final-gate]

# Dependency graph
requires:
  - phase: 15
    provides: 5-tool MCP wiring complete (Plan 15-10); HTTP /v1/models single-lens mirror + 3 cross-cutting integration tests (Plan 15-11); applyPreflight helper + HTTP route refactor; routerMcpActiveSessions gauge + routerMcpToolCallsTotal counter; shutdownSessions 5s Promise.race utility; D-15 disabled-mode early-return in mcpHostPlugin
provides:
  - Golden snapshot drift gate (P1-03): router/tests/golden/mcp-tools-manifest.json + tests/unit/mcp/host/tools-manifest.test.ts (UPDATE_GOLDEN=1 escape hatch documented)
  - MCPS-05 SIGTERM cleanup integration test (3 tests including a wedged-transport simulation that proves the 5s race ceiling fires)
  - D-15 MCP_ENABLED=false integration test (4 tests; 404 response, no /v1/* regression, hasRoute=false on disabled mode)
  - bin/smoke-test-router.sh extended with Phase 15 MCP section (MCP-01 initialize + MCP-02 bearer 401 + MCP-03 tools/call list_models)
  - DEPLOY.md `## MCP Host (Phase 15 — v0.11.0)` operator section + README.md feature-list bullet
  - MCPS-06 stdio grep gate as vitest invariant (tests/unit/mcp/host/stdio-grep-gate.test.ts — fails CI on any future Stdio*Transport import in router/src/)
affects:
  - phase-16-RESS: Phase 15 closure means MCP wire is stable; Phase 16 can extend /v1/responses without disturbing MCP integration tests
  - phase-19-OBSV-01: smoke script now has a Phase 15 section to extend with live SDK Client round-trip + tool error path

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Golden snapshot drift gate: a checked-in JSON manifest + a unit test that programmatically builds the surface (here: a fresh McpServer + all 5 register*Tool calls) and asserts deep-equality. UPDATE_GOLDEN=1 env-var escape hatch for intentional regenerations."
    - "Integration test pattern for SIGTERM/wedged-transport: vi.spyOn on the prototype's close() method with a counter that wedges only the FIRST invocation, captures the wedged instance, observes the warn log line, then unsticks the wedged transport via the captured originalClose so Hono's internal forceClose timer can settle cleanly. uncaughtException handler swallows the expected socket.destroySoon side-effect."
    - "Smoke section idempotency-safe MCP handshake: initialize → notifications/initialized → tools/call, with skip-on-404 branch so MCP_ENABLED=false routers do not fail downstream checks."
    - "Runtime grep gate as vitest test: execSync('grep -rn pattern src/ || true') asserting empty output. Cheaper than a custom ESLint rule, runs on every test invocation, fails with a precise file:line pointer on violation."

key-files:
  created:
    - router/tests/golden/mcp-tools-manifest.json
    - router/tests/unit/mcp/host/tools-manifest.test.ts
    - router/tests/integration/mcp-shutdown.integration.test.ts
    - router/tests/integration/mcp-disabled.integration.test.ts
    - router/tests/unit/mcp/host/stdio-grep-gate.test.ts
    - .planning/phases/15-mcp-host-router-as-mcp-server/15-12-SUMMARY.md
  modified:
    - bin/smoke-test-router.sh
    - DEPLOY.md
    - README.md
    - .planning/STATE.md
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md
    - .planning/phases/15-mcp-host-router-as-mcp-server/deferred-items.md

key-decisions:
  - "Sort the tools/list response alphabetically in the golden manifest builder, NOT in the SDK. The SDK 1.29.0 currently emits in registration order, but a future SDK upgrade that changes emission order would create a false drift signal. Sorting at golden-build time isolates the test from SDK internals while still pinning the schemas + names + descriptions + titles end-to-end."
  - "Wedged-transport leak handling in MCPS-05 Test 2: instead of letting Hono's forceClose timer fire 5s after our test wallclock and produce uncaught socket.destroySoon errors, the test captures the wedged StreamableHTTPServerTransport instance during the spy callback, then calls the captured originalClose AFTER assertions complete. Belt-and-suspenders: also register a process-level uncaughtException handler that swallows ONLY the `destroySoon is not a function` error message; everything else bubbles."
  - "D-15 integration test is a separate file from the inline Test 5 already in mcp-host.integration.test.ts. The Plan brief explicitly requested a dedicated file (`router/tests/integration/mcp-disabled.integration.test.ts`); duplicating the assertion is justified because the disabled-mode behavior is a top-level operator contract — having a file named after the feature surfaces it in the test report and tracks the assertion across future plans (e.g., when a v0.12.0 might extend disabled-mode to per-tool toggles)."
  - "MCPS-06 grep gate uses runtime execSync, not eslint. The repo already runs vitest unconditionally on every CI invocation; adding an ESLint custom rule requires maintenance of a custom plugin + flat-config integration. The test runs in <500ms and provides the same gate at lower friction."
  - "Smoke section MCP-03 body extraction supports BOTH JSON-mode and SSE-mode responses. The SDK chooses between JSON-body and SSE-framed based on the Accept header negotiation; rather than force one mode, the harness parses either via a 3-line python3 fallback that checks the first byte (`{` → JSON; else look for `data:` line). Cleaner than asserting a specific Content-Type."

patterns-established:
  - "Drift gate for ANY schema-driven surface: when a wire schema is derived programmatically from another schema (here: MCP inputSchema derived from HTTP route Zod schemas via SDK toJsonSchemaCompat), the SAFE way to prevent silent drift is to checkpoint the derived shape in a golden JSON file + an assertion test + an UPDATE_GOLDEN=1 escape hatch. Cheaper than a manual review process; impossible to forget."
  - "Phase-wide gate as the last plan of a phase: rather than spreading verification across all phase plans, the FINAL plan runs the full verification suite (typecheck + vitest + grep gates + smoke section) and documents the gate results in the Plan SUMMARY. Operators reading the SUMMARY can trace each ROADMAP success criterion to the exact test that enforces it."

requirements-completed: [MCPS-01, MCPS-02, MCPS-03, MCPS-05, MCPS-06]

# Metrics
duration: 22min
completed: 2026-05-31
---

# Phase 15 Plan 12: Final Phase Wrap-Up Summary

**Phase 15 closes with 7 deliverables locking the 5 ROADMAP success criteria + the 3 BLOCK-level pitfalls (P1-01 / P1-03 / P1-04) into automated tests. All 6 MCPS requirements (MCPS-01..06) verified end-to-end. Vitest 949/0/7 green; typecheck clean; smoke script extended; operator docs land in DEPLOY.md + README.md.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-05-31T14:57:19Z
- **Completed:** 2026-05-31T15:19:00Z (approximate — final commit landed shortly after)
- **Tasks:** 7
- **Files modified/created:** 13 (5 created + 8 modified, counting planning artifacts)

## Accomplishments

- **Golden snapshot drift gate (P1-03):** `router/tests/golden/mcp-tools-manifest.json` (326 lines) checkpoints the exact tools/list shape for all 5 tools — names, descriptions, titles, and full inputSchema JSON for each. The companion test (`tests/unit/mcp/host/tools-manifest.test.ts`, 3 cases) builds a fresh McpServer via the same `register*Tool` helpers used by `buildServerForRequest`, invokes the SDK's internal `tools/list` handler, and asserts deep-equality. `UPDATE_GOLDEN=1 npm test` regenerates the file for intentional schema changes; without the env var, any drift fails CI with a precise diff.
- **MCPS-05 SIGTERM cleanup integration test (`tests/integration/mcp-shutdown.integration.test.ts`, 3 tests):** Test 1 (graceful path) opens 3 real sessions and asserts close completes in <4s with gauge → 0. Test 2 (5s race ceiling) installs a wedge counter on `StreamableHTTPServerTransport.prototype.close` — the first invocation returns a never-resolving promise; subsequent invocations delegate to the captured original. The test then observes the "5s timeout — abandoning unresponsive sessions" warn line from `session-gc.ts:152-156`, unsticks the wedged transport so Hono's internal forceClose settles cleanly, and asserts the gauge reaches 0 anyway. Test 3 (empty map) covers the early-return path. End-to-end proof of Phase 15 SC4.
- **D-15 MCP_ENABLED=false integration test (`tests/integration/mcp-disabled.integration.test.ts`, 4 tests):** Test 1 asserts POST /mcp returns 404 with valid bearer + initialize body (proves the route is gone, not a bearer failure). Test 2 verifies `app.hasRoute` returns false for POST/GET/DELETE /mcp. Test 3 confirms POST /v1/chat/completions still works under MCP_ENABLED=false (no regression). Test 4 builds a second app with MCP_ENABLED=true to confirm the early-return is conditional. End-to-end proof of operator escape hatch.
- **Smoke section in `bin/smoke-test-router.sh`** adds Phase 15 MCP-01..03 checks (initialize handshake + bearer 401 + tools/call list_models). 53 occurrences of "MCP" in the script after the change (3+ required). Skip-on-404 branch handles MCP_ENABLED=false routers gracefully. Final summary banner updated to include Phase 15.
- **DEPLOY.md gains a comprehensive operator section (`## MCP Host (Phase 15 — v0.11.0)`)** covering: tools exposed table (5 tools + their schema source), streaming caveat (D-12), env vars table (MCP_ENABLED, MCP_SESSION_TTL_SEC, MCP_GC_INTERVAL_MS), session lifecycle (initialize → Mcp-Session-Id → idle GC → SIGTERM 5s race), n8n MCP Server Trigger integration steps, observability surface (gauges, counters, Pino flat keys, request_log rows), scoped IDs flow from outer HTTP request, and a verification table linking each ROADMAP success criterion to the test that enforces it.
- **README.md feature list** mentions MCP host with a link to the DEPLOY.md section.
- **MCPS-06 stdio grep gate (`tests/unit/mcp/host/stdio-grep-gate.test.ts`, 2 tests):** runtime execSync grep for `StdioServerTransport` + `StdioClientTransport` (defense-in-depth) in `router/src/`. Fails CI on any future Stdio*Transport import with a precise file:line pointer in the error message.
- **Phase-wide final gate (Task 7)** ran the full verification matrix: `npx tsc --noEmit` clean (0 errors); `npm test --no-file-parallelism` 949 passed / 7 skipped / 0 failed across 95 test files; grep gates: 0 StdioServerTransport occurrences in router/src/, 1 `req.log = ` assignment in router/src/ (the Pitfall-9 single canonical location), 0 `applyPolicyGate(` calls in router/src/routes/ (D-09 preflight refactor complete), 5 wired `register*Tool(server, opts, capturedReq);` calls in plugin.ts (P1-05 allowlist enforced).

## Task Commits

Each task was committed atomically:

1. **Task 1: Golden snapshot + drift-gate unit test (P1-03 mitigation)** — `bd48180` (test)
2. **Task 2: MCPS-05 SIGTERM cleanup integration tests (5s race ceiling)** — `902babb` (test)
3. **Task 3: D-15 MCP_ENABLED=false integration tests** — `fdeb3df` (test)
4. **Task 4: Extend smoke-test-router.sh with Phase 15 MCP host section** — `e443cf7` (feat)
5. **Task 5: Document MCP host in DEPLOY.md + README.md** — `3a69e16` (docs)
6. **Task 6: MCPS-06 stdio grep gate as vitest invariant** — `dc25c8b` (test)
7. **Task 7: Final phase-wide gate — verification only (no commit; results documented in this SUMMARY)**

**Plan metadata commit follows this SUMMARY** (STATE.md + ROADMAP.md + REQUIREMENTS.md + SUMMARY.md + deferred-items.md).

## Files Created/Modified

### Created
- `router/tests/golden/mcp-tools-manifest.json` (326 lines) — pinned shape of `tools/list` for all 5 tools.
- `router/tests/unit/mcp/host/tools-manifest.test.ts` (185 lines) — drift-gate unit test with 3 cases (deep-equality, count invariant, shape invariant) + UPDATE_GOLDEN=1 escape hatch documented in code comments.
- `router/tests/integration/mcp-shutdown.integration.test.ts` (273 lines) — MCPS-05 5s race ceiling integration coverage with a wedged-transport simulation.
- `router/tests/integration/mcp-disabled.integration.test.ts` (203 lines) — D-15 disabled-mode integration coverage (4 tests).
- `router/tests/unit/mcp/host/stdio-grep-gate.test.ts` (96 lines) — MCPS-06 P1-01 grep gate (StdioServerTransport + StdioClientTransport).
- `.planning/phases/15-mcp-host-router-as-mcp-server/15-12-SUMMARY.md` (this file).

### Modified
- `bin/smoke-test-router.sh` — Phase 15 MCP section (MCP-01..03) added before the final summary banner; banner updated.
- `DEPLOY.md` — `## MCP Host (Phase 15 — v0.11.0)` section added between Policy Primitives and Backups.
- `README.md` — feature list bullet for MCP host added.
- `.planning/STATE.md` — Last Updated + Current Position + Progress bars + 12/48 requirements counter updated to reflect Phase 15 SHIPPED.
- `.planning/ROADMAP.md` — Phase 15 row checked + 15-12-PLAN row checked + plans count 12/12.
- `.planning/REQUIREMENTS.md` — MCPS-06 checkbox + traceability row updated to Complete.
- `.planning/phases/15-mcp-host-router-as-mcp-server/deferred-items.md` — pnpm-lock + backend typecheck items marked RESOLVED; Plan 15-12 entries added (hotreload.vram.test.ts CPU-contention flake; plugin.ts comment-line gate variance).

## Decisions Made

- **Sort the tools/list response alphabetically in the golden manifest builder, NOT in the SDK.** The SDK 1.29.0 currently emits in registration order, but a future SDK upgrade could change emission order silently. Sorting at golden-build time isolates the test from SDK internals while still pinning the schemas + names + descriptions + titles end-to-end. `buildServerForRequest` already registers alphabetically, so the visible order matches today; the sort is defense-in-depth.
- **Wedged-transport leak handling in MCPS-05 Test 2.** Letting Hono's forceClose timer fire 5s after our test wallclock produces uncaught `socket.destroySoon is not a function` errors (light-my-request socket lacks `destroySoon`). Two mitigations layered: (1) capture the wedged `StreamableHTTPServerTransport` instance during the spy callback, then call the captured `originalClose` AFTER assertions complete to release the socket cleanly; (2) register a process-level `uncaughtException` handler that swallows ONLY the `destroySoon is not a function` message and re-throws everything else. The unit-level test (`session-gc.test.ts` Test 4) already verifies the 5s race ceiling precisely with a pure mock object; the integration test proves the full `app.close()` chain works end-to-end including the plugin's onClose hook + gauge reset.
- **D-15 integration test in a dedicated file** (not just the inline Test 5 already in `mcp-host.integration.test.ts`). The plan brief explicitly requested `tests/integration/mcp-disabled.integration.test.ts`; duplicating the assertion is justified because disabled-mode is a top-level operator contract — having a file named after the feature surfaces it in the test report and tracks the assertion across future plans (e.g., a v0.12.0 might extend disabled-mode to per-tool toggles).
- **MCPS-06 grep gate uses runtime execSync, not eslint.** The repo already runs vitest unconditionally on every CI invocation; adding an ESLint custom rule requires maintenance of a custom plugin + flat-config integration. The test runs in <500ms and provides the same gate at lower friction. Also added a defense-in-depth check for `StdioClientTransport` even though the router does not act as an MCP client — Phase 18 might introduce one, and the constraint that THAT future client must use HTTP transport too should be locked in now.
- **Smoke section MCP-03 body extraction supports BOTH JSON-mode and SSE-mode responses.** The SDK chooses between JSON-body and SSE-framed based on the Accept header negotiation; rather than force one mode, the harness parses either via a 3-line python3 fallback that checks the first byte (`{` → JSON; else look for `data:` line). Cleaner than asserting a specific Content-Type and tolerant of future SDK behavior changes.

## Deviations from Plan

- **[Rule 3 — Auto-fix blocking issue] uncaughtException handler in MCPS-05 Test 2.** The plan brief asked for "a 1-second buffer (assert `< 6000` for the 5s race; assert `< 1000` for the empty-map case)". The wallclock-timing approach is correct but produces unrelated socket.destroySoon uncaught exceptions when the wedged transport is abandoned (Hono internals fire `forceClose` against a light-my-request socket that lacks `destroySoon`). The fix is mechanical (capture-and-replay the original close + scoped uncaughtException handler), does not change the test's intent, and is documented in the test file's header comment.
- **[Rule 3 — Auto-fix blocking issue] Plugin.ts grep gate variance.** The Task 7 verify command `grep -c "register.*Tool(server, opts, capturedReq)" router/src/mcp/host/plugin.ts -eq 5` returns 6 because line 26 (a file header doc comment) matches the pattern. A stricter regex (`grep -cE "^\s+register[A-Z][A-Za-z]+Tool\(server, opts, capturedReq\);"`) returns 5 (the actual wired calls). Both gates effectively satisfied; documented in deferred-items.md for future cleanup.

**Total deviations:** 2 (both Rule 3 mechanical fixes; no architectural changes).
**Impact on plan:** None. Both fixes preserve the original intent of the gate.

## Phase 15 Final Gate Results

| Gate | Result | Verified by |
|------|--------|-------------|
| `npx tsc --noEmit` | 0 errors | manual run (Task 7) |
| `npm test` (full vitest, --no-file-parallelism) | 949 passed / 7 skipped / 0 failed across 95 files | manual run (Task 7) |
| `grep -rn 'StdioServerTransport' router/src/` | 0 matches | `stdio-grep-gate.test.ts` |
| `grep -rn 'req\.log = ' router/src/ \| grep -v __tests__` | 1 match (the single canonical assignment site) | manual run (Task 7) |
| `grep -rn 'applyPolicyGate(' router/src/routes/ \| grep -v __tests__` | 0 matches (D-09 refactor complete) | manual run (Task 7) |
| Wired `register*Tool(server, opts, capturedReq);` calls in plugin.ts | 5 (strict regex; 6 with comment match) | manual run (Task 7) |
| Prometheus cardinality CI guard | 5/5 pass | `scripts/__tests__/check-prometheus-cardinality.test.ts` |
| `[ -f router/tests/golden/mcp-tools-manifest.json ]` | exists, 5 tools | `tools-manifest.test.ts` |

## Phase 15 ROADMAP Success Criteria Verification

| ROADMAP SC | What it asserts | Verified by |
|------------|-----------------|-------------|
| #1 (initialize) | MCP-compatible client connects, JSON-RPC 2.0 handshake works | `tests/integration/mcp-host.integration.test.ts` Test 2 + bin/smoke-test-router.sh MCP-01 |
| #2 (bearer 401) | Missing Authorization returns 401 BEFORE any MCP handling | `tests/integration/mcp-host.integration.test.ts` Test 1 + bin/smoke-test-router.sh MCP-02 |
| #3 (chat_completion round-trip) | tools/call chat_completion returns text via MCP wire | `tests/integration/mcp-host.integration.test.ts` Test 7 |
| #4 (SIGTERM cleanup ≤5s) | app.close() closes all sessions within 5s | `tests/integration/mcp-shutdown.integration.test.ts` (3 tests) |
| #5 (router_mcp_active_sessions gauge) | Gauge present in /metrics and reflects live count | `tests/integration/mcp-metrics.integration.test.ts` (6 tests, Plan 15-11) |

## MCPS Requirements Final Status

All 6 closed:

- **MCPS-01** (initialize over Streamable HTTP) — `mcp-host.integration.test.ts` Test 2
- **MCPS-02** (bearer 401 before MCP handling) — `mcp-host.integration.test.ts` Test 1
- **MCPS-03** (5 tools exposed with inputSchema) — `mcp-host.integration.test.ts` Test 3 + `tools-manifest.test.ts` (this plan)
- **MCPS-04** (structured isError on failure) — per-tool unit-test matrices (`tests/unit/mcp/host/tools/*.test.ts`) + `mcp-host.integration.test.ts` Test 6 + Test 7
- **MCPS-05** (SIGTERM session cleanup) — `mcp-shutdown.integration.test.ts` (this plan) + `session-gc.test.ts` Test 4
- **MCPS-06** (no stdio transport) — `stdio-grep-gate.test.ts` (this plan)

## Manifest of New Test Files Across All 12 Phase-15 Plans

Phase 15 added 13 new test files (unit + integration) on top of pre-existing coverage:

**Unit (9 files):**
- `tests/unit/dispatch/preflight.test.ts` (15-02)
- `tests/unit/mcp/host/plugin.test.ts` (15-05)
- `tests/unit/mcp/host/session-gc.test.ts` (15-05)
- `tests/unit/mcp/host/tools/chat-completion.test.ts` (15-06)
- `tests/unit/mcp/host/tools/create-response.test.ts` (15-07)
- `tests/unit/mcp/host/tools/create-embedding.test.ts` (15-08)
- `tests/unit/mcp/host/tools/rerank.test.ts` (15-09)
- `tests/unit/mcp/host/tools/list-models.test.ts` (15-10)
- `tests/unit/mcp/host/tools-manifest.test.ts` (15-12) + `tests/unit/mcp/host/stdio-grep-gate.test.ts` (15-12)

**Integration (4 files):**
- `tests/integration/mcp-host.integration.test.ts` (15-05 + extended 15-10)
- `tests/integration/list-models-policy-filter.integration.test.ts` (15-11)
- `tests/integration/mcp-request-log.integration.test.ts` (15-11)
- `tests/integration/mcp-metrics.integration.test.ts` (15-11)
- `tests/integration/mcp-shutdown.integration.test.ts` (15-12)
- `tests/integration/mcp-disabled.integration.test.ts` (15-12)

**Golden:**
- `tests/golden/mcp-tools-manifest.json` (15-12)

## Forward Pointer

Phase 19's OBSV-01 will extend `bin/smoke-test-router.sh` further with a live SDK Client round-trip (vs. raw curl) + a tool error-path check (deliberately invalid model → assert isError envelope + status_class=client_error in `/metrics` increments). Phase 15-12 ships the minimum surface required to call Phase 15 complete; OBSV-01 will extend it.

## Issues Encountered

- **MCPS-05 Test 2 wedged-transport leak** — initial implementation produced 3-6 `socket.destroySoon is not a function` uncaught exceptions per run. Diagnosed as Hono's internal forceClose timer firing against a light-my-request socket after the test abandoned its wedged transport. Mitigated by capture-and-replay of the original close + a scoped uncaughtException handler (see Decisions above). The unit-level timing test (session-gc.test.ts Test 4) was already in place from Plan 15-05, so timing precision is covered without involving real SDK transports.
- **hotreload.vram.test.ts flake under full-suite parallelism** — 2 of 3 tests in this file occasionally time out (20s vitest test timeout) when the full 95-file suite runs under default file parallelism. The file's own header comments document the cause: `WSL2 + Docker Desktop fs.watchFile pauses under CPU contention`. Re-running the same file in isolation passes 3/3 in ~3s. Phase-wide gate was confirmed green by running `npm test --no-file-parallelism` which produced 949/0/7. Pre-existing flake, NOT introduced by this plan. Documented in deferred-items.md.
- **Plugin.ts grep gate variance** — the Task 7 verify command `grep -c "register.*Tool(server, opts, capturedReq)" router/src/mcp/host/plugin.ts -eq 5` returns 6 because line 26 (a file header doc comment from Plan 15-05) matches the pattern. The actual wired calls are exactly 5 (lines 127-131). A stricter regex returns 5. Documented in deferred-items.md; both gates effectively satisfied.

## Known Stubs

None. All Phase 15 surfaces are wired end-to-end: MCP tools call through to the same canonical adapter as the HTTP routes; HTTP /v1/models and MCP list_models share a single projection lens; bearer auth flows through the existing root-scoped onRequest hook; observability gauges + counters increment on every tool call. No placeholder data flows anywhere.

## Threat Flags

None — no new security-relevant surface introduced. The drift gate (P1-03), the SIGTERM race (P1-04), the stdio grep gate (P1-01), and the P1-05 allowlist (verified by the golden snapshot's 5-tool invariant test) all strengthen existing mitigations.

## User Setup Required

None — Plan 15-12 ships purely automated verification + documentation. Operators can verify their deployment via `bash bin/smoke-test-router.sh --router-url <their-router>` after the next pull; the MCP section will surface MCP-01..03 results inline with the rest of the suite.

## Self-Check: PASSED

- `router/tests/golden/mcp-tools-manifest.json` — exists (verified above; jq says 5 tools)
- `router/tests/unit/mcp/host/tools-manifest.test.ts` — exists (185 lines)
- `router/tests/integration/mcp-shutdown.integration.test.ts` — exists (273 lines)
- `router/tests/integration/mcp-disabled.integration.test.ts` — exists (203 lines)
- `router/tests/unit/mcp/host/stdio-grep-gate.test.ts` — exists (96 lines)
- Commits `bd48180`, `902babb`, `fdeb3df`, `e443cf7`, `3a69e16`, `dc25c8b` — all present in `git log --oneline` and contain the stated Task work
