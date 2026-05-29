# Feature Research

**Domain:** v0.11.0 Retrieval-Ready Infrastructure — Fastify/TypeScript LLM router adding MCP, /v1/responses streaming, five provider interfaces, and slim policy primitives
**Researched:** 2026-05-29
**Confidence:** HIGH (MCP spec, OpenAI Responses API wire format, LiteLLM/OpenRouter patterns verified via official sources; interface shapes derived from production implementations)

---

## Research Answers by Question

### 1. MCP Server Mode (Host) — Exposing Router Capabilities as MCP Tools

**What it means.** The router becomes an MCP server. MCP clients (Claude Desktop, n8n MCP node, AI SDK agents, Cursor) connect to it and discover router capabilities — chat completions, embeddings, rerank, responses — as model-controlled tools. The router is already a gateway; adding MCP server mode makes it consumable via the protocol that agent frameworks are standardizing on.

**Tool manifest shape (per MCP spec 2025-11-25).** Each exposed capability becomes a JSON-RPC `tools/list` entry:

```jsonc
// tools/list response — one entry per capability
{
  "name": "chat_completion",           // SHOULD be 1-128 chars, [a-zA-Z0-9_\-.] only
  "title": "Chat Completion",          // human-readable display name
  "description": "Send a chat prompt to any model registered in models.yaml …",
  "inputSchema": {                     // JSON Schema 2020-12 (default when no $schema)
    "type": "object",
    "properties": {
      "model":    { "type": "string", "description": "Model alias from registry, e.g. chat-local" },
      "messages": { "type": "array",  "items": { "$ref": "#/$defs/Message" } },
      "stream":   { "type": "boolean", "default": false },
      "temperature": { "type": "number" },
      "max_tokens":  { "type": "integer" }
    },
    "required": ["model", "messages"]
  },
  "outputSchema": {                    // optional but recommended for structured results
    "type": "object",
    "properties": {
      "content": { "type": "string" },
      "model":   { "type": "string" },
      "usage":   { "type": "object" }
    }
  }
}
```

Minimum four tools to expose: `chat_completion`, `create_embedding`, `rerank`, `create_response`. The `list_models` tool (wrapping `GET /v1/models`) is a low-cost addition that MCP clients find very useful for dynamic model selection.

**Discovery.** MCP clients call `tools/list` (JSON-RPC 2.0 over Streamable HTTP POST to `/mcp`). Tools are returned in a flat array; clients cache them and call `tools/call` with `{ name, arguments }`.

**Transport recommendation.** Streamable HTTP (spec 2025-03-26 and 2025-11-25) is the production transport. Single endpoint (`/mcp`), POST for client-to-server messages, GET for server-to-client SSE (streaming tool results). The older SSE-only transport (`/sse` + `/messages`) was deprecated in March 2025 — implement Streamable HTTP as primary, SSE-only as optional backward compat.

**Auth conventions.**
- Bearer token via `Authorization: Bearer <token>`: passes the same token already in `.env`, zero new surface. This is the right choice for single-user same-bearer-token operation (HIGH confidence — verified against MCP spec and LLM Gateway implementation).
- OAuth 2.1 / PKCE: defined in MCP spec as the enterprise path; required if MCP clients connect from untrusted contexts. For v0.11.0 single-user, skip OAuth; design the auth hook so it is swappable later.
- The Streamable HTTP spec allows per-request `Authorization` headers on every envelope, unlike the old SSE transport that required session establishment. Use this.

**Implementation package.** `@modelcontextprotocol/sdk` (npm, version ≥ 1.x) provides `McpServer` and `StreamableHTTPServerTransport`. Register tools with `server.registerTool(name, { description, inputSchema }, handlerFn)`. Each handler calls the router's existing service layer (the same path that `/v1/chat/completions` uses) and returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

**Fastify integration.** Mount the MCP transport at `/mcp` as a Fastify route that calls `transport.handleRequest(req, reply)`. The transport is stateless for non-session mode (pass `sessionIdGenerator: undefined`). This means no session state is needed at the MCP layer — the router's existing auth + rate-limit hooks fire before the MCP handler.

---

### 2. MCP Client Mode — Consuming External MCP Servers

**Production router pattern.** The router acts as an MCP client when a completion request declares it wants tools from an external MCP server. The router fetches `tools/list` from the external server, transforms the tool definitions into OpenAI-format function call schemas, injects them into the `tools[]` array of the upstream request, and proxies `tools/call` invocations back to the external server when the model returns a tool-use response.

**Config shape.** Declare in `models.yaml` (or a sibling `mcp-clients.yaml`) as a static registry:

```yaml
mcp_clients:
  my_rag_server:
    url: "http://rag-service:8080/mcp"
    transport: "http"                   # http | sse | stdio
    auth_type: "bearer"                 # bearer | api_key | none
    auth_value: "${RAG_MCP_TOKEN}"      # env-var reference
    tool_filter: ["search_docs", "get_chunk"]  # optional allowlist of tool names
    timeout_ms: 5000
  local_file_server:
    url: "stdio"
    command: ["node", "/opt/mcp-files/index.js"]
    transport: "stdio"
    auth_type: "none"
```

- Declare servers statically in config; do NOT auto-discover from the network (security boundary).
- Per-tenant or per-agent server selection can be expressed via request header `X-MCP-Client: my_rag_server` or via the model's declared `mcp_clients[]` list in `models.yaml`.

**Tool injection into model request.** When a client request includes `mcp_clients: ["my_rag_server"]` (extension field, ignored by dumb proxies) or the model registry declares `default_mcp_clients`, the router:

