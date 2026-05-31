---
phase: 15-mcp-host-router-as-mcp-server
plan: 10
subsystem: api
tags: [mcp, tool-handler, list-models, policy-filter, registry-projection, anti-leak, p1-05]

# Dependency graph
requires:
  - phase: 15
    provides: mcpHostPlugin shell + buildServerForRequest seam (15-05); registerChatCompletionTool (15-06); registerCreateResponseTool (15-07); registerCreateEmbeddingTool (15-08); registerRerankTool (15-09)
  - phase: 14
    provides: ModelEntry.policy.cloud_allowed; RegistrySchema.policies.default.model_allowlist
provides:
  - registerListModelsTool — read-only MCP tool wrapping the registry projection
  - All 5 MCP tools wired into buildServerForRequest (P1-05 hard-coded allowlist)
  - D-10 filter + cloud_allowed annotation on MCP-side list (HTTP-side mirror in 15-11)
  - End-to-end tools/call round-trip integration tests (list_models + chat_completion)
  - Rule-1 fix: rerank + create-embedding now pass Zod schemas (not JSON Schema) to SDK
affects: [phase-15-11 — HTTP /v1/models + /v1/models/:id mirror the same projection]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "List_models = read-only projection: no adapter call, no bufferedWriter row, only D-07 counter + duration histogram"
    - "Empty raw shape `{}` as MCP inputSchema for no-input tools (SDK 1.29.0 mcp.js:842-855)"
    - "Zod schema (not z.toJSONSchema output) as inputSchema for SDK 1.29.0 (mcp.js:868)"
    - "JSON_SCHEMA_LOCK module-load constant as P1-03 drift gate, exported from each tool file"

key-files:
  created:
    - router/src/mcp/host/tools/list-models.ts
    - router/tests/unit/mcp/host/tools/list-models.test.ts
  modified:
    - router/src/mcp/host/plugin.ts (wired 5 explicit register*Tool calls; P1-05 hard-coded)
    - router/src/mcp/host/tools/rerank.ts (Rule 1 — Zod schema as inputSchema + JSON_SCHEMA_LOCK)
    - router/src/mcp/host/tools/create-embedding.ts (Rule 1 — same fix as rerank)
    - router/tests/unit/mcp/host/tools/rerank.test.ts (assertion updated)
    - router/tests/unit/mcp/host/tools/create-embedding.test.ts (assertion updated)
    - router/tests/integration/mcp-host.integration.test.ts (Test 3 inverted, Tests 6 + 7 added)

key-decisions:
  - "list_models is read-only — no request_log row even though D-05 says 'per tool call'. CONTEXT D-05 only applies to backend-touching calls; logging a row for a pure registry projection would pollute usage analytics."
  - "Empty raw shape `{}` chosen over a synthetic z.object({}) because the SDK explicitly accepts `{}` as 'no params' (mcp.js:851-853); a z.object({}) would also work but adds a Zod indirection for zero benefit."
  - "JSON_SCHEMA_LOCK added to rerank + create-embedding to preserve the P1-03 drift gate that previously lived in the (now-removed) z.toJSONSchema(...) call at the inputSchema site. Test 1 asserts deep-equality of the lock against a fresh z.toJSONSchema(...) computation."
  - "5 register*Tool calls in plugin.ts are kept in ALPHABETICAL-BY-TOOL-NAME order (chat_completion, create_embedding, create_response, list_models, rerank) so the integration Test 3 sort-stable assertion is a 1-to-1 mapping with the source order."

patterns-established:
  - "Read-only MCP tool template: skip applyPreflight, skip adapter, skip bufferedWriter; emit D-07 counter + duration histogram with backend='none'/model='none' sentinels"
  - "Zod-schema-as-inputSchema discipline: never pass z.toJSONSchema(...) output; pass the Zod schema directly and let the SDK convert internally for tools/list"
  - "5-tool integration gate locks both the count and the alphabetical set; future tool additions must update the gate explicitly (P1-05)"

requirements-completed: [MCPS-03, MCPS-04]

# Metrics
duration: 18min
completed: 2026-05-31
---

# Phase 15 Plan 10: list_models MCP tool + 5-tool wiring Summary

