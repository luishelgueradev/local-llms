# Research Summary — v0.11.0 Retrieval-Ready Infrastructure

**Project:** local-llms
**Domain:** Fastify v5/TypeScript LLM router — MCP server/client, streaming Responses API, provider interface abstractions, policy primitives
**Researched:** 2026-05-29
**Confidence:** HIGH (all stack versions verified from npm dist; MCP SDK inspected from installed dist; live codebase read; pitfalls sourced from official SDK issues + OWASP)

---

## Executive Summary

v0.11.0 extends the router from a pure HTTP proxy into a retrieval-ready infrastructure layer. The scope adds four interconnected surfaces: MCP-as-server (the router becomes consumable by agent frameworks via the Model Context Protocol), /v1/responses streaming with tool calls (closing v0.10.0 debt), a set of five provider interfaces that define seams for retrieval and memory without implementing either, and slim policy primitives for allowlisting and cloud restriction. The strategic frame — "Retrieval Interfaces, not Retrieval Logic" — is the most important constraint and the most likely to be violated under implementation pressure.

The recommended approach is to build in dependency order: policy primitives first (purely additive, sets up observability context for all later phases), MCP host second (unlocks agent framework consumption immediately), responses streaming third (closes the n8n compatibility gap), then memory and retrieval abstractions, and finally MCP client + retriever hook last (depends on everything before it). This order resolves the contradiction between researchers: Features research labeled Phase 14 as MCP server + responses streaming; Architecture research labeled Phase 14 as policy primitives + tenant IDs. The architecture researcher is correct. Policy primitives are a zero-dependency additive foundation that every subsequent phase depends on for correct tenant/agent ID attribution in logs.

The primary risks are architectural. Eight BLOCK-severity pitfalls exist in the MCP work alone, and six architectural frame violation traps are documented. These are not implementation details — they are design-time decisions that must be explicit in each phase plan. The single new npm dependency (`@modelcontextprotocol/sdk@^1.29.0`) is confirmed production-ready; all other scope items use the existing locked stack.

---

## Key Findings

### Recommended Stack

The entire milestone adds exactly one new npm dependency: `@modelcontextprotocol/sdk@^1.29.0`. The official TypeScript SDK ships both server and client in one package. Version 1.29.0 is confirmed production-ready (not alpha), is compatible with `zod@4.4.3` via its `"^3.25 || ^4.0"` peer dependency, and integrates with Fastify v5 via `req.raw`/`reply.raw` without any plugin or shim. The alpha packages (`@modelcontextprotocol/fastify@2.0.0-alpha.2`, `@modelcontextprotocol/node@2.0.0-alpha.2`) must not be used.

Everything else — Responses API streaming, provider interfaces, Postgres session schema, policy primitives — uses the existing locked stack with zero upgrades. `openai@6.39.1` (already installed) ships full Responses streaming support with 40+ typed `ResponseStreamEvent` variants. `drizzle-orm@0.36.0` (already installed) handles the new session tables. Provider interfaces are pure TypeScript with no external library dependency, deliberately rejecting LangChain.js, Vercel AI SDK, and Mastra as inappropriate for a server-side middleware router.

**Core technologies (new or newly relevant in v0.11.0):**
- `@modelcontextprotocol/sdk@^1.29.0`: MCP server + client in one package — official org, production-stable
- `openai@6.39.1` (existing): `responses.create({ stream: true })` returns `Stream<ResponseStreamEvent>` — already in lockfile
- `drizzle-orm@0.36.0` (existing): `sessions` + `session_turns` tables via standard `pgTable` + migration files
- Pure TypeScript interfaces (no library): `SessionStore`, `ContextProvider`, `RetrieverProvider`, `EmbeddingProvider`, `SummaryProvider` — zero external deps
- `fastify-sse-v2@4.2.2` (existing): `reply.sse(asyncIterable)` powers Responses streaming identically to chat completions

### Expected Features