1. Connects to the declared MCP server (lazy, on first use).
2. Calls `tools/list`; optionally caches the result (controlled by `cacheToolsList: true` — reduces latency on subsequent calls in the same session).
3. Transforms MCP tool schemas → OpenAI function call schemas.
4. Appends them to `tools[]` before forwarding to the backend.
5. If the backend returns a `tool_calls[]` response, for each tool call that belongs to an MCP tool, the router calls `tools/call` on the MCP server and injects the result as a `tool` role message.
6. Loops until no more MCP tool calls (with a max-iterations guard, e.g. 10).

**Per-tenant MCP servers.** Defer full per-tenant server config for v0.11.0; use a global registry with optional per-request override via header. The tenant/project/agent IDs are written to `request_log` regardless.

**Lifecycle.** Lazy connection on first use (do NOT eager-connect at boot — MCP servers may be unavailable, and startup should not block). Use `try/finally` or `onFinish` to close connections. For persistent high-traffic connections, a pool with TTL is a v2 concern.

**Implementation package.** `@modelcontextprotocol/sdk` provides `Client` (MCP client) + `StreamableHTTPClientTransport` / `SSEClientTransport`. The AI SDK (`ai` npm package) provides `createMCPClient()` as a higher-level wrapper if you want schema auto-inference. For the router's own implementation, use the MCP SDK directly since you need precise control over the tool-injection lifecycle.

---

### 3. /v1/responses Streaming + Tools — Canonical Wire Shape

**What v0.10.0 Phase 13 delivered.** Non-streaming `/v1/responses` with `{ model, input, instructions?, temperature?, max_output_tokens? }` → `{ id, object: "response", output: [{type: "message", role: "assistant", content: [{type: "output_text", text}]}], usage }`. Streaming was deferred with a structured 400.

**Full streaming event sequence (authoritative, from OpenAI community guide).** Events are SSE with `data: { "type": "...", ... }`. The canonical sequence for a simple text response:

```
response.created           → { id, object: "response", status: "in_progress", ... }
response.in_progress       → (status update)
response.output_item.added → { output_index: 0, item: { type: "message", ... } }
response.content_part.added→ { item_id, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }
response.output_text.delta → { item_id, output_index: 0, content_index: 0, delta: "In" }   (repeats N times)
response.output_text.done  → { item_id, output_index: 0, content_index: 0, text: "In full..." }
response.content_part.done → (part finalization)
response.output_item.done  → (item finalization)
response.completed         → { response: { id, status: "completed", usage: { input_tokens, output_tokens } } }
```

**Tool call event sequence** (when a tool fires within a streaming response):

```
response.output_item.added            → item type = "function_call"
response.function_call_arguments.delta → { item_id, output_index, delta: '{ "arg":' }  (N times)
response.function_call_arguments.done  → { item_id, output_index, arguments: '{ "arg": "val" }' }
response.output_item.done             → (function_call item finalized)
```

After the model yields function_call items, the streaming response pauses. The client must submit tool results via a new request with `previous_response_id` or via the Responses API continuation. The router's implementation should yield `response.completed` with `status: "requires_action"` when tools fire, matching the Responses API contract.

**Key events to emit for v0.11.0 streaming implementation:**

| Event | Required | Notes |
|-------|----------|-------|
| `response.created` | YES | First event, contains response ID |
| `response.in_progress` | YES | Status update |
| `response.output_item.added` | YES | One per output item |
| `response.content_part.added` | YES | One per content block |
| `response.output_text.delta` | YES | One per chunk from backend SSE |
| `response.output_text.done` | YES | Final accumulated text |
| `response.content_part.done` | YES | Part finalization |
| `response.output_item.done` | YES | Item finalization |
| `response.completed` | YES | With usage; `status: "completed"` or `"requires_action"` |
| `response.function_call_arguments.delta` | YES (if tools used) | Stream tool arg deltas |
| `response.function_call_arguments.done` | YES (if tools used) | Final args |
| `error` | YES | Transport-level errors |
| `response.failed` | YES | Generation-level failures |

**How it differs from `/v1/chat/completions` streaming.** Chat completions emit `chat.completion.chunk` events with a flat `delta.content` string. Responses API uses semantic event names (`response.output_text.delta`), has an explicit item/content-part hierarchy, carries `sequence_number`, and includes built-in tool lifecycle events. The router must translate the upstream `chat.completion.chunk` SSE stream into the Responses API event shape — a transformer, not a passthrough.

**Implementation.** Reuse the backend adapter's streaming path. Add a `ResponsesStreamTransformer` that consumes `AsyncIterable<ChatCompletionChunk>` and emits `AsyncIterable<ResponsesStreamEvent>`. Mount via `fastify-sse-v2` reply.sse() the same as chat/messages routes.

---

### 4. SessionStore Patterns — Canonical Interface

**Operations that matter.**

