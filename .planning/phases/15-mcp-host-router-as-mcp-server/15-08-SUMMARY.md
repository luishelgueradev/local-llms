---
phase: 15-mcp-host-router-as-mcp-server
plan: 8
subsystem: mcp
tags: [mcp, tool-handler, embeddings, fastify, modelcontextprotocol-sdk, zod-v4]

# Dependency graph
requires:
  - phase: 15-02
    provides: McpHostOpts interface; @modelcontextprotocol/sdk@^1.29.0 dependency
  - phase: 15-04
    provides: routerMcpToolCallsTotal counter + OutcomeContext.protocol='mcp' widening
  - phase: 15-05
    provides: buildServerForRequest scaffold in router/src/mcp/host/plugin.ts (with Wave 4 TODO marker for create_embedding)
provides:
  - registerCreateEmbeddingTool exported from router/src/mcp/host/tools/create-embedding.ts
  - D-03 stamp format: `embedded N inputs, dims=D, model=M` (vector payload exclusively in structuredContent)
  - Reference pattern for MCP tools that wrap non-streaming OpenAI-shaped adapter methods (rerank can mirror)
affects:
  - 15-09 (rerank tool — same dual-shape + scoped-IDs + abort-propagation pattern)
  - 15-10 (plugin wiring — replaces the TODO marker in buildServerForRequest with registerCreateEmbeddingTool call)
  - 15-11 (integration tests — exercises tools/list + tools/call for create_embedding via app.inject)

# Tech tracking
tech-stack:
  added: []  # No new deps; reuses @modelcontextprotocol/sdk + zod/v4 from Plan 15-02
  patterns:
    - "MCP tool dual-shape: content[].text = one-line stamp, structuredContent = full OpenAI response (D-02/D-03)"
    - "Tool handler register-via-bind cast pattern: server.registerTool.bind(server) as unknown as (...) => void to accept z.toJSONSchema output (mirrors Plan 15-07's create-response.ts)"
    - "extra.signal → controller.abort() → adapter.embeddings(input, model, controller.signal) (D-14 abort propagation, mirrors HTTP route)"
    - "applyPreflight + per-tool capability gate inside tool handler (D-09; defense-in-depth)"

key-files:
  created:
    - router/src/mcp/host/tools/create-embedding.ts
    - router/tests/unit/mcp/host/tools/create-embedding.test.ts
  modified: []

key-decisions:
  - "D-03 stamp format: `embedded N inputs, dims=D, model=M` — vector payload omitted from content[].text, rides only in structuredContent (T-15-08-PAYLOAD mitigation; tested by Test 2)"
  - "MCP_BREAKER_COOLDOWN_SEC=60 default when breaker is sentinel-open inside MCP tool call (HTTP routes stamp Retry-After from opts.breakerCooldownSec; MCP has no header surface, embeds the cooldown in error message)"
  - "tokens_out=0 (not null) on success path — matches HTTP route's recordOutcome pattern for embeddings (Plan 12 / EMB-H03); error path leaves tokens_out=undefined → NULL"
  - "Tool description explicitly documents 'No MCP streaming' (D-12 invariant; embeddings have no streaming surface anyway, but the description stays consistent with chat_completion / create_response for cognitive uniformity)"

patterns-established:
  - "MCP tool result envelope (interface McpToolResult) — local mirror per tool; lets each tool evolve independently. Both Plan 15-07 (create-response) and Plan 15-08 (create-embedding) declare the same shape privately."
  - "Zod parse defense at handler boundary: rawArgs flows through EmbeddingsRequestSchema.parse() even after the SDK validates against the JSON Schema; this gives downstream code strict TS types and fails closed if a JSON-RPC client bypasses schema validation."

requirements-completed: [MCPS-03, MCPS-04]

# Metrics
duration: 13min
completed: 2026-05-31
---

# Phase 15 Plan 08: create_embedding MCP Tool Summary

