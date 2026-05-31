---
gsd_state_version: 1.0
milestone: v0.11.0
milestone_name: Retrieval-Ready Infrastructure
status: executing
last_updated: "2026-05-31T05:41:16.005Z"
last_activity: 2026-05-31
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 21
  completed_plans: 18
  percent: 17
---

# Project State: local-llms

**Last Updated:** 2026-05-31 — Phase 15 Plan 05 shipped (mcpHostPlugin shell: multi-method POST/GET/DELETE /mcp + in-process sessionMap + idle GC sweep + 5s Promise.race SIGTERM shutdown; buildServerForRequest is the SOLE Wave-4 tool-registration hook; MCPS-01/02/05 verified end-to-end). v0.11.0 progress: 1/6 phases + 5/12 Phase-15 plans complete (Wave 1: 15-01 env + 15-02 helper; Wave 2: 15-03 route refactor + 15-04 metric surface; Wave 3: 15-05 MCP plugin shell).
**Status:** Ready to execute

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Strategic frame (binding):** "Retrieval Interfaces, not Retrieval Logic" · "Memory Abstraction Layer, not Memory implementation" · local-llms = infraestructura; RAG/KB = consumidor downstream.

**Current Focus:** Phase 15 — mcp host (router as mcp server)

## Current Position

Phase: 15
Plan: 8 of 12 complete (15-01 EnvSchema widening; 15-02 applyPreflight helper; 15-03 HTTP route refactor; 15-04 MCP metric surface + protocol union; 15-05 mcpHostPlugin shell + sessionMap + GC + SIGTERM race) — Wave 3 task 1 of 4 done
Status: Ready to execute
Last activity: 2026-05-31

### Progress

```
Milestone v0.11.0: █▓░░░░░░░░ 17% — Phase 14/6 shipped (POL-01..06)
  Phase 14: ██████████ Policy Primitives + Tenant/Project ID Foundation (POL-01..06) — SHIPPED 2026-05-30
  Phase 15: ████░░░░░░ MCP Host (MCPS-01..06) — Wave 1 done (15-01 env + 15-02 applyPreflight); Wave 2 done (15-03 HTTP route refactor + 15-04 metric surface); Wave 3 in-flight (15-05 mcpHostPlugin shell shipped — MCPS-01/02/05 end-to-end)
  Phase 16: ░░░░░░░░░░ /v1/responses Streaming + Tool Calls (RESS-01..05)
  Phase 17: ░░░░░░░░░░ SessionStore + ContextProvider + SummaryProvider (SESS-01..06 + CTXP-01..04 + SUMP-01..03)
  Phase 18: ░░░░░░░░░░ MCP Client + RetrieverProvider + Pre-Completion Hook (MCPC-01..06 + RETR-01..06)
  Phase 19: ░░░░░░░░░░ EmbeddingProvider Formalization + Observability Hardening (EMBP-01..02 + OBSV-01..04)

Overall v0.11.0:  █▓░░░░░░░░  6/48 requirements (POL-01..06)

Milestone v0.10.0: ██████████ 100% — SHIPPED 2026-05-29 (archived)
Milestone v0.9.0:  ██████████ 100% — SHIPPED 2026-05-28 (archived)
```

## Key Design Decisions (v0.11.0)