```typescript
interface SessionStore {
  // Create a new session; returns opaque session_id
  createSession(metadata: SessionMetadata): Promise<string>;

  // Append one turn; returns stable turn_id; ordering guaranteed by insertion
  appendTurn(
    sessionId: string,
    role: "user" | "assistant" | "system" | "tool",
    content: string | ContentBlock[],
    meta?: TurnMeta            // model, tokens_in, tokens_out, latency_ms, tool_call_id
  ): Promise<string>;          // turn_id

  // Load history; newest first by default; limit controls how many turns to return
  loadHistory(
    sessionId: string,
    opts?: { limit?: number; before_turn_id?: string }
  ): Promise<Turn[]>;

  // Soft or hard delete
  deleteSession(sessionId: string): Promise<void>;

  // List sessions for a tenant/agent (used by management UI, not hot path)
  listSessions(filter: { tenant_id?: string; agent_id?: string }, cursor?: string): Promise<{ sessions: SessionSummary[]; next_cursor?: string }>;

  // Optional: replace all turns with a compacted version after summarization
  replaceTurns(sessionId: string, turns: Turn[]): Promise<void>;
}

interface SessionMetadata {
  tenant_id?: string;
  agent_id?: string;
  project_id?: string;
  model: string;
  created_at?: Date;           // defaults to now()
  ttl_seconds?: number;        // optional expiry; null = permanent
}

interface Turn {
  turn_id: string;             // uuid
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentBlock[];
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  tool_call_id?: string;
  created_at: Date;
}
```

**Persistence guarantees.** The Postgres-backed default implementation provides durable ordered writes (insertion order = turn order, enforced by `created_at` + `serial` tiebreak). Ordering is critical — LLMs are sensitive to message order. Postgres serial columns or `INSERT ... RETURNING` give reliable ordering without gaps.

**Metadata.**  `tenant_id`, `agent_id`, `project_id` are strings (nullable); they flow into `request_log` as foreign keys (or denormalized columns in v0.11.0). `model` is required — needed to compute context limits in ContextProvider.

**Default implementation.** Postgres-backed (already present as the `pg` + Drizzle stack). Interface allows swap to Redis/Valkey-backed for hot short-lived sessions in v2.

---

### 5. ContextProvider Patterns — Context Window Management

**Interface.**

```typescript
interface ContextProvider {
  // Given a session and an incoming user message, return the messages[] array
  // that should be sent to the model — already within the model's context limit.
  buildContext(
    session: SessionHandle,
    incomingMessage: IncomingMessage,
    opts?: ContextBuildOpts
  ): Promise<ContextResult>;
}

interface ContextBuildOpts {
  model: string;               // used to look up ctx_size from registry
  max_tokens_reserve?: number; // tokens to reserve for model output (default: 2048)
  strategy?: "truncate" | "sliding-window" | "summarize-hook";
  systemPrompt?: string;       // prepended before history
}

interface ContextResult {
  messages: Message[];         // ready to pass to chat completions backend
  truncated: boolean;          // true if history was cut
  turns_included: number;
  estimated_tokens: number;
}
```

**Strategies.**
- `truncate`: Drop oldest turns first. Cheapest. Loses early context. Default.
- `sliding-window`: Keep last N turns (by count). Simple, predictable. Good for most agents.
- `summarize-hook`: When history exceeds `ctx_size - max_tokens_reserve`, call `SummaryProvider.summarize()` on the oldest segment, replace those turns with a synthetic `system` turn containing the summary, then continue. The ContextProvider does NOT implement summarization itself — it calls the seam.

**Model-awareness.** The registry (`models.yaml`) declares `ctx_size` per model. ContextProvider reads `ctx_size` from the registry when building context, using it to enforce the window. The router already has the registry in memory; ContextProvider receives it as a constructor dependency.

**Interaction with SessionStore.** ContextProvider calls `SessionStore.loadHistory()` to get turns, then applies the strategy, then optionally calls `SessionStore.replaceTurns()` if a summarization compaction occurred.

**Token estimation.** Use a fast approximation (4 chars ≈ 1 token for English, or use `tiktoken-lite` if precise counting is needed). Exact counting via `/v1/messages/count_tokens` (already built) is an option for Anthropic surface — too slow for hot path; use for deferred summarization trigger only.

---

### 6. RetrieverProvider Patterns — Generic Transport-Agnostic Interface

**Interface.**

```typescript
interface RetrieverProvider {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

interface RetrievalRequest {
  query: string;
  top_k?: number;              // default: 5
  filters?: Record<string, unknown>;  // metadata filters; provider interprets
  hybrid_flags?: {
    alpha?: number;            // 0.0 = pure BM25 / 1.0 = pure vector (provider interprets)
  };
  metadata?: Record<string, unknown>; // arbitrary pass-through context for the provider
}

interface RetrievalResult {
  documents: RetrievedDocument[];
  latency_ms?: number;
}

interface RetrievedDocument {
  id: string;
  content: string;
  score: number;               // 0.0–1.0; provider normalizes
  metadata?: Record<string, unknown>;  // source, chunk_index, created_at, etc.
  source?: string;             // URI or label (e.g., "s3://bucket/doc.pdf#page=3")
}
```

**Why transport-agnostic.** The router does NOT implement a specific vector DB or retrieval strategy. The interface is a seam. A downstream consumer registers a `RetrieverProvider` implementation (e.g., a Weaviate client, a Qdrant client, or an MCP-tool-based retriever) without the router knowing the transport.

**Two invocation paths.**

1. **Pre-completion hook**: Router calls `retrieverProvider.retrieve()` automatically before forwarding to the model. Retrieval result is appended as a `system` message or injected into `messages[]`. The caller does not control when retrieval fires — it fires on every request.

2. **MCP tool invocation**: The model decides when to call retrieval by invoking an MCP tool (`search_docs`). The router proxies the `tools/call` to the registered MCP server. The model receives the result as a tool result turn and continues generation. The caller controls retrieval timing implicitly via the model's reasoning.

---

### 7. SummaryProvider Seam — Minimal Interface

**Interface.**

