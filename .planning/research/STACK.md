# Stack Research

**Domain:** MCP-as-server/client, /v1/responses streaming+tools, provider interfaces, policy primitives — local-llms v0.11.0
**Researched:** 2026-05-29
**Confidence:** HIGH (all version pins verified via npm registry; MCP SDK inspected by installing 1.29.0 and reading dist/esm/)

---

## New Dependencies for v0.11.0

Only packages not already in the router's package.json are listed. The existing locked stack (Fastify 5.8.5, openai 6.39.1, @anthropic-ai/sdk 0.95.1, zod 4.4.3, drizzle-orm 0.36, pg 8.13, ioredis 5.x, fastify-sse-v2 4.2.2) is NOT re-researched here.

---

## Recommended Stack

### Core Technologies — New in v0.11.0

| Technology | Pin | Purpose | Why Recommended |
|------------|-----|---------|-----------------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | MCP server + client in one package — `McpServer`, `StreamableHTTPServerTransport`, `StdioServerTransport`, `SSEServerTransport`, `StreamableHTTPClientTransport` | **Official TypeScript SDK from modelcontextprotocol org.** Version 1.29.0 (published 2026-03-30) ships both server and client in the single package. Exports at `@modelcontextprotocol/sdk/server` and `@modelcontextprotocol/sdk/client`. `StreamableHTTPServerTransport` (Node IncomingMessage/ServerResponse) is the correct class for Fastify `raw.req`/`raw.res` integration — confirmed by reading dist/esm/server/streamableHttp.d.ts. No separate `@modelcontextprotocol/node` package needed at 1.x; that is an alpha-only 2.x modular split. **HIGH confidence** — dist tree verified. |

### No Additional Packages Required for Other Scopes

The remaining v0.11.0 scope (Responses streaming, provider interfaces, policy primitives, Postgres session schema) requires **zero new npm dependencies** beyond the MCP SDK. Details in each section below.

---

## Detailed Analysis by Scope

### 1. MCP TypeScript SDK — `@modelcontextprotocol/sdk@^1.29.0`

**What 1.29.0 ships (verified by inspecting installed dist):**

**Server-side exports (`@modelcontextprotocol/sdk/server`):**
- `McpServer` — high-level API with `registerTool()`, `registerResource()`, `registerPrompt()`, `connect(transport)`. The `tool()` method is deprecated in favour of `registerTool()`.
- `StreamableHTTPServerTransport` — handles `IncomingMessage` + `ServerResponse` directly. Constructor: `new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })` for stateful sessions or `{ sessionIdGenerator: undefined }` for stateless. Method: `transport.handleRequest(req, res, parsedBody)`.
- `SSEServerTransport` — the legacy HTTP+SSE transport from protocol version 2024-11-05. Keep for backward-compat with older clients that don't support Streamable HTTP.
- `StdioServerTransport` — for local stdio processes; secondary target per project constraints.

**Client-side exports (`@modelcontextprotocol/sdk/client`):**
- `StreamableHTTPClientTransport` — connects to any Streamable HTTP MCP server with optional `Last-Event-ID` resumption.
- `SSEClientTransport` — legacy SSE client transport.
- `StdioClientTransport` — for spawning local stdio MCP servers.
- Auth helpers in `@modelcontextprotocol/sdk/client/auth.js`.

**Protocol spec (verified at modelcontextprotocol.io/docs/concepts/transports):**
- Two official transports: stdio and Streamable HTTP. The old HTTP+SSE is deprecated but the SDK keeps it for backward compat.
- Streamable HTTP uses a single MCP endpoint (`POST` for client→server, `GET` for server→client SSE stream). Bearer tokens are a valid auth mechanism on this transport — no OAuth required for an internal self-hosted server.
- Sessions managed via `Mcp-Session-Id` header (server assigns at init, client echoes on every subsequent request).

**Fastify integration pattern (no plugin needed, no `@modelcontextprotocol/fastify`):**
`@modelcontextprotocol/fastify` is a pre-alpha package (`2.0.0-alpha.2`, published 2026-04-01) that targets the v2 SDK split (`@modelcontextprotocol/server`) — it does NOT work with 1.x. The pattern for Fastify v5 is raw:

