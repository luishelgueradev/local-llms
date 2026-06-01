# Roadmap: local-llms

**Coverage:** 76/76 v1 requirements shipped in v0.9.0 · 26/26 v0.10.0 requirements shipped · 48/48 v0.11.0 requirements mapped
**Status:** v0.11.0 "Retrieval-Ready Infrastructure" — in planning.

## Milestones

- ✅ **v0.9.0 MVP** — Router multi-backend con cloud fallback + observability + ops · Phases 1-9 · shipped 2026-05-28 · 9 phases, 55 plans, 112 tasks · [archive](./milestones/v0.9.0-ROADMAP.md) · [requirements](./milestones/v0.9.0-REQUIREMENTS.md) · [audit](./milestones/v0.9.0-MILESTONE-AUDIT.md)
- ✅ **v0.10.0 Cognitive Primitives** — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API · Phases 10-13 · shipped 2026-05-29 · 4 phases (freeform single-shot pattern), 26 requirements · [archive](./milestones/v0.10.0-ROADMAP.md) · [requirements](./milestones/v0.10.0-REQUIREMENTS.md) · [audit](./milestones/v0.10.0-MILESTONE-AUDIT.md)
- 🚧 **v0.11.0 Retrieval-Ready Infrastructure** — MCP-as-server/client · `/v1/responses` streaming + tools · SessionStore/ContextProvider/SummaryProvider · RetrieverProvider + pre-completion hook · EmbeddingProvider interface · Policy primitives · Phases 14-19

## Phases

### v0.11.0 Retrieval-Ready Infrastructure (Phases 14–19)

- [ ] **Phase 14: Policy Primitives + Tenant/Project ID Foundation** — Additive zero-dep policy gate + tenant/project ID headers in logs and request_log; every later phase inherits correct observability context from this foundation.
- [x] **Phase 15: MCP Host (Router as MCP Server)** — Router exposes five MCP tools (chat, embeddings, rerank, responses, list_models) over Streamable HTTP at `/mcp`; any MCP-compatible client can consume the router as a tool server.
- [x] **Phase 16: `/v1/responses` Streaming + Tool Calls** ✅ 2026-05-31 — Full Responses API streaming with `OutputItemStateMachine`, tool-call events, and `response.completed` always last; closes v0.10.0 streaming debt.
- [x] **Phase 17: SessionStore + ContextProvider + SummaryProvider** ✅ 2026-06-01 — Postgres-backed sessions + ContextProvider sliding-window + NoopSummaryProvider all wired through `buildApp` in `router/src/index.ts`; SESS/CTXP/SUMP 13 requirements closed.
- [ ] **Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook** — Generic MCP client capability (lazy-connect, tool namespace prefix, 60s Valkey cache), RetrieverProvider interface + pre-completion hook seam with explicit fail-open/closed, and EmbeddingProvider interface formalization.
- [ ] **Phase 19: EmbeddingProvider Formalization + Observability Hardening** — EmbeddingProvider interface extracted, all new surfaces covered by smoke tests and Prometheus metrics, cardinality CI guard, docs updated.

<details>
<summary>✅ v0.10.0 Cognitive Primitives (Phases 10-13) — SHIPPED 2026-05-29</summary>

- [x] **Phase 10: Structured Outputs / JSON Mode** ✅ 2026-05-29
- [x] **Phase 11: Reranker (`POST /v1/rerank`)** ✅ 2026-05-29
- [x] **Phase 12: Embeddings Hardening** ✅ 2026-05-29
- [x] **Phase 13: Cost Observability + `/v1/responses`** ✅ 2026-05-29

</details>

<details>
<summary>✅ v0.9.0 MVP (Phases 1-9) — SHIPPED 2026-05-28</summary>

- [x] **Phase 1: GPU + Compose Foundation** ✅ 2026-05-10
- [x] **Phase 2: MVP Vertical Slice — Router + Ollama + SSE** ✅ 2026-05-12
- [x] **Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening** ✅ 2026-05-13
- [x] **Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision** ✅ 2026-05-14
- [x] **Phase 5: Postgres + Observability Seam** ✅ 2026-05-15
- [x] **Phase 6: Open WebUI + Traefik Edge** ✅ 2026-05-15
- [x] **Phase 7: Embeddings + vLLM + GPU Telemetry** ✅ 2026-05-17
- [x] **Phase 8: Ollama Cloud Fallback + Resilience Hardening** ✅ 2026-05-27
- [x] **Phase 9: Operations Hardening** ✅ 2026-05-17