```typescript
interface SummaryProvider {
  // Summarize a segment of conversation turns into a compact representation.
  // Router calls this; implementation decides HOW to summarize (model, prompt, strategy).
  summarize(turns: Turn[], opts?: SummaryOpts): Promise<SummaryResult>;
}

interface SummaryOpts {
  max_summary_tokens?: number;   // target size of the summary
  hint?: string;                 // optional caller hint about focus
}

interface SummaryResult {
  summary: string;               // the compact text
  tokens_estimated?: number;
}
```

**Noop default.** The router ships with `NoopSummaryProvider` that returns `{ summary: "" }` and never calls a model. ContextProvider falls back to `truncate` when the summary is empty. Downstream registers a real implementation.

**Triggers (what the router knows).** The router triggers `summarize` when `ContextProvider` strategy is `"summarize-hook"` AND `estimated_tokens > ctx_size - max_tokens_reserve`. The router does NOT trigger summarization automatically on a schedule, on turn count thresholds only, or in background. Trigger = ContextProvider calls it synchronously as part of `buildContext`.

**What the router does NOT decide.** Which model to use for summarization, what prompt template to use, whether to use extractive vs abstractive summary, whether to summarize incrementally or in batch. All of that is the implementation's concern.

---

### 8. EmbeddingProvider as Named Interface

**What it buys.** The `/v1/embeddings` route already exists (v0.10.0 Phase 12 with Valkey cache + dims enforcement). Promoting it to a named `EmbeddingProvider` interface does two things:

1. Makes the router's embedding capability discoverable and swappable by downstream without touching the route handler.
2. Allows `RetrieverProvider` implementations to call the router's own embedding capability via a typed dependency (instead of HTTP round-trip back to self).

**Interface.**

```typescript
interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts?: EmbedOpts
  ): Promise<EmbeddingResult>;
}

interface EmbedOpts {
  model?: string;              // override registry default embedding model
  dimensions?: number;         // override registry dims
  encoding_format?: "float" | "base64";
}

interface EmbeddingResult {
  embeddings: number[][];      // one vector per input string
  model: string;               // actual model used
  dims: number;
  usage: { prompt_tokens: number; total_tokens: number };
}
```

**Naming convention.** Use `Provider` suffix for all five interfaces (`SessionStore` is the exception — it follows the storage-object convention). The pattern is: `interface XxxProvider` for capability seams, `interface XxxStore` for persistence-oriented stores. This matches LangChain/LlamaIndex conventions and avoids the "Adapter" vs "Strategy" ambiguity (`Provider` = "I provide this capability", not "I adapt this API" or "I embody this algorithm").

**Existing implementation.** The `BackendAdapter` class that handles `/v1/embeddings` already IS an `EmbeddingProvider`; the milestone adds the interface declaration and wires it as a Fastify decorator dependency (`fastify.decorate('embeddingProvider', adapter)`).

---

### 9. Policy Primitives — Slim, Not a Policy Engine

**Model allowlists (per-bearer / global).** Production gateways (LiteLLM, OpenRouter) implement allowlists at the virtual-key level: each key has an optional `models: string[]`; requests to non-listed models are rejected with 403. For the single-bearer v0.11.0 router, implement a global `model_allowlist: string[]` in `models.yaml` (or the env). Empty = allow all. The per-bearer level is the v2 concern when multiple keys are added.

```yaml
# models.yaml addition
policy:
  model_allowlist: []           # empty = allow all; non-empty = only these aliases
  cloud_allowed: true           # false = block any request routed to backend: ollama-cloud
```

**Cloud restriction (`cloud_allowed: false`).** Flag lives in the `policy` stanza of `models.yaml`. The router checks it at request-routing time (when resolving backend for the requested model). If the resolved backend is `ollama-cloud` and `cloud_allowed: false`, the router returns 403 with `{ error: { code: "cloud_disabled", message: "..." } }`. This is a REGISTRY check, not a content classifier or a request header — explicit and auditable.

**Sensitive-workload routing trigger.** The router does NOT classify content to decide routing. Trigger is explicit: client sends `X-Workload-Class: sensitive` header (or `workload_class: sensitive` in request body metadata). Router uses this hint to apply policy (e.g., block cloud models). This preserves the "no smart routing" principle while giving clients a way to declare intent.

**Tenant/project/agent IDs in tracing.** Extracted from request headers (`X-Tenant-ID`, `X-Agent-ID`, `X-Project-ID`) or from the request body's `metadata` field if present. Written to `request_log` columns. Used for `cost_per_agent_daily` view extension (already has `agent_id`; add `tenant_id` and `project_id` columns in a new migration). NOT used for access control in v0.11.0 — only for observability.

**What does NOT belong in policy primitives for v0.11.0:**
- Per-tenant model allowlists (requires multi-key auth — deferred)
- Budget enforcement per tenant (requires policy DB table — deferred)
- Rate-limit per tenant (current rate-limit is per-bearer — deferred)
- Content classifiers to auto-route (architectural anti-pattern)
- Full RBAC (v2+)

---

### 10. Pre-completion Hook vs MCP-Tool Retrieval — When Each Wins

**Pre-completion hook shines when:**
- The client is a dumb caller (e.g., n8n `Basic LLM Chain` node) that cannot handle tool-call loops.
- Retrieval should be transparent to the model and client (augmentation, not orchestration).
- Every request to a given model/route should always retrieve context (e.g., "always inject user profile docs for agent X").
- Latency is the priority (one retrieval call per request, no round-trip to model for tool decision).
- Use case: search grounding, always-on RAG, mandatory context injection.