```typescript
// Fastify route for the MCP endpoint
fastify.route({
  method: ['POST', 'GET', 'DELETE'],
  url: '/mcp',
  handler: async (req, reply) => {
    const transport = getOrCreateTransport(req.headers['mcp-session-id']);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }
});
```

`StreamableHTTPServerTransport.handleRequest` takes `IncomingMessage` and `ServerResponse` — exactly what `req.raw` / `reply.raw` provide in Fastify. No shim required.

**Zod compatibility (confirmed safe):**
`@modelcontextprotocol/sdk@1.29.0` declares `peerDependencies: { zod: "^3.25 || ^4.0" }` and its direct dependencies also use `"^3.25 || ^4.0"`. The project already uses `zod@4.4.3`. No conflict. The SDK internally imports from `zod/v4` when available. The zod conflict issues reported in GitHub were against SDK ≤1.17.5; 1.28+ resolved them.

**Node 22 compatibility:** Package.json `engines: { node: ">=18" }`. No native addons, pure ESM/CJS dual. Safe on Node 22.

**MCP client pattern for consuming external MCP servers:**

Use `Client` from `@modelcontextprotocol/sdk/client` + `StreamableHTTPClientTransport`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'local-llms-router', version: '0.11.0' });
const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
await client.connect(transport);
const tools = await client.listTools();
const result = await client.callTool({ name: 'tool_name', arguments: { ... } });
```

For stdio MCP servers (local subprocesses):

```typescript
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'npx', args: ['some-mcp-server'] });
```

**MCP server config discovery convention:** No standard runtime discovery API yet in 1.29. The emerging `.well-known/mcp/server-card.json` pattern is a draft spec (IETF draft-serra-mcp-discovery-uri). For v0.11.0, config the client registry via `mcp-servers.yaml` (same pattern as existing `models.yaml`) — list server URLs + bearer tokens declaratively, load at router startup.

---

### 2. Responses API Streaming + Tools — openai@^6.39.1 (already installed)

**No new package needed.** `openai@6.39.1` (already in package.json at `^6.37.0`, resolves to 6.39.1) ships full Responses API streaming support. Confirmed by reading `dist/esm/resources/responses/responses.d.ts`:

```typescript
// openai SDK Responses resource signature (verified):
create(body: ResponseCreateParamsStreaming, options?: RequestOptions): APIPromise<Stream<ResponseStreamEvent>>;
```

**`ResponseStreamEvent`** is a fully typed union (verified from dist) covering:
- `ResponseCreatedEvent`, `ResponseInProgressEvent`, `ResponseCompletedEvent`, `ResponseFailedEvent`
- `ResponseOutputItemAddedEvent`, `ResponseOutputItemDoneEvent`
- `ResponseTextDeltaEvent` (text delta — primary streaming event)
- `ResponseFunctionCallArgumentsDeltaEvent`, `ResponseFunctionCallArgumentsDoneEvent` (tool streaming)
- `ResponseRefusalDeltaEvent`, `ResponseRefusalDoneEvent`
- Plus audio, code interpreter, file search, MCP tool events

**Iteration pattern (confirmed):**
```typescript
const stream = await openaiClient.responses.create({
  model: 'gpt-4o',
  input: messages,
  stream: true,
  tools: [...],
});
for await (const event of stream) {
  if (event.type === 'response.output_text.delta') { /* emit SSE chunk */ }
  if (event.type === 'response.function_call_arguments_delta') { /* buffer tool args */ }
  if (event.type === 'response.completed') { /* finalize */ }
}
```

**Re-emit as router SSE:** The existing `fastify-sse-v2` `reply.sse()` pattern already used for chat completions applies identically. Wrap the `for await` loop inside an async generator and pass to `reply.sse()`. No new library required.

**Tool calling in Responses streaming:** Uses `response.function_call_arguments_delta` + `response.function_call_arguments_done` events, analogous to `chat.completions` chunk deltas. The local backends (Ollama, llama.cpp, vLLM) don't expose a native Responses API — the router's Responses↔canonical translator (already in v0.10.0 Phase 13) continues to handle the translation. Streaming is added to the translator: emit Responses SSE events from canonical ChatCompletionChunk events.

---

### 3. Provider Interfaces — Pure TypeScript, No Library

**No new package.** The five provider interfaces (`SessionStore`, `ContextProvider`, `RetrieverProvider`, `EmbeddingProvider`, `SummaryProvider`) and the pre-completion hook seam are **pure TypeScript interface declarations**. No library ships the right contracts for this use case.

**Why not adopt external frameworks:**
- **Vercel AI SDK v5** — defines `LanguageModelV1`, `EmbeddingModelV1` provider specs. Useful reference for model-provider shape, but its `UIMessage`/`ModelMessage` separation is UI/React-centric and introduces React-facing generics. Not appropriate for a server-side router that has no UI layer.
- **LangChain.js** — `BaseMemory`, `BaseStore`, `InMemoryStore` are deeply coupled to LangChain's `Chain` execution model. Cannot be used standalone without pulling in `@langchain/core` dependency tree (~10 packages). The `BaseMemory.loadMemoryVariables()` contract doesn't fit the router's seam-only design.
- **Mastra** — 1.0 released Jan 2026, TypeScript-first agent framework with built-in memory, MCP, and RAG. Its memory system is interesting but is tightly coupled to Mastra's agent/workflow runtime. Importing Mastra just to use an interface shape would be wrong.

**Recommended pattern — define our own, inspect external shapes for naming conventions:**

```typescript
// provider-interfaces.ts — zero external deps