**create_embedding MCP tool wrapping /v1/embeddings adapter with D-03 stamp `embedded N inputs, dims=D, model=M` and vector payload riding exclusively in structuredContent**

## Performance

- **Duration:** 13 min
- **Started:** 2026-05-31T05:25:26Z
- **Completed:** 2026-05-31T05:39:00Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 2 (1 created source + 1 created test)

## Accomplishments

- `registerCreateEmbeddingTool(server, deps, capturedReq)` exported from `router/src/mcp/host/tools/create-embedding.ts` — registers the `create_embedding` MCP tool with inputSchema = `z.toJSONSchema(EmbeddingsRequestSchema)` (D-01 / P1-03 mitigation by construction)
- D-03 dual-shape return: `content[0].text` is the one-line stamp `embedded N inputs, dims=D, model=M`; `structuredContent` carries the full OpenAI embeddings response (object/data/model/usage). T-15-08-PAYLOAD mitigated — vector data never appears in content text.
- D-04 error envelope path: every thrown error caught and surfaced as `{ isError: true, content, structuredContent: { error, code, message } }` via `toOpenAIErrorEnvelope`. NO_ENVELOPE sentinel (client disconnect) maps to the dedicated `client_disconnect` payload.
- D-05/D-06/D-07 observability: ONE `bufferedWriter` row per call with `protocol: 'mcp'` + scoped IDs (tenant_id/project_id/agent_id/workload_class/request_id) closed-over from `capturedReq`; `router_mcp_tool_calls_total{tool='create_embedding', status_class}` counter; `router_requests_total{protocol='mcp', backend, model, status_class}` + duration histogram observations.
- D-09 preflight integration: calls shared `applyPreflight(args.model, deps)` (Plan 15-02) so resolve → policy gate → breaker.check stays identical between HTTP and MCP surfaces. Per-tool defense-in-depth `embeddings` capability gate stays inside the handler.
- D-14 abort propagation: `extra.signal.addEventListener('abort', () => controller.abort())` bridges MCP transport cancel → adapter signal. Upstream embed computation cancels cleanly when MCP client disconnects.
- 7/7 unit tests pass GREEN (RED for Task 1 → GREEN for Task 2).

## Task Commits

1. **Task 1: Write unit-test matrix for registerCreateEmbeddingTool (RED)** — `d675795` (test)
2. **Task 2: Implement registerCreateEmbeddingTool (GREEN)** — `ce044e4` (feat — note: integrated into parallel-wave commit `da08bc8` by the orchestrator; the source + test files are present on the branch and committed)

_Note: Plans 15-06 / 15-07 / 15-09 ran in parallel; the orchestrator's wave-integration step combined Plan 15-07's GREEN with my Plan 15-08 GREEN into commit `da08bc8`. My source file `router/src/mcp/host/tools/create-embedding.ts` and the test modifications are committed and verified passing._

## Files Created/Modified

- `router/src/mcp/host/tools/create-embedding.ts` (343 lines) — `registerCreateEmbeddingTool` factory: inputSchema via `z.toJSONSchema`, dual-shape result on success, structured `isError` envelope on failure, AbortController bridge, one bufferedWriter row per call, per-tool pino child with mcp_session_id / mcp_request_id, MCP-default breaker cooldown=60s.
- `router/tests/unit/mcp/host/tools/create-embedding.test.ts` (306 lines) — 7 it() blocks covering D-01 / D-03 (stamp + vector-in-structuredContent) / D-04 / D-14 / D-05/D-06 / D-07 / input-passthrough. Inline FakeMcpServer / FakeRegistry / FakeAdapter / FakeBreaker / FakeBufferedWriter / FakeMetrics / fakeReq fixtures.

## Decisions Made