**MCP-tool retrieval shines when:**
- The model decides WHEN and WHAT to retrieve (adaptive retrieval).
- Multi-step retrieval is needed (retrieve → refine query → retrieve again).
- The client is an agent framework that handles tool-call loops (n8n AI Agent node, Claude, OpenAI Agents SDK).
- Different queries in the same session may need different retrieval strategies.
- Transparency is desired — the model's tool calls are visible in the conversation trace.
- Use case: question answering over a large corpus, agentic research tasks.

**Design principle.** The router supports BOTH seams. Pre-completion hook = `RetrieverProvider` registered on the route as middleware. MCP tool = `tools/call` proxy to an external MCP server. They are not mutually exclusive; an agent can register both (hook for mandatory context, MCP tool for optional deep dives). The router does NOT orchestrate between them.

---

## Feature Landscape

### Table Stakes (Must-Have for v0.11.0)

Features required for the milestone to meet its stated goal of "retrieval-ready infrastructure." Missing any of these leaves the milestone incomplete by the architectural frame.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| MCP server (host) — Streamable HTTP at `/mcp` | Agent frameworks (n8n, Claude Desktop, Cursor) standardizing on MCP; without this the router is invisible to next-gen agents | HIGH | `@modelcontextprotocol/sdk`; mount in Fastify; expose `chat_completion`, `create_embedding`, `rerank`, `create_response`, `list_models` as tools; reuse existing service layer |
| MCP server bearer auth | Already in place for HTTP surface; MCP clients need the same bearer token contract | LOW | Pass bearer from `Authorization` header through existing `onRequest` hook; MCP transport sits behind same auth guard |
| MCP client — config-driven external server consumption | P1 in project plan; n8n AI Agent node can already call MCP tools; the router needs to be the bridge | HIGH | `mcp-clients.yaml` or `models.yaml` extension; lazy connect; tools/list cache; tool-injection into upstream request; tool-call proxy loop with iteration guard |
| `/v1/responses` streaming | Deferred from v0.10.0 with explicit 400; n8n and AI SDK clients need streaming on Responses API | HIGH | `ResponsesStreamTransformer` wrapping existing backend adapter; emit 15 canonical events; reuse `fastify-sse-v2` SSE path |
| `/v1/responses` tool calls (streaming) | Agents using Responses API expect tool calling within streaming; without it the Responses API surface is incomplete | HIGH | Detect function_call items in backend stream; emit `response.function_call_arguments.delta/.done` events; yield `requires_action` status on `response.completed` |
| `SessionStore` interface + Postgres default impl | Memory abstraction requires a place to put turns; Postgres already present | MEDIUM | Interface in `src/providers/session-store.ts`; Drizzle schema for `sessions` + `turns` tables; migration 0005; `createSession`, `appendTurn`, `loadHistory`, `deleteSession`, `listSessions`, `replaceTurns` |
| `ContextProvider` interface + truncate/sliding-window strategies | Without this, callers must manage context themselves — defeats the abstraction layer goal | MEDIUM | Interface + two strategies (truncate, sliding-window); model ctx_size from registry; noop-safe (returns full history if below limit) |
| `SummaryProvider` interface + NoopSummaryProvider default | Interface must exist from day 1 so ContextProvider's summarize-hook strategy can be declared even before a real implementation is plugged in | LOW | Interface file + `NoopSummaryProvider` returning `{ summary: "" }`; ContextProvider falls back to truncate when noop returns empty |
| `RetrieverProvider` interface + pre-completion hook seam | The hook seam is the primary value delivery of P3; the interface makes it swappable | MEDIUM | Interface + optional Fastify lifecycle hook (registered per-route); `retrieve()` result injected into messages[] as system turn; no default implementation (noop = no retrieval) |
| `EmbeddingProvider` interface formalization | Existing embedding capability needs a stable named interface so RetrieverProvider implementations can depend on it without HTTP round-tripping | LOW | Extract interface from `BackendAdapter`; `fastify.decorate('embeddingProvider', ...)` |
| `tenant_id`, `agent_id`, `project_id` in request_log | Multi-tenant observability from day 1; cost_per_agent_daily already uses agent_id | LOW | Drizzle migration adding `tenant_id TEXT`, `project_id TEXT` columns; extraction from `X-Tenant-ID`, `X-Agent-ID`, `X-Project-ID` headers (or body metadata) |
| Model allowlist policy primitive | Basic gatekeeping; single `model_allowlist: []` in models.yaml; empty = allow all | LOW | Registry loader reads policy stanza; request dispatch checks allowlist before routing; 403 on miss |
| Cloud restriction (`cloud_allowed` flag) | Sensitive workloads must not go to Ollama Cloud; explicit flag in registry | LOW | `policy.cloud_allowed: true/false` in models.yaml; checked at backend resolution; 403 with structured error |
| `X-Workload-Class: sensitive` header awareness | Explicit client-declared sensitivity without content classification | LOW | Extract header; if `sensitive` AND `cloud_allowed == true` globally, optionally block per model; log to request_log |

### Differentiators (Competitive Advantage)