export interface SessionStore {
  getSession(sessionId: string): Promise<Session | null>;
  upsertSession(session: Session): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ContextProvider {
  loadHistory(sessionId: string, windowTokens: number): Promise<ConversationTurn[]>;
  appendTurn(sessionId: string, turn: ConversationTurn): Promise<void>;
}

export interface RetrieverProvider {
  retrieve(query: string, opts: RetrieveOptions): Promise<RetrievedChunk[]>;
}

export interface EmbeddingProvider {
  embed(inputs: string[], opts?: EmbedOptions): Promise<number[][]>;
}

export interface SummaryProvider {
  summarize(turns: ConversationTurn[]): Promise<string | null>;  // noop default returns null
}

export interface PreCompletionHook {
  (payload: PreCompletionPayload): Promise<PreCompletionResult>;
}
```

The naming follows the `XProvider` convention used by Vercel AI SDK and Mastra (both have `Provider` suffix on their integration points). Using the same suffix aids discoverability for downstream consumers building on local-llms.

---

### 4. Postgres Schema — Drizzle ORM 0.36 (already installed)

**No new package.** `drizzle-orm@0.36.0` (already installed) handles the new `sessions` and `conversation_turns` tables. No upgrade to 0.45.x needed — the 0.36→0.45 delta does not add features required here; 0.45.x is latest stable but 0.36 is fully sufficient. (Drizzle 1.0.0-rc.4 exists but is pre-release; skip.)

**Schema pattern for `sessions` + `conversation_turns`:**

```typescript
// sessions table
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),              // ULID or UUID
  tenant_id: text('tenant_id'),             // multi-tenant day-1
  agent_id: text('agent_id'),
  project_id: text('project_id'),
  metadata: jsonb('metadata').default({}),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  expires_at: timestamp('expires_at'),      // NULL = no expiry
});

