# Architecture Research: v0.11.0 Integration Map

**Domain:** LLM router — Retrieval-Ready Infrastructure extension
**Researched:** 2026-05-29
**Confidence:** HIGH (based on live code inspection + verified MCP SDK docs)

---

## Existing Architecture Baseline (do not re-research, integrate with)

The router is a single Fastify v5 process. Its current layer cake, from outermost to innermost:

```
HTTP IN
  ↓
onRequest hooks (t0 stamp → bearer auth → rate-limit)
  ↓
preHandler hook (agentId extract + req._t0 measurement)
  ↓
Route handler (zod body parse → registry.resolve → capability gate)
  ↓
Resilience layer (breaker.check → semaphore.acquire → idempotency.acquire)
  ↓
BackendAdapter.chatCompletionsCanonical[Stream] / embeddings / rerank
  ↓
Translation layer (canonical ↔ OpenAI/Anthropic/Responses wire shapes)
  ↓
fastify-sse-v2 reply.sse(asyncIterable) OR reply.send(body)
  ↓
onSend hook (X-Cost-Cents stamp)
  ↓
finally block (safeRecord → bufferedWriter.push + Prometheus)
HTTP OUT
```

Key existing files to preserve unchanged or extend minimally:

- `src/backends/adapter.ts` — `BackendAdapter` interface (extend, never break)
- `src/translation/canonical.ts` — canonical request/response/stream event types (extend, never remove)
- `src/config/registry.ts` — `ModelEntrySchema` + `RegistryStore` (add fields, widened zod enum)
- `src/app.ts` — `buildApp` + `BuildAppOpts` (add optional fields, never remove existing ones)
- `src/db/schema/request_log.ts` — Drizzle schema (add columns via new migrations, never ALTER existing)
- `src/routes/v1/responses.ts` — minimal non-stream surface from v0.10.0 (extend to streaming)

---

## v0.11.0 System Overview

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    Fastify v5 app (single port)          │
                    │                                                           │
                    │  /v1/chat/completions   (existing, unchanged)             │
                    │  /v1/messages           (existing, unchanged)             │
                    │  /v1/embeddings         (existing, unchanged)             │
                    │  /v1/rerank             (existing, unchanged)             │
                    │  /v1/responses          (EXTEND: add streaming + tools)   │
                    │  /mcp  (GET+POST+DELETE) ─── NEW: MCP host plugin        │
                    │                                                           │
  n8n / agents ────►  onRequest: bearer auth                                   │
  Claude Desktop ──►  onRequest: rate-limit                                    │
  MCP clients ─────►  preHandler: agentId + tenant/project IDs (EXTEND)       │
                    │                                                           │
                    │  ┌──────────────────────────────────────────────────┐    │
                    │  │  Request pipeline (per route)                     │    │
                    │  │  registry.resolve → capability gate               │    │
                    │  │  [NEW] policy gate (allowlist, cloud, sensitive)  │    │
                    │  │  [NEW] pre-completion hook (RetrieverProvider)    │    │
                    │  │  [NEW] ContextProvider (session history inject)   │    │
                    │  │  breaker → semaphore → idempotency                │    │
                    │  │  BackendAdapter                                   │    │
                    │  │  [NEW] MCP tool-call loop (if tools in response)  │    │
                    │  │  Translation layer                                │    │
                    │  │  reply.sse / reply.send                           │    │
                    │  │  recordOutcome (+ tenant/agent IDs)               │    │
                    │  └──────────────────────────────────────────────────┘    │
                    │                                                           │
                    │  ┌────────────────┐  ┌────────────────┐                  │
                    │  │ MCP Client     │  │ SessionStore   │                  │
                    │  │ registry       │  │ (Postgres)     │                  │
                    │  │ (mcp.yaml or  │  └────────────────┘                  │
                    │  │  models.yaml) │                                        │
                    │  └──────┬────────┘                                        │
                    └─────────┼───────────────────────────────────────────────┘
                              │ outbound HTTP (StreamableHTTP)
                              ▼
                    External MCP servers (Qdrant-MCP, filesystem-MCP, etc.)