</details>

## Phase Details

### Phase 14: Policy Primitives + Tenant/Project ID Foundation

**Goal**: Operators can configure model allowlists and cloud restrictions in `models.yaml`; tenant/project context flows through every request log entry from this phase onward.

**Depends on**: Phase 13 (continuation; all v0.10.0 surfaces exist)

**Requirements**: POL-01, POL-02, POL-03, POL-04, POL-05, POL-06

**Design constraints (BLOCK-severity from PITFALLS.md):**
- Policy gate fires BEFORE circuit breaker check (P8-01 BLOCK) — same position as existing capability gate; allowlist violations must NOT count as backend failures
- `cloud_allowed: false` checked against `entry.backend === 'ollama-cloud'` (P8-02 BLOCK) — no per-request override; route Zod schemas use `.strict()`
- Prometheus metric labels NEVER include `tenant_id`, `project_id`, `agent_id`, `session_id` (P8-03 BLOCK) — these IDs live only in Postgres + pino; CI check validates `/metrics` output against `_id` suffix
- Migration journal: read `_journal.json` as first action to assign next sequential number (P9-01 BLOCK) — `tenant_id` + `project_id` columns on `request_log` require one migration file
- `X-Workload-Class: sensitive` is opaque metadata only — no content classification (Frame-04 BLOCK)

**Success Criteria** (what must be TRUE):
1. An operator who adds `model_allowlist: ["chat-local"]` to a registry entry sees any request for a different model return `403 { code: "model_not_in_allowlist", model }` before the circuit breaker is consulted (verified by integration test asserting breaker counter unchanged after the 403).
2. An operator who sets `policy.cloud_allowed: false` for a registry entry sees requests routed to `backend: ollama-cloud` return `403 { code: "cloud_not_allowed", model }`, with no cloud request emitted to Ollama Cloud.
3. A caller sending `X-Tenant-ID: acme` and `X-Project-ID: agents` sees both values appear in the Postgres `request_log` row for that request (verified by integration test querying the DB row).
4. The live `/metrics` endpoint contains no label matching `.*_id` on `router_request_total` or `router_request_duration_seconds` (verified by the new `scripts/check-prometheus-cardinality.ts` CI check).
5. Existing smoke test suite passes unchanged (policy defaults to allow-all with no config declared).

**Plans:** 9/9 plans complete
- [x] 14-01-PLAN.md — Migration 0005 atomic tuple (SQL + Drizzle schema + journal entry) [POL-04]
- [x] 14-02-PLAN.md — Extend RegistrySchema with `policies` + per-entry `policy.cloud_allowed` [POL-01, POL-02]
- [x] 14-03-PLAN.md — Add AllowlistViolationError, CloudNotAllowedError, InvalidScopedIdError + envelope mappings [POL-01, POL-02, POL-05]
- [x] 14-04-PLAN.md — Implement applyPolicyGate helper + unit-test matrix [POL-01, POL-02]
- [x] 14-05-PLAN.md — Wire applyPolicyGate into 5 routes + BLOCKING migration apply + breaker-spy integration test [POL-01, POL-02, POL-04, POL-05]
- [x] 14-06-PLAN.md — scopedIdsPreHandler + agentId.child() extension + Pitfall-9 grep gate [POL-03, POL-05]
- [x] 14-07-PLAN.md — Plumb scoped IDs through recordOutcome to request_log row + integration test [POL-04]
- [x] 14-08-PLAN.md — Prometheus cardinality CI guard script + vitest [POL-06]
- [x] 14-09-PLAN.md — models.yaml commented stanza + DEPLOY/README docs + REQUIREMENTS POL-01 wording patch + smoke gate [POL-01, POL-02, POL-03]

---

### Phase 15: MCP Host (Router as MCP Server)

**Goal**: Any MCP-compatible client (n8n MCP trigger, Claude Desktop, Cursor) can connect to `/mcp` over Streamable HTTP and invoke the router's existing capabilities as MCP tools — using the same bearer token and observability stack.