// conversation_turns table
export const conversationTurns = pgTable('conversation_turns', {
  id: text('id').primaryKey(),              // ULID
  session_id: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'tool', 'system'] }).notNull(),
  content: jsonb('content').notNull(),      // OpenAI message shape
  token_count: integer('token_count'),      // for context window management
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  session_idx: index('conversation_turns_session_id_idx').on(t.session_id),
  created_idx: index('conversation_turns_created_at_idx').on(t.created_at),
}));
```

**TTL / retention strategy for v0.11.0:**
- Use `expires_at` column; a scheduled Postgres function or a router startup task runs `DELETE FROM sessions WHERE expires_at < NOW()` (cron or pg_cron).
- Do NOT use Postgres range partitioning at this stage. Drizzle 0.36 supports partitioned tables in introspection but not in schema declaration — partitioning would require raw SQL migration. At single-user scale (hundreds of sessions) this is premature optimization.
- Foreign key `ON DELETE CASCADE` from `conversation_turns.session_id` to `sessions.id` ensures turn cleanup without explicit joins.

**Drizzle migration approach (already established pattern):** Add migration SQL file `0005_sessions.sql` + `0006_conversation_turns.sql` with `_journal.json` entries as the existing Drizzle migration journal pattern requires (per project memory note).

---

### 5. Policy Primitives — Pure TypeScript + Existing Stack

**No new package.** Model allowlists, `cloud_allowed` per-tenant/agent, sensitive-workload routing, and tenant/project/agent IDs in metadata all live in:

- `models.yaml` — extend per-model declarations with `allowed_agents: [...]`, `cloud_allowed: true/false`, `tags: [sensitive, ...]`
- `request_log` schema — already has `agent_id`; add `tenant_id` and `project_id` columns (migration 0007 or folded into sessions migration)
- Router middleware — extend existing bearer auth `onRequest` hook to parse `X-Tenant-Id`, `X-Agent-Id`, `X-Project-Id` headers and attach to request context for logging and allowlist checks

**Why not a dedicated policy library:**
- LiteLLM is Python-only; its proxy model is irrelevant here.
- OpenRouter, Portkey, Helicone are managed cloud services, not TS libraries.
- The policy surface for v0.11.0 is intentionally slim (allowlists + cloud restriction flag + IDs in metadata). A dedicated library would over-engineer this scope.

---

## Installation

```bash
# Single new production dependency for v0.11.0
npm install @modelcontextprotocol/sdk@^1.29.0
```

No new dev dependencies required.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `@modelcontextprotocol/sdk@^1.29.0` (official, main org) | `@smithery-ai/mcp-sdk` (Smithery fork) | Not the official SDK. Smithery fork may diverge from spec. Use official org package only — project quality gate requires it. |
| `@modelcontextprotocol/sdk@^1.29.0` (1.x stable) | `@modelcontextprotocol/server@2.0.0-alpha.2` + `@modelcontextprotocol/fastify@2.0.0-alpha.2` | Both are April 2026 alpha packages. `@modelcontextprotocol/fastify` was last published 2026-04-01 and has no stable release. The 2.x modular split is unfinished; 1.x is the production-recommended series. |
| `StreamableHTTPServerTransport` (from main SDK) | `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` | `@modelcontextprotocol/node` is 2.0.0-alpha.2 only. The `StreamableHTTPServerTransport` in the main 1.29 SDK already handles Node.js `IncomingMessage`/`ServerResponse` natively. |
| openai@6.39.1 (already installed) for Responses streaming | Hand-rolled SSE parser | `openai.responses.create({ stream: true })` returns `Stream<ResponseStreamEvent>` with 40+ fully-typed event variants. Hand-rolling would re-implement this type surface. The SDK already ships it. |
| Pure TS provider interfaces | Adopting Vercel AI SDK types | AI SDK interfaces are React/UI-centric (UIMessage, useChat hooks). The router has no UI layer. Importing ai-sdk would pull React-facing deps into a server-only codebase. |
| Pure TS provider interfaces | Adopting LangChain.js BaseMemory | Requires `@langchain/core` as a dep (~10 transitive packages). The `loadMemoryVariables(inputValues)` signature is Chain-oriented, not a clean seam for a middleware router. |
| `sessions` + `conversation_turns` in Drizzle 0.36 | Upgrading to Drizzle 0.45 | 0.36 is the pinned version; the 0.45 diff adds no features needed for these two tables. Upgrading mid-milestone introduces unnecessary churn. Re-evaluate at v0.12.0. |
| Postgres `expires_at` column + delete job for TTL | pg_cron or separate worker | pg_cron adds a Postgres extension not in the current Compose stack. A lightweight router-side cleanup task (run at startup + periodic interval via `setInterval`) is simpler and avoids ops scope creep. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@modelcontextprotocol/fastify@2.0.0-alpha.2` | Pre-alpha, no stable release, targets v2 SDK not 1.x, published only once on 2026-04-01. Peer-deps on `@modelcontextprotocol/server@^2.0.0-alpha.2` which does not exist in production. | Raw Fastify `req.raw`/`reply.raw` with `StreamableHTTPServerTransport.handleRequest()` — 3 lines, no plugin needed. |
| `haroldadmin/fastify-mcp` or `flaviodelgrosso/fastify-mcp-server` | Community plugins with unknown maintenance; wrap the same `StreamableHTTPServerTransport` the router would call directly anyway. Extra abstraction with no upside. | Direct SDK integration. |
| `mcp-use` npm package | Not the official SDK. Exposes `MCPClient.fromDict()` pattern but is a third-party wrapper, not from `modelcontextprotocol` org. | `Client` + transport from `@modelcontextprotocol/sdk/client`. |
| `@langchain/core` or `langchain` | Pulls ~10 packages, tight LangChain runtime coupling, wrong interface shapes for a middleware router. | Pure TS interfaces defined in the router. |
| `ai` (Vercel AI SDK) | Designed for Next.js/React server actions and UI streaming. `useChat`, `UIMessage`, React generics don't belong in a Node Fastify router. `LanguageModelV1` spec is interesting but Vercel's `StreamableValue` wire format is incompatible with OpenAI/Anthropic SSE shapes already in use. | Provider interfaces defined natively in the router with naming conventions borrowed from Vercel AI SDK (XProvider suffix). |
| `mastra` | Full agent framework, 300K+ weekly npm downloads, but carries its own agent/workflow/observability runtime. Importing just to use memory interface shapes is architectural overreach. | Pure TS interfaces. |
| `drizzle-orm@1.0.0-rc.4` | Release candidate, unverified for the existing migration journal pattern. The jump from 0.36 to 1.0.0-rc risks silent migration behavior changes. | Stick to `^0.36.0` pinned in package.json for this milestone. |
| `jose` (direct dependency) | Already bundled inside `@modelcontextprotocol/sdk` dependencies. Adding it directly creates a potential version conflict. If JWT validation is needed for MCP auth, use the copy bundled by the SDK or rely on the SDK's auth helpers. | `@modelcontextprotocol/sdk/server/auth` exports. |
| WebSocket transport | Not in the MCP spec as of 2025-06-18 protocol version. The SDK's `websocket.d.ts` in the client module is a non-standard extension. Project constraint: HTTP/SSE first. | `StreamableHTTPServerTransport` + SSE fallback. |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@modelcontextprotocol/sdk@1.29.0` | `zod@4.4.3` | peerDep `"^3.25 \|\| ^4.0"` — explicit dual compat confirmed in package.json. No resolver conflict. |
| `@modelcontextprotocol/sdk@1.29.0` | Node 22 | `engines: { node: ">=18" }`. Pure ESM/CJS dual — no native addons. |
| `@modelcontextprotocol/sdk@1.29.0` | `fastify@5.8.5` | No Fastify peer dep. Integration via `req.raw`/`reply.raw` — framework-agnostic. |
| `@modelcontextprotocol/sdk@1.29.0` | `@bram-dc/fastify-type-provider-zod@^7.0.1` | No conflict. MCP SDK does not use Fastify's type system. |
| `openai@6.39.1` | Responses streaming | `responses.create({ stream: true })` returns `Stream<ResponseStreamEvent>` — verified from dist types. Typed iteration works identically to `chat.completions.stream()`. |
| `drizzle-orm@0.36.0` | `sessions` + `conversation_turns` schema | `pgTable`, `text`, `timestamp`, `jsonb`, `integer`, `index` all available since 0.30+. No 0.45 features needed. |

