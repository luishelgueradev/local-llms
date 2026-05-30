# Requirements: local-llms v0.11.0 — Retrieval-Ready Infrastructure

**Defined:** 2026-05-29
**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Milestone goal:** Convertir el router en infraestructura *retrieval-ready* exponiendo las cinco provider interfaces (`SessionStore`, `ContextProvider`, `RetrieverProvider`, `EmbeddingProvider`, `SummaryProvider`), MCP en ambas direcciones, streaming first-class y los policy primitives mínimos — sin que el router asuma una sola línea de lógica de retrieval, memoria semántica, ni esquemas de negocio.

**Strategic frame (binding constraint on every REQ below):**
- *"Retrieval Interfaces, not Retrieval Logic"*
- *"Memory Abstraction Layer, not Memory implementation"*
- local-llms = infraestructura; RAG/KB empresarial = consumidor downstream

## v0.11.0 Requirements

Mapped to roadmap phases 14–19 (continuation from v0.10.0; no reset).

### Policy primitives + multi-tenant identifiers (POL)

Build first because additive, zero-dependency, and every later phase's observability depends on these IDs being in place. (Phase 14 candidate.)

- [ ] **POL-01**: Operator can declare a top-level `policies.default.model_allowlist: []` array in `models.yaml`; empty list (default) = allow-all. Requests for a model outside the allowlist return `403` with structured error `{ code: "model_not_in_allowlist", model }` BEFORE backend resolution (per registry-entry allowlist shape was discarded at discuss time — see CONTEXT.md D-02/D-03).
- [ ] **POL-02**: Operator can declare `policy.cloud_allowed: false` per registry entry in `models.yaml`; request dispatch refuses any model resolved to a `backend: ollama-cloud` entry when this flag is false, returning `403 { code: "cloud_not_allowed", model }`.
- [ ] **POL-03**: Caller can declare workload sensitivity via `X-Workload-Class: sensitive` request header; header value is extracted into `request_log.workload_class` and emitted in structured logs. **No content classification** — the value is opaque metadata.
- [ ] **POL-04**: Caller can supply `X-Tenant-ID`, `X-Project-ID`, `X-Agent-ID` headers (each optional); values are extracted into new `request_log` columns (`tenant_id TEXT`, `project_id TEXT`; `agent_id` already exists). Drizzle migration 0005 adds the new columns with NULL default.
- [ ] **POL-05**: The policy gate fires BEFORE the circuit breaker check in the request pipeline — policy violations MUST NOT count as backend failures (verified by integration test asserting breaker counter unchanged after 403).
- [ ] **POL-06**: Prometheus metric labels NEVER include `tenant_id`, `project_id`, `agent_id`, or `session_id` (cardinality protection — verified by CI assertion against `/metrics` output).

### MCP server / host (MCPS)

Phase 15 candidate. Router exposes its existing endpoints as MCP tools via Streamable HTTP transport, reusing the bearer auth + observability stack.

- [ ] **MCPS-01**: Operator can connect any MCP-compatible client to `POST /mcp` over Streamable HTTP transport; the endpoint speaks JSON-RPC 2.0 per the MCP specification (verified against `@modelcontextprotocol/sdk` client integration test).
- [ ] **MCPS-02**: The MCP server endpoint sits behind the existing bearer `onRequest` hook; requests without a valid `Authorization: Bearer <token>` return `401` BEFORE any MCP-level handling.
- [ ] **MCPS-03**: The MCP server exposes five tools — `chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models` — each wrapping the existing service-layer handler with a JSON Schema 2020-12 `inputSchema`.
- [ ] **MCPS-04**: MCP tool handlers return structured errors on failure (`isError: true` with `{ error, code, message }` content block) instead of throwing, so MCP clients can self-correct.
- [ ] **MCPS-05**: The MCP server cleans up open sessions on `SIGTERM` (verified by integration test triggering shutdown and asserting no leaked sessions).
- [ ] **MCPS-06**: Stdio transport is NOT exposed in v0.11.0 (n8n compatibility constraint — n8n consumes Streamable HTTP only).