Features that distinguish this router from LiteLLM/OpenRouter/basic proxies. Not required on day 1, but worth building when the table stakes are stable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| `list_models` MCP tool with capability filtering | Agents can dynamically pick the right model based on declared capabilities (tools, vision, embedding, rerank) — no hardcoded model names in agent prompts | LOW | Wraps existing GET /v1/models with MCP shape; add `filter_by_capability` input param |
| MCP server `notifications/tools/list_changed` | Agents auto-refresh when models.yaml changes (hot-reload already implemented) | LOW | Emit notification via MCP SSE channel when registry reloads; requires stateful MCP session |
| ContextProvider `summarize-hook` strategy (beyond truncate/sliding-window) | Enables long-session agents without losing early context; differentiating for agentic workflows | MEDIUM | Requires `SummaryProvider` wiring; ContextProvider calls summarize when threshold exceeded; `replaceTurns` compacts history |
| Session TTL + automatic expiry | Sessions expire after inactivity; prevents unbounded Postgres growth without manual intervention | LOW | `ttl_seconds` on session; cron or Drizzle scheduled query to delete expired sessions; emit `session.expired` log event |
| Per-model context size in registry (ctx_size field) | Enables ContextProvider to enforce correct limits without hardcoding; models.yaml already declares capabilities | LOW | Add `ctx_size: 32768` field to models.yaml model entry; ContextProvider reads it; validated at boot |
| Structured error shape on MCP tool failures | MCP `isError: true` result with structured JSON so agents can self-correct | LOW | On tool handler exception, return `{ content: [{ type: "text", text: JSON.stringify({ error, code, message }) }], isError: true }` |
| `X-Session-ID` response header on sessions created | Lets stateless clients discover their session_id without parsing the body | LOW | On `createSession`, set `X-Session-ID: <session_id>` response header |

### Anti-Features (Commonly Requested, Often Problematic)

Features that look in-scope for "retrieval-ready infrastructure" but violate the architectural frame and should be explicitly refused.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Vector DB integration (Qdrant, Weaviate, pgvector) | "RAG-ready" sounds like it should include vector storage | Violates "Retrieval Interfaces, not Retrieval Logic"; couples router to a specific DB; schema assumptions leak into router | `RetrieverProvider` interface accepts ANY vector DB impl as a plugin; downstream registers it |
| Chunking / document ingestion pipeline | "If there's retrieval, there must be ingestion" | Text splitting, overlap, metadata extraction are domain-specific; hardcoding any strategy poisons the interface | Out of scope; consumer builds ingestion as a separate service that writes to their vector DB |
| Automatic semantic memory (store+retrieve on every turn) | "Smart agents remember everything" | Requires retrieval strategy decisions (what to store, what to retrieve, relevance threshold) the router cannot make neutrally; invisible side effects surprise callers | `RetrieverProvider` hook gives callers EXPLICIT control; auto-memory is a consumer concern |
| Summarization behavior / prompt templates | "The router should be able to summarize" | Which model, which prompt, extractive vs abstractive — all domain decisions; baking them in creates an opinionated router that conflicts with caller's desired behavior | `SummaryProvider` seam; router calls `summarize(turns)`; caller provides the impl |
| Full OAuth 2.1 PKCE flow for MCP auth | "MCP spec requires OAuth for enterprise" | For single-user localhost bearer-token deployment, PKCE adds auth server complexity with no security gain; premature | Bearer token in v0.11.0; OAuth is a clearly documented extension point for the auth hook |
| Multi-key / per-tenant auth (different bearer per tenant) | "Multi-tenant support" | Requires key DB, key lifecycle management, per-key policy enforcement — a separate milestone | Tenant IDs are written to request_log from headers for observability; auth remains single-bearer |
| Content-based smart routing (classify prompt → pick model) | "Route sensitive prompts to local models automatically" | Requires classifier model running in-process; adds latency; wrong predictions invisible to caller; violates "client always specifies model" invariant | `X-Workload-Class: sensitive` header for explicit client-declared routing hint |
| Background retrieval / pre-fetch | "Pre-fetch docs before user asks" | Requires session prediction, speculative execution, rollback on miss; vastly more complexity than the hook seam | Hook fires synchronously at request time with the actual query |
| Persistent MCP connections (connection pool) | "Re-connecting on every request wastes latency" | Persistent connections to external MCP servers are a resilience liability (broken pipe, server restart); premature optimization | Lazy connect + tools list cache handles >95% of the latency concern; pooling is v2 |
| Built-in knowledge base / FAQ store | "Should be able to answer from docs out of the box" | Knowledge schema, freshness policy, access control — all domain-specific; builds the wrong abstraction | `RetrieverProvider` interface; consumer provides impl backed by their KB |
| Reasoning event pass-through (`response.reasoning_text.delta`) | "Expose model reasoning in Responses API stream" | Reasoning events are model-specific (o1/o3 only); most backends don't emit them; adds format complexity for near-zero v0.11.0 value | Suppress reasoning events in initial impl; emit as pass-through in a later phase when o1-class models become available locally |

---

## Feature Dependencies

```
[MCP server (host)]
    └──requires──> [Auth bearer] (already built — v0.9.0)
    └──requires──> [Backend service layer] (already built — v0.9.0/v0.10.0)
    └──requires──> [@modelcontextprotocol/sdk installed]

[MCP client (consume external)]
    └──requires──> [MCP server (host)] — shares SDK package
    └──requires──> [models.yaml mcp_clients stanza]
    └──enhances──> [RetrieverProvider] — MCP servers can back RetrieverProvider impls

[/v1/responses streaming]
    └──requires──> [/v1/responses non-stream] (built — v0.10.0 Phase 13)
    └──requires──> [Backend adapter streaming path] (already built — v0.9.0)
    └──requires──> [ResponsesStreamTransformer — new]

[/v1/responses tool calls streaming]
    └──requires──> [/v1/responses streaming]
    └──requires──> [Tool calling in backend adapter] (already built — v0.9.0 Phase 4)

[SessionStore Postgres impl]
    └──requires──> [Postgres + Drizzle stack] (already built — v0.9.0 Phase 5)
    └──requires──> [Drizzle migration 0005 (sessions + turns tables)]

[ContextProvider]
    └──requires──> [SessionStore] — calls loadHistory()
    └──requires──> [ctx_size field in models.yaml] (new field)
    └──optionally calls──> [SummaryProvider] (for summarize-hook strategy)

[SummaryProvider seam]
    └──requires──> [ContextProvider] (the only current caller)
    └──default impl: NoopSummaryProvider] (no external deps)

[RetrieverProvider + pre-completion hook]
    └──requires──> [Fastify lifecycle hooks] (already built — v0.9.0)
    └──optionally uses──> [EmbeddingProvider] (for semantic queries)
    └──optionally backed by──> [MCP client] (MCP-tool retrieval path)

[EmbeddingProvider interface]
    └──requires──> [/v1/embeddings route + BackendAdapter.embed()] (already built — v0.10.0 Phase 12)
    └──no new deps — extraction, not addition]

[tenant_id / agent_id / project_id in request_log]
    └──requires──> [request_log table] (already built — v0.9.0 Phase 5)
    └──requires──> [Drizzle migration 0005 (add columns)]

[Model allowlist + cloud restriction policy]
    └──requires──> [models.yaml policy stanza — new]
    └──requires──> [backend resolution path] (already built — v0.9.0)
```