---

## Stack Patterns by Variant

**MCP server-mode (router as host, exposing tools):**
- Instantiate `McpServer` with `registerTool()` calls for `chat`, `embeddings`, `rerank`, `responses`
- Mount `StreamableHTTPServerTransport` on a Fastify route group `/mcp/*`
- Add `SSEServerTransport` on `/mcp/sse` for backward compat with legacy MCP clients
- Single `McpServer` instance per router process; sessions tracked in a `Map<string, StreamableHTTPServerTransport>`

**MCP client-mode (router consuming external MCP servers):**
- Config: extend `models.yaml` or add `mcp-servers.yaml` with `{name, url, auth: {type: bearer, token: $ENV_VAR}}` entries
- Registry: boot-time connect + `listTools()` for each configured server; cache tool manifests in Valkey (same pattern as model registry cache)
- Dispatch: pre-completion hook calls `client.callTool()` on the relevant MCP server; result injected into `messages[]` before model call

**Responses API streaming (extending Phase 13 base):**
- Phase 13 translator (`responses↔canonical`) is extended to emit streaming: iterate `openai.responses.create({ stream: true })` and re-emit each `ResponseStreamEvent` as a router SSE event
- For local backends (Ollama/llama.cpp/vLLM): translate `ChatCompletionChunk` events → `ResponseStreamEvent` shape in the translator
- `fastify-sse-v2` `reply.sse(asyncGenerator)` — same SSE infrastructure already in use for chat.completions