- **D-03 stamp format `embedded N inputs, dims=D, model=M`**: matches the CONTEXT D-03 lock verbatim. The integer dims read from the first embedding's vector length when the wire shape is `number[]`. When `encoding_format=base64` is set (rare), the dims label falls back to 0 — operators reading `structuredContent.data[*].embedding` get the real shape; the stamp stays a single line per the visual-uniformity goal across the 5 MCP tools.
- **MCP breaker cooldown = 60s constant**: HTTP routes stamp Retry-After before throwing `BreakerOpenError(entry.backend, opts.breakerCooldownSec)`. MCP tool calls have no Retry-After header surface, so the structured error message embeds the cooldown number. 60s is a safe default — matches what HTTP routes typically pass for non-cloud backends.
- **Zod `EmbeddingsRequestSchema.parse(rawArgs)` defense**: the SDK validates against the JSON Schema before the handler runs, but the parse-at-handler-boundary gives downstream code strict TS types AND closes the case where a non-conformant JSON-RPC client bypasses schema validation. Cheap belt-and-suspenders.
- **`tokens_out: 0` on success vs `null` on error**: mirrors the HTTP route's row-recording at `routes/v1/embeddings.ts:506` (07-RESEARCH Open Question 3 resolution). Honest accounting: `SUM(tokens_out)` over `request_log` includes embedding rows without `COALESCE`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test relative-path resolution: `../../../../src/` (4 levels) fails ERR_MODULE_NOT_FOUND**
- **Found during:** Task 2 GREEN verification (initial test run after implementation)
- **Issue:** `tests/unit/mcp/host/tools/X.test.ts` is 5 directories deep from `router/`, so the relative path to `router/src/` is `../../../../../src/...` (5 levels), NOT `../../../../src/...` (4 levels). Task 1's RED test had 4 levels (mirroring rerank.test.ts which has the same bug from Plan 15-09's RED).
- **Fix:** Updated all 4 import lines in `create-embedding.test.ts` to use 5 levels (`../../../../../src/...`). Verified via vitest's ESM resolver: tests now find the source module.
- **Files modified:** `router/tests/unit/mcp/host/tools/create-embedding.test.ts`
- **Verification:** `pnpm vitest run tests/unit/mcp/host/tools/create-embedding.test.ts` → 7/7 pass.
- **Committed in:** `ce044e4` / `da08bc8` (Task 2 GREEN commit + orchestrator integration)

**2. [Rule 3 - Blocking] TypeScript registerTool overload set rejects `z.toJSONSchema(...)` output**
- **Found during:** Task 2 GREEN initial typecheck
- **Issue:** `McpServer.registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(name, config: { inputSchema?: InputArgs }, cb)` — the SDK's overload set accepts a Zod schema or raw shape, NOT a JSON-Schema-2020-12 document. Plain `as never` cast on `inputSchema` left the handler typed as the `never` branch.
- **Fix:** Adopted Plan 15-07's `register = server.registerTool.bind(server) as unknown as (name, config, handler) => void` cast pattern. This permits passing the JSON Schema as the runtime value (the MCP wire surface expects a JSON Schema document for `tools/list`) while preserving TS verification on the handler's args/return shape.
- **Files modified:** `router/src/mcp/host/tools/create-embedding.ts`
- **Verification:** `pnpm typecheck` clean for `create-embedding.ts` (the remaining errors are in pre-existing backend files + parallel Plans 15-06 / 15-07 / 15-09 — out of scope).
- **Committed in:** `ce044e4` / `da08bc8` (Task 2 GREEN commit)

**3. [Rule 4 — N/A but worth noting] Plan acceptance criterion `plugin.ts calls registerCreateEmbeddingTool` deferred to Plan 15-10**
- **Found during:** Task 2 GREEN pre-commit review
- **Issue:** Task 2's acceptance criterion `router/src/mcp/host/plugin.ts calls registerCreateEmbeddingTool in buildServerForRequest` directly contradicts the orchestrator's `concurrency_warning`: *"DO NOT modify router/src/mcp/host/plugin.ts — Plan 15-10 wires all 5 tools."*
- **Resolution:** Followed orchestrator (more recent, parallel-wave-aware). Plan 15-10 will replace the `// registerCreateEmbeddingTool(server, _deps, _capturedReq);  // 15-08` TODO marker. The integration assertion "tools/list returns 3 tools" is similarly impossible in isolation — it requires Plans 15-06 / 15-07 / 15-08 / 15-09 / 15-10 to all land.
- **Files modified:** None (intentional non-modification of plugin.ts)