### Dependency Notes

- **MCP server depends on existing auth bearer**: The same `onRequest` hook that guards `/v1/*` routes must guard `/mcp`. No new auth code, just extend the hook's protected path list. HIGH confidence.
- **ContextProvider depends on ctx_size in registry**: The `models.yaml` schema must be extended with `ctx_size: integer` before ContextProvider can be meaningful. This is a data schema change, not a behavior change.
- **SummaryProvider noop default is required**: ContextProvider must compile and work without a real summarizer. The noop default ensures the `summarize-hook` strategy degrades gracefully to `truncate` rather than erroring.
- **EmbeddingProvider is an extraction, not a new feature**: The capability already exists; the interface is extracted from `BackendAdapter`. No behavior change to embeddings.
- **MCP client and MCP server share `@modelcontextprotocol/sdk`**: One package, two roles (`McpServer` for host, `Client` for client). Install once.

---

## MVP Definition (v0.11.0 Phase Ordering)

### Phase 14 — MCP Server + /v1/responses Streaming (P1 + P2)

These two unlock the most downstream value and are independent of the provider interface stack.

- [x] `@modelcontextprotocol/sdk` installed
- [x] MCP server (host) mounted at `/mcp` with Streamable HTTP transport
- [x] Five MCP tools: `chat_completion`, `create_embedding`, `rerank`, `create_response`, `list_models`
- [x] Bearer auth on MCP endpoint (same token, same hook)
- [x] `/v1/responses` streaming — `ResponsesStreamTransformer` + canonical event sequence
- [x] `/v1/responses` streaming tool calls — function_call delta events + `requires_action` status

### Phase 15 — MCP Client + RetrieverProvider (P1 + P3)

MCP client enables the external-server consumption; RetrieverProvider gives the pre-completion hook seam.

- [x] `mcp_clients` stanza in models.yaml
- [x] MCP client lifecycle (lazy connect, tools/list cache, tool-injection, proxy loop with 10-iter guard)
- [x] `RetrieverProvider` interface + pre-completion hook seam (Fastify lifecycle hook)
- [x] `EmbeddingProvider` interface extracted from BackendAdapter

### Phase 16 — Memory Abstraction (P4)

SessionStore + ContextProvider + SummaryProvider; Postgres migration.

- [x] Drizzle migration 0005 (sessions + turns tables; tenant_id/project_id on request_log)
- [x] `SessionStore` interface + Postgres default implementation
- [x] `ContextProvider` interface + truncate + sliding-window strategies; ctx_size from registry
- [x] `SummaryProvider` interface + `NoopSummaryProvider` default
- [x] tenant_id / agent_id / project_id extraction and request_log persistence

### Phase 17 — Policy Primitives (Slim)

- [x] `policy` stanza in models.yaml (model_allowlist, cloud_allowed)
- [x] Allowlist enforcement at request dispatch
- [x] Cloud restriction check at backend resolution
- [x] `X-Workload-Class: sensitive` header extraction and logging

### Add After Phase 17 (Differentiators)

- [ ] ContextProvider `summarize-hook` strategy (requires real SummaryProvider consumer)
- [ ] Session TTL + expiry cron
- [ ] Per-model `ctx_size` field in registry (used by ContextProvider)
- [ ] MCP `notifications/tools/list_changed` on registry hot-reload

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| MCP server (host) | HIGH — unlocks all MCP-native agents | HIGH | P1 |
| /v1/responses streaming | HIGH — closes v0.10.0 debt; n8n streaming | HIGH | P1 |
| MCP client (consume external) | HIGH — enables RAG-router bridge pattern | HIGH | P1 |
| SessionStore + Postgres impl | HIGH — core of memory abstraction | MEDIUM | P1 |
| ContextProvider (truncate/sliding) | HIGH — makes sessions usable for LLMs | MEDIUM | P1 |
| RetrieverProvider + pre-completion hook | HIGH — the primary P3 value delivery | MEDIUM | P1 |
| EmbeddingProvider interface | MEDIUM — extraction; low risk | LOW | P1 |
| SummaryProvider seam + noop | MEDIUM — required for ContextProvider compile | LOW | P1 |
| tenant_id/project_id tracing | MEDIUM — multi-tenant observability | LOW | P1 |
| Model allowlist policy | MEDIUM — basic access control | LOW | P1 |
| Cloud restriction flag | MEDIUM — sensitive workload protection | LOW | P1 |
| X-Workload-Class header | MEDIUM — explicit workload declaration | LOW | P1 |
| list_models MCP tool with capability filter | MEDIUM — dynamic model selection in agents | LOW | P2 |
| ContextProvider summarize-hook strategy | MEDIUM — long-session support | MEDIUM | P2 |
| Session TTL expiry | LOW — ops quality of life | LOW | P2 |
| MCP tools/list_changed notification | LOW — agent ergonomics | LOW | P2 |
| OAuth 2.1 for MCP auth | LOW for single-user | HIGH | P3 |
| MCP connection pool | LOW — premature optimization | MEDIUM | P3 |