### `/v1/responses` streaming + tools (RESS)

Phase 16 candidate. Closes v0.10.0 Phase 13 deferred work.

- [ ] **RESS-01**: Caller can `POST /v1/responses` with `stream: true` and receives Server-Sent Events emitting the canonical Responses API event sequence: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta` (N times), `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed`.
- [ ] **RESS-02**: Every streaming event carries `sequence_number` per the Responses API spec; `response.completed` is the last event on every successful stream (no premature connection close; verified by integration test asserting last-event invariant).
- [ ] **RESS-03**: When the underlying model emits a function call, the stream surfaces `response.function_call_arguments.delta` (N times) + `response.function_call_arguments.done`, and the final `response.completed` includes `status: "requires_action"`.
- [ ] **RESS-04**: A new `responsesStreamTranslator` module converts the existing canonical chat-completions stream into Responses API events; golden round-trip fixtures verify wire shape against the openai-node SDK `Stream<ResponseStreamEvent>` types.
- [ ] **RESS-05**: Streaming `/v1/responses` reuses the existing `fastify-sse-v2` plumbing, heartbeats, abort propagation, idempotency multiplexer replay, and `X-Cost-Cents` header emission (verified by piggyback on existing chat-completions streaming smoke).

### Session storage (SESS)

Phase 17 candidate. `SessionStore` interface + Postgres-backed default implementation.

- [ ] **SESS-01**: A TypeScript interface `SessionStore` is exported from `src/providers/session-store.ts` with operations: `createSession(metadata) → session_id`, `appendTurn(session_id, role, content, metadata) → turn_id`, `loadHistory(session_id, opts?) → Turn[]`, `deleteSession(session_id) → void`, `listSessions(filter) → Session[]`, `replaceTurns(session_id, turns) → void`.
- [ ] **SESS-02**: A `PostgresSessionStore` default implementation persists sessions to two new tables (`sessions`, `conversation_turns`) created by Drizzle migration 0005; `sessions.expires_at TIMESTAMPTZ NOT NULL` is required (no unbounded retention path).
- [ ] **SESS-03**: `SessionStore.loadHistory(session_id)` requires `agent_id` in the lookup; cross-tenant leakage is prevented at the query layer (verified by integration test asserting empty result when agent_id mismatches).
- [ ] **SESS-04**: `SessionStore.appendTurn` is a **synchronous** durable write (not async-buffered like `request_log`); the call returns only after the turn is committed, with fail-open behavior under 1s timeout (returns turn anyway with `persisted: false` flag).
- [ ] **SESS-05**: `X-Session-ID` response header is set on responses when a session is created or used; stateless callers can discover the session_id without parsing the body.
- [ ] **SESS-06**: Session persistence is **optional** — callers that do not set `X-Session-ID` or include a `session_id` in the request body operate stateless without any SessionStore involvement.

### Context provider (CTXP)

Phase 17 candidate. Sits between SessionStore and the model call.

- [ ] **CTXP-01**: A TypeScript interface `ContextProvider` is exported with `buildContext(session, incoming_message, opts) → { messages: Message[], dropped_count, summary?: string }`.
- [ ] **CTXP-02**: Two default strategies ship: `truncate` (drop oldest non-system turns when over `ctx_size`) and `sliding-window` (keep last N turns); `ContextProvider` is model-aware via a new `ctx_size: integer` field in each `models.yaml` entry.
- [ ] **CTXP-03**: System messages are **always** preserved by every strategy (silent dropping of system prompts breaks agent behavior); preservation is verified by unit test against both strategies.
- [ ] **CTXP-04**: Token estimation uses a fixed 4-chars-per-token approximation by default (no per-model tokenizer dependency); the estimate is conservative (over-estimates) so callers do not blow `ctx_size`.

### Summary provider (SUMP)

Phase 17 candidate. Seam only — no behavior shipped.

- [ ] **SUMP-01**: A TypeScript interface `SummaryProvider` is exported with `summarize(turns, opts) → { summary, replaced_turn_ids }`.
- [ ] **SUMP-02**: A `NoopSummaryProvider` default returns `{ summary: "", replaced_turn_ids: [] }` so that `ContextProvider`'s future `summarize-hook` strategy degrades gracefully to `truncate` when no real summarizer is plugged in.
- [ ] **SUMP-03**: `SummaryProvider.summarize` is NEVER invoked when the session has a pending tool call (verified by `session.has_pending_tool_call` check; protects `tool_call_id` pairing).

### MCP client (MCPC)

Phase 18 candidate. Generic capability for consuming external MCP servers as tools — NOT a retrieval framework.

- [ ] **MCPC-01**: Operator can declare external MCP servers in a new `mcp_servers:` top-level section of `models.yaml` with fields `{ alias, url, transport, auth_type, auth_value, tool_filter? }`.
- [ ] **MCPC-02**: The router connects to declared MCP servers **lazily** on first use (NOT eager at boot) — router boot MUST NOT block on external MCP server availability (verified by integration test simulating unresponsive MCP server during boot).
- [ ] **MCPC-03**: Tools discovered via `tools/list` are namespace-prefixed with `<server_alias>__<tool_name>` before being injected into the upstream model's `tools[]` array; collision-free across multiple MCP servers (verified by unit test with two servers registering same tool name).
- [ ] **MCPC-04**: When the model emits a `tool_call` for a prefixed external tool, the router proxies `tools/call` to the corresponding MCP server, returns the result as a `tool` role message, and loops up to 10 iterations before aborting with structured error `{ code: "mcp_tool_loop_exceeded" }`.
- [ ] **MCPC-05**: The inbound bearer token is NEVER forwarded to external MCP servers; per-server credentials in `auth_value` are used instead (verified by integration test asserting outbound MCP request headers contain only the configured per-server credential).
- [ ] **MCPC-06**: `tools/list` results are cached in Valkey with a 60-second TTL keyed by `<server_alias>` and invalidated when `mcp_servers` configuration reloads via the existing registry hot-reload path.

### Retriever provider + pre-completion hook (RETR)

Phase 18 candidate. The retrieval seam — interface only, no logic.

- [ ] **RETR-01**: A TypeScript interface `RetrieverProvider` is exported with `retrieve(request) → RetrieverResponse` where request is `{ query, top_k?, filters?, metadata?, hybrid?: object }` and response is `{ documents: Array<{ content, score?, metadata? }>, retrieved_at }`.
- [ ] **RETR-02**: Operator can register a `RetrieverProvider` per route via a new Fastify `preHandler` hook seam; the hook fires BEFORE backend dispatch and AFTER `ContextProvider` history loading.
- [ ] **RETR-03**: Hook registration declares an `on_timeout` field (`fail-open` | `fail-closed`) — there is no default; missing field is a startup error (implicit failure mode is a security risk that cannot be deferred to code review).
- [ ] **RETR-04**: Retrieved documents are injected into the canonical request as a new system message tagged `<retrieved_context>...</retrieved_context>`; the injection is visible in `request_log` via a new `hook_log` JSONB column (audit trail).
- [ ] **RETR-05**: The router ships NO retriever implementation by default (the `RetrieverProvider` is uninstantiated unless a config provides one); a `NoopRetrieverProvider` exists only in tests.
- [ ] **RETR-06**: When both an MCP-tool retrieval is registered AND a pre-completion hook is configured for the same route, both fire on the same request without overlap (model can still call the MCP tool after pre-completion injection) — verified by integration test asserting both code paths execute independently.

### Embedding provider formalization (EMBP)

Phase 19 candidate. Extract existing capability into a named interface.

- [ ] **EMBP-01**: A TypeScript interface `EmbeddingProvider` is exported with `embed(input, opts) → { embeddings, model, usage }`; the interface is exposed via `fastify.decorate('embeddingProvider', ...)` so `RetrieverProvider` implementations can depend on it without HTTP round-tripping.
- [ ] **EMBP-02**: The existing `/v1/embeddings` route delegates to `EmbeddingProvider` under the hood; wire shape, dims enforcement, Valkey cache (v0.10.0 Phase 12), and `X-Cost-Cents` emission are unchanged (verified by regression suite).

### Observability hardening (OBSV)

Phase 19 candidate. Smoke coverage + cardinality CI + production-grade docs.

- [ ] **OBSV-01**: `bin/smoke-test-router.sh` gains new sections covering MCP host (`/mcp` initialize + tools/list + tools/call for `list_models`), `/v1/responses` streaming with and without tools, and SessionStore round-trip; live tunnel run prints PASS/FAIL summary.
- [ ] **OBSV-02**: A new CI check `scripts/check-prometheus-cardinality.ts` parses the live `/metrics` output and FAILS if any label contains an `_id` suffix (cardinality guard against accidental tenant_id/agent_id label addition).
- [ ] **OBSV-03**: `README.md` and `DEPLOY.md` are updated to document: MCP host endpoint + tools + auth · MCP client config (`mcp_servers:`) · session lifecycle and `X-Session-ID` · pre-completion hook registration · policy stanza (`model_allowlist`, `cloud_allowed`) · tenant/project/agent ID headers.
- [ ] **OBSV-04**: A new Drizzle migration 0007 adds the `hook_log` JSONB column on `request_log` if not already added in Phase 18 (this REQ provides the safety net for migration ordering across phases).

## Future Requirements

Deferred to v0.12+ — interfaces already in place via v0.11.0 seams.

### Memory abstraction differentiators
- **SUMP-FUT-01**: Real `LlmSummaryProvider` implementation (calls a model to summarize old turns via existing chat-completions adapter).
- **SUMP-FUT-02**: `ContextProvider` `summarize-hook` strategy actively triggers `SummaryProvider` when over `ctx_size`.

### Session lifecycle
- **SESS-FUT-01**: Background cron deletes sessions where `expires_at < now()`.
- **SESS-FUT-02**: Session export endpoint (operator can dump a session's full history for audit).

### MCP server differentiators
- **MCPS-FUT-01**: `notifications/tools/list_changed` emitted via MCP SSE when `models.yaml` hot-reloads.
- **MCPS-FUT-02**: MCP `list_models` tool supports `filter_by_capability` input parameter.

### MCP client differentiators
- **MCPC-FUT-01**: Persistent MCP client connection pool with health checks (lazy-connect + cache covers v0.11.0 needs).
- **MCPC-FUT-02**: Per-tenant MCP server config (different `mcp_servers:` stanza per tenant).

### Policy engine completion
- **POL-FUT-01**: `max_cost_per_request` policy primitive.
- **POL-FUT-02**: After-hours / time-windowed routing rules.
- **POL-FUT-03**: Multi-bearer auth (different bearer per tenant) with per-bearer policy table.

### `/v1/responses` differentiators
- **RESS-FUT-01**: Reasoning event pass-through (`response.reasoning_text.delta`) for o1-class models.
- **RESS-FUT-02**: Multi-turn Responses API (server-side conversation state with `previous_response_id`).

### Audio
- **AUDIO-FUT-01**: `/v1/audio/transcriptions` Whisper passthrough endpoint.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Vector DB integration (Qdrant, Weaviate, pgvector) | Violates "Retrieval Interfaces, not Retrieval Logic"; couples router to a specific DB |
| Chunking / document ingestion pipeline | Domain-specific; hardcoding any strategy poisons the interface |
| Automatic semantic memory (auto store+retrieve every turn) | Requires retrieval strategy decisions the router cannot make neutrally |
| Summarization behavior / prompt templates inside router | `SummaryProvider` seam; router calls `summarize(turns)`; caller provides the impl |
| Full OAuth 2.1 PKCE flow for MCP auth | Bearer token sufficient for single-user; OAuth is a future extension point |
| Multi-key / per-tenant bearer auth | Tenant IDs in `request_log` only; multi-bearer auth is a separate milestone |
| Content-based smart routing (classify prompt → pick model) | Violates "client always specifies model" invariant; `X-Workload-Class` header is the explicit alternative |
| Background retrieval / pre-fetch | Requires session prediction; hook fires synchronously at request time |
| Built-in knowledge base / FAQ store | Knowledge schema and access control are consumer concerns |
| Reasoning event pass-through (initial) | Model-specific (o1/o3 only); deferred to `RESS-FUT-01` |
| Multi-host / clustering | Single-host constraint unchanged from PROJECT.md |
| CPU-only backends | GPU-NVIDIA constraint unchanged from PROJECT.md |
| Other runtimes (TGI, TRT-LLM, exllamav2, MLC-LLM) | Existing 4-backend coverage sufficient |
| RAG completo / knowledge vaults / CRM/ERP semantics / GraphRAG / business ontology | Downstream consumer responsibility — strategic frame |

## Architectural-Frame Violation Trip-Wires

The roadmap and plan-phase agents must reject any task that would:

1. Add a default in-process retriever implementation (NOT the noop test stub).
2. Add a default `SummaryProvider` that calls a model (Noop default is the ONLY shipped impl).
3. Add content-based smart routing (classifier model inside the router).
4. Add a vector DB to the router's Drizzle migrations (pgvector even for "testing").
5. Auto-derive `tenant_id` from the bearer token (flag for design review only — single-user keeps tenant_id from headers).
6. Persist external MCP server credentials in plaintext in `request_log` or logs.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| POL-01 | Phase 14 | Pending |
| POL-02 | Phase 14 | Pending |
| POL-03 | Phase 14 | Pending |
| POL-04 | Phase 14 | Pending |
| POL-05 | Phase 14 | Pending |
| POL-06 | Phase 14 | Pending |
| MCPS-01 | Phase 15 | Pending |
| MCPS-02 | Phase 15 | Pending |
| MCPS-03 | Phase 15 | Pending |
| MCPS-04 | Phase 15 | Pending |
| MCPS-05 | Phase 15 | Pending |
| MCPS-06 | Phase 15 | Pending |
| RESS-01 | Phase 16 | Pending |
| RESS-02 | Phase 16 | Pending |
| RESS-03 | Phase 16 | Pending |
| RESS-04 | Phase 16 | Pending |
| RESS-05 | Phase 16 | Pending |
| SESS-01 | Phase 17 | Pending |
| SESS-02 | Phase 17 | Pending |
| SESS-03 | Phase 17 | Pending |
| SESS-04 | Phase 17 | Pending |
| SESS-05 | Phase 17 | Pending |
| SESS-06 | Phase 17 | Pending |
| CTXP-01 | Phase 17 | Pending |
| CTXP-02 | Phase 17 | Pending |
| CTXP-03 | Phase 17 | Pending |
| CTXP-04 | Phase 17 | Pending |
| SUMP-01 | Phase 17 | Pending |
| SUMP-02 | Phase 17 | Pending |
| SUMP-03 | Phase 17 | Pending |
| MCPC-01 | Phase 18 | Pending |
| MCPC-02 | Phase 18 | Pending |
| MCPC-03 | Phase 18 | Pending |
| MCPC-04 | Phase 18 | Pending |
| MCPC-05 | Phase 18 | Pending |
| MCPC-06 | Phase 18 | Pending |
| RETR-01 | Phase 18 | Pending |
| RETR-02 | Phase 18 | Pending |
| RETR-03 | Phase 18 | Pending |
| RETR-04 | Phase 18 | Pending |
| RETR-05 | Phase 18 | Pending |
| RETR-06 | Phase 18 | Pending |
| EMBP-01 | Phase 19 | Pending |
| EMBP-02 | Phase 19 | Pending |
| OBSV-01 | Phase 19 | Pending |
| OBSV-02 | Phase 19 | Pending |
| OBSV-03 | Phase 19 | Pending |
| OBSV-04 | Phase 19 | Pending |

**Coverage:**
- v0.11.0 requirements: 48 total
- Mapped to phases (finalized by ROADMAP.md 2026-05-29): 48/48
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-29*
*Last updated: 2026-05-30 — POL-01 wording patched per D-03 (top-level policies block).*