**Depends on**: Phase 14 (policy gate in place before MCP tool exposure; tenant IDs in logs)

**Requirements**: MCPS-01, MCPS-02, MCPS-03, MCPS-04, MCPS-05, MCPS-06

**Design constraints (BLOCK-severity from PITFALLS.md):**
- Streamable HTTP ONLY — no stdio transport (P1-01 BLOCK) — n8n production compatibility; stdio is explicitly NOT exposed (MCPS-06)
- Bearer auth inherited from app-level `onRequest` hook (P1-02 BLOCK) — MCP plugin registered under the same Fastify scope; no separate auth mechanism; unauthenticated access returns 401 before any MCP-level handling
- MCP tool JSON Schemas generated programmatically from existing Zod schemas via `z.toJSONSchema()` (P1-03 BLOCK) — no hand-authored duplicate schemas; prevents drift
- Session GC loop every 30 min + SIGTERM handler calls `transport.close()` for all sessions with 5s hard timeout (P1-04 BLOCK) — wired into Fastify `onClose` hook
- Raw `req.raw`/`reply.raw` integration only — no `@modelcontextprotocol/fastify` or other community alpha plugins (constraint from REQUIREMENTS.md + SUMMARY.md)
- Tool handler errors return `isError: true` with `{ error, code, message }` content block (MCPS-04) — not thrown exceptions
- Exactly five tools exposed: `chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models` — explicit allowlist, no auto-discovery of routes (P1-05 FLAG)