**Priority key:**
- P1: Must have for v0.11.0 milestone to be complete
- P2: Should have; add when P1 is stable
- P3: Deferred; revisit in v0.12.0+

---

## Competitor Feature Analysis

| Feature | LiteLLM | OpenRouter | This Router (v0.11.0) |
|---------|---------|------------|----------------------|
| MCP server (host) | YES — exposes proxy as MCP server (2025) | NO | YES — with tool-level capability decomposition |
| MCP client (consume external) | YES — mcp_servers in config.yaml; gateway model | NO | YES — mcp_clients in models.yaml; lazy connect |
| /v1/responses streaming | YES — full implementation | NO (routes to OpenAI) | YES — own transformer over backend stream |
| Session/memory abstraction | Via LangChain integration | NO | YES — `SessionStore` + `ContextProvider` as first-class interfaces |
| Retrieval hook | Via custom callbacks | NO | YES — `RetrieverProvider` pre-completion hook |
| Model allowlist per-key | YES (virtual keys, enterprise) | YES (scoped keys) | YES (global allowlist v0.11.0; per-key v0.12.0) |
| Cloud restriction flag | Via key routing rules | Via model routing | YES — explicit `cloud_allowed` in registry |
| Tenant/agent ID tracing | YES — via team_id / user_id | Partial — via API key metadata | YES — `X-Tenant-ID`/`X-Agent-ID`/`X-Project-ID` headers to request_log |
| Local-first (no cloud dependency) | NO — SaaS; requires their proxy | NO — cloud-only | YES — entire stack runs on-host |

---

## Sources

- [MCP Specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — tools/list wire format, tools/call, inputSchema, outputSchema, isError — **HIGH**
- [MCP Specification 2025-11-25 — Overview](https://modelcontextprotocol.io/specification/2025-11-25) — JSON-RPC 2.0, capabilities negotiation, Streamable HTTP primary transport — **HIGH**
- [OpenAI Community — Responses API streaming events guide](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122) — complete event sequence including tool call deltas — **HIGH** (community-verified with official API reference)
- [OpenAI API Reference — response.output_text.delta](https://platform.openai.com/docs/api-reference/responses_streaming/response/output_text/delta) — wire format fields (item_id, output_index, content_index, delta, sequence_number) — **HIGH**
- [LiteLLM MCP Overview](https://docs.litellm.ai/docs/mcp) — config shape (mcp_servers in config.yaml), tool injection into tools[], lazy lifecycle, auth types — **HIGH**
- [LiteLLM Model Access docs](https://docs.litellm.ai/docs/proxy/model_access) — model allowlist per virtual key, team, project — **HIGH**
- [AI SDK MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) — createMCPClient(), transport types, tool discovery, lazy lifecycle, cacheToolsList — **HIGH**
- [MCP TypeScript SDK — server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) — McpServer, NodeStreamableHTTPServerTransport, registerTool, Express integration — **HIGH**
- [Auth0 — MCP Streamable HTTP and OAuth](https://auth0.com/blog/mcp-streamable-http/) — Streamable HTTP replaces SSE-only, per-request Authorization header, OAuth 2.1 resource server classification — **HIGH**
- [LLM Gateway MCP guide](https://docs.llmgateway.io/guides/mcp) — concrete example of exposing `chat`, `list-models` as MCP tools; dual auth (bearer + x-api-key) — **HIGH**
- [LlamaIndex TypeScript Retriever docs](https://developers.llamaindex.ai/typescript/framework/modules/rag/retriever/) — `retrieve({ query })` returning `nodesWithScore`; basis for RetrieverProvider interface shape — **MEDIUM** (pattern verified; exact TS interface not shown)
- [LlamaIndex Chat Stores](https://developers.llamaindex.ai/python/framework/module_guides/storing/chat_stores/) — `set_messages`, `get_messages`, `add_message`, `delete_last_message`; session key pattern; TTL — **MEDIUM** (Python; mapped to TS conventions)
- [Zylos Research — MCP Remote Evolution 2026](https://zylos.ai/research/2026-03-08-mcp-remote-evolution-streamable-http-enterprise-adoption) — Streamable HTTP as the 2025-03-26 inflection point; OAuth 2.1 mandated for enterprise — **MEDIUM** (analysis, not official spec)
- [MCP TypeScript SDK npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — package identity; version; transport exports — **HIGH** (verified package exists, 403 on npm detail page)
- [WSO2 — Agent ID in AI gateways](https://wso2.com/library/blogs/elevating-ai-gateway-security-and-control-llm-access-with-agentid/) — agent_id as first-class tracing field in LLM gateways — **MEDIUM**
- [Context window management — Tanuj Garg](https://tanujgarg.com/blog/llm-context-window-management-production) — sliding window, truncation, summarize-hook strategies; assembly order for lost-in-middle avoidance — **MEDIUM** (blog, but well-aligned with LangChain/LlamaIndex patterns)

---

*Feature research for: v0.11.0 Retrieval-Ready Infrastructure (local-llms router)*
*Researched: 2026-05-29*