**Must have (table stakes for v0.11.0 to be complete):**
- MCP server (host) at `/mcp` with Streamable HTTP transport — five tools; bearer auth inherited from existing hook
- MCP client (consumer) with lazy connect, `mcp_servers:` in `models.yaml`, 60s tools/list Valkey cache, tool-call proxy loop with 10-iteration guard
- `/v1/responses` streaming — `ResponsesStreamTransformer` via explicit `OutputItemStateMachine`; 15 canonical event types; `response.completed` always last
- `/v1/responses` tool call streaming — `response.function_call_arguments.delta/.done`; `requires_action` on completion
- `SessionStore` interface + `PostgresSessionStore` (sync writes, fail-open 1s timeout, `agent_id` required on every load)
- `ContextProvider` interface + truncate and sliding-window strategies; system message always pinned; 20% ctx_size safety margin
- `SummaryProvider` interface + `NoopSummaryProvider` default
- `RetrieverProvider` interface + pre-completion hook seam with explicit `on_timeout` field and `Promise.race()` enforcement
- `EmbeddingProvider` interface — extraction from existing `BackendAdapter`, no wire shape change
- `tenant_id` + `project_id` in `request_log` (migration), extraction from `X-Tenant-ID`/`X-Project-ID` headers
- `policy.model_allowlist` + `policy.cloud_allowed` in `models.yaml`; policy gate fires BEFORE breaker/semaphore
- `X-Workload-Class: sensitive` header extraction and logging
- `expires_at TIMESTAMP WITH TIME ZONE NOT NULL` in sessions table from day one

**Should have (differentiators, add when table stakes are stable):**
- `list_models` MCP tool with `filter_by_capability` param
- MCP `notifications/tools/list_changed` on registry hot-reload
- ContextProvider `summarize-hook` strategy (requires real SummaryProvider consumer)
- Per-model `ctx_size` in `models.yaml`
- Structured error shape on MCP tool failure (`isError: true`)
- `X-Session-ID` response header on session creation

**Defer to v2+:**
- OAuth 2.1 / PKCE for MCP auth
- Per-tenant model allowlists (requires multi-key auth)
- Persistent MCP connection pool
- Content-based automatic routing / PII classifier (explicit anti-feature — architectural frame violation)
- Built-in vector DB / pgvector in router's Postgres (explicit anti-feature)
- Full RBAC

### Architecture Approach

The router is a single Fastify v5 process. v0.11.0 extends its existing 8-layer pipeline with additive hooks at well-defined positions. No existing layer is restructured. The MCP host plugin registers on `/mcp` via Fastify plugin isolation using `req.raw`/`reply.raw`; its transport does not conflict with `fastify-sse-v2` which operates on `/v1/*` routes only.

**Major components:**
1. **MCP Host Plugin** (`src/mcp/host/`) — `McpServer` + `StreamableHTTPServerTransport` at `/mcp`; tool handlers call existing `BackendAdapter` directly; GC loop + SIGTERM cleanup
2. **MCP Client Registry** (`src/mcp/client/`) — lazy per-request `Client` + transport; `toolLoop.ts` with MAX 5 iterations; `{server_alias}__{tool_name}` namespace prefix prevents collision
3. **Responses Stream Transformer** (`src/translation/responses-out.ts`) — `OutputItemStateMachine` (idle/text/function_call) converts `AsyncIterable<CanonicalStreamEvent>` to 15 Responses API events
4. **Session + Context Layer** (`src/session/`, `src/context/`) — `PostgresSessionStore` sync writes + fail-open; `ContextProvider` with pinned system messages and conservative token estimation; `NoopSummaryProvider`
5. **Pre-Completion Hook Chain** (`src/hooks/`) — `runHookChain()` wraps hooks in `Promise.race()`; retrieved content fenced as `<retrieved_context>`; `hook_log` table for audit
6. **Policy Gate** (`src/policy/`) — `YamlPolicyStore` reading from registry; fires before breaker/semaphore; Prometheus labels stay bounded (no `_id` fields)
7. **Tenant/Project Middleware** (`src/middleware/tenantId.ts`) — preHandler extraction; stamps `request_log`, pino, Prometheus (bounded labels only)
8. **EmbeddingProvider Interface** (`src/embeddings/provider.ts`) — declaration only; `BackendAdapter` satisfies it; zero wire shape change

### Critical Pitfalls

38 numbered pitfalls identified. The following are the BLOCK-severity items that must be addressed as design requirements before each phase begins.