```

---

## Integration Points Per Feature

### 1. MCP Host (server) — Integration Point

**Verdict: Option C (Fastify plugin at /mcp) is the correct choice.**

Rationale:
- Option A (bare routes at /mcp/*) works but loses plugin encapsulation — you'd wire SSE, session management, and JSON-RPC dispatch by hand, which the `@modelcontextprotocol/sdk` `McpServer` + `NodeStreamableHTTPServerTransport` already handles correctly.
- Option B (separate process/port) fragments the auth stack. Bearer token would need to be threaded to a second port, Traefik would need a second entrypoint, and Prometheus metrics would diverge. Rejected.
- Option C uses `haroldadmin/fastify-mcp` (v3.0.0, released 2026-05-12) which wraps `@modelcontextprotocol/sdk`'s `NodeStreamableHTTPServerTransport` and mounts at a configurable path (`/mcp`). Same port, same process.

**MCP Streamable HTTP transport protocol summary (verified from spec):**
- `POST /mcp` — JSON-RPC messages (requests, notifications, responses). Returns `Content-Type: text/event-stream` for request-initiated SSE streams, or `application/json` for single-response operations.
- `GET /mcp` — Opens a standalone SSE stream for server-initiated notifications. The client sends `Accept: text/event-stream`.
- `DELETE /mcp` — Session termination (when stateful mode is used).
- Session state is tracked via `Mcp-Session-Id` header (server-generated UUID on initialize, client must echo on all subsequent requests).

**SSE conflict with fastify-sse-v2:** The MCP plugin handles its own SSE via `reply.raw.write()` inside the `NodeStreamableHTTPServerTransport`, NOT via `fastify-sse-v2`. The two plugins operate on different routes (`/mcp` vs `/v1/...`) so there is no routing conflict. The `FastifySSEPlugin` continues to power `/v1/chat/completions` and `/v1/messages` streaming. **No conflict confirmed.** (MEDIUM confidence — not verified with live test, but architecturally isolated by route prefix.)

**Auth integration:** The MCP plugin does NOT share the existing bearer `onRequest` hook automatically. The hook is registered at the app level and applies to ALL routes, so if it runs before the MCP plugin routes, the bearer check fires first. This is correct behavior — the existing bearer guard at `onRequest` stage already covers `/mcp` routes. No auth duplication needed.

**Observability integration:** The existing `preHandler` agentId hook, Prometheus `recordOutcome`, and `bufferedWriter` are NOT automatically wired to MCP tool invocations — those operate inside the MCP plugin's JSON-RPC handler, which is opaque to Fastify's route lifecycle. MCP tool invocations must emit their own pino log lines and optionally push to `bufferedWriter` from within the tool handler.

**How existing routes are exposed as MCP tools:**
Do NOT duplicate route handlers. Instead, use an internal adapter pattern: each MCP tool handler constructs the canonical request directly (bypassing HTTP), calls `adapter.chatCompletionsCanonical()` or `adapter.embeddings()` from the same `BackendAdapter` instances used by the HTTP routes. This keeps a single code path. The MCP tool call is essentially: MCP tool invocation → construct `CanonicalRequest` → call adapter → return text content to MCP client.

```typescript
// NEW: src/mcp/host/tools/chat.ts (sketch — not literal code)
mcpServer.registerTool('chat', { inputSchema: z.object({ model: z.string(), messages: z.array(...) }) },
  async ({ model, messages }) => {
    const entry = registry.resolve(model);
    const canonical = /* build from messages */;
    const result = await adapter.chatCompletionsCanonical(canonical, AbortSignal.timeout(30_000));
    return { content: [{ type: 'text', text: result.content.filter(b => b.type === 'text').map(b => b.text).join('') }] };
  }
);
```

**New files:**
- `src/mcp/host/index.ts` — McpServer instance + tool registrations
- `src/mcp/host/tools/chat.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts` — one tool per surface
- `src/mcp/host/plugin.ts` — Fastify plugin that registers `haroldadmin/fastify-mcp` and wires tools

**Modified files:**
- `src/app.ts` — `app.register(mcpHostPlugin, { registry, makeAdapter, ... })` added to `buildApp`
- `src/config/env.ts` — `MCP_ENABLED=true/false` env flag (default true) to let the operator disable the MCP surface if not needed

---

### 2. MCP Client (router as consumer) — Integration Point

**Config lives in models.yaml (new top-level `mcp_servers:` section), NOT a separate file.**

Rationale: models.yaml is already the single source of truth for runtime configuration, has the hot-reload watcher, the Valkey-backed cache, and the zod parsing pipeline. Adding `mcp_servers:` as an optional top-level key is an additive schema change with zero impact on existing `models:` entries. A separate `mcp.yaml` would require a second watcher + hot-reload path + second Valkey cache key — unnecessary complexity.

```yaml
# models.yaml addition (sketch)
mcp_servers:
  - name: qdrant-retrieval
    url: http://qdrant-mcp:8080/mcp
    transport: http          # http | stdio
    auth: bearer             # none | bearer
    token_env: QDRANT_MCP_TOKEN
    capabilities: [retrieval]
    connect: lazy            # boot | first-use | lazy (per-request)
```

**Connection lifecycle — use lazy per-request for v0.11.0:**
- `boot` would block startup and fail fast on unavailable MCP servers — too brittle for an optional capability.
- `first-use` holds a persistent connection that needs reconnect logic.
- `lazy` (recommended): create a new `Client` + `StreamableHTTPClientTransport` per request, connect, call tool, disconnect. For a router under light-to-moderate load with infrequent MCP calls this is correct. Connection pooling is a v0.12+ concern.

**How the model sees MCP tools:**
Tools from connected MCP servers are injected into the `tools[]` field of the `CanonicalRequest` BEFORE the adapter call. The `CanonicalToolSchema` already supports arbitrary `input_schema` — no canonical type change needed. The MCP client handler lists tools from the server (`client.listTools()`), converts each to `CanonicalTool`, merges with any user-provided tools from the request body, and injects the merged set into the canonical before forwarding to the backend.

**Tool call resolution loop:**
```
CanonicalRequest (with injected MCP tools) → adapter → CanonicalResponse
  if response.content has tool_use blocks:
    for each tool_use block:
      if tool.name matches an MCP server tool:
        client.callTool(name, input) → result
        append CanonicalMessage(role:user, content:tool_result) to messages
    repeat adapter call with updated messages
  until no tool_use blocks OR max_iterations reached