**Provider interfaces (seam-first approach):**
- Declare interfaces in `src/providers/types.ts`
- Ship Postgres-backed defaults for `SessionStore` and `ContextProvider`
- Ship noop defaults for `RetrieverProvider`, `SummaryProvider`
- Formalize `EmbeddingProvider` as a thin wrapper around the existing `/v1/embeddings` BackendAdapter method
- Register via a `providers` section in the router's startup config; downstream consumers override by implementing the interface

---

## Sources

- `npm view @modelcontextprotocol/sdk@1.29.0` — version, deps, peerDeps (node: >=18, zod: "^3.25 || ^4.0") — **HIGH**
- Manual install + dist inspection: `npm install @modelcontextprotocol/sdk@1.29.0` → `ls dist/esm/server/` + reading `.d.ts` files — **HIGH** (direct artifact)
- `npm view openai@6.39.1` — latest stable published 2026-05-28 — **HIGH**
- `openai/resources/responses/responses.d.ts` (dist from openai@6.39.1): `ResponseStreamEvent` union type + `create()` overloads — **HIGH** (direct artifact)
- [modelcontextprotocol.io/docs/concepts/transports](https://modelcontextprotocol.io/docs/concepts/transports) — Streamable HTTP spec, stdio spec, bearer token auth mention — **HIGH**
- [modelcontextprotocol.io/docs/concepts/architecture](https://modelcontextprotocol.io/docs/concepts/architecture) — Host/Client/Server roles — **HIGH**
- [github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) — McpServer API, transport setup patterns — **HIGH**
- `npm view @modelcontextprotocol/fastify` — 2.0.0-alpha.2, published 2026-04-01, peers `@modelcontextprotocol/server@^2.0.0-alpha.2` — **HIGH** (confirms avoid)
- `npm view @modelcontextprotocol/node` — 2.0.0-alpha.2, published 2026-04-01, alpha-only — **HIGH** (confirms avoid)
- [github.com/modelcontextprotocol/typescript-sdk/issues/925](https://github.com/modelcontextprotocol/typescript-sdk/issues/925) — zod v4 compat issues fixed in 1.28+ — **MEDIUM** (GitHub issue thread)
- `npm view drizzle-orm dist-tags` — `latest: 0.45.2`, `beta: 1.0.0-beta.22`, `rc: 1.0.0-rc.3` — **HIGH**
- [vercel.com/blog/ai-sdk-5](https://vercel.com/blog/ai-sdk-5) — AI SDK v5 provider architecture (V2 specs, UIMessage/ModelMessage split) — **MEDIUM** (confirms UI-centric design, not suitable here)
- [IETF draft-serra-mcp-discovery-uri](https://datatracker.ietf.org/doc/draft-serra-mcp-discovery-uri/) — `.well-known/mcp.json` discovery is a draft; not production-ready for v0.11.0 — **MEDIUM**
- Router `package.json` at `/home/luis/proyectos/local-llms/router/package.json` — confirmed existing locked deps — **HIGH**

---

*Stack research for: local-llms v0.11.0 Retrieval-Ready Infrastructure*
*Researched: 2026-05-29*