**MCP (Phase 15):**
1. **Wrong transport (stdio)** — n8n does not support stdio. Use `StreamableHTTPServerTransport` on `/mcp` as the only production transport. Severity: BLOCK/design.
2. **Tool name collision across MCP servers** — use `{server_alias}__{tool_name}` namespace prefix at ingestion; strip on dispatch. Severity: BLOCK/design.
3. **External MCP tool schema as prompt injection vector** — static allowlist of MCP server addresses; strip/truncate descriptions > 512 chars; validate tool names match `[a-z0-9_]{1,64}`; fence all retrieved content. Severity: BLOCK/design.
4. **Auth credential leakage** — inbound bearer token must NEVER be forwarded to external MCP servers; per-server credential in config. Severity: BLOCK/design.
5. **Boot blocked on MCP client availability** — lazy per-request connect only; MCP client availability is a soft dependency separate from `/readyz`. Severity: BLOCK/design.
6. **Stale session lifecycle + SIGTERM** — GC loop every 30min; SIGTERM handler calls `transport.close()` for all sessions with 5s hard timeout; `onClose` hook wired. Severity: BLOCK/design.

**Responses Streaming (Phase 16):**
7. **Wire shape drift** — dedicated `responsesStreamTranslator`; golden fixture for every event type; `response.completed` always last. Severity: BLOCK/design + code-review.
8. **Tool-call mid-stream state machine bug** — explicit `OutputItemStateMachine`; unit test with text/tool/text fixture. Severity: BLOCK/code-review.
9. **Non-streaming shape broken by streaming addition** — golden fixture for non-streaming `/v1/responses` guards against regression. Severity: BLOCK/code-review.

**SessionStore (Phase 17):**
10. **No TTL schema** — `expires_at NOT NULL` in migration from day one. Severity: BLOCK/design.
11. **Concurrent write race** — `pg_advisory_xact_lock(hashtext(session_id))` inside transaction. Severity: BLOCK/design.
12. **Cross-tenant session leakage** — `agent_id` required parameter on every `SessionStore.load()`. Severity: BLOCK/design.
13. **System message eviction** — pinned turns (role=system) are never evictable; window management only removes user/assistant/tool turns. Severity: BLOCK/code-review.
14. **Summarization during active tool-call** — `has_pending_tool_call` flag prevents summarization until tool round-trip completes. Severity: BLOCK/design.

**RetrieverProvider (Phase 18):**
15. **fail-open/closed undefined** — `on_timeout: "fail-open"|"fail-closed"` required field on hook interface. Severity: BLOCK/design.
16. **Synchronous hook I/O** — `Promise.race([hookPromise, timeout])` mandatory in `runHookChain()`; `router_hook_duration_ms` Prometheus histogram. Severity: BLOCK/design.
17. **Retrieved content injected without sanitization** — `<retrieved_context source="{name}">` fence + 4000 char limit + `context_hash` in `hook_log`. Severity: BLOCK/code-review.

**Policy + Observability (Phases 14 and 18):**
18. **Policy gate after breaker** — allowlist check fires BEFORE `breaker.check()`; same position as capability gate. Severity: BLOCK/design.
19. **Prometheus cardinality explosion** — `agent_id`, `tenant_id`, `project_id`, `session_id` are NEVER Prometheus labels; they live in Postgres + pino only. At 50 agents × 10 tenants × 5 projects the metric series count hits Prometheus defaults. CI check enforces this. Severity: BLOCK/design.
20. **Migration journal collision** — read `_journal.json` before writing any migration SQL; assign migration number as first task of each phase plan. Severity: BLOCK/design.

**Architectural frame violations (all phases):**
- Frame-01: No retrieval logic in the router (default `RetrieverProvider` is noop)
- Frame-02: No in-process retriever even in tests (use `msw` fixture server)
- Frame-03: No model-based default in `SummaryProvider` (noop returns empty)
- Frame-04: No content classifier for sensitive routing (explicit header only)
- Frame-05: No pgvector or vectors table in router's Postgres migrations
- Frame-06: No tenant ID derived from bearer token hash (explicit `X-Tenant-ID` header)

---

## Implications for Roadmap

### Contradiction Resolution: Phase 14 Scope