```

This loop lives in a new `src/mcp/client/toolLoop.ts` helper called from the route handler, between the capability gate and the adapter call. It is NOT inside the adapter — adapters remain stateless per-call.

**New files:**
- `src/mcp/client/index.ts` — `McpClientRegistry` (loads mcp_servers from registry, creates clients on demand)
- `src/mcp/client/toolLoop.ts` — `runMcpToolLoop(canonical, adapter, mcpClients, signal)` → `CanonicalResponse`
- `src/mcp/client/transport.ts` — thin wrapper around `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`

**Modified files:**
- `src/config/registry.ts` — `RegistrySchema` gains optional `mcp_servers: z.array(McpServerEntrySchema).optional()`
- `src/routes/v1/chat-completions.ts` — inject MCP tool loop call between capability gate and adapter (only when `mcpClients` present and request `tools` not explicitly `none`)

---

### 3. /v1/responses Streaming + Tools — Integration Point

**Use the same architecture as chat-completions streaming: canonical stream → re-emit as Responses SSE events.**

The current non-stream `/v1/responses` calls `adapter.chatCompletionsCanonical()` via `responsesToCanonical()`. Streaming extension:
1. Call `adapter.chatCompletionsCanonicalStream()` instead (same stream pipeline already used by `/v1/chat/completions`).
2. Consume the `AsyncIterable<CanonicalStreamEvent>` and translate each event to Responses API SSE event format.
3. Emit via `reply.sse()` from `fastify-sse-v2` — same plugin already registered in `buildApp`.

**Responses API SSE event sequence (verified from OpenAI community guide, October 2025):**
```
response.created                (envelope opened)
response.in_progress            (model processing)
response.output_item.added      (new output item — message or tool_call)
response.content_part.added     (text content started)
response.output_text.delta      (streaming text chunks)
response.output_text.done       (text block finalized)
response.content_part.done      (content part done)
response.output_item.done       (output item finalized)
response.completed              (envelope closed, usage included)
```

**Mapping from existing CanonicalStreamEvent to Responses events:**
```
message_start        → response.created + response.in_progress
content_block_start  → response.output_item.added + response.content_part.added
content_block_delta  → response.output_text.delta
content_block_stop   → response.output_text.done + response.content_part.done + response.output_item.done
message_delta        → (captured for usage, emit at end)
message_stop         → response.completed (with usage from message_delta)
```

**Tool call events in Responses stream:**
When a `content_block_start` with `content_block.type = 'tool_use'` arrives:
- Emit `response.output_item.added` with `type: 'function_call'`
- `content_block_delta` with `type: 'input_json_delta'` → emit `response.function_call_arguments.delta`
- `content_block_stop` → emit `response.function_call_arguments.done` + `response.output_item.done`

**Failure mode when backend doesn't support all Responses events:**
Backends (Ollama, llama.cpp, vLLM) all speak the canonical stream format — the translator is the boundary. If the upstream stream terminates early or emits an error event, the translator catches it, emits `response.failed` with a structured error body, and closes the SSE stream. This mirrors how `canonicalToOpenAISse` currently handles abort + error cases. No new failure surface.

**New file:**
- `src/translation/responses-out.ts` — `canonicalToResponsesSse(events: AsyncIterable<CanonicalStreamEvent>): AsyncIterable<{event: string, data: string}>`

**Modified file:**
- `src/routes/v1/responses.ts` — add streaming branch: `if (body.stream === true)` → call stream path + `reply.sse(asyncIterable)` (remove the 400 stream-unsupported block from v0.10.0)

---

### 4. SessionStore — Integration Point

**New Postgres tables via Drizzle migration 0005, writes are SYNC per turn (not async-buffered).**

Schema:
```typescript
// src/db/schema/sessions.ts (NEW)
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),               // client-supplied or ULID generated
  agent_id: text('agent_id'),                // nullable — from X-Agent-Id
  tenant_id: text('tenant_id'),              // nullable — from X-Tenant-Id (v0.11.0)
  project_id: text('project_id'),            // nullable — from X-Project-Id
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),               // arbitrary client-supplied metadata
});

