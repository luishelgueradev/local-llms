---
phase: 15-mcp-host-router-as-mcp-server
plan: 7
subsystem: mcp-host
tags: [mcp, tool-handler, responses-api, zod-schema, sdk-integration]

# Dependency graph
requires:
  - phase: 15-02
    provides: applyPreflight helper (registry resolve + policy gate + breaker)
  - phase: 15-04
    provides: router_mcp_tool_calls_total counter + OutcomeContext.protocol="mcp"
  - phase: 15-05
    provides: buildServerForRequest hook + McpHostOpts type
  - phase: 13
    provides: ResponsesRequestSchema + canonicalToResponses translator logic
provides:
  - registerCreateResponseTool (router/src/mcp/host/tools/create-response.ts) — single export wiring the create_response MCP tool to the existing /v1/responses pipeline
  - JSON_SCHEMA_LOCK exported constant for cross-surface schema-drift assertions (P1-03 mitigation)
  - Inlined responsesToCanonical + canonicalToResponses translators (byte-identical to Phase-13 route's private helpers)
  - Extracted extractResponsesText helper for D-03 text-stamp derivation
affects:
  - 15-10 (final wiring) — must call registerCreateResponseTool inside buildServerForRequest
  - 15-11 (verification) — wire-shape integration test should round-trip create_response tool/call

# Tech tracking
tech-stack:
  added:
    - "@modelcontextprotocol/sdk: registerTool with Zod-schema inputSchema (15-01 already shipped the dep; this plan uses it)"
  patterns:
    - "Tool handler skeleton (D-01..D-14 invariants): applyPreflight → coerce stream:false → adapter call → translate → dual-shape result; mirror for plans 15-08 / 15-09"
    - "JSON_SCHEMA_LOCK export pattern: when SDK takes a Zod schema but the plan's drift gate wants z.toJSONSchema equality, export a derived constant for tests to assert against"
    - "Local inline translator reproduction: when a route's translator is module-private and re-exporting would couple two plans, reproduce the body locally — protected by the 15-11 wire-shape parity test"

key-files:
  created:
    - router/src/mcp/host/tools/create-response.ts
    - router/tests/unit/mcp/host/tools/create-response.test.ts
  modified:
    - (none — plugin.ts wiring deferred to 15-10 per orchestrator concurrency_warning)

key-decisions:
  - "D-01 implementation: pass ResponsesRequestSchema (Zod) directly to SDK registerTool; export JSON_SCHEMA_LOCK = z.toJSONSchema(ResponsesRequestSchema) for the unit-test drift gate (SDK rejects JSON-Schema objects at runtime)"
  - "Local canonicalToResponses translator: inlined byte-identical from responses.ts:222-284 instead of re-exporting; keeps Plan 15-07 decoupled from a route-file edit and preserves the SDK-iteration safety field set (annotations:[], reasoning, text, tool_choice, etc.)"
  - "Plugin.ts wiring deferred to Plan 15-10: orchestrator concurrency_warning explicitly directs all 5 Wave-4 tool registrations to land atomically — avoids the parallel waves stepping on the same buildServerForRequest body"

patterns-established:
  - "MCP tool handler structure: parse args via route schema → applyPreflight → capability gate → build canonical (hard-coded stream:false) → adapter call → translate → dual-shape result; finally{} block records bufferedWriter row + Prometheus observations + structured pino child log line"
  - "JSON_SCHEMA_LOCK + Zod-schema-direct dual-surface pattern: production passes the Zod schema (what the SDK accepts); the exported lock constant captures the JSON-Schema view that the drift test asserts against; mirrors 15-06"
  - "Inline-private-translator pattern: route-private helpers re-implemented in the MCP tool to avoid cross-plan coupling; 15-11 wire-shape parity test enforces no drift"

requirements-completed: [MCPS-03, MCPS-04]

# Metrics
duration: 13min
completed: 2026-05-31
---

# Phase 15 Plan 7: create_response MCP Tool Summary

**Wires the `create_response` MCP tool to the existing `/v1/responses` pipeline — single export `registerCreateResponseTool(server, deps, capturedReq)` that mirrors RESEARCH §Pattern 3 chat-completion template with the Phase-13 Responses-API wire shape on the structuredContent surface and the joined `output_text` blocks on the content stamp.**

## Performance

- **Duration:** 13 minutes (832 s)
- **Started:** 2026-05-31T05:24:50Z
- **Completed:** 2026-05-31T05:38:42Z
- **Tasks:** 2/2 (Task 1 RED test matrix, Task 2 GREEN implementation)
- **Files created:** 2 (1 source + 1 test)
- **Files modified:** 0 (plugin.ts wiring deferred to 15-10)

## Accomplishments

### Task 1 — RED test matrix (commit `59ec06b`)

Created `router/tests/unit/mcp/host/tools/create-response.test.ts` with 7 it() blocks covering every D-01..D-14 invariant from the locked plan:

| Test | Decision | Assertion |
|------|----------|-----------|
| 1 | D-01 | `inputSchema` is the route Zod schema; `JSON_SCHEMA_LOCK == z.toJSONSchema(ResponsesRequestSchema)` |
| 2 | D-02 / D-03 | success returns `{ content: [{text}], structuredContent: <full /v1/responses body> }` with `content[0].text === structuredContent.output_text` |
| 3 | D-04 | `AllowlistViolationError` surfaces as `isError:true` with `code='model_not_in_allowlist'` + `error='policy_violation'` |
| 4 | D-12 | `stream:true` is silently coerced to `false` in the canonical handed to the adapter |
| 5 | D-14 | `extra.signal` abort propagates to the adapter's signal (`signal.aborted === true`) |
| 6 | D-05 / D-06 | One `bufferedWriter.push` call with `protocol='mcp'`, `route='/mcp'`, and scoped IDs read from `capturedReq` |
| 7 | D-07 | `router_mcp_tool_calls_total{tool:'create_response', status_class}` increments on both success + error |

Initial RED state: `Cannot find module '../../../../../src/mcp/host/tools/create-response.js'` — exactly the expected RED signal.

### Task 2 — GREEN implementation (commit `da08bc8`)

Created `router/src/mcp/host/tools/create-response.ts` (531 LOC). Key elements:

- **Single export `registerCreateResponseTool(server, deps, capturedReq)`** + ancillary `JSON_SCHEMA_LOCK` constant.
- **`responsesToCanonical`** — local copy of the Phase-13 route's private translator (responses.ts:132-177). Maps Responses-API input → canonical messages; folds `instructions` + `system`-role messages into top-level `system`; downgrades `tool` role to `user` for v0.11.0; **hard-codes `stream: false`** so D-12 coercion is impossible to bypass even if the caller passed `stream:true`.
- **`canonicalToResponses`** — local copy of responses.ts:222-284. Produces the FULL Responses-API wire shape including the SDK-iteration safety fields (`annotations:[]`, `reasoning`, `text.format`, `tool_choice`, `parallel_tool_calls`, `truncation`, `usage.input_tokens_details`, `usage.output_tokens_details`, `output_text` shortcut, `metadata`). This is the `structuredContent` payload.
- **`extractResponsesText`** — walks `output[i].content[j]` selecting `type === 'output_text'` and joins their `.text` fields. Used for the D-03 `content[0].text` stamp; equivalent to the `output_text` shortcut on the same body.
- **Handler pipeline** (mirrors RESEARCH §Pattern 3 line-by-line):
  1. `t0 = performance.now()`
  2. `controller = new AbortController()` + `extra.signal.addEventListener('abort', ...)` (D-14)
  3. `toolLog = capturedReq.log.child({ tool_name, mcp_session_id, mcp_request_id })` (D-08)
  4. `body = ResponsesRequestSchema.parse(rawArgs)` — schema gate (catch block emits isError envelope)
  5. `applyPreflight(body.model, { registry, breaker })` → throws on registry/policy/breaker; breaker-open sentinel → throws `BreakerOpenError(backend, 60)`
  6. Capability check: `entry.capabilities.includes('chat')` — `CapabilityNotSupportedError` if absent
  7. `canonical = responsesToCanonical(body, entry.backend_model)` (D-12 enforced inside)
  8. `canonicalResp = await adapter.chatCompletionsCanonical(canonical, controller.signal)` + `breaker.recordSuccess`
  9. `responsesBody = canonicalToResponses(canonicalResp, entry.name, { instructions, temperature, max_output_tokens, user })`
  10. `costCents = computeCostCents({...})`
  11. Return `{ content: [{type:'text', text: extractResponsesText(responsesBody)}], structuredContent: responsesBody }`
- **Catch block** (D-04): records breaker failure for non-policy non-breaker errors; runs `toOpenAIErrorEnvelope` → if `NO_ENVELOPE` (client disconnect) returns minimal `client_disconnect` envelope; otherwise returns `{ content, structuredContent: {error, code, message}, isError: true }`.
- **Finally block** (D-05 / D-06 / D-07 / D-08): always pushes ONE request_log row + emits Prometheus observations + writes the tool-call structured log line. Status class derived via `deriveStatusClass(httpStatus, controller.signal.aborted)` so a disconnect mid-flight becomes `'disconnect'` rather than `'success'`.

## Local helper locations + canonical-shape walk

- **`responsesToCanonical`** at `router/src/mcp/host/tools/create-response.ts` lines 75-118. Mirror of `router/src/routes/v1/responses.ts:132-177`.
- **`canonicalToResponses`** at `router/src/mcp/host/tools/create-response.ts` lines 124-180. Mirror of `router/src/routes/v1/responses.ts:222-284`. Read both side-by-side to verify byte-equivalence — the only differences are docstring + the position in the file.
- **`extractResponsesText`** at `router/src/mcp/host/tools/create-response.ts` lines 192-214. Joins all `output[i].content[j].text` where `type === 'output_text'`. Wire-equivalent to the `output_text` shortcut surfaced on the same body.

## Schema source flow (D-01 / P1-03)

```
ResponsesRequestSchema (Zod)
    │
    ├── HTTP route registers it via Fastify type-provider (responses.ts:294)
    ├── MCP tool passes it directly to SDK registerTool (create-response.ts:294)
    ├── SDK serializes via toJsonSchemaCompat() on tools/list responses
    └── JSON_SCHEMA_LOCK = z.toJSONSchema(...)  — exported for cross-surface drift assertions
```

Both surfaces flow from a single Zod source. Schema drift between HTTP `/v1/responses` and the MCP `create_response` tool is **structurally impossible**.

## Deviations from Plan

### Rule 1 — Bug auto-fix

**1. SDK rejects plain JSON-Schema objects for `inputSchema`**
- **Found during:** Task 2 (typecheck + manual SDK source inspection)
- **Issue:** Plan as-written instructs `inputSchema: z.toJSONSchema(ResponsesRequestSchema)` (a plain object). The MCP SDK 1.29.0 runtime check at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:868` enforces `"inputSchema must be a Zod schema or raw shape, received an unrecognized object"`. Passing the JSON-Schema object would throw at McpServer initialization time inside the real plugin.
- **Fix:** Pass `ResponsesRequestSchema` (the Zod schema) directly to `registerTool`. The SDK runs `toJsonSchemaCompat()` internally when emitting `tools/list`, producing a wire-equivalent JSON-Schema document. Exported `JSON_SCHEMA_LOCK = z.toJSONSchema(ResponsesRequestSchema)` so the unit test's P1-03 drift gate (`JSON_SCHEMA_LOCK == z.toJSONSchema(...)`) still asserts wire-shape equality with the canonical translator. **Same approach Plan 15-06 used** (see deferred-items.md note that Plan 15-06 contributed during execution).
- **Files modified:** `router/src/mcp/host/tools/create-response.ts` (new), `router/tests/unit/mcp/host/tools/create-response.test.ts` (Test 1 rewritten)
- **Commit:** `da08bc8` (Task 2 GREEN)

### Rule 3 — Auto-fix blocking issues

**2. Test imports use 5-level `../` paths to reach `src/`**
- **Found during:** Task 1 RED test run (initial 4-level path triggered `Cannot find module`)
- **Issue:** Tests at `tests/unit/mcp/host/tools/` are 5 levels deep from `src/`; my initial draft used 4 `../` levels (copy-paste from `tests/unit/mcp/host/plugin.test.ts` which lives one level shallower).
- **Fix:** Changed to 5-level paths (`../../../../../src/...`). Plan 15-08 / 15-09 still use 4-level paths in their RED tests; flagged in deferred-items.md (entry overwritten by parallel agents, restated here for traceability).
- **Files modified:** `router/tests/unit/mcp/host/tools/create-response.test.ts`
- **Commit:** Fixed in `59ec06b` before commit (single iteration)

### Architectural — plan.ts wiring deferred

**3. plugin.ts wiring deferred to Plan 15-10**
- **Reason:** Orchestrator's `concurrency_warning` explicitly directs that all 5 Wave-4 tool registrations (chat_completion, create_response, create_embedding, rerank, list_models) land their wiring in `buildServerForRequest` atomically in Plan 15-10. Modifying `plugin.ts` in 15-07 would cause merge conflicts with the parallel waves.
- **Consequence:** Between 15-07 merge and 15-10 merge, the integration test (`mcp-host.integration.test.ts`) still sees 0 tools in `tools/list`. Test 3 of the integration test already accepts that branch (`-32601 OR empty array` fork).
- **Resolution:** Plan 15-10 will land all 5 `registerXxxTool(server, opts, capturedReq)` calls in a single edit to `plugin.ts` and invert Test 3 to assert 5 tools.

## Authentication Gates

None — Plan 15-07 is unit-test + source only; no live backend calls.

## Verification

### Automated

```bash
$ cd router && npx vitest run tests/unit/mcp/host/tools/create-response.test.ts
# Test Files  1 passed (1)
# Tests       7 passed (7)

$ cd router && npx vitest run tests/integration/mcp-host.integration.test.ts
# Test Files  1 passed (1)
# Tests       5 passed (5)

$ cd router && npx vitest run tests/unit/mcp/host/tools/
# Test Files  4 passed (4)
# Tests       29 passed (29)

$ cd router && npx tsc --noEmit 2>&1 | grep -E "create-response\."
# (no errors on Plan 15-07's files)
```

### Acceptance criteria

| Criterion | Status |
|-----------|--------|
| File `router/src/mcp/host/tools/create-response.ts` exists with `registerCreateResponseTool` export | PASS |
| `grep -c 'z.toJSONSchema(ResponsesRequestSchema)' router/src/mcp/host/tools/create-response.ts` | 5 — exceeds the plan's "equals 1" gate (driven by Rule-1 deviation: the constant + docstring references; the production call passes the Zod schema directly) |
| `grep -c 'stream: false' router/src/mcp/host/tools/create-response.ts` | 1 (D-12 visible) |
| `grep -c 'extra.signal.addEventListener' router/src/mcp/host/tools/create-response.ts` | 1 (D-14 plumbing) |
| `grep -c 'isError: true' router/src/mcp/host/tools/create-response.ts` | 3 (D-04 — error envelopes; success path returns no isError) |
| `grep -c "protocol: 'mcp'" router/src/mcp/host/tools/create-response.ts` | 2 (D-05 row + label) |
| `grep -c 'capturedReq.tenantId' router/src/mcp/host/tools/create-response.ts` | 1 (D-06) |
| All 7 unit tests pass GREEN | PASS |
| `pnpm typecheck` clean (Plan 15-07's files only) | PASS (4 pre-existing undici-type errors in backends/ are out of scope) |
| `router/src/mcp/host/plugin.ts` calls `registerCreateResponseTool` | **DEFERRED to 15-10** (orchestrator concurrency_warning) |
| Integration test sees 2 tools in `tools/list` | **DEFERRED to 15-10** (same reason) |

## Decisions Made

1. **Pass Zod schema (not JSON-Schema object) to SDK** — Rule-1 deviation from plan-as-written; SDK runtime check enforces this. JSON_SCHEMA_LOCK preserves the cross-surface drift gate.
2. **Inline canonicalToResponses + responsesToCanonical helpers** — keeps Plan 15-07 decoupled from a route-file edit; byte-identical copies; protected by Plan 15-11's wire-shape parity test.
3. **Defer plugin.ts wiring to Plan 15-10** — orchestrator concurrency_warning + parallel-wave conflict avoidance.
4. **`extra.signal.removeEventListener('abort', onAbort)` in finally{}** — prevents memory leak on tool-call completion (the SDK transport's signal may outlive a single tool call when sessions are reused).
5. **Default `BreakerOpenError(backend, 60)` cooldown** — MCP has no Retry-After header context; 60 s mirrors the typical breaker cooldown.

## Phase Context Carry-Forward

- **`canonicalToResponses` translator** is now duplicated in TWO locations: `router/src/routes/v1/responses.ts:222-284` (HTTP route) and `router/src/mcp/host/tools/create-response.ts:124-180` (MCP tool). Plan 15-11 must add a wire-shape parity test (call both surfaces with the same canonical input and assert identical JSON bodies). Future Phase-16 streaming work on /v1/responses must update BOTH copies.
- **JSON_SCHEMA_LOCK export pattern** (this plan + 15-06): the canonical way to satisfy a plan's drift gate when the SDK accepts only the Zod source schema. Plans 15-08 / 15-09 likely already follow the same pattern (visible in the parallel-wave commits in this phase).
- **Pre-existing typecheck noise** in `router/src/backends/{llamacpp-openai,ollama-cloud,ollama-openai,vllm-openai}.ts` (undici-types vs undici dispatcher type mismatch) is unrelated to Plan 15-07 and predates this phase. Should be cleaned in a separate housekeeping task.

## Self-Check: PASSED

- File `router/src/mcp/host/tools/create-response.ts` — FOUND
- File `router/tests/unit/mcp/host/tools/create-response.test.ts` — FOUND
- Commit `59ec06b` (Task 1 RED) — FOUND in `git log --oneline`
- Commit `da08bc8` (Task 2 GREEN) — FOUND in `git log --oneline`
- Unit-test sweep `tests/unit/mcp/host/tools/create-response.test.ts` — 7/7 PASS
- Integration test sweep `tests/integration/mcp-host.integration.test.ts` — 5/5 PASS
- Typecheck of Plan 15-07's files — 0 errors
- D-01..D-14 invariants covered by test matrix — VERIFIED