**Success Criteria** (what must be TRUE):
1. A caller using the `@modelcontextprotocol/sdk` TypeScript `Client` connects to `POST /mcp` with `Authorization: Bearer <token>` and successfully calls `tools/list`, receiving at least the five declared tools (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`).
2. A caller who omits the `Authorization` header on `POST /mcp` receives `401` before any MCP-level JSON-RPC handling occurs.
3. A caller invokes the `chat_completion` MCP tool with `{ model: "chat-local", messages: [...] }` and receives a non-error MCP tool result containing the model's text response — verified by integration test using the `@modelcontextprotocol/sdk` Client.
4. When the router receives `SIGTERM`, all active MCP sessions are closed cleanly within 5 seconds (verified by integration test triggering shutdown and asserting no leaked session entries in the session map).
5. The `router_mcp_active_sessions` Prometheus gauge is present in `/metrics` output and reflects the current session count (0 when no MCP clients are connected).

**Plans:** 12/12 plans executed
- [x] 15-01-PLAN.md — Install @modelcontextprotocol/sdk@^1.29.0 + extend EnvSchema with MCP_ENABLED/MCP_SESSION_TTL_SEC/MCP_GC_INTERVAL_MS [MCPS-01]
- [x] 15-02-PLAN.md — applyPreflight helper (resolve + gate + breaker) + unit-test matrix [MCPS-01]
- [x] 15-03-PLAN.md — Refactor 5 HTTP routes to call applyPreflight (chat/messages/embeddings/rerank/responses) [MCPS-01]
- [x] 15-04-PLAN.md — router_mcp_tool_calls_total counter + router_mcp_active_sessions gauge + widen OutcomeContext.protocol union to include 'mcp' [MCPS-05]
- [x] 15-05-PLAN.md — mcpHostPlugin shell (multi-method /mcp, sessionMap, GC, onClose) + wire into app.ts + integration smoke for initialize/401/empty-tools [MCPS-01, MCPS-02, MCPS-05]
- [x] 15-06-PLAN.md — chat_completion MCP tool (D-01 passthrough, D-02/D-03 dual-shape, D-04 isError, D-12 stream coerce, D-14 abort) [MCPS-03, MCPS-04]
- [x] 15-07-PLAN.md — create_response MCP tool [MCPS-03, MCPS-04]
- [x] 15-08-PLAN.md — create_embedding MCP tool (D-03 stamp + vector ride-along) [MCPS-03, MCPS-04]
- [x] 15-09-PLAN.md — rerank MCP tool [MCPS-03, MCPS-04]
- [x] 15-10-PLAN.md — list_models MCP tool (D-10 allowlist filter + cloud_allowed annotation + T-3-A2 anti-leak) [MCPS-03, MCPS-04]
- [x] 15-11-PLAN.md — Widen GET /v1/models + /v1/models/:id with allowlist filter + cloud_allowed (D-11) + integration tests for request_log + metrics + dual-surface filter parity [MCPS-03, MCPS-04, MCPS-05]
- [x] 15-12-PLAN.md — Golden snapshot drift gate (P1-03), MCPS-05 SIGTERM cleanup integration, D-15 disabled-mode integration, smoke section, DEPLOY/README docs, MCPS-06 stdio grep gate [MCPS-01, MCPS-02, MCPS-03, MCPS-05, MCPS-06]
**UI hint**: no

---

### Phase 16: `/v1/responses` Streaming + Tool Calls

**Goal**: Callers can stream responses from `POST /v1/responses` with `stream: true` and receive the canonical Responses API event sequence including tool-call events; the non-streaming path from v0.10.0 is fully preserved.

**Depends on**: Phase 14 (policy gate wired to responses route), Phase 15 (tool-call event pattern reference from MCP work)

**Requirements**: RESS-01, RESS-02, RESS-03, RESS-04, RESS-05

**Design constraints (BLOCK-severity from PITFALLS.md):**
- Dedicated `responsesStreamTranslator` module with explicit `OutputItemStateMachine` (P3-01 BLOCK, P3-02 BLOCK) — states: `idle | text | function_call`; never re-use chat-completions SSE events
- `response.completed` is always the final event on every successful stream (P3-03 BLOCK) — verified by integration test asserting last-event invariant
- Heartbeats MUST use SSE comment lines (`: keep-alive`) not data events (P3-04 FLAG) — same existing pattern; regression risk on copy-paste
- Golden fixture for non-streaming `/v1/responses` shape from v0.10.0 must pass unchanged (P9-02 BLOCK) — streaming addition must not alter non-streaming wire shape

**Success Criteria** (what must be TRUE):
1. A caller sends `POST /v1/responses` with `{ stream: true, model: "chat-local", input: "hello" }` and receives an SSE stream whose events in order are: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, one or more `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed` — and `response.completed` is the final non-comment event.
2. A caller sends the same request with a function-calling model and tool definitions; the stream surfaces `response.function_call_arguments.delta` events and the final `response.completed` includes `status: "incomplete"` with `incomplete_details: { reason: "tool_calls" }`. (Editorial note 2026-05-31: corrected from `"requires_action"` — that value belongs to Assistants-API-v2; the Responses-API `ResponseStatus` enum in openai@6.x uses `incomplete + reason:tool_calls` for the pause-awaiting-tools state.)
3. The existing non-streaming `POST /v1/responses` golden fixture (v0.10.0) passes unchanged — wire shape, `usage`, and `output` fields are byte-identical to the v0.10.0 fixture.
4. The streaming path reuses the existing `fastify-sse-v2` plumbing, heartbeats (SSE comment lines), idempotency multiplexer replay, and the cost-recording machinery. Cost lands in `request_log.cost_cents` on stream completion (SSE headers seal before token counts are known, so `X-Cost-Cents` is NOT emitted on streamed responses — same behavior as chat-completions streaming today; non-streaming `/v1/responses` continues to emit the header). Verified by smoke confirming a streaming request produces a `request_log` row with `cost_cents > 0` for a cloud model.
5. Each streaming event carries a `sequence_number` field and the stream never closes before `response.completed` under normal completion.

**Plans:** 4/4 plans complete

Plans:
- [x] 16-01-PLAN.md — Wave 0 scaffold (translator unit suite + 6 golden fixtures + route integration suite + P9-02 placeholder) [RESS-01..05]
- [x] 16-02-PLAN.md — canonicalToResponsesSse translator + OutputItemStateMachine FSM + 25 unit tests + 6 populated golden fixtures [RESS-01, RESS-02, RESS-03, RESS-04]
- [x] 16-03-PLAN.md — /v1/responses route streaming branch (leader + follower) + 13+ integration tests RESS-01..05 [RESS-01..05]
- [x] 16-04-PLAN.md — P9-02 byte-identical golden snapshot lockdown + P3-04 heartbeat grep gate + smoke-test RESS section + STATE/ROADMAP/REQUIREMENTS update [RESS-01..05]

---

### Phase 17: SessionStore + ContextProvider + SummaryProvider

**Goal**: Callers can maintain persistent multi-turn sessions across requests via `X-Session-ID`; ContextProvider manages the context window by strategy; SummaryProvider seam is declared with a noop default — the router gains stateful conversation capability without implementing any retrieval or semantic memory.

**Depends on**: Phase 14 (tenant_id/agent_id in request_log for session attribution), Phase 16 (responses route in final streaming form before session injection is wired into it)

**Requirements**: SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06, CTXP-01, CTXP-02, CTXP-03, CTXP-04, SUMP-01, SUMP-02, SUMP-03

**Phase 17 split rationale (kept whole):** SESS-01..06 (SessionStore + DB), CTXP-01..04 (ContextProvider strategies), and SUMP-01..03 (SummaryProvider seam) all wire into the same route integration point at the same time — splitting would leave routes half-integrated (session loading without window management) and double the integration overhead. 13 REQs with clear internal sequencing (SESS → CTXP → SUMP) fit a single coherent delivery boundary.

**Design constraints (BLOCK-severity from PITFALLS.md):**
- `sessions.expires_at TIMESTAMPTZ NOT NULL` in migration from day one (P4-01 BLOCK) — no unbounded retention path; default TTL 7 days
- `pg_advisory_xact_lock(hashtext(session_id))` inside transaction wrapping turn append (P4-02 BLOCK) — prevents concurrent write race for same session_id
- `SessionStore.loadHistory()` requires `agent_id` as mandatory parameter (P4-03 BLOCK) — cross-agent leakage prevented at query layer; WHERE clause always includes `agent_id`
- System messages are NEVER evictable by window management (P4-04 BLOCK) — pinned turns (role=system) always appear first; only user/assistant/tool turns are evictable
- `SummaryProvider.summarize()` is NEVER invoked when session has a pending tool call (P6-01 BLOCK) — `has_pending_tool_call` flag prevents summarization until tool round-trip completes (SUMP-03)
- Session persistence is optional — callers without `X-Session-ID` operate stateless with zero SessionStore involvement (SESS-06)
- Session writes are synchronous durable writes (NOT async-buffered like request_log) — fail-open under 1s timeout with `persisted: false` flag (SESS-04)
- No FK from `conversation_turns` to `request_log` — sessions must be independently deletable (P4-06 FLAG). (Editorial fix 2026-05-31: aligned table name with REQUIREMENTS.md SESS-02; earlier draft used `session_turns` inconsistently.)
- Migration journal: assign number as first task; consult `_journal.json` before writing any SQL (P9-01 BLOCK)

**Success Criteria** (what must be TRUE):
1. A caller sends `POST /v1/chat/completions` twice with the same `X-Session-ID: <id>` header; the second request's model response demonstrates awareness of the first turn's content (the history was loaded and injected into the second request's message array).
2. A caller sends `X-Session-ID` with one `agent_id` and attempts to load that session with a different `agent_id`; they receive an empty history (cross-tenant leakage prevention verified by integration test).
3. A model entry declaring `context_strategy: sliding-window` with `ctx_size: 4096` receives a long session; the ContextProvider trims the history to fit, the system message is always present at index 0 in the trimmed context, and no 400 "context length exceeded" error occurs from the backend.
4. A session created without `X-Session-ID` in the request operates fully stateless — no `sessions` or `conversation_turns` rows are written, and the response is identical to pre-Phase-17 behavior.
5. The `X-Session-ID` response header is set on responses when a session is active; the `NoopSummaryProvider` is the default and never calls any model.

**Plans:** 7/7 plans complete

Plans:
- [x] 17-01-PLAN.md — Wave 0 scaffold (9 test files + tests/fakes.ts extension; `it.todo` placeholders + SESS-01 expectTypeOf assertions) [SESS-01..06 + CTXP-01..04 + SUMP-01..03] — SHIPPED 2026-06-01
- [x] 17-02-PLAN.md — Migration 0006 indivisible tuple (SQL + Drizzle schema + journal + barrel re-export) [SESS-02] — SHIPPED 2026-06-01
- [x] 17-03-PLAN.md — SessionStore interface + 4 error classes + PostgresSessionStore (advisory lock + 1s fail-open + sliding TTL + agent_id mandatory) [SESS-01, SESS-02, SESS-03, SESS-04] — SHIPPED 2026-06-01
- [x] 17-04-PLAN.md — ContextProvider interface + sliding-window default + truncate + system pin + Pitfall 17-G incoming-privilege invariant [CTXP-01, CTXP-02, CTXP-03] — SHIPPED 2026-06-01
- [x] 17-05-PLAN.md — SummaryProvider + Noop + sessionIdPreHandler + EnvSchema (SESSION_TTL_DAYS) + ModelEntrySchema widening (ctx_size, context_strategy) + models.yaml banner + BuildAppOpts widening + countTokens warmup [SUMP-01, SUMP-02, SUMP-03, CTXP-04, SESS-05, SESS-06] — SHIPPED 2026-06-01
- [x] 17-06-PLAN.md — Three-route wire-up (chat-completions + responses + messages) — non-stream await, stream-path fire-and-forget, Q5 follower gate, Pitfalls 17-D/E/F [SESS-01, SESS-03, SESS-05, SESS-06, CTXP-01..03, SUMP-02] — SHIPPED 2026-06-01
- [x] 17-07-PLAN.md — Production composition (index.ts) + Pitfall 17-E counter (router_session_append_failed_total) + smoke SESSION section (6 PASS gates) + DEPLOY/README docs + Q5 follower test flipped + STATE/ROADMAP/REQUIREMENTS wrap-up [all 13 REQs verified-by] — SHIPPED 2026-06-01

---

### Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook

**Goal**: Operators can declare external MCP servers in `models.yaml` and the router lazily connects to them to inject their tools into model requests; operators can register a `RetrieverProvider` pre-completion hook that injects retrieved context before the model call; both mechanisms coexist without interference.

**Depends on**: Phase 15 (MCP SDK installed, Streamable HTTP transport integration pattern established), Phase 17 (ContextProvider fully wired; hooks receive post-context-window canonical)

**Requirements**: MCPC-01, MCPC-02, MCPC-03, MCPC-04, MCPC-05, MCPC-06, RETR-01, RETR-02, RETR-03, RETR-04, RETR-05, RETR-06

**Design constraints (BLOCK-severity from PITFALLS.md):**
- MCP clients connect LAZILY on first use (P2-01 BLOCK) — router boot MUST NOT block on external MCP server availability; `/readyz` does not check MCP client connectivity
- Tool names namespace-prefixed `{server_alias}__{tool_name}` on ingestion; stripped on dispatch (P2-02 BLOCK) — prevents collision across multiple MCP servers
- External MCP tool descriptions validated: name must match `[a-z0-9_]{1,64}`, description truncated at 512 chars with warning (P2-03 BLOCK) — defense-in-depth against tool poisoning
- Inbound bearer token is NEVER forwarded to external MCP servers (P2-04 BLOCK) — per-server `auth_value` from config used; verified by integration test asserting outbound headers contain only per-server credential
- `RetrieverProvider` hook interface requires explicit `on_timeout: "fail-open" | "fail-closed"` field (P5-01 BLOCK) — no default; missing field is a startup error
- Every hook call wrapped in `Promise.race([hookPromise, timeoutPromise])` (P5-02 BLOCK) — `router_hook_duration_ms{hook_name}` Prometheus histogram
- Retrieved content fenced as `<retrieved_context source="{hook_name}">...</retrieved_context>` with 4000 char limit (P5-03 BLOCK) — `hook_log` JSONB column or table for audit (RETR-04)
- `EmbeddingProvider` formalization does NOT change `/v1/embeddings` wire shape (P7-01 BLOCK) — interface is a wrapper over existing `BackendAdapter`; route handler is not modified
- Tool list cached in Valkey with 60s TTL keyed by `mcp:tools:{server_alias}` (MCPC-06) — consistent with existing `model-registry:*` key pattern
- MCP tool-call loop capped at 10 iterations (MCPC-04) — structured error `{ code: "mcp_tool_loop_exceeded" }` on cap
- No in-process retriever implementation shipped (Frame-01 BLOCK) — `NoopRetrieverProvider` exists only in tests via `msw` fixture server

**Success Criteria** (what must be TRUE):
1. An operator declares an external MCP server in `mcp_servers:` in `models.yaml`; the router starts cleanly even if that server is unreachable at boot time, and only fails at request time when an MCP-tool-enabled request is made (integration test: unresponsive MCP server during boot, router `/readyz` returns 200).
2. Two external MCP servers each register a tool named `search`; after tool injection the model's tool list contains `serverA__search` and `serverB__search` with no collision, and calling `serverA__search` routes to server A while `serverB__search` routes to server B.
3. A request with a pre-completion hook configured with `on_timeout: fail-open` continues to completion when the hook times out (request succeeds, `X-Hook-Error` response header is set, hook timeout is logged); a request with `on_timeout: fail-closed` returns 502 when the hook times out.
4. Retrieved documents appear in the `request_log.hook_log` JSONB column with `context_hash` (SHA256 of content), `hook_name`, `latency_ms`, and `chars_retrieved` — not the full content.
5. The existing `/v1/embeddings` smoke test passes byte-identical to pre-Phase-18 (no wire shape change from EmbeddingProvider formalization).
6. When both a pre-completion hook and an MCP tool are configured for the same route, both execute independently on the same request — the hook fires before the model call, the MCP tool fires via the model's tool-call loop after the first model response.

**Plans:** 6/8 plans executed

Plans:
- [x] 18-01-PLAN.md — Wave 0 scaffold (22+ test files + MSW MCP fixture + tests/fakes.ts extension) [MCPC-01..06 + RETR-01..06]
- [x] 18-02-PLAN.md — Migration 0007 indivisible tuple (SQL + Drizzle + journal idx=7 + barrel) + 4 envelope errors + 2 Prometheus metrics + registry Zod widening + models.yaml stanza [MCPC-01, MCPC-04, MCPC-05, RETR-03, RETR-04]
- [x] 18-03-PLAN.md — RetrieverProvider interface + inject.ts (P5-03 fence) + sanitize.ts (P2-03) + prefix.ts (MCPC-03) + barrels [RETR-01, RETR-05, MCPC-03]
- [x] 18-04-PLAN.md — McpClientRegistry impl + transport.ts + Valkey cache + sanitize-on-ingest + dispose lifecycle [MCPC-01..03, MCPC-05, MCPC-06]
- [x] 18-05-PLAN.md — runMcpToolLoop + MCP_TOOL_LOOP_MAX=10 + abort propagation [MCPC-04]
- [x] 18-06-PLAN.md — runHookChain + Promise.race timeout helper + SHA256 hook_log producer + redactBearer [RETR-02, RETR-03, RETR-04, RETR-05, RETR-06]
- [ ] 18-07-PLAN.md — Three-route wire-up via shared helper + BuildAppOpts widening + boot-time HookConfigError validator + production composition root (empty preCompletionHooks Map — Frame-01) + onSwap hot-reload + SIGTERM disposeAll [all 12 REQs]
- [ ] 18-08-PLAN.md — Smoke MCP-CLIENT + HOOK section + DEPLOY/README docs + STATE/ROADMAP/REQUIREMENTS wrap-up + final phase gate [all 12 REQs verified-by]

---

### Phase 19: EmbeddingProvider Formalization + Observability Hardening

**Goal**: All new v0.11.0 surfaces are covered by smoke tests and Prometheus metrics; the cardinality CI guard is enforced; documentation reflects the full v0.11.0 configuration surface; the milestone is ready for production verification.

**Depends on**: Phase 18 (all new surfaces exist and are stable)

**Requirements**: EMBP-01, EMBP-02, OBSV-01, OBSV-02, OBSV-03, OBSV-04

**Design constraints (BLOCK-severity from PITFALLS.md):**
- Prometheus cardinality CI check (`scripts/check-prometheus-cardinality.ts`) FAILS on any label containing `_id` suffix (P8-03 BLOCK) — enforcement of zero-cardinality-explosion guarantee for `tenant_id`, `agent_id`, etc.
- `OBSV-04`: If `hook_log` JSONB column on `request_log` was not added in Phase 18, migration 0007 adds it here as safety net — migration journal must be consulted first (P9-01 BLOCK)
- Smoke test extension is not optional (P9-03 BLOCK) — new PASS entries required for `/mcp` initialize + tools/list + tools/call, streaming `/v1/responses` with and without tools, session round-trip, hook invocation, policy enforcement

**Success Criteria** (what must be TRUE):
1. `bin/smoke-test-router.sh` runs end-to-end against the live stack with new sections covering: `/mcp` (initialize + tools/list + `list_models` tool call), streaming `/v1/responses` (with and without function calls), `X-Session-ID` round-trip, pre-completion hook invocation, and policy `model_allowlist` enforcement — all printing PASS.
2. The `scripts/check-prometheus-cardinality.ts` CI check passes against the live `/metrics` output, confirming no label contains an `_id` suffix.
3. `README.md` and `DEPLOY.md` contain sections documenting: MCP host endpoint + five tools + auth header requirement; `mcp_servers:` config schema; `X-Session-ID` lifecycle and `SESSION_TTL_DAYS` env; pre-completion hook registration and `on_timeout` field; `model_allowlist` and `cloud_allowed` policy stanza; `X-Tenant-ID`/`X-Project-ID` headers.
4. A caller can call `fastify.embeddingProvider.embed(input, opts)` directly (Fastify decorator injected) and receive the same embedding output as `POST /v1/embeddings` — verified by unit test asserting interface conformance (EMBP-01); the `/v1/embeddings` wire shape is byte-identical to pre-Phase-19 (EMBP-02 regression).
5. Vitest full suite passes with 0 failures; `tsc --noEmit` reports 0 errors.

**Plans:** 6/8 plans complete

Plans:
- [x] 18-01-PLAN.md — Wave 0 scaffold (22+ test files + MSW MCP fixture + tests/fakes.ts extension) [MCPC-01..06 + RETR-01..06]
- [x] 18-02-PLAN.md — Migration 0007 indivisible tuple (SQL + Drizzle + journal idx=7 + barrel) + 4 envelope errors + 2 Prometheus metrics + registry Zod widening + models.yaml stanza [MCPC-01, MCPC-04, MCPC-05, RETR-03, RETR-04]
- [x] 18-03-PLAN.md — RetrieverProvider interface + inject.ts (P5-03 fence) + sanitize.ts (P2-03) + prefix.ts (MCPC-03) + barrels [RETR-01, RETR-05, MCPC-03]
- [x] 18-04-PLAN.md — McpClientRegistry impl + transport.ts + Valkey cache + sanitize-on-ingest + dispose lifecycle [MCPC-01..03, MCPC-05, MCPC-06]
- [x] 18-05-PLAN.md — runMcpToolLoop + MCP_TOOL_LOOP_MAX=10 + abort propagation [MCPC-04]
- [x] 18-06-PLAN.md — runHookChain + Promise.race timeout helper + SHA256 hook_log producer + redactBearer [RETR-02, RETR-03, RETR-04, RETR-05, RETR-06]
- [ ] 18-07-PLAN.md — Three-route wire-up via shared helper + BuildAppOpts widening + boot-time HookConfigError validator + production composition root (empty preCompletionHooks Map — Frame-01) + onSwap hot-reload + SIGTERM disposeAll [all 12 REQs]
- [ ] 18-08-PLAN.md — Smoke MCP-CLIENT + HOOK section + DEPLOY/README docs + STATE/ROADMAP/REQUIREMENTS wrap-up + final phase gate [all 12 REQs verified-by]

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 14. Policy Primitives + Tenant ID Foundation | 9/9 | Complete    | 2026-05-30 |
| 15. MCP Host (Router as MCP Server) | 12/12 | Complete    | 2026-05-31 |
| 16. /v1/responses Streaming + Tool Calls | 4/4 | Complete   | 2026-05-31 |
| 17. SessionStore + ContextProvider + SummaryProvider | 7/7 | Complete    | 2026-06-01 |
| 18. MCP Client + RetrieverProvider + Pre-Completion Hook | 6/8 | In Progress|  |
| 19. EmbeddingProvider Formalization + Observability Hardening | 0/TBD | Not started | - |

---

*Phase-level details (success criteria, requirements, plan breakdowns) preserved per milestone:*
- v0.9.0 — [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md)
- v0.10.0 — [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md)

*Requirements traceability per milestone:*
- v0.9.0 — [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md)
- v0.10.0 — [`milestones/v0.10.0-REQUIREMENTS.md`](./milestones/v0.10.0-REQUIREMENTS.md)
- v0.11.0 — REQUIREMENTS.md (active, this milestone)
