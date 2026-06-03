---
phase: 15-mcp-host-router-as-mcp-server
verified: 2026-06-03T02:35:00Z
status: passed
score: 6/6 must-haves verified
retroactive: true
overrides_applied: 0
re_verification:
  previous_status: null
  previous_score: null
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  note: "No prior VERIFICATION.md existed. This file is a retroactive audit produced for v0.11.0 milestone closure (phase shipped 2026-06-01; the older execute-phase workflow did not invoke the verifier)."
human_verification: []
---

# Phase 15: MCP Host (Router as MCP Server) Verification Report

**Phase Goal:** Any MCP-compatible client (n8n MCP trigger, Claude Desktop, Cursor) can connect to `/mcp` over Streamable HTTP and invoke the router's existing capabilities as MCP tools — using the same bearer token and observability stack.

**Verified:** 2026-06-03T02:35:00Z
**Status:** passed
**Re-verification:** No — this is a retroactive verification. The phase shipped in v0.11.0 (2026-06-01) before the workflow change that mandates a verifier pass. All evidence cited below was gathered by reading code currently on disk plus running the test suites referenced in the must_haves blocks.

## Goal Achievement

### Observable Truths (Derived from MCPS-01..06 — REQUIREMENTS.md lines 32-37)

| # | Truth (Requirement) | Status | Evidence |
|---|---------------------|--------|----------|
| 1 | **MCPS-01** — Operator can connect any MCP-compatible client to `POST /mcp` over Streamable HTTP; endpoint speaks JSON-RPC 2.0 per MCP spec | VERIFIED | `@modelcontextprotocol/sdk@^1.29.0` listed at `router/package.json:22`. Multi-method `/mcp` route registered at `router/src/mcp/host/plugin.ts:167-255` using `StreamableHTTPServerTransport` (line 188) + `isInitializeRequest` body detection (line 179). `buildServerForRequest` (lines 112-134) wires all 5 tools onto a fresh `McpServer`. Integration: `tests/integration/mcp-host.integration.test.ts` Tests 2+3 cover initialize handshake + `tools/list`. Live test run: 3 suites, 14/14 tests pass. Smoke harness (`bin/smoke-test-router.sh:2079-2160`) drives the same flow against the live router. |
| 2 | **MCPS-02** — `/mcp` sits behind existing bearer `onRequest` hook; missing/invalid bearer returns 401 BEFORE any MCP handling | VERIFIED | `router/src/auth/bearer.ts:25` defines `PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics'])` — `/mcp` is NOT included. Plugin registers at root scope (`router/src/app.ts:906`), inheriting the root-level bearer hook (verified by plugin comment at plugin.ts:36-39). Test `tests/integration/mcp-host.integration.test.ts` Test 1 asserts 401 with `BearerAuthError` envelope on bearer-less POST /mcp. Smoke harness MCP-02 (lines 2113-2123) drives the same assertion against a live router. |
| 3 | **MCPS-03** — Server exposes 5 tools (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`), each wrapping the existing service-layer handler with a JSON Schema 2020-12 `inputSchema` | VERIFIED | All 5 tool files exist: `router/src/mcp/host/tools/{chat-completion,create-response,create-embedding,rerank,list-models}.ts` (384/531/357/384/243 lines). All 5 `register*Tool` calls are wired in `buildServerForRequest` at `plugin.ts:127-131`. Golden snapshot `router/tests/golden/mcp-tools-manifest.json` enumerates exactly the 5 expected `"name"` entries (verified via grep). Tool-manifest drift gate `tests/unit/mcp/host/tools-manifest.test.ts` (222 lines, with `UPDATE_GOLDEN=1` escape hatch) re-derives `tools/list` from the live `buildServerForRequest` and deep-equals against the golden file. Schemas are sourced via `z.toJSONSchema(<RequestSchema>)` per plan must_haves (verified in chat-completion.ts header comments). Live test run: 9 unit suites covering the 5 tools — 50/50 tests pass. |
| 4 | **MCPS-04** — Tool handlers return `{ isError: true, content, structuredContent: { error, code, message } }` on failure (via `toOpenAIErrorEnvelope`) instead of throwing JSON-RPC errors, so clients can self-correct | VERIFIED | Every tool file imports `toOpenAIErrorEnvelope` and emits `isError: true` envelopes in its catch block: chat-completion.ts:76,271; create-response.ts:62,410,422,434; create-embedding.ts:59,251,268; rerank.ts:57,268,285; list-models.ts:56,211,238. Each file defines the dual-shape result type with `isError?: boolean`. Plan 15-06..15-10 unit tests assert the isError shape for thrown errors (covered by the 50 passing unit tests above). |
| 5 | **MCPS-05** — Server cleans up open sessions on SIGTERM (integration-tested) | VERIFIED | `shutdownSessions` (router/src/mcp/host/session-gc.ts:140-162) implements the 5s `Promise.race` ceiling against `Promise.allSettled(transport.close())`, then `sessionMap.clear()`. Plugin `onClose` hook (plugin.ts:275-279) invokes `shutdownSessions` + resets `routerMcpActiveSessions` gauge to 0. Idle GC sweep at session-gc.ts:85-120 with `.unref()` timer. Integration: `tests/integration/mcp-shutdown.integration.test.ts` (273 lines, 4 tests) covers graceful path (3 sessions close cleanly), wedged-transport simulation (`close() = new Promise(() => {})` proves the 5s race fires), and no-session no-op. Live test run: all 4 tests pass. |
| 6 | **MCPS-06** — Stdio transport is NOT exposed in v0.11.0 (n8n compatibility constraint) | VERIFIED | `grep -rn "StdioServerTransport" router/src/` returns ZERO matches. Runtime grep-gate test `router/tests/unit/mcp/host/stdio-grep-gate.test.ts` enforces this invariant continuously (test passed in live run). Only `StreamableHTTPServerTransport` is imported (plugin.ts:56). Plugin header comment at plugin.ts:30-35 documents the P1-01 mitigation. |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `router/package.json` | `@modelcontextprotocol/sdk@^1.29.0` under dependencies | VERIFIED | Line 22 — confirmed exact match |
| `router/src/config/env.ts` | Zod schema with `MCP_ENABLED` (default true), `MCP_SESSION_TTL_SEC` (default 3600), `MCP_GC_INTERVAL_MS` (default 1_800_000) | VERIFIED | Lines 116-118 — all three keys with documented defaults |
| `router/.env.example` (root `/.env.example`) | Documents the 3 MCP env vars | VERIFIED | Root `/.env.example:301-318` covers all three with operator commentary |
| `router/src/dispatch/preflight.ts` | `applyPreflight(model, opts)` exporting registry resolve → policy gate → breaker check + sentinel return for breakerState | VERIFIED | `applyPreflight` exported (line 56); `applyPolicyGate` invocation line 73; `breaker.check` line 76; returns `{ entry, breakerState }` |
| `router/src/routes/v1/chat-completions.ts` | Uses `applyPreflight` instead of inline trio | VERIFIED | Line 227 — confirmed wired |
| `router/src/routes/v1/messages.ts` | Same | VERIFIED | Line 235 |
| `router/src/routes/v1/embeddings.ts` | Same | VERIFIED | Line 162 |
| `router/src/routes/v1/rerank.ts` | Same | VERIFIED | Line 92 |
| `router/src/routes/v1/responses.ts` | Same | VERIFIED | Line 366 |
| `router/src/metrics/registry.ts` | `router_mcp_tool_calls_total` Counter + `router_mcp_active_sessions` Gauge, no `_id`-suffixed labels | VERIFIED | Lines 129-141 define both metrics with `{tool, status_class}` and no labels respectively. POL-06 cardinality discipline preserved (no `_id` labels). |
| `router/src/metrics/recordOutcome.ts` | `OutcomeContext.protocol` widened to include `'mcp'` | VERIFIED | Line 70 — `protocol: 'openai' \| 'anthropic' \| 'mcp'` |
| `router/src/mcp/host/plugin.ts` | mcpHostPlugin Fastify plugin, multi-method /mcp route, sessionMap, onClose hook, D-15 disabled-mode early-return | VERIFIED | 289 lines (≥120 required). All key surfaces present: `app.route` lines 167-255, `sessionMap` line 162, `app.addHook('onClose', ...)` lines 275-279, MCP_ENABLED short-circuit at lines 151-154. |
| `router/src/mcp/host/session-gc.ts` | `startSessionGc`, `shutdownSessions`, `SessionEntry` exports; 5s Promise.race shutdown | VERIFIED | 162 lines (≥50 required). All 3 exports present with the documented 5s ceiling at line 158. |
| `router/src/mcp/host/index.ts` | Barrel re-export | VERIFIED | 7 lines — re-exports `mcpHostPlugin`, `buildServerForRequest`, `McpHostOpts` |
| `router/src/app.ts` | `app.register(mcpHostPlugin, { ... })` after FastifySSEPlugin with env defaults | VERIFIED | Import at line 54; registration block at lines 904-915 passes registry/makeAdapter/bufferedWriter/metrics/breaker + env defaults |
| `router/src/mcp/host/tools/chat-completion.ts` | `registerChatCompletionTool('chat_completion', ..., dual-shape return, isError on error, stream silently coerced)` | VERIFIED | 384 lines; `registerChatCompletionTool` (line 146), tool name `'chat_completion'` (line 152), description documents non-streaming (line 159), `structuredContent` shape (line 263), `isError: true` envelope (line 271) |
| `router/src/mcp/host/tools/create-response.ts` | `registerCreateResponseTool('create_response', ...)` matching plan 15-07 contract | VERIFIED | 531 lines; tool name `'create_response'` (line 216); isError envelope at lines 422, 434 |
| `router/src/mcp/host/tools/create-embedding.ts` | `registerCreateEmbeddingTool('create_embedding', ..., dual shape)` | VERIFIED | 357 lines; tool name `'create_embedding'` (line 131); isError envelope at line 268 |
| `router/src/mcp/host/tools/rerank.ts` | `registerRerankTool('rerank', ...)` + signal forwarding | VERIFIED | 384 lines; tool name `'rerank'` (line 143); isError envelope at line 285 |
| `router/src/mcp/host/tools/list-models.ts` | `registerListModelsTool('list_models', ..., empty inputSchema, cloud_allowed annotation, T-3-A2 anti-leak)` | VERIFIED | 243 lines; tool name `'list_models'` (line 127); explicit field projection at line 172 (`policy.cloud_allowed`); no `backend`/`backend_url`/`backend_model` fields emitted; isError envelope at line 238 |
| `router/src/routes/v1/models.ts` | `/v1/models` applies allowlist filter + `policy.cloud_allowed` annotation; `/v1/models/:id` 404s allowlist-excluded | VERIFIED | `filterAndProject` at lines 38-53 implements both. `/v1/models/:id` allowlist check at lines 72-84 returns 404 + `model_not_found` |
| `router/tests/golden/mcp-tools-manifest.json` | Snapshot of `tools/list` output with all 5 tool names | VERIFIED | File present; `"name"` grep finds exactly: chat_completion, create_embedding, create_response, list_models, rerank |
| `router/tests/unit/mcp/host/tools-manifest.test.ts` | Drift-gate unit test deep-equaling against golden file | VERIFIED | 222 lines (≥30 required); test passes live; `UPDATE_GOLDEN=1` escape hatch at line 173 |
| `router/tests/integration/mcp-shutdown.integration.test.ts` | SIGTERM cleanup integration test | VERIFIED | 273 lines (≥60 required); 4 tests including wedged-transport simulation; passes live |
| `router/tests/integration/mcp-disabled.integration.test.ts` | MCP_ENABLED=false integration test | VERIFIED | 203 lines (≥40 required); 4 tests covering 404 response, route absence, /v1/* non-regression, opposite mode positive case; passes live |
| `bin/smoke-test-router.sh` | New MCP host section (initialize + bearer 401 + tools/call list_models) | VERIFIED | Lines 2059-2160 — MCP-01, MCP-02, MCP-03 implemented with graceful skip on MCP_ENABLED=false |
| `DEPLOY.md` | MCP Host section documenting endpoint, 5 tools, bearer auth, 3 env vars, n8n integration | VERIFIED | Section at line 469 covers all of: endpoint URL, tool table (5 tools), streaming caveat, configuration table, session lifecycle, n8n integration, observability metrics |
| `README.md` | Mentions MCP host capability in feature list | VERIFIED | Line 27 — bullet with full feature description + DEPLOY.md cross-link |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `router/src/app.ts` | `router/src/mcp/host/plugin.ts` | `app.register(mcpHostPlugin, { ... })` | VERIFIED | Import line 54, registration lines 906-915 |
| `router/src/mcp/host/plugin.ts` | `@modelcontextprotocol/sdk/server/streamableHttp.js` | `new StreamableHTTPServerTransport(...)` + `transport.handleRequest(req.raw, reply.raw, req.body)` | VERIFIED | Construct at line 188; handleRequest at line 239 |
| `router/src/mcp/host/plugin.ts` | `router/src/metrics/registry.ts` | `opts.metrics.routerMcpActiveSessions.set(sessionMap.size)` | VERIFIED | Lines 198 (initialize), 205 (close), 278 (onClose) |
| All 5 HTTP routes | `router/src/dispatch/preflight.ts` | `applyPreflight(body.model, { registry, breaker })` | VERIFIED | grep confirms identical call pattern across chat-completions, messages, embeddings, rerank, responses |
| All 5 MCP tool handlers | `router/src/dispatch/preflight.ts` | `applyPreflight` reuse (D-06 inheritance via capturedReq) | VERIFIED | grep across `router/src/mcp/host/tools/*.ts` finds preflight wiring + scoped-id read paths |
| `router/src/routes/v1/models.ts` | `router/src/mcp/host/tools/list-models.ts` | Shared T-3-A2 projection + D-10 allowlist semantics (single lens) | VERIFIED | Both files implement identical field whitelist and `policy.cloud_allowed` defaulting; cross-cutting integration test `tests/integration/list-models-policy-filter.integration.test.ts` (passes live, 3 suites / 16 tests in batch) asserts parity |
| Auth chain | `/mcp` endpoint | Root `onRequest` bearer hook applies because `/mcp` is NOT in `PUBLIC_PATHS` | VERIFIED | `router/src/auth/bearer.ts:25` confirms PUBLIC_PATHS contains only `/healthz`, `/readyz`, `/metrics` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `list-models` MCP tool | `data: [...]` in structuredContent | `opts.registry.get().models` filtered by allowlist | YES — driven by live RegistryStore (same source as HTTP /v1/models) | FLOWING |
| `chat_completion` MCP tool | `structuredContent: openAiResp` | adapter.chat result via applyPreflight → makeAdapter → backend HTTP call | YES — calls real backend through same adapter as POST /v1/chat/completions | FLOWING |
| `create_response` MCP tool | response payload | applyPreflight → adapter.respond | YES — same code path as /v1/responses HTTP route | FLOWING |
| `create_embedding` MCP tool | OpenAI embeddings response | applyPreflight → adapter.embed | YES — same path as /v1/embeddings HTTP route | FLOWING |
| `rerank` MCP tool | rerank result | applyPreflight → adapter.rerank | YES — same path as /v1/rerank HTTP route | FLOWING |
| `router_mcp_active_sessions` gauge | `sessionMap.size` | live mutation by initialize/close/GC | YES — incremented on every `onsessioninitialized`, decremented on `onsessionclosed`/GC sweep/onClose | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Tools-manifest golden drift gate | `npx vitest run tests/unit/mcp/host/tools-manifest.test.ts` | 1 file / 1 test passed | PASS |
| Stdio grep gate (MCPS-06) | `npx vitest run tests/unit/mcp/host/stdio-grep-gate.test.ts` | 1 file / 4 tests passed | PASS |
| MCP host integration (init + tools/list + bearer + close + disabled) | `npx vitest run tests/integration/mcp-host.integration.test.ts tests/integration/mcp-disabled.integration.test.ts tests/integration/mcp-shutdown.integration.test.ts` | 3 files / 14 tests passed | PASS |
| MCP request log + metrics + list-models policy filter | `npx vitest run tests/integration/mcp-request-log... tests/integration/mcp-metrics... tests/integration/list-models-policy-filter...` | 3 files / 16 tests passed | PASS |
| All MCP host unit tests (plugin + session-gc + tools + manifest + grep-gate) | `npx vitest run tests/unit/mcp/host/ tests/unit/mcp/host/tools/` | 9 files / 50 tests passed | PASS |
| `StdioServerTransport` import scan | `grep -rn "StdioServerTransport" router/src/` | 0 matches | PASS |

### Probe Execution

Phase 15 does not declare formal `scripts/*/tests/probe-*.sh` probes. The live-router smoke section in `bin/smoke-test-router.sh:2079-2160` (MCP-01..03) is the equivalent harness; it is exercised in operator UAT but does not run during retroactive verification because that requires a running router container. The behavioral spot-checks above (which run the same plugin + transports in-process via vitest) provide the unit/integration equivalent.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|---------------|-------------|--------|----------|
| MCPS-01 | 15-01, 15-02, 15-03, 15-05, 15-12 | Operator can connect MCP client to POST /mcp over Streamable HTTP; JSON-RPC 2.0 | SATISFIED | Truth #1 above |
| MCPS-02 | 15-05, 15-12 | /mcp behind bearer onRequest hook; 401 before MCP handling | SATISFIED | Truth #2 above |
| MCPS-03 | 15-06, 15-07, 15-08, 15-09, 15-10, 15-11, 15-12 | 5 tools wrapping service-layer handlers with JSON-Schema 2020-12 inputSchema | SATISFIED | Truth #3 above |
| MCPS-04 | 15-06, 15-07, 15-08, 15-09, 15-10, 15-11 | isError envelope via toOpenAIErrorEnvelope | SATISFIED | Truth #4 above |
| MCPS-05 | 15-04, 15-05, 15-11, 15-12 | SIGTERM cleanup integration-tested | SATISFIED | Truth #5 above |
| MCPS-06 | 15-12 | No stdio transport exposed | SATISFIED | Truth #6 above |

No orphaned requirements: all 6 MCPS IDs declared in REQUIREMENTS.md map to plans listed above. REQUIREMENTS.md status table (lines 187-192) already marks all 6 as Complete.

### Anti-Patterns Found

None blocking. Spot-check on the 5 tool files + plugin.ts + session-gc.ts shows:

- No `TBD`/`FIXME`/`XXX` markers in production code.
- `TODO` markers in plugin.ts header are documentary references to Wave 4 plans (which all shipped — the TODOs are stale doc but harmless; the actual `register*Tool` calls are wired at lines 127-131).
- Tool handlers return real adapter responses inside `structuredContent`, not empty objects.
- No `console.log`-only handlers; all use pino via `req.log.info`/`req.log.error`.

### Human Verification Required

None. Every must-have was verified via code inspection + automated test execution. The phase has already been operator-validated in v0.11.0 UAT (see `.planning/phases/15-mcp-host-router-as-mcp-server/15-VALIDATION.md` and the smoke section in `bin/smoke-test-router.sh:2079-2160`). Live client roundtrips (Claude Desktop, n8n MCP Server Trigger, Cursor) are downstream consumer tests outside this retroactive audit's scope — they have been exercised in production usage since v0.11.0 ship.

### Gaps Summary

No gaps. All 6 MCPS requirements have implementation evidence on disk plus passing automated tests. The phase goal — "Any MCP-compatible client can connect to /mcp over Streamable HTTP and invoke the router's existing capabilities as MCP tools using the same bearer token and observability stack" — is observably true:

1. The Streamable HTTP transport is wired and serves a multi-method `/mcp` route.
2. All 5 expected tools (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`) are registered on every new session.
3. Bearer auth is enforced via the existing root-scope hook (PUBLIC_PATHS unchanged).
4. Observability: dedicated MCP metrics (`router_mcp_tool_calls_total`, `router_mcp_active_sessions`) plus integration with existing `router_requests_total{protocol="mcp", ...}` and the request_log row stream.
5. Operator escape hatch (`MCP_ENABLED=false`) and stdio-transport exclusion (MCPS-06) are both enforced by integration / grep tests.
6. Documentation (DEPLOY.md MCP Host section + README feature bullet) covers the operator-facing surface.

---

_Verified: 2026-06-03T02:35:00Z_
_Verifier: Claude (gsd-verifier) — retroactive audit for v0.11.0 milestone closure_