export const session_turns = pgTable('session_turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  session_id: text('session_id').notNull().references(() => sessions.id),
  turn_index: integer('turn_index').notNull(),  // monotonic ordering
  role: text('role').notNull(),                  // 'user' | 'assistant'
  content: jsonb('content').notNull(),           // CanonicalMessage['content']
  tokens: integer('tokens'),                     // nullable, populated by ContextProvider on load
  summary: text('summary'),                      // nullable, set by SummaryProvider
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Rationale for NOT extending `request_log`: `request_log` is an audit log with fixed columns. Sessions are mutable state. Mixing them creates a schema that can't be independently retained, purged, or migrated.

Rationale for SYNC writes per turn: session history must be committed BEFORE the response is sent — if the write fails, the session is inconsistent. Unlike `request_log` (observability, loss-ok), session turns are the truth. The existing buffered async pattern is explicitly wrong here.

**Migration 0005:** `sessions` + `session_turns` tables + indexes on `(session_id, turn_index)`.

**SessionStore invocation in request lifecycle:**
```
Route handler entry
  → if X-Session-Id present: SessionStore.loadSession(id) → CanonicalMessage[]
  → prepend to request.body.messages (before ContextProvider window trimming)
  → [call backend]
  → if response successful: SessionStore.appendTurn(sessionId, userMsg, assistantMsg)
  → reply.send
```

Position: inside the route handler, AFTER registry.resolve + capability gate, BEFORE breaker/semaphore. SessionStore failures → fail-open (log warn, proceed without history) to avoid blocking completions on a database hiccup.

**Interface definition:**
```typescript
// src/session/store.ts (NEW)
export interface SessionStore {
  loadSession(sessionId: string): Promise<CanonicalMessage[]>;
  appendTurn(sessionId: string, user: CanonicalMessage, assistant: CanonicalMessage): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
```

**New files:**
- `src/session/store.ts` — interface + `PostgresSessionStore` implementation
- `src/session/windowManager.ts` — token-window trimming (used by ContextProvider)
- `src/db/schema/sessions.ts` — Drizzle schema

**Modified files:**
- `src/routes/v1/chat-completions.ts` — add session load/append around adapter call
- `src/routes/v1/messages.ts` — same
- `src/app.ts` — `BuildAppOpts` gains optional `sessionStore?: SessionStore`

---

### 5. ContextProvider — Integration Point

**Position: inside route handler, AFTER SessionStore.loadSession, BEFORE breaker/semaphore.**

The ContextProvider's sole job is: given a request with potentially long message history, return a trimmed/windowed version that fits the model's context window. It is NOT responsible for retrieval, summarization, or semantic search.

```typescript
// src/context/provider.ts (NEW)
export interface ContextProvider {
  resolveContext(
    messages: CanonicalMessage[],
    opts: { modelEntry: ModelEntry; maxTokens?: number }
  ): Promise<CanonicalMessage[]>;
}
```

**Strategy selection:** Per-bearer default declared in `models.yaml` under the model entry. No per-request override in v0.11.0 (that is a policy engine concern, deferred). The model entry gains an optional `context_strategy: 'sliding_window' | 'summarize_oldest' | 'passthrough'` field — default `passthrough` (current behavior, zero change for existing routes).

**Integration in route handler:**
```
SessionStore.loadSession → full history
  → ContextProvider.resolveContext(full_history, { modelEntry, maxTokens })
  → trimmed messages used as canonical.messages
  → [breaker → semaphore → adapter]
```

If `context_strategy` is absent (model entry doesn't declare it), ContextProvider is a no-op (passthrough). This means existing routes are unaffected even after the ContextProvider is wired in.

**Modified files:**
- `src/config/registry.ts` — `ModelEntrySchema` gains `context_strategy: z.enum(['passthrough', 'sliding_window', 'summarize_oldest']).default('passthrough').optional()`
- `src/routes/v1/chat-completions.ts` — ContextProvider resolve call inserted after session load
- `src/routes/v1/messages.ts` — same
- `src/app.ts` — `BuildAppOpts` gains optional `contextProvider?: ContextProvider`

---

### 6. RetrieverProvider + Pre-Completion Hook — Integration Point

**Position: inside route handler, AFTER ContextProvider, BEFORE breaker/semaphore. Runs as a named hook in a hook chain.**

The hook receives the (post-context-window) `CanonicalRequest`, returns an enriched `CanonicalRequest` (with retrieved documents injected as additional user message content). It does NOT call the backend. It does NOT orchestrate retrieval internally — it calls an external retriever (typically via the MCP client) and injects the result.

```typescript
// src/hooks/preCompletion.ts (NEW)
export interface PreCompletionHook {
  name: string;
  execute(
    canonical: CanonicalRequest,
    opts: { modelEntry: ModelEntry; signal: AbortSignal }
  ): Promise<CanonicalRequest>;
  onError: 'fail-open' | 'fail-closed';  // per-hook config
}
```

**Hook configuration:** Declared per-model in `models.yaml`:
```yaml
models:
  - name: chat-local
    pre_completion_hooks:
      - name: qdrant-retrieval
        retriever_mcp_server: qdrant-retrieval   # references mcp_servers[].name
        top_k: 5
        on_error: fail-open
```

**MCP tool-driven retrieval vs pre-completion hook — coexistence rule:** If the model has MCP tools injected AND a pre-completion hook configured, the hook fires FIRST (pre-backend), injecting documents. The MCP tool-call loop fires AFTER the first adapter response, if the model decides to call tools. This prevents double-retrieval: the hook is for server-decided context injection (RAG); the tool loop is for model-decided tool invocation. The hook's `name` prefix allows it to skip if the request already contains retrieved content (indicated by a custom header `X-Context-Injected: true` that the hook stamps on the request context).

**Error handling:**
- `fail-open`: hook throws → log warn, proceed with original canonical, stamp `X-Hook-Error: <name>` on response
- `fail-closed`: hook throws → 502 upstream error, abort request

**New files:**
- `src/hooks/preCompletion.ts` — `PreCompletionHook` interface + `runHookChain()` function
- `src/hooks/mcpRetrieverHook.ts` — concrete hook implementation using MCP client

**Modified files:**
- `src/config/registry.ts` — `ModelEntrySchema` gains `pre_completion_hooks: z.array(HookConfigSchema).optional()`
- `src/routes/v1/chat-completions.ts` — hook chain inserted after ContextProvider, before breaker

---

### 7. SummaryProvider — Integration Point

**Position: called BY ContextProvider when token window is exceeded. Not a standalone route hook.**

```typescript
// src/context/summary.ts (NEW)
export interface SummaryProvider {
  summarize(turns: CanonicalMessage[]): Promise<string>;
}

// Default implementation — noop
export class NoopSummaryProvider implements SummaryProvider {
  async summarize(_turns: CanonicalMessage[]): Promise<string> {
    return '[summary omitted — no SummaryProvider configured]';
  }
}
```

**When called:** ContextProvider with `context_strategy: 'summarize_oldest'` holds a reference to SummaryProvider. When the message window exceeds `max_tokens`, oldest turns are passed to `SummaryProvider.summarize()`, the result is stored in `session_turns.summary` column, and the turn is replaced with a synthetic `{role:'user', content:'[Summary: ...]'}` message. The model sees the summary, not the raw history.

**Explicit trigger via API param:** `X-Summarize-Session: true` header → ContextProvider runs summarization immediately on all turns older than N (configurable per model entry). This is a v0.11.0 stretch goal, not required for MVP.

**Cron-based summarization:** Deferred to v0.12+. The seam is declared, the noop is the default.

**New files:**
- `src/context/summary.ts` — `SummaryProvider` interface + `NoopSummaryProvider`
- `src/context/provider.ts` — `ContextProvider` implementation holds `SummaryProvider` as dependency

---

### 8. EmbeddingProvider Interface — Integration Point

This is a **formalization of existing code**, not a new capability.

The existing `BackendAdapter.embeddings()` method already implements the semantic of an EmbeddingProvider. The v0.11.0 task is to:
1. Define a stable `EmbeddingProvider` interface in `src/embeddings/provider.ts` that matches the existing signature.
2. Make `BackendAdapter` extend `EmbeddingProvider` (or declare conformance explicitly).
3. Expose as an MCP tool via the MCP host plugin.

No schema changes, no new routes, no new DB tables.

**Modified files:**
- `src/embeddings/provider.ts` — NEW file, interface declaration only
- `src/backends/adapter.ts` — `BackendAdapter` gains `implements EmbeddingProvider` comment or explicit type intersection

---

### 9. Policy Primitives — Integration Point

**Policy primitives are PURELY ADDITIVE. They add checks to the existing pipeline without restructuring it.**

**Model allowlist per-bearer:**
```yaml
# New optional top-level section in models.yaml
policies:
  default:
    allowed_models: ["*"]           # wildcard = all (default behavior)
    cloud_allowed: true
    sensitive_routing: local_only   # none | local_only | local_preferred
```

For v0.11.0 with a single bearer token, policies are declared once in models.yaml under a `policies.default` key. The bearer hash is not in the key because there is only one bearer. This is architecturally preparatory for multi-tenant: the policy lookup by bearer hash is a v0.12+ drop-in, the schema supports it now.

**Pipeline position:** Policy gate inserted AFTER registry.resolve, AFTER capability gate, BEFORE breaker/semaphore:
```
registry.resolve(model) → entry
capability gate (existing)
[NEW] policy gate: policyStore.check(entry, requestContext)
  → if not allowed: 403 PolicyViolationError
  → if cloud not allowed + entry.backend === 'ollama-cloud': 403
  → if sensitive + entry.backend !== local: 400 SensitiveRoutingError
breaker → semaphore → adapter
```

**Cloud restriction implementation:** `cloud_allowed: false` in policy → any request resolving to `backend: ollama-cloud` returns 403 with structured error. Simple boolean check against `entry.backend`.

**Sensitive-workload routing:** Request includes header `X-Sensitive: true` → policy checks `policies.default.sensitive_routing`. If `local_only` and resolved backend is cloud → 400 with `sensitive_routing_violation` error code. If `local_preferred` and resolved backend is cloud → attempt re-resolve to local model first (if exists), fall through to cloud only if no local available.

**Tenant/project/agent IDs:**
- `X-Tenant-Id` header → validated regex `^[A-Za-z0-9._:-]{1,256}$` (same as X-Agent-Id) → `req.tenantId`
- `X-Project-Id` header → same validation → `req.projectId`
- Both stamped into: `request_log` (new columns in migration 0006), pino child log context, Prometheus metric labels on `router_request_total` and `router_request_duration_seconds`.

**Migration 0005 (sessions + session_turns) and Migration 0006 (tenant_id + project_id on request_log)** ship in the same milestone but as separate SQL files per the existing journal pattern.

**New files:**
- `src/policy/store.ts` — `PolicyStore` interface + `YamlPolicyStore` reading from registry
- `src/policy/errors.ts` — `PolicyViolationError`, `SensitiveRoutingError`
- `src/middleware/tenantId.ts` — X-Tenant-Id + X-Project-Id extraction (mirrors `agentId.ts`)

**Modified files:**
- `src/config/registry.ts` — `RegistrySchema` gains optional `policies: PolicyConfigSchema`
- `src/db/schema/request_log.ts` — add `tenant_id` + `project_id` columns (migration 0006)
- `src/routes/v1/chat-completions.ts` — policy gate inserted
- `src/routes/v1/messages.ts` — same
- `src/routes/v1/embeddings.ts` — same
- `src/routes/v1/rerank.ts` — same
- `src/routes/v1/responses.ts` — same
- `src/app.ts` — `BuildAppOpts` gains optional `policyStore?: PolicyStore`, `tenantIdPreHandler` added to hook chain
- `src/metrics/registry.ts` — add `tenant_id` and `project_id` label to relevant counters

---

## Full Request Pipeline (v0.11.0 — chat-completions, showing all new hooks)

```
POST /v1/chat/completions
  onRequest: t0 stamp
  onRequest: bearer auth (EXISTING)
  onRequest: rate-limit (EXISTING)
  preHandler: agentId (EXISTING)
  preHandler: tenantId + projectId (NEW — additive)
  Route handler:
    zod body parse (EXISTING)
    registry.resolve(model) (EXISTING)
    capability gate (EXISTING)
    [NEW] policy gate (allowlist, cloud, sensitive)
    [NEW] SessionStore.loadSession (if X-Session-Id present)
    [NEW] ContextProvider.resolveContext (if context_strategy declared)
    [NEW] pre-completion hook chain (if pre_completion_hooks declared)
    [NEW] MCP tool injection (inject MCP server tools into canonical.tools)
    breaker.check (EXISTING)
    semaphore.acquire (EXISTING)
    idempotency.acquire (EXISTING)
    adapter.chatCompletionsCanonical[Stream] (EXISTING)
    [NEW] MCP tool-call loop (if response contains tool_use blocks from MCP tools)
    [NEW] SessionStore.appendTurn (if session active)
    canonicalToOpenAIResponse / canonicalToOpenAISse (EXISTING)
    reply.send / reply.sse (EXISTING)
  onSend: X-Cost-Cents (EXISTING)
  finally: recordOutcome + bufferedWriter (EXISTING, extended with tenant/project IDs)
```

---

## New vs Modified File Summary

### NEW files (pure additions, no existing code touched)

```
src/mcp/
  host/
    index.ts          — McpServer instance + tool wire-up
    plugin.ts         — Fastify plugin registration
    tools/
      chat.ts         — MCP tool: chat completions
      embeddings.ts   — MCP tool: embeddings
      rerank.ts       — MCP tool: rerank
      responses.ts    — MCP tool: responses API
  client/
    index.ts          — McpClientRegistry (lazy connect)
    toolLoop.ts       — runMcpToolLoop helper
    transport.ts      — Client + StreamableHTTPClientTransport wrapper

src/session/
  store.ts            — SessionStore interface + PostgresSessionStore
  windowManager.ts    — token-window trimming utility

src/context/
  provider.ts         — ContextProvider interface + implementation
  summary.ts          — SummaryProvider interface + NoopSummaryProvider

src/hooks/
  preCompletion.ts    — PreCompletionHook interface + runHookChain
  mcpRetrieverHook.ts — concrete MCP-based retriever hook

src/policy/
  store.ts            — PolicyStore interface + YamlPolicyStore
  errors.ts           — PolicyViolationError, SensitiveRoutingError

src/embeddings/
  provider.ts         — EmbeddingProvider interface (formalization only)

src/middleware/
  tenantId.ts         — X-Tenant-Id + X-Project-Id preHandler

src/translation/
  responses-out.ts    — canonicalToResponsesSse translator

src/db/schema/
  sessions.ts         — Drizzle schema for sessions + session_turns
```

### MODIFIED files (extend, never break existing contract)

```
src/app.ts                           — new opts fields (all optional), new hooks, MCP plugin register
src/backends/adapter.ts              — EmbeddingProvider conformance annotation (no sig change)
src/config/registry.ts               — RegistrySchema: mcp_servers?, policies?, context_strategy?, pre_completion_hooks?
src/config/env.ts                    — MCP_ENABLED flag
src/db/schema/request_log.ts        — tenant_id + project_id columns (via migration 0006)
src/metrics/registry.ts              — tenant_id, project_id labels
src/middleware/agentId.ts            — no change (tenantId.ts is a separate hook)
src/routes/v1/chat-completions.ts   — policy gate + session + context + hooks + MCP tools inserted
src/routes/v1/messages.ts           — same insertions
src/routes/v1/embeddings.ts         — policy gate only
src/routes/v1/rerank.ts             — policy gate only
src/routes/v1/responses.ts          — streaming branch added + policy gate
```

### NEW Drizzle migrations

```
src/db/migrations/
  0005_sessions.sql                  — CREATE TABLE sessions + session_turns
  0006_request_log_tenant_project.sql — ALTER TABLE request_log ADD COLUMN tenant_id, project_id
```

---

## Build Order (with dependency rationale)

**Phase 14: Policy Primitives + Tenant/Agent IDs**
- Pure additive. No other v0.11.0 feature works correctly without tenant IDs in the log.
- `tenantId.ts` preHandler, `PolicyStore` + policy gate, migration 0006, Prometheus label extensions.
- No new dependencies introduced.
- All existing tests continue to pass — policy gate defaults to allow-all with no config.

**Phase 15: MCP Host (router as server)**
- Depends on: Phase 14 (policy gate already in place for tool-exposure control by tenant).
- New: MCP plugin + tool handlers calling existing adapters directly (no new adapter code).
- Adds: `mcp_enabled` env flag, `/mcp` endpoint with bearer-auth inherited from app-level hook.
- Test: MCP client (Claude Desktop or `@modelcontextprotocol/sdk` Client) can call chat/embeddings tools.

**Phase 16: /v1/responses Streaming + Tools**
- Depends on: Phase 14 (policy gate), Phase 15 (for MCP-tool tool-call pattern reference).
- New: `responses-out.ts` translator, streaming branch in `responses.ts`, tool-call handling.
- Closes the v0.10.0 streaming debt. Uses the SAME `fastify-sse-v2` + canonical stream pattern as chat-completions.

**Phase 17: SessionStore + ContextProvider + SummaryProvider**
- Depends on: Phase 14 (tenant_id available for session attribution), Phase 16 (responses route done before adding session to it).
- New: migration 0005, `store.ts`, `provider.ts`, `summary.ts`, `windowManager.ts`.
- Insert session load/append into chat-completions + messages + responses routes.
- `SummaryProvider` ships as noop-default.

**Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook**
- Depends on: Phase 15 (MCP host exists as reference), Phase 17 (session + context done, hooks have full canonical to work with).
- New: `McpClientRegistry`, `toolLoop.ts`, `PreCompletionHook`, `mcpRetrieverHook.ts`.
- Registry schema gains `mcp_servers:` + `pre_completion_hooks:`.
- MCP tool injection + tool-call loop wired into chat-completions.

**Phase 19: EmbeddingProvider Formalization + Observability Hardening**
- Depends on: Phase 18 (all new surfaces exist and need metrics coverage).
- Formalize `EmbeddingProvider` interface. Add MCP tool metrics, hook metrics, session metrics, policy metrics to Prometheus. Update Grafana dashboard. Smoke test all new surfaces end-to-end.

---

## Architecture Risks to Existing Flows

### Risk 1: MCP plugin SSE conflicts with fastify-sse-v2
**Assessment:** LOW risk. The MCP plugin uses `reply.raw.write()` on `/mcp` routes; `fastify-sse-v2` uses `reply.sse()` on `/v1/*` routes. Route prefixes are disjoint. Confirm with integration test: start MCP client + concurrent `/v1/chat/completions` stream, verify both complete correctly.

### Risk 2: Pre-completion hook latency on critical path
**Assessment:** HIGH operational risk. The hook is synchronous in the request pipeline. A slow retriever MCP server (e.g., Qdrant taking 2s) adds 2s to every request with that hook configured. Mitigation: per-hook timeout (default 5s), fail-open by default so a stuck retriever does not block completions. Clearly documented in PITFALLS.

### Risk 3: SessionStore sync writes blocking replies
**Assessment:** MEDIUM risk. `await sessionStore.appendTurn()` is on the critical path BEFORE `reply.send()`. If Postgres is slow, it delays the response. Mitigation: per-call timeout (1000ms), fail-open on timeout — log warn, send reply anyway. The session turn is lost on timeout (acceptable: better to respond than to wait). This differs from the bufferedWriter (which is explicitly async) — session turns must be durable-before-response but with a bounded wait.

### Risk 4: MCP tool-call loop infinite loop / runaway cost
**Assessment:** HIGH architectural risk. A model that always emits tool_use blocks will loop forever. Mitigation: hard `MAX_MCP_TOOL_ITERATIONS = 5` cap in `toolLoop.ts`, fail with structured 500 on cap exceeded. Declated in env as `MCP_MAX_TOOL_ITERATIONS` (default 5).

### Risk 5: CanonicalRequest.tools injection overwriting user-supplied tools
**Assessment:** MEDIUM. If the client sends `tools: [...]` AND the model has MCP tools configured, the merge must preserve client tools as higher priority (client-declared tools are explicit intent). MCP tools are appended after client tools, not prepended. If a name collision exists, client tool wins. Documented in the tool merge function.

### Risk 6: Responses streaming route removing the 400 for stream:true
**Assessment:** LOW. The v0.10.0 400 was explicitly documented as "deferred to v0.11+". Removing it is the intended change. Existing callers that relied on the 400 to detect "streaming not supported" need to be updated — but the only known caller is n8n, which already handles streaming via `/v1/chat/completions`.

### Risk 7: migration 0005+0006 journal ordering
**Assessment:** LOW if the existing journal pattern is followed exactly. The `_journal.json` must receive entries for 0005 and 0006 in the correct order. Breaking the journal ordering causes Drizzle's migrator to silently skip entries (known pitfall from v0.10.0 MEMORY.md). Always generate both the SQL and journal entries together as an indivisible unit.

### Risk 8: MCP consumer lock-in to TS/Node transport assumption
**Assessment:** LOW for v0.11.0, but worth noting. The MCP Streamable HTTP transport (POST/GET/DELETE on `/mcp`) is fully language-agnostic — any MCP client speaks it. stdio is NOT implemented (the router is a server, not a subprocess). If a future Python consumer wants to connect as a client, it uses the same `/mcp` HTTP endpoint. No lock-in.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Retrieval logic inside the router
**What:** Implementing vector search, embedding generation for queries, or knowledge-graph traversal directly in the router's hook or context provider.
**Why bad:** Violates the "Retrieval Interfaces, not Retrieval Logic" strategic frame. Makes the router responsible for knowledge correctness, schema evolution, and external service contracts it cannot own.
**Instead:** The hook calls an external MCP server that owns the retrieval logic. The router provides context (query text, top_k, filters) and receives documents. It injects documents as message content and does nothing else.

### Anti-Pattern 2: Persistent MCP client connections at boot
**What:** Opening MCP client connections to all `mcp_servers` during `buildApp()` and holding them for the process lifetime.
**Why bad:** Blocks boot on unavailable external servers, requires reconnect logic, holds TCP connections that may timeout silently.
**Instead:** Lazy per-request connections for v0.11.0. A session-scoped connection pool is a v0.12+ optimization once the connection overhead is measured as a real bottleneck.

### Anti-Pattern 3: SessionStore as async-buffered writes
**What:** Using `bufferedWriter.push()` for session turns (fire-and-forget, no durability guarantee).
**Why bad:** If the process crashes after a response is sent but before the buffer flushes, the session turn is lost. The next request in the session loads incomplete history, leading to confused model behavior.
**Instead:** Sync `await db.insert(session_turns)` with a 1s timeout and fail-open. Durability is required; bounded latency is the constraint, not zero latency.

### Anti-Pattern 4: Policy gate AFTER breaker
**What:** Running the policy check after `breaker.check()` — i.e., counting a policy violation as a backend failure.
**Why bad:** Circuit breaker trip counts should reflect backend health, not client policy violations. A misconfigured client that hits a policy wall will trip the breaker against a healthy backend.
**Instead:** Policy gate runs before breaker, same as capability gate. Policy violation → 403, breaker not consulted, no failure recorded against the backend.

### Anti-Pattern 5: Exposing backend-specific retriever params in RetrieverProvider
**What:** Defining `RetrieverProvider.retrieve(query, { qdrantCollectionName, pineconeNamespace })`.
**Why bad:** Leaks Qdrant/Pinecone-specific knowledge into the router's interface layer. If the retriever changes, the interface must change, breaking all callers.
**Instead:** Hook payload uses generic fields: `{ query: string, top_k: number, filters?: Record<string, unknown>, hybrid?: boolean }`. The MCP server translates generic fields to backend-specific params. The router has zero awareness of what vector store is behind the MCP server.

---

## Sources

- Live code inspection: `router/src/app.ts`, `router/src/backends/adapter.ts`, `router/src/routes/v1/responses.ts`, `router/src/translation/canonical.ts`, `router/src/db/schema/request_log.ts`, `router/src/config/registry.ts` — **HIGH confidence**
- MCP Streamable HTTP transport spec: https://modelcontextprotocol.io/docs/concepts/transports — **HIGH confidence** (official spec, verified 2026-05-29)
- `haroldadmin/fastify-mcp` v3.0.0 (2026-05-12): mounts at configurable path, same-port, Streamable HTTP + legacy HTTP+SSE support — **MEDIUM confidence** (GitHub README, not verified with local test)
- `@modelcontextprotocol/sdk` `NodeStreamableHTTPServerTransport`: `handleRequest(req, opts?)`, stateful/stateless modes, POST+GET+DELETE on single endpoint — **HIGH confidence** (DeepWiki + official docs)
- OpenAI Responses API SSE event sequence: `response.created → response.output_item.added → response.output_text.delta → response.completed` — **MEDIUM confidence** (community guide, consistent with official reference)
- OpenAI Responses API tool call events: `function_call_arguments.delta/done` pattern — **MEDIUM confidence** (community guide)
- Drizzle ORM schema pattern for sessions/turns: standard `pgTable` with `references()` FK — **HIGH confidence** (Drizzle official docs pattern)
- Fastify v5 hook ordering (onRequest → preHandler → route handler → onSend): verified from live code in `app.ts` — **HIGH confidence**

---
*Architecture research for: local-llms v0.11.0 Retrieval-Ready Infrastructure*
*Researched: 2026-05-29*