| Decision | Rationale |
|----------|-----------|
| Phase 14 first (policy/tenant IDs before MCP) | Zero-dep additive; tenant_id/project_id must be in request_log before any new surface generates rows — no retrofit pass needed |
| Phase 15 before Phase 18 (MCP host before MCP client) | Shared `@modelcontextprotocol/sdk` package; host establishes raw `req.raw`/`reply.raw` integration pattern before client uses a different SDK surface |
| Phase 16 before Phase 17 (responses streaming before sessions) | Responses route must be in final form before session injection is wired into it |
| Phase 17 before Phase 18 (sessions before retriever hook) | Pre-completion hook operates on post-context-window canonical; without ContextProvider, injection may push messages over model budget |
| Phase 17 kept whole (not split 17a/17b) | SESS→CTXP→SUMP all wire into the same route integration point simultaneously; splitting leaves routes half-integrated and doubles integration overhead |
| MCP transport: Streamable HTTP only, no stdio | n8n production compatibility (n8n issue #24967: 95M retry storm from transport mismatch) |
| Raw `req.raw`/`reply.raw` MCP integration | No `@modelcontextprotocol/fastify` community alpha plugin; 3 lines, HIGH confidence, zero unverified dependency |
| `{server_alias}__{tool_name}` namespace prefix | MCP spec does not define collision semantics; explicit prefix is the only safe approach across multiple servers |
| `on_timeout` required field on hook interface | No default fail mode; implicit fail-open for authorization hooks is a security risk that cannot be deferred |
| Prometheus labels: NEVER include `_id` suffix | Cardinality math: 50 agents × 10 tenants × 5 projects × existing 800 base series = 2M+ series, hitting Prometheus defaults |

## Architectural Frame Violations (reject immediately)

- Frame-01: No retrieval logic in the router (default RetrieverProvider = noop, test-only)
- Frame-02: No in-process retriever even in tests (use msw fixture server)
- Frame-03: No model-based default SummaryProvider (noop returns empty string)
- Frame-04: No content classifier for sensitive routing (explicit X-Workload-Class header only)
- Frame-05: No pgvector or vectors table in router's Postgres migrations
- Frame-06: No tenant ID derived from bearer token hash (explicit X-Tenant-ID header)

## Accumulated Context

### Active Decisions

- **Plan 15-01 path corrections**: router/ uses npm (package-lock.json present, no pnpm-lock.yaml) — `npm install` not `pnpm install`. Env tests append to `router/tests/config/env.test.ts` (canonical) not `router/tests/unit/config/env.test.ts` (plan path, nonexistent). `.env.example` lives at repo root not `router/.env.example` — appending to root preserves single operator surface alongside CIRCUIT_*, ROUTER_RATE_LIMIT_RPM, ROUTER_EMBED_CACHE_TTL_SEC.
- **MCP_ENABLED z.coerce.boolean quirk documented**: Zod v4 z.coerce.boolean() delegates to Boolean(value); any non-empty string is truthy. Operators disable by unsetting var (or `MCP_ENABLED=`). Documented inline in env.ts + .env.example so `MCP_ENABLED=false` doesn't silently leave plugin enabled.
- **applyPreflight Option A sentinel return (Phase 15 / Plan 15-02)**: helper RETURNS breakerState rather than throwing, so HTTP callers stamp Retry-After before raising BreakerOpenError while MCP tool handlers throw without setting any header. Single helper for both protocols; protocol-agnostic.
- **applyPreflight lives at router/src/dispatch/preflight.ts (Phase 15 / Plan 15-02)**: D-09 left dir to planner's discretion; chose `dispatch/` (not `policy/`) because pipeline includes resilience/breaker step, not just policy.
- **MCP metric naming (Phase 15 / Plan 15-04)**: MCP-specific Prometheus series use the `router_mcp_*` namespace — Counter `router_mcp_tool_calls_total{tool,status_class}` + Gauge `router_mcp_active_sessions` (no labels). Future MCP metrics must extend the same prefix for PromQL discoverability. Cardinality budget for the counter: 5 tools × ~5 status_classes ≈ 25 series.
- **Plan 15-04 test placement convention**: registry assertions extend the canonical `router/tests/unit/metricsRegistry.test.ts`, NOT a new `router/tests/unit/metrics/registry.test.ts`. Keeps Pitfall 2 (no-double-register) coverage co-located with new-metric introspection.
- **OutcomeContext.protocol union (Phase 15 / Plan 15-04)**: widened from `'openai' | 'anthropic'` to `'openai' | 'anthropic' | 'mcp'`. Strict superset; no migration needed (request_log.protocol is TEXT NOT NULL with no CHECK constraint). Wave 4 MCP tool handlers write `protocol: 'mcp'` rows without `as any` casts.
- **Plan 15-03 HTTP route refactor**: All 5 HTTP routes (`chat-completions`, `messages`, `embeddings`, `rerank`, `responses`) call `applyPreflight()` at the top of the handler with structurally-identical stanza; `applyPolicyGate` + inline `breaker.check` removed from each route. Sentinel-open branch follows `req.resolvedBackend` stamp so `X-Model-Backend` header still flows on 503 responses. Phase 14 `policy-gate-integration.test.ts` 10/10 green; full vitest run 869 passed / 0 failed.
- **15-03 capability check placement**: capability checks (vision/json_mode/embeddings/rerank/chat) kept in their pre-refactor location in each route — outside-try for chat/messages, inside-try for embeddings/rerank/responses — rather than moving them. This preserves the existing inner-try observability contract for capability-mismatch 400s without invasively reshaping each handler.
- **Plan 15-05 mcpHostPlugin shell ships (Wave 3 task 1 of 4)**: router/src/mcp/host/{plugin.ts, session-gc.ts, index.ts} + tests + app.ts wiring. `buildServerForRequest(capturedReq, opts)` is the SOLE Wave-4 tool-registration site — Wave 4 plans (15-06..15-10) each add ONE `registerXxxTool` call inside. Wave 3 ships zero tools → SDK's `tools/list` returns -32601 (McpServer only installs `setToolRequestHandlers` from inside `registerTool` — verified in node_modules/.../server/mcp.js:650); Wave 4 will invert Test 3 to expect a populated tools array.
- **15-05 BuildAppOpts.env widening**: changed to intersection `Pick<Env, existing 5 keys> & Partial<Pick<Env, MCP_ENABLED|MCP_SESSION_TTL_SEC|MCP_GC_INTERVAL_MS>>` to preserve 4 pre-existing integration test fixtures (circuit-breaker, idempotency, rate-limit) that build env without MCP keys. Production wiring (index.ts) always passes the full env.
- **15-05 onClose ordering**: MCP plugin registered AFTER main app.ts onClose body in buildApp — Fastify v5 fires main FIRST (3s bufferedWriter.drain), MCP onClose AFTER (5s Promise.race transport teardown ceiling). Fits 10s Compose stop_grace_period with 2s margin.
- **Plan 15-06 chat_completion MCP tool ships (Wave 4 task 1 of 5)**: `router/src/mcp/host/tools/chat-completion.ts` + 8-case unit-test matrix. Registers `chat_completion` on the McpServer with `inputSchema = ChatCompletionRequestSchema` (Zod object passed directly — SDK 1.29.0 rejects raw JSON Schema input per `node_modules/@modelcontextprotocol/sdk/.../mcp.js:868`). Exported `JSON_SCHEMA_LOCK = z.toJSONSchema(ChatCompletionRequestSchema)` preserves the P1-03 drift gate at module load. Handler shape: applyPreflight → openAIRequestToCanonical(stream:false coerced) → adapter.chatCompletionsCanonical(signal) → dual-shape return; catch runs toOpenAIErrorEnvelope → isError:true (NO_ENVELOPE → 'client_disconnect'); finally pushes one `protocol:'mcp'` row + increments `routerMcpToolCallsTotal{tool:'chat_completion', status_class}`. D-14 abort wiring uses `extra.signal.addEventListener('abort', ...)` + finally removeEventListener. plugin.ts wiring deferred to Plan 15-10 per concurrency_warning (siblings 15-07/08/09 land their files in parallel; 15-10 wires all 5 atomically). Integration test extension (Task 3) also deferred to 15-10 because tool-call round-trip can only pass once the tool is wired.
- MCP session GC: 30-min interval + SIGTERM handler 5s timeout + Fastify `onClose` hook
- SessionStore writes: SYNC + 1s timeout + fail-open (different from async-buffered request_log)
- Token counting: `chars / 3` conservative heuristic + 20% ctx_size safety margin (no model-specific tokenizer)
- MCP tools/list cache key: `mcp:tools:{server_alias}` consistent with existing `model-registry:*` pattern

### Deferred (carries forward from v0.10.0)

- Phase 7 Plan 07-06 Task 3 — vLLM cold-start UAT on RTX 5060 Ti (user decision: Ollama-only profile)
- RERANK-06 dedicated live smoke — deferred (model needs to be pulled first)

### Active Todos

- `/gsd:execute-phase 15` — Phase 15 execution underway (Wave 1 complete: 15-01, 15-02; Wave 2 complete: 15-03 HTTP route refactor + 15-04 metric surface; Wave 3 task 1/4 complete: 15-05 mcpHostPlugin shell). Wave 4 next: 15-06+ (5 tool registrations parallelizable on top of buildServerForRequest seam).