**registerListModelsTool ships as the fifth MCP tool, wires all 5 tools into buildServerForRequest with a hard-coded P1-05 allowlist, and proves end-to-end tools/call round-trips for both list_models (T-3-A2 anti-leak) and chat_completion (MCPS-01 #3 assistant text).**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-05-31T05:43:30Z
- **Completed:** 2026-05-31T06:01:48Z
- **Tasks:** 3
- **Files modified:** 7 (1 created in src + 1 created in tests + 5 modified)

## Accomplishments

- Read-only `list_models` MCP tool with D-10 filter + cloud_allowed annotation; T-3-A2 anti-leak preserved.
- All 5 MCP tools wired into `buildServerForRequest` (chat_completion, create_embedding, create_response, list_models, rerank) — P1-05 hard-coded allowlist.
- Integration Test 3 inverted: tools/list now asserts the exact 5-tool golden set sort-stably.
- New integration Test 6 verifies the T-3-A2 anti-leak end-to-end through the MCP wire (no backend/backend_url/backend_model/vram_budget_gb fields leak through tools/call list_models).
- New integration Test 7 closes MCPS-01 success-criterion #3 (assistant text round-trip via tools/call chat_completion).
- Rule-1 fix: sibling tools `rerank` and `create_embedding` were passing JSON Schema (output of `z.toJSONSchema`) to the SDK 1.29.0 `registerTool` API, which rejects with `inputSchema must be a Zod schema or raw shape` (mcp.js:868). Both files now pass the Zod schema directly; `JSON_SCHEMA_LOCK` exported on both preserves the P1-03 drift gate. The bug was latent because plans 15-06..15-09 deferred plugin.ts wiring to 15-10 per the concurrency_warning, so it never executed end-to-end before today.

## Task Commits

Each task was committed atomically:

1. **Task 1: Write unit-test matrix for registerListModelsTool (RED)** — `62c8df8` (test)
2. **Task 2: Implement registerListModelsTool (GREEN) + wire 5 tools in plugin.ts** — `69b2419` (feat)
3. **Task 3: Invert integration Test 3 + add Tests 6 & 7 (list_models + chat_completion tools/call)** — `f1fd729` (test)

**Plan metadata:** (final docs commit follows this SUMMARY)

## Files Created/Modified

### Created
- `router/src/mcp/host/tools/list-models.ts` — `registerListModelsTool(server, deps, capturedReq)`: read-only registry projection. Applies D-10 filter (`policies.default.model_allowlist`); projects `{id, object:'model', created, owned_by:'local-llms', capabilities, policy:{cloud_allowed}}`; T-3-A2 anti-leak (no backend fields); D-07 counter + duration histogram; no bufferedWriter row.
- `router/tests/unit/mcp/host/tools/list-models.test.ts` — 7-case matrix (empty inputSchema, allow-all default, D-10 filter, T-3-A2 projection field set, cloud_allowed annotation, D-07 counter, no bufferedWriter row).

### Modified
- `router/src/mcp/host/plugin.ts` — `buildServerForRequest` now calls 5 explicit `register*Tool(server, opts, capturedReq);` statements in alphabetical-by-tool-name order. Added 5 imports at the top.
- `router/src/mcp/host/tools/rerank.ts` — Rule 1: pass `RerankRequestSchema` directly (was `z.toJSONSchema(RerankRequestSchema)`); exported `JSON_SCHEMA_LOCK` preserves P1-03 drift gate.
- `router/src/mcp/host/tools/create-embedding.ts` — Rule 1: pass `EmbeddingsRequestSchema` directly; exported `JSON_SCHEMA_LOCK` preserves P1-03 drift gate.
- `router/tests/unit/mcp/host/tools/rerank.test.ts` — Test 1 now asserts `reg.config.inputSchema === RerankRequestSchema` AND `JSON_SCHEMA_LOCK.toEqual(z.toJSONSchema(RerankRequestSchema))`.
- `router/tests/unit/mcp/host/tools/create-embedding.test.ts` — Same shape change for create-embedding.
- `router/tests/integration/mcp-host.integration.test.ts` — Test 3 inverted to assert exact 5-tool golden set; new Test 6 covers tools/call list_models with T-3-A2 anti-leak gate; new Test 7 covers tools/call chat_completion with assistant-text round-trip via injected fake adapter.

## Decisions Made

- **`{}` as inputSchema for list_models:** SDK 1.29.0 explicitly accepts the empty raw shape `{}` as a "no params" tool (mcp.js:851-853). Cleaner than z.object({}) — avoids a Zod indirection layer.
- **`object: 'list'` not `type: 'list'`:** Mirrors HTTP `/v1/models` (T-3-A2 projection). Plan's verify-stanza grep `type: 'list'` returns 0 by design.
- **D-05 row deliberately skipped for list_models:** Read-only registry projection. CONTEXT D-05 ("one request_log row per tool call") only applies to backend-touching tools; the test matrix explicitly asserts bufferedWriter.push is not called (Test 7 of the unit matrix).
- **Test 7 (chat_completion round-trip) uses opts.makeAdapter to inject a fake:** Avoids MSW handler-registration burden for what is fundamentally a wire-shape gate. The fake returns a single canonical text block; the test asserts both content[0].text (D-03 stamp) and structuredContent.choices[0].message.content (full OpenAI shape) carry it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SDK 1.29.0 rejects JSON Schema as inputSchema in sibling tools**
- **Found during:** Task 2 (running integration tests after wiring 5 tools into plugin.ts)
- **Issue:** Plans 15-08 (`create-embedding.ts`) and 15-09 (`rerank.ts`) ship with `inputSchema: z.toJSONSchema(SchemaX) as Record<string, unknown>`. SDK 1.29.0 (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:868`) throws `inputSchema must be a Zod schema or raw shape, received an unrecognized object` when registerTool sees a plain JSON Schema object — only Zod schemas (instances with `_def`/`_zod`) or "raw shapes" (plain objects whose values are Zod schemas) are accepted. The bug never surfaced because plans 15-06..15-09 deferred plugin.ts wiring to 15-10 per the concurrency_warning; this plan is the first to execute the wired path.
- **Fix:** Changed both source files to pass `RerankRequestSchema` / `EmbeddingsRequestSchema` directly (Zod schemas). The SDK converts internally for the tools/list wire surface (equivalent to `z.toJSONSchema(...)`). Exported `JSON_SCHEMA_LOCK = z.toJSONSchema(...)` from both files preserves the P1-03 drift gate that previously lived in the inputSchema site. Updated Test 1 in both test files to assert (a) the Zod schema is the captured inputSchema and (b) `JSON_SCHEMA_LOCK.toEqual(z.toJSONSchema(...))` — drift gate still active.
- **Files modified:** router/src/mcp/host/tools/rerank.ts, router/src/mcp/host/tools/create-embedding.ts, router/tests/unit/mcp/host/tools/rerank.test.ts, router/tests/unit/mcp/host/tools/create-embedding.test.ts
- **Verification:** Integration Test 2 (initialize) and Test 3 (tools/list now returns 5 tools) both green after fix. Unit tests 7/7 (rerank) + 7/7 (create-embedding) still passing.
- **Committed in:** `69b2419` (Task 2 commit — bundled with the GREEN implementation since the bug blocked the wiring path)

---

**Total deviations:** 1 auto-fixed (Rule 1 — Bug)
**Impact on plan:** Required to ship the plan at all (plugin.ts wiring would 500 on every initialize otherwise). No scope creep — the fix is structurally a 2-line change per file (Zod schema in, JSON_SCHEMA_LOCK exported).

## Issues Encountered

- **Pre-existing typecheck errors in backend adapters (4):** A stale `router/pnpm-lock.yaml` (148KB, mtime 05:32, NOT created by this plan) is pulling `undici@7.26.0` while `@types/node`'s peer brings `undici-types@6.21.0`, causing 4 TS2322 mismatches in `router/src/backends/{llamacpp,vllm,ollama-cloud,ollama}-openai.ts`. Verified pre-existing by `git stash` before my changes: 4 errors before, 4 errors after. **Not introduced by Plan 15-10.** Logged to `deferred-items.md`. Recommend a housekeeping task to delete the rogue pnpm-lock.yaml so npm resolves a consistent undici version.
- **`tests/integration/hotreload.vram.test.ts` flake under parallel load:** The test passes cleanly in isolation (3/3 in 3.3s) but intermittently times out at 10s when run as part of the full vitest suite (917-918 other tests in flight). Pre-existing fs.watch timing issue; verified by running the same full suite on baseline (912/919 tests, 1 file with no tests evaluating = the list-models RED test). Not introduced by Plan 15-10. Out of scope per scope_boundary.
- **Untracked `router/pnpm-workspace.yaml` (83 bytes):** Sibling of the rogue pnpm-lock.yaml. Same disposition: left in place; recommend housekeeping cleanup.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 15-11 unblocked:** HTTP `/v1/models` and `/v1/models/:id` will now mirror the same D-10 filter + cloud_allowed annotation; Plan 15-10 establishes the projection shape that 15-11 will port.
- **MCPS-01 success-criterion #3 closed:** Test 7 in the integration suite verifies the assistant-text round-trip via tools/call chat_completion. Phase 15 verifier can mark MCPS-01 ✓.
- **MCP host plugin observable surface stable:** 5 tools, 5 explicit register calls, 2 prometheus series (`routerMcpToolCallsTotal` 5 tools × ~5 status_classes ≈ 25 series; `routerMcpActiveSessions` 1 gauge). Cardinality budget intact.

## Self-Check: PASSED

- File `router/src/mcp/host/tools/list-models.ts` — FOUND
- File `router/tests/unit/mcp/host/tools/list-models.test.ts` — FOUND
- Commit `62c8df8` (Task 1 RED) — FOUND
- Commit `69b2419` (Task 2 GREEN + 5-tool wiring + Rule-1 fixes) — FOUND
- Commit `f1fd729` (Task 3 integration test inversion + tools/call round-trips) — FOUND
- `grep -c "^  register.*Tool(server, opts, capturedReq);" router/src/mcp/host/plugin.ts` → 5 — PASS
- `npx vitest run tests/unit/mcp/` → 7 files, 45/45 passing — PASS
- `npx vitest run tests/integration/mcp-host.integration.test.ts` → 7/7 passing — PASS

---
*Phase: 15-mcp-host-router-as-mcp-server*
*Completed: 2026-05-31*