Features researcher proposed Phase 14 = MCP server + /v1/responses streaming. Architecture researcher proposed Phase 14 = policy primitives + tenant IDs. **Architecture researcher is correct.** Policy primitives are the zero-dependency additive foundation. Every subsequent phase depends on tenant/project IDs being present in `request_log` and pino context for correct observability. The 6-phase build order from Architecture research (Phases 14–19) is adopted directly.

### Phase 14: Policy Primitives + Tenant/Project ID Foundation
**Rationale:** Zero external dependencies. Pure additive. Every subsequent phase depends on tenant/agent ID context in logs for correct attribution. Policy gate must exist before MCP (Phase 15) to ensure correct 403 behavior on tool invocations. Existing tests all pass because policy defaults to allow-all with no config.
**Delivers:** `X-Tenant-ID`/`X-Project-ID` preHandler; `policies.default` in `models.yaml` (`allowed_models`, `cloud_allowed`, `sensitive_routing`); policy gate before breaker in all routes; migration for `tenant_id`/`project_id` columns on `request_log`; Prometheus label addition for bounded fields only; `X-Workload-Class: sensitive` extraction
**Features addressed:** Policy primitives (supplemental scope), tenant/project/agent ID tracing
**Pitfalls avoided:** P8-01 (allowlist position), P8-02 (cloud restriction bypass), P8-03 (Prometheus cardinality), P9-01 (migration ordering), P9-03 (smoke test)
**Research flag:** Standard patterns — no deeper research needed.

### Phase 15: MCP Host (Router as MCP Server)
**Rationale:** Unlocks consumption by any MCP-native agent (n8n MCP trigger, Claude Desktop, Cursor). Depends on Phase 14 for tenant-context attribution on tool invocations. No changes to `/v1/*` routes.
**Delivers:** `@modelcontextprotocol/sdk@^1.29.0` installed; `McpServer` + `StreamableHTTPServerTransport` at `/mcp` via raw `req.raw`/`reply.raw` (not community plugin); five MCP tools calling existing adapters directly; bearer auth from app-level hook; session GC loop + SIGTERM cleanup; `MCP_ENABLED` env flag; `router_mcp_active_sessions` gauge
**Features addressed:** MCP server (host) — full P1 delivery
**Pitfalls avoided:** P1-01 through P1-06 (all MCP host pitfalls)
**Research flag:** Decision required. Architecture research cited `haroldadmin/fastify-mcp` as MEDIUM confidence (not locally tested). Stack research confirms raw `req.raw`/`reply.raw` integration is 3 lines and HIGH confidence. Phase plan must specify raw integration explicitly.

### Phase 16: /v1/responses Streaming + Tool Calls
**Rationale:** Closes v0.10.0 streaming debt. n8n needs Responses API streaming. Depends on Phase 14 (policy gate) and Phase 15 (tool-call pattern reference). Identical SSE infrastructure to chat completions.
**Delivers:** `src/translation/responses-out.ts` with explicit `OutputItemStateMachine`; streaming branch in `responses.ts` (removes the 400); 15 canonical events in correct order; `response.completed` always last; heartbeat stays as SSE comment; tool call events + `requires_action`; golden fixtures for every event type
**Features addressed:** /v1/responses streaming (P2), /v1/responses tool calls (P2)
**Pitfalls avoided:** P3-01 (wire shape drift), P3-02 (state machine bug), P3-03 (connection close before completed), P3-04 (heartbeat collision), P9-02 (non-streaming shape unchanged)
**Research flag:** Standard patterns — event vocabulary fully typed in installed SDK dist.

### Phase 17: SessionStore + ContextProvider + SummaryProvider
**Rationale:** Memory abstraction requires storage schema + window management. Phase 14 (tenant IDs) must exist for session attribution. Phase 16 (responses route complete) must precede wiring sessions into that route.
**Delivers:** Drizzle migration for `sessions` + `session_turns` with `expires_at NOT NULL` and `agent_id NOT NULL`; `PostgresSessionStore` sync writes + fail-open 1s timeout; `ContextProvider` truncate + sliding-window; system message always pinned; `chars/3` + 20% ctx_size safety margin; `NoopSummaryProvider`; session load/append wired into chat-completions, messages, responses routes; cleanup interval at startup
**Features addressed:** SessionStore + Postgres default (P4), ContextProvider strategies (P4), SummaryProvider seam + noop (P4)
**Pitfalls avoided:** P4-01 through P4-06 (all session/context pitfalls), P6-01 (summarization during tool-call)
**Research flag:** Needs attention. Concurrent write race (P4-02) implementation choice (advisory lock vs Valkey lock) must be specified before code is written. `has_pending_tool_call` flag interface contract between ContextProvider and SummaryProvider must be explicit in the plan.

### Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook
**Rationale:** MCP client depends on Phase 15 (SDK installed, integration pattern established). Pre-completion hook depends on Phase 17 (hooks operate on post-context-window canonical). This is the most complex phase with the highest frame-violation risk.
**Delivers:** `McpClientRegistry` lazy connect; `toolLoop.ts` MAX 5 iterations; `{server_alias}__{tool_name}` namespace prefix; 60s Valkey tools/list cache; inbound bearer never forwarded; `RetrieverProvider` interface + `PreCompletionHook` with `on_timeout` field; `runHookChain()` with `Promise.race()`; retrieved content fenced; `hook_log` table (async-buffered, hash only); `EmbeddingProvider` interface (zero wire change); `mcp_servers:` + `pre_completion_hooks:` in registry schema
**Features addressed:** MCP client (P1), RetrieverProvider + hook (P3), EmbeddingProvider (P4)
**Pitfalls avoided:** P2-01 through P2-05, P5-01 through P5-05, P7-01
**Research flag:** Highest complexity. Tool namespace prefix, credential isolation, hook timeout framework, and `hook_log` schema must all be explicitly specified in the phase plan before implementation begins.

### Phase 19: Observability Hardening + Smoke Test Coverage
**Rationale:** Integration gate for the entire milestone. All new surfaces need metrics, dashboards, and smoke coverage before v0.11.0 is complete.
**Delivers:** Prometheus metrics for all new surfaces; Grafana dashboard updates; `bin/smoke-test-router.sh` extended with PASS entries for `/mcp`, streaming responses, session persistence, hook invocation, policy enforcement; README + DEPLOY.md updated with all new env vars and configuration reference
**Features addressed:** Observability completeness, documentation
**Pitfalls avoided:** P8-03 (cardinality CI check), P9-03 (smoke test all surfaces), P9-04 (README drift)
**Research flag:** Standard patterns — identical to Phases 12–13 observability work.

### Phase Ordering Rationale

- Policy before MCP: Tenant/project IDs must exist in logs before any new surface generates log rows. No retrofit pass needed.
- MCP host before MCP client: Shared SDK package; host establishes the `req.raw`/`reply.raw` integration pattern before client uses a different SDK surface from the same install.
- Responses streaming before sessions: The responses route must be in final streaming form before session injection is wired into it.
- Sessions before retriever hook: The pre-completion hook operates on the post-context-window canonical. Without ContextProvider, injection may push the message array over the model's budget.
- MCP client + hook last: Highest complexity, highest frame-violation risk. Building last, when the rest of the pipeline is stable, reduces scope creep risk.

### Research Flags

**Needs attention during phase planning:**
- **Phase 15 (MCP Host):** Plugin vs raw integration decision must be explicit. Recommend raw `req.raw`/`reply.raw` — avoids unverified community dependency, 3 lines, HIGH confidence.
- **Phase 17 (SessionStore):** Concurrent write race resolution and `has_pending_tool_call` flag design must be specified before code is written.
- **Phase 18 (MCP Client + Hook):** Most open design decisions. Tool namespace prefix, credential isolation enforcement, hook timeout framework, `hook_log` Valkey key structure (`mcp:tools:{server_alias}` pattern consistent with existing `model-registry:*`), and `hook_log` table schema must all be in the phase plan before implementation begins.