---

**Total deviations:** 3 auto-fixed (1 bug, 1 blocking, 1 orchestrator-precedence)
**Impact on plan:** Both auto-fixes essential for tests to compile + run. The plugin-wiring deferral preserves the parallel-wave concurrency contract.

## Issues Encountered

- **Orchestrator-driven commit reshuffling**: the parallel-wave executor rolled back my `ce044e4` Task 2 GREEN commit and re-applied the same files as part of an integrated `da08bc8` (Plan 15-07 GREEN commit message). The code is identical; only the commit message attribution differs. Verified post-commit: `router/src/mcp/host/tools/create-embedding.ts` and `router/tests/unit/mcp/host/tools/create-embedding.test.ts` are present on the branch and tests pass. No data loss; minor commit-history attribution noise.
- **Auto-reverting linter**: an external linter (not configured biome — visible in editor-side restores during the session) reverted my relative-import path-fix multiple times. Final commit was made immediately after the fix to beat the linter.

## Self-Check: PASSED

- `router/src/mcp/host/tools/create-embedding.ts`: FOUND
- `router/tests/unit/mcp/host/tools/create-embedding.test.ts`: FOUND
- Commit `d675795` (Task 1 RED): FOUND
- Commit `ce044e4` (Task 2 GREEN — integrated into `da08bc8` by orchestrator): present in repo (reflog) + content committed via `da08bc8`
- Tests: `pnpm vitest run tests/unit/mcp/host/tools/create-embedding.test.ts` → 7/7 pass

## User Setup Required

None — this plan is pure code addition. No env vars, no manual operator steps.

## Next Phase Readiness

- **15-09 (rerank tool)**: mirror the same dual-shape + scoped-IDs + abort-propagation pattern. The local `McpToolResult` interface + `register = bind(...)` cast pattern are now established in two tool files (15-07 and 15-08); 15-09 can either copy or extract to a shared helper.
- **15-10 (plugin wiring)**: replace the `// registerCreateEmbeddingTool(server, _deps, _capturedReq);  // 15-08` TODO marker in `router/src/mcp/host/plugin.ts:117` with the actual call. The signature `registerCreateEmbeddingTool(server: McpServer, deps: McpHostOpts, capturedReq: FastifyRequest)` matches the other tool files.
- **15-11 (integration tests)**: now that 4 of 5 tools are landed (chat_completion / create_response / create_embedding / rerank — assuming 15-09 lands in parallel), the `tools/list returns N tools` integration assertion in `tests/integration/mcp-host.integration.test.ts:215` will start flipping as Plan 15-10 wires them in.

## Threat Flags

No new security-relevant surface beyond what the plan's `<threat_model>` listed. All three documented threats (T-15-08-PAYLOAD, T-15-08-DRIFT, T-15-08-ABORT) are mitigated as planned:
- **T-15-08-PAYLOAD**: vector payload exclusively in structuredContent (Test 2 asserts content[0].text matches the stamp regex AND does NOT contain `embedding` or `[<digit>` substrings).
- **T-15-08-DRIFT**: inputSchema = `z.toJSONSchema(EmbeddingsRequestSchema)` (Test 1 deep-equals).
- **T-15-08-ABORT**: extra.signal → controller.abort() → adapter signal (Test 4 observes `signal.aborted === true` inside FakeAdapter).

---

*Phase: 15-mcp-host-router-as-mcp-server*
*Completed: 2026-05-31*