**Standard patterns — research-phase not needed:**
- **Phase 14 (Policy):** Middleware insertion at well-defined pipeline position; Zod schema extension established from existing registry work.
- **Phase 16 (Responses streaming):** Canonical event mapping fully documented; `openai@6.39.1` types provide the complete event vocabulary.
- **Phase 19 (Observability):** Identical pattern to Phases 12–13 already in the codebase.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Version pins verified from npm dist; MCP SDK inspected from installed package; `openai@6.39.1` dist types read directly. Only ambiguity: `haroldadmin/fastify-mcp` plugin (MEDIUM) — resolved by recommending raw transport integration (HIGH). |
| Features | HIGH | MCP spec 2025-11-25 read directly; Responses API event vocabulary verified from OpenAI reference + typed SDK dist; provider interface shapes derived from LlamaIndex/LangChain/Mastra with explicit rationale for naming conventions. |
| Architecture | HIGH (existing) / MEDIUM (MCP host plugin choice) | Existing codebase inspected directly. Pipeline positions for all new hooks are explicit and dependency-ordered. MEDIUM item resolved by recommending raw SDK integration. |
| Pitfalls | HIGH | 38 pitfalls sourced from official SDK GitHub issues (#812, #532), n8n issue (#24967), LangMem issue (#126), OWASP MCP cheat sheet, Prometheus cardinality docs, and first-party codebase inspection. Cardinality math is quantified to actual series counts. |

**Overall confidence: HIGH**

### Gaps to Address

- **`haroldadmin/fastify-mcp` plugin:** Not locally tested. Phase 15 plan must specify raw integration explicitly and not leave it to implementer discretion.
- **Valkey key structure for MCP tools/list cache:** Research documents the 60s TTL cache but not the exact key format. Phase 18 plan must define this (suggest `mcp:tools:{server_alias}`, consistent with existing `model-registry:*` key pattern).
- **Migration number assignment:** Research documents migrations 0005/0006 are needed but the actual next sequential number in `_journal.json` may differ. Phase 14 plan must read `_journal.json` as its first action.
- **`ctx_size` values per model:** ContextProvider requires `ctx_size` per model. Actual values for `qwen2.5:7b`, `gpt-oss:*`, etc. must be populated in Phase 17 when the registry schema is extended.

---

## Sources

### Primary (HIGH confidence)
- `npm view @modelcontextprotocol/sdk@1.29.0` + dist inspection — version, peer deps, transport classes
- `openai@6.39.1` `dist/esm/resources/responses/responses.d.ts` — `ResponseStreamEvent` union, streaming create() overloads
- [modelcontextprotocol.io/specification/2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) — tool wire format, Streamable HTTP protocol
- [github.com/modelcontextprotocol/typescript-sdk/issues/812](https://github.com/modelcontextprotocol/typescript-sdk/issues/812) — idle session GC missing from SDK
- [github.com/modelcontextprotocol/typescript-sdk/issues/532](https://github.com/modelcontextprotocol/typescript-sdk/issues/532) — SIGTERM ordering bug
- [github.com/n8n-io/n8n/issues/24967](https://github.com/n8n-io/n8n/issues/24967) — 95M retry storm from transport mismatch
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) — tool poisoning vectors
- [OpenAI Responses API streaming reference](https://platform.openai.com/docs/api-reference/responses_streaming) — event vocabulary
- [Prometheus high-cardinality — Grafana Labs](https://grafana.com/blog/2022/10/20/how-to-manage-high-cardinality-metrics-in-prometheus-and-kubernetes/) — label multiplication math
- Live codebase: `router/src/app.ts`, `router/src/backends/adapter.ts`, `router/src/routes/v1/responses.ts`, `router/src/translation/canonical.ts`, `router/src/db/schema/request_log.ts`, `router/src/config/registry.ts`

### Secondary (MEDIUM confidence)
- [OpenAI Community — Responses API streaming guide](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122) — event ordering, state machine
- [github.com/langchain-ai/langmem/issues/126](https://github.com/langchain-ai/langmem/issues/126) — summarization during tool-call state bug
- [github.com/haroldadmin/fastify-mcp](https://github.com/haroldadmin/fastify-mcp) — v3.0.0 plugin (README only, not locally tested)
- [LiteLLM MCP docs](https://docs.litellm.ai/docs/mcp) — config shape reference
- [Dev.to: Multi-LLM context management tokenizer gap](https://dev.to/backboardio/the-hidden-challenge-of-multi-llm-context-management-1pbh) — 10-25% cross-tokenizer variation

### Tertiary (LOW confidence / requires validation)
- [IETF draft-serra-mcp-discovery-uri](https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/) — `.well-known/mcp.json` discovery draft — not production-ready for v0.11.0

---

*Research completed: 2026-05-29*
*Ready for roadmap: yes*
