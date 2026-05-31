# Phase 15: MCP Host (Router as MCP Server) - Research

**Researched:** 2026-05-31
**Domain:** Fastify v5 plugin exposing `/mcp` via `@modelcontextprotocol/sdk@^1.29.0` `StreamableHTTPServerTransport` — 5 tools wrapping existing `BackendAdapter` calls
**Confidence:** HIGH (CONTEXT.md is exhaustive; all 15 decisions validated against live codebase; SDK version verified on npm registry; canonical Streamable HTTP patterns sourced from upstream SDK + community examples)

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 — Tool I/O surface (Full Zod passthrough).** Every MCP tool's `inputSchema` derives programmatically from the existing route Zod schema via `z.toJSONSchema()` (`zod/v4`). No hand-authored MCP-specific request schemas; no MCP-specific knobs (no `_tenant_id`, no `_idempotency_key`, no `_agent_id`).

**D-02 — Successful tool result returns BOTH `content` AND `structuredContent`** per MCP spec (revision 2025-06+):
- `content: [{ type: 'text', text: <human-readable stamp> }]`
- `structuredContent: <full canonical response>`

**D-03 — Uniform dual-shape across all five tools.** Per-tool stamps:
- `chat_completion` → text = the assistant text (joined from text content blocks)
- `create_response` → text = the assistant text (extracted from `output` field)
- `create_embedding` → text = `"embedded N inputs, dims=D, model=M"`
- `rerank` → text = `"reranked N docs vs query, model=M"`
- `list_models` → text = `"N models available"`
Embedding vector payloads (1024×100 ≈ 3 MB) ride entirely in `structuredContent`.

**D-04 — Error codes reused verbatim from envelope mapping.** On thrown error:
1. Run `toOpenAIErrorEnvelope(err)`.
2. Stamp MCP error content block.
3. Return `{ content: [...], structuredContent: { error, code, message }, isError: true }`.

**D-05 — One `request_log` row per MCP tool call** (NOT per outer `POST /mcp`). `protocol = 'mcp'`. Plan MUST first inspect the current `request_log.protocol` column constraint.

**D-06 — Scoped IDs (tenant/project/agent/workload) flow exclusively from the outer `POST /mcp`** via existing `scopedIdsPreHandler`. Tool handlers close over `req`. All N tool calls share the same scoped identity.

**D-07 — Metric surface.** No `_id`-suffixed labels:
- Reuse: `router_requests_total{protocol='mcp', backend, model, status_class}` + `router_request_duration_seconds{protocol='mcp', ...}` on every MCP tool call.
- New: `router_mcp_tool_calls_total{tool, status_class}` counter (~25 series).
- New: `router_mcp_active_sessions` gauge.

**D-08 — Pino structured log fields are flat top-level keys.** Inherited via `req.log.child` (existing): `request_id`, `agent_id`, `tenant_id`, `project_id`, `workload_class`, `model`, `backend`, `status`, `latency_ms`. New: `tool_name`, `mcp_session_id`, `mcp_request_id`.

**D-09 — Extract shared `applyPreflight(model, opts) → ResolvedEntry` helper.** Pipeline: `registry.resolve` → `applyPolicyGate(snapshot.policies, entry, model)` → `await opts.breaker.check(entry.backend)`. Used by **both** the 5 HTTP routes AND the 5 MCP tool handlers. Capability check stays per-route/per-tool.

**D-10 — `list_models` returns policy-filtered + annotated set.** When `policies.default.model_allowlist` is non-empty, only allowlisted models appear. Each entry includes `policy: { cloud_allowed }`. Backend stays hidden (T-3-A2).

**D-11 — `GET /v1/models` HTTP also picks up the same filter + annotation** in Phase 15. One additional boolean field (`cloud_allowed`). Backend leakage protection preserved.

**D-12 — `stream: true` silently coerced to `false` inside every MCP tool handler.** Tool descriptions explicitly document this. P1-06 backpressure risk eliminated by construction.

**D-13 — Idempotency stays HTTP-only.** MCP tool calls are dedup-free; one JSON-RPC payload with N tool calls fires N upstream requests.

**D-14 — Abort propagation: MCP transport `signal` → fresh `AbortController` → adapter `signal`.** Mirrors existing HTTP route abort pattern.

**D-15 — Three new env vars:**
- `MCP_ENABLED=true` (default; `false` skips plugin registration → `/mcp` returns 404)
- `MCP_SESSION_TTL_SEC=3600` (1h idle TTL)
- `MCP_GC_INTERVAL_MS=1800000` (30 min sweep cadence)

### Claude's Discretion

- Exact file split between `router/src/mcp/host/` modules (`index.ts`, `plugin.ts`, `tools/chat.ts`, `tools/responses.ts`, `tools/embeddings.ts`, `tools/rerank.ts`, `tools/list-models.ts`, `session-gc.ts`).
- Whether `applyPreflight` lives at `router/src/dispatch/preflight.ts` or `router/src/policy/preflight.ts`.
- Exact wording of per-tool description strings documenting "no MCP streaming in v0.11.0" (D-12).
- Whether MCP plugin registers via `app.register(plugin, { prefix: '/mcp' })` or three direct `app.route()` calls.
- How `router_mcp_tool_calls_total` is registered in `router/src/metrics/registry.ts`.
- The exact projection field names for `policy: { cloud_allowed }` (snake_case to match models.yaml).

### Deferred Ideas (OUT OF SCOPE)

- MCP-native streaming via progress notifications (MCPS-FUT).
- MCP-level idempotency.
- Per-tool tenant/agent override.
- MCP-emitted `notifications/tools/list_changed` on registry hot-reload (MCPS-FUT-01).
- `list_models` `filter_by_capability` input param (MCPS-FUT-02).
- MCP plugin readiness in `/readyz`.
- Per-MCP-session bearer rotation.
- MCP tool call rate-limit per session.
- Dedicated `policy_violation_total{code}` Prometheus counter.

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MCPS-01 | Any MCP-compatible client can connect to `POST /mcp` over Streamable HTTP transport; speaks JSON-RPC 2.0 per MCP spec | Streamable HTTP boilerplate (§Pattern 1); `@modelcontextprotocol/sdk@^1.29.0` confirmed installed at npm latest |
| MCPS-02 | MCP server sits behind existing bearer `onRequest` hook; missing bearer → 401 before MCP-level handling | Existing `makeBearerHook` at root scope (`app.ts` line 275) — `/mcp` inherits automatically; verified against `auth/bearer.ts` PUBLIC_PATHS set (no addition needed) |
| MCPS-03 | Five tools exposed: `chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models` — each wraps existing handler with JSON Schema 2020-12 `inputSchema` | Existing Zod schemas already exported (`ChatCompletionRequestSchema`, etc.); D-01 + `z.toJSONSchema()` pattern |
| MCPS-04 | Tool handlers return structured errors on failure (`isError: true` + `{ error, code, message }` content block) | D-04 + existing `toOpenAIErrorEnvelope` mapping |
| MCPS-05 | MCP server cleans up open sessions on `SIGTERM` (verified via integration test) | D-15 GC loop + Promise.race shutdown with 5s timeout (§Pattern 2); wired via `app.addHook('onClose', …)` |
| MCPS-06 | Stdio transport NOT exposed in v0.11.0 (n8n compatibility constraint) | Never construct `StdioServerTransport` in router code; documented in DEPLOY.md |

</phase_requirements>

## Summary

Phase 15 is a **strictly additive plugin** mounted at `/mcp` that re-exposes five existing capabilities (`chat_completion`, `create_response`, `create_embedding`, `rerank`, `list_models`) as MCP tools over Streamable HTTP. The plugin is implemented via raw `req.raw`/`reply.raw` against `@modelcontextprotocol/sdk@^1.29.0`'s `McpServer` + `StreamableHTTPServerTransport` — **no community Fastify plugin** is used (rejected per SUMMARY.md research flag and CONTEXT canonical_refs). Tool handlers construct `CanonicalRequest` and call `BackendAdapter` directly; they do **not** round-trip through the HTTP route handlers.

CONTEXT.md already locks 15 decisions (D-01..D-15). This research validates each decision against the live codebase and codifies the exact snippets the planner needs. The only **discoveries** of note from re-reading the codebase:

1. **`request_log.protocol` is free-text TEXT NOT NULL with no CHECK constraint** (verified in `db/migrations/0000_init.sql` line 5 + no CHECK anywhere in `db/migrations/*.sql`) — `'mcp'` requires **zero migration work**. D-05 resolves trivially.
2. **`OutcomeContext.protocol` is currently typed `'openai' | 'anthropic'`** (`router/src/metrics/recordOutcome.ts:64`) — this **MUST be widened to `'openai' | 'anthropic' | 'mcp'`** for MCP tool handlers to push request_log rows via the existing `safeRecord`/`recordOutcome` path.
3. **`@modelcontextprotocol/sdk` is NOT yet installed** in `router/node_modules/` — npm registry confirms `@modelcontextprotocol/sdk@1.29.0` is current latest. Plan must include an `npm install` step gated behind slopcheck verification.
4. **`registerModelsRoute` exposes two routes** (`GET /v1/models` AND `GET /v1/models/:id`) — D-11 widening must touch **both** projections.
5. **`fastify-sse-v2` registration** (`app.ts:243`) and the MCP plugin do **not conflict**: routes are disjoint (`/v1/*` vs `/mcp`) and `reply.sse` is only called from chat/messages/embeddings/responses paths.
6. **Phase 14 left a stable pivot point**: `applyPolicyGate(opts.registry.get().policies, entry, body.model)` is called at canonical positions across all 5 HTTP routes (verified line numbers via `grep`: chat 225, messages 228, embeddings 236, rerank 140, responses 369). All 5 are immediately followed by `await opts.breaker.check(entry.backend)` — clean target for `applyPreflight` consolidation.

**Primary recommendation:** Use raw `app.route({ method: ['POST','GET','DELETE'], url: '/mcp', handler: … })` (single multi-method route) over `app.register(plugin, { prefix: '/mcp' })` — yields the smallest diff and inherits the root-scoped bearer hook + scopedIds preHandler + agentId preHandler automatically per Fastify v5 hook propagation. The plugin module owns the `Map<string, StreamableHTTPServerTransport>` session map, GC interval, SIGTERM cleanup, metric registration, and the `applyPreflight` consolidation.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| MCP transport (Streamable HTTP wire) | Frontend Server (Fastify route) | — | Single-process Node router; transport binds to `req.raw`/`reply.raw` directly |
| Tool routing (JSON-RPC `tools/call` dispatch) | API / Backend (in-process) | — | MCP SDK's `McpServer` owns `tools/list` + `tools/call` dispatch internally |
| Tool handler logic (build CanonicalRequest, call adapter) | API / Backend | — | Mirrors existing HTTP route handlers; calls `BackendAdapter.chatCompletionsCanonical` directly |
| Bearer auth | Frontend Server (root-scoped `onRequest` hook) | — | `app.ts:275 — makeBearerHook(opts.bearerToken)` — `/mcp` inherits automatically |
| Scoped-ID extraction (tenant/project/agent/workload) | Frontend Server (root-scoped `preHandler`) | — | Phase 14: `scopedIdsPreHandler` + `agentIdPreHandler` fire on `/mcp` before MCP handler runs |
| Session lifecycle (`Mcp-Session-Id`) | API / Backend (in-process map) | — | Lives in plugin module; not shared across processes (single-host constraint) |
| Session GC | API / Backend (in-process `setInterval`) | — | Same shape as `bufferedWriter`'s flush timer; `unref()` so it doesn't block process exit |
| Policy gate + breaker preflight | API / Backend (shared `applyPreflight` helper) | — | D-09 shared helper used by both HTTP routes and MCP tool handlers |
| `request_log` row push | Database (via `bufferedWriter`) | API / Backend | Same `BufferedWriter.push` API; `protocol: 'mcp'` is a new value, no schema change |
| Observability metrics | API / Backend (prom-client `Counter`/`Gauge`) | — | Co-located with existing `MetricsRegistry`; same `register` instance |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | `McpServer`, `StreamableHTTPServerTransport`, `isInitializeRequest`, `Client` (Phase 18) | Official TypeScript SDK from `modelcontextprotocol` org; CONTEXT canonical_refs locks this version; verified on npm registry 2026-05-31 as current latest (`npm view @modelcontextprotocol/sdk version` → `1.29.0`) [VERIFIED: npm registry]. peerDep `zod: "^3.25 \|\| ^4.0"` is compatible with project's `zod@4.4.3` [CITED: `npm view @modelcontextprotocol/sdk@1.29.0`] |

### Supporting (already in package.json, no new install)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fastify` | `^5.8.5` | Route registration via `app.route({ method, url, handler })` | Root-level route; bearer + scopedIds + agentId hooks inherited automatically |
| `zod` | `^4.4.3` | Already imported as `zod/v4` in 5 routes; tools use existing schemas | `z.toJSONSchema(ChatCompletionRequestSchema)` produces JSON Schema 2020-12 for tool `inputSchema` |
| `prom-client` | `^15.1.3` | `Counter`, `Gauge` classes already used in `metrics/registry.ts` | New `router_mcp_tool_calls_total` Counter + `router_mcp_active_sessions` Gauge |
| `pino` | `^10.3.1` | Logger already on `req.log` after `agentIdPreHandler.child(...)` call | Per-tool-call lines via `req.log.child({ tool_name, mcp_session_id, mcp_request_id })` — does NOT trip the Pitfall-9 grep gate because the new `.child()` is in tool handler scope, not at `req.log = ...` |
| `undici`/native `crypto` | already present | `crypto.randomUUID()` for `Mcp-Session-Id` generation | Same approach the SDK examples use; no new dep |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw `app.route({method:['POST','GET','DELETE']})` | `app.register(mcpPlugin, { prefix: '/mcp' })` | Plugin scope creates a child encapsulation context — hooks still inherit, but the smaller-diff path is the multi-method `app.route` (planner's choice per CONTEXT discretion) |
| Raw `req.raw`/`reply.raw` integration | `@modelcontextprotocol/fastify@2.0.0-alpha.2` (community) | Pre-alpha, last published 2026-04-01, targets the v2 SDK split that does not exist in production — REJECTED per STACK.md "What NOT to Add" |
| `@modelcontextprotocol/sdk@^1.29.0` | `@smithery-ai/mcp-sdk` (fork) | Not the official SDK; may diverge from spec — REJECTED |
| In-process session `Map` | Valkey-backed session map | Single-host constraint + sessions are bound to in-process `StreamableHTTPServerTransport` objects which cannot be serialized; Valkey-backed would still need the transport in memory — adds complexity without benefit |
| `z.toJSONSchema()` (Zod v4 native) | `zod-to-json-schema@^3.25.1` (transitive dep of SDK) | Zod v4's built-in is the canonical path; the SDK ships its own copy as a transitive dep but exposes the conversion through `registerTool`'s `inputSchema` accepting a raw Zod shape too — either path works |

**Installation:**
```bash
# Pre-install slopcheck verification
slopcheck install @modelcontextprotocol/sdk --json
# Install (pin minor to 1.29):
npm install @modelcontextprotocol/sdk@^1.29.0
```

**Version verification (2026-05-31):**
- `npm view @modelcontextprotocol/sdk version` → `1.29.0` [VERIFIED: npm registry]
- `npm view @modelcontextprotocol/sdk@1.29.0 peerDependencies` → `{ zod: "^3.25 || ^4.0" }` — compatible with project `zod@4.4.3` [VERIFIED: npm registry]
- Direct deps include: `ajv`, `ajv-formats`, `content-type`, `cors`, `cross-spawn`, `eventsource`, `eventsource-parser`, `express` (heavy but tree-shake unused), `hono`, `jose`, `json-schema-typed`, `pkce-challenge`, `raw-body`, `zod-to-json-schema`. These are **transitive deps not used by the router's import paths**: the router imports only from `@modelcontextprotocol/sdk/server/mcp.js`, `/server/streamableHttp.js`, and `/types.js` — no Express/Hono surface area touched.

## Package Legitimacy Audit

> slopcheck was not invokable in this research session (no `slopcheck` binary on path; `pip install slopcheck` not attempted in researcher context). Following the package_legitimacy_protocol graceful-degradation rule, every recommended package below is tagged `[ASSUMED]` and the planner MUST gate the install behind a `checkpoint:human-verify` task.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@modelcontextprotocol/sdk@1.29.0` | npm | published 2026-03-30 (~2 months) per STACK.md | High (official org) | github.com/modelcontextprotocol/typescript-sdk | not run [ASSUMED] | Approved with `checkpoint:human-verify` before `npm install` |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none (but `[ASSUMED]` until planner runs slopcheck at execution time)

**Defense-in-depth verification (planner MUST do these in the first task that touches package.json):**
1. `npm view @modelcontextprotocol/sdk@1.29.0 repository.url` → must equal `git+https://github.com/modelcontextprotocol/typescript-sdk.git`
2. `npm view @modelcontextprotocol/sdk@1.29.0 maintainers` → must include an `@modelcontextprotocol` org user
3. `npm view @modelcontextprotocol/sdk@1.29.0 scripts.postinstall` → must be empty/undefined
4. After install, verify integrity hash matches `npm view @modelcontextprotocol/sdk@1.29.0 dist.integrity`

## Architecture Patterns

### System Architecture Diagram

```
                                           ┌──────────────────────────────┐
                                           │  MCP Client (n8n trigger /   │
                                           │  Claude Desktop / Cursor)    │
                                           └────────────┬─────────────────┘
                                                        │ Streamable HTTP
                                                        │ Authorization: Bearer <token>
                                                        │ POST / GET / DELETE /mcp
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Fastify root scope (router/src/app.ts)                                          │
│   onRequest:  bearerHook  ───►  (rateLimit hook, if Valkey)                     │
│   preHandler: scopedIdsPreHandler ─► agentIdPreHandler (pino .child() once)     │
│                                                       │                         │
│                              app.route('/mcp', POST|GET|DELETE) ───────┐        │
│                                                       │                ▼        │
│                                          ┌─────────────────────────────────┐    │
│                                          │ MCP Plugin (router/src/mcp/host)│    │
│                                          │   sessionMap: Map<sid, Transport>│   │
│                                          │   gcTimer: setInterval (30 min) │    │
│                                          │   onClose hook: race(close, 5s) │    │
│                                          │                                 │    │
│                                          │   POST → existing? reuse        │    │
│                                          │        : isInitializeRequest?   │    │
│                                          │          create transport       │    │
│                                          │            + register tools     │    │
│                                          │   GET  → reuse sid for SSE pull │    │
│                                          │   DELETE → close session        │    │
│                                          │                                 │    │
│                                          │  transport.handleRequest(       │    │
│                                          │      req.raw, reply.raw,        │    │
│                                          │      req.body                   │    │
│                                          │  )                              │    │
│                                          └────────┬───────────────────────┘    │
│                                                   │ JSON-RPC dispatch          │
│                                                   ▼                            │
│                  ┌────────────────────────────────────────────────────┐        │
│                  │ McpServer tool handlers (5 of them)                │        │
│                  │   each: applyPreflight(model, opts)                │        │
│                  │           ↓ (throws → catch → toOpenAIErrorEnvelope)│       │
│                  │         capability gate                            │        │
│                  │           ↓                                        │        │
│                  │         canonical = …RequestToCanonical({...args, │        │
│                  │                                stream: false})     │        │
│                  │           ↓                                        │        │
│                  │         adapter = deps.makeAdapter(entry)          │        │
│                  │           ↓                                        │        │
│                  │         await adapter.chatCompletionsCanonical(    │        │
│                  │             canonical, controller.signal)          │        │
│                  │           ↓                                        │        │
│                  │         metrics.observe()                          │        │
│                  │           ↓                                        │        │
│                  │         bufferedWriter.push({protocol:'mcp', ...}) │        │
│                  │           ↓                                        │        │
│                  │         return { content: [{text:…}],              │        │
│                  │                  structuredContent: <canonical>}   │        │
│                  └────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────────────────┘
                                                   │
                ┌──────────────────────────────────┼──────────────────────────────┐
                ▼                                  ▼                              ▼
        ┌───────────────┐                  ┌──────────────┐              ┌─────────────────┐
        │ BackendAdapter│ ──── HTTP ───▶  │ Ollama /     │              │ bufferedWriter   │
        │ (Ollama, vLLM,│                  │ llama.cpp /  │              │ → Postgres        │
        │  llama.cpp,   │                  │ vLLM / cloud │              │ request_log     │
        │  ollama-cloud)│                  └──────────────┘              │ (protocol='mcp')│
        └───────────────┘                                                 └─────────────────┘
```

### Recommended Project Structure

```
router/src/
├── mcp/
│   └── host/                                # all new (Phase 15)
│       ├── plugin.ts                        # Fastify multi-method route + sessionMap + gcTimer + onClose
│       ├── tools/
│       │   ├── chat-completion.ts           # registerChatCompletionTool(server, deps)
│       │   ├── create-response.ts           # registerCreateResponseTool(server, deps)
│       │   ├── create-embedding.ts          # registerCreateEmbeddingTool(server, deps)
│       │   ├── rerank.ts                    # registerRerankTool(server, deps)
│       │   └── list-models.ts               # registerListModelsTool(server, deps)
│       ├── session-gc.ts                    # GC sweep + Promise.race shutdown (5s)
│       └── index.ts                         # re-export mcpHostPlugin
├── dispatch/                                # NEW directory — applyPreflight helper
│   └── preflight.ts                         # applyPreflight(model, opts)
└── (existing tree unchanged below this point)

router/src/routes/v1/                        # MODIFIED in Phase 15
├── chat-completions.ts                      # ← swap inline resolve+gate+breaker for applyPreflight
├── messages.ts                              # ← same
├── embeddings.ts                            # ← same
├── rerank.ts                                # ← same
├── responses.ts                             # ← same
└── models.ts                                # ← add cloud_allowed projection + allowlist filter (D-10/D-11)

router/src/metrics/registry.ts               # ← add 2 metric registrations (D-07)
router/src/metrics/recordOutcome.ts          # ← widen OutcomeContext.protocol union to include 'mcp'
router/src/config/env.ts                     # ← add MCP_ENABLED, MCP_SESSION_TTL_SEC, MCP_GC_INTERVAL_MS
router/src/app.ts                            # ← single app.register(mcpHostPlugin, { ... }) call
router/.env.example                          # ← document 3 new env vars
DEPLOY.md, README.md                         # ← add MCP host section (bare endpoint + tools list + env vars)
bin/smoke-test-router.sh                     # ← add minimal MCP smoke (initialize + tools/list + list_models tools/call)
```

### Pattern 1: Streamable HTTP Multi-Method Route (the route boilerplate)

**What:** Single Fastify route that handles `POST /mcp` (client→server messages), `GET /mcp` (server→client SSE pull), and `DELETE /mcp` (session termination) per the MCP Streamable HTTP transport spec (2025-11-25 revision).

**When to use:** Always — this is the canonical pattern documented in the SDK's `simpleStreamableHttp.ts` example (referenced from `docs/server.md`) and adopted by every community-published example.

**Why three methods (the planner needs to know this):**
- `POST /mcp` is the primary path: every JSON-RPC request (initialize, tools/list, tools/call, etc.) arrives via POST.
- `GET /mcp` is the SSE upgrade path: a stateful client opens a long-lived GET to receive server-initiated notifications (resource changes, sampling requests, etc.) — **even though our tool handlers don't emit notifications in v0.11.0**, the spec requires the endpoint to exist and at minimum return 405 for unknown sessions; without it, conformant clients (Claude Desktop, MCP Inspector) refuse to initialize.
- `DELETE /mcp` is the explicit session termination path. Without it, sessions are only garbage-collected by the GC sweep or `onClose`/SIGTERM hook.

**Reference implementation sketch (planner copies + adapts):**
```ts
// router/src/mcp/host/plugin.ts
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory } from '../../backends/adapter.js';
import type { BufferedWriter } from '../../db/bufferedWriter.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { Env } from '../../config/env.js';
import { registerChatCompletionTool } from './tools/chat-completion.js';
import { registerCreateResponseTool } from './tools/create-response.js';
import { registerCreateEmbeddingTool } from './tools/create-embedding.js';
import { registerRerankTool } from './tools/rerank.js';
import { registerListModelsTool } from './tools/list-models.js';
import { startSessionGc, shutdownSessions } from './session-gc.js';

export interface McpHostOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  bufferedWriter: BufferedWriter;
  metrics: MetricsRegistry;     // already extended with routerMcpToolCallsTotal + routerMcpActiveSessions
  breaker: CircuitBreaker;
  env: Pick<Env, 'MCP_ENABLED' | 'MCP_SESSION_TTL_SEC' | 'MCP_GC_INTERVAL_MS'>;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivityAt: number;
}

export const mcpHostPlugin: FastifyPluginAsync<McpHostOpts> = async (app, opts) => {
  if (!opts.env.MCP_ENABLED) {
    app.log.info('MCP_ENABLED=false — skipping /mcp registration');
    return;
  }

  const sessionMap = new Map<string, SessionEntry>();

  // Helper: build a fresh McpServer + register all 5 tools
  const buildServer = (): McpServer => {
    const server = new McpServer(
      { name: 'local-llms-router', version: '0.11.0' },
      { capabilities: { tools: {} } },
    );
    registerChatCompletionTool(server, opts);
    registerCreateResponseTool(server, opts);
    registerCreateEmbeddingTool(server, opts);
    registerRerankTool(server, opts);
    registerListModelsTool(server, opts);
    return server;
  };

  // Single multi-method route — root scope inherits bearer + scopedIds + agentId hooks.
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const sessionId = req.headers['mcp-session-id'];
      const sid = typeof sessionId === 'string' ? sessionId : Array.isArray(sessionId) ? sessionId[0] : undefined;

      let entry: SessionEntry | undefined = sid ? sessionMap.get(sid) : undefined;

      if (entry) {
        // Existing session — bump lastActivityAt + delegate.
        entry.lastActivityAt = Date.now();
      } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
        // New initialization request — create transport + server.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid: string) => {
            entry = { transport, server, lastActivityAt: Date.now() };
            sessionMap.set(newSid, entry);
            opts.metrics.routerMcpActiveSessions.set(sessionMap.size);
            req.log.info({ mcp_session_id: newSid }, 'mcp session initialized');
          },
        });
        const server = buildServer();
        await server.connect(transport);
        // Stash a pre-init entry; the onsessioninitialized callback above overwrites
        // with the durable entry after the SDK assigns the session id.
        entry = { transport, server, lastActivityAt: Date.now() };
      } else {
        // No session id + not an initialize request → 400.
        reply.code(400).send({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request: missing Mcp-Session-Id and not an initialize request' },
          id: null,
        });
        return;
      }

      // Delegate to the SDK transport. handleRequest writes to reply.raw directly.
      try {
        await entry.transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err, mcp_session_id: sid }, 'mcp transport.handleRequest threw');
        // The SDK transport normally writes the JSON-RPC error frame itself; this is
        // the defense-in-depth path for synchronous setup throws (e.g., body parse
        // failures before transport.handleRequest takes over reply.raw).
        if (!reply.raw.headersSent) {
          reply.code(500).send({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal mcp transport error' },
            id: null,
          });
        }
      }
    },
  });

  // GC sweep — clears sessions whose lastActivityAt is older than TTL.
  const gcTimer = startSessionGc({
    sessionMap,
    ttlSec: opts.env.MCP_SESSION_TTL_SEC,
    intervalMs: opts.env.MCP_GC_INTERVAL_MS,
    metrics: opts.metrics,
    log: app.log,
  });

  // SIGTERM cleanup: Promise.race(closeAll, 5s timeout). See Pattern 2 below.
  app.addHook('onClose', async () => {
    clearInterval(gcTimer);
    await shutdownSessions(sessionMap, app.log);
    opts.metrics.routerMcpActiveSessions.set(0);
  });
};
```

**Wiring in `app.ts`** (single line addition after `FastifySSEPlugin` registration ~line 243):
```ts
await app.register(mcpHostPlugin, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
  bufferedWriter: opts.bufferedWriter,
  metrics: opts.metrics,
  breaker,
  env: { MCP_ENABLED: opts.env?.MCP_ENABLED ?? true, MCP_SESSION_TTL_SEC: opts.env?.MCP_SESSION_TTL_SEC ?? 3600, MCP_GC_INTERVAL_MS: opts.env?.MCP_GC_INTERVAL_MS ?? 1_800_000 },
});
```
(Planner widens `BuildAppOpts.env` Pick to include the three new keys.)

### Pattern 2: Session GC + Race-Free SIGTERM Shutdown

**What:** A `setInterval` timer that sweeps the session map every `MCP_GC_INTERVAL_MS` (30 min default) and closes any transport whose `lastActivityAt` is older than `MCP_SESSION_TTL_SEC` (1 hour default). On `onClose`, all remaining sessions are closed via `Promise.race([Promise.allSettled(...), setTimeout(5_000)])` — the 5-second ceiling prevents a single wedged transport from blocking SIGTERM beyond Compose's 10-second `stop_grace_period`.

**When to use:** Required — P1-04 BLOCK. Without GC, idle MCP sessions accumulate in memory over weeks-long container uptimes.

**Reference implementation sketch:**
```ts
// router/src/mcp/host/session-gc.ts
import type { Logger } from 'pino';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MetricsRegistry } from '../../metrics/registry.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivityAt: number;
}

export interface SessionGcOpts {
  sessionMap: Map<string, SessionEntry>;
  ttlSec: number;
  intervalMs: number;
  metrics: MetricsRegistry;
  log: Logger;
}

export function startSessionGc(opts: SessionGcOpts): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    const ttlMs = opts.ttlSec * 1000;
    const stale: string[] = [];
    for (const [sid, entry] of opts.sessionMap) {
      if (now - entry.lastActivityAt > ttlMs) stale.push(sid);
    }
    for (const sid of stale) {
      const entry = opts.sessionMap.get(sid);
      if (entry) {
        // transport.close() returns a Promise; fire-and-forget — GC sweep doesn't await.
        // We log the error if close rejects but don't rethrow (idle session cleanup
        // must not crash the timer).
        void entry.transport.close().catch((err) => {
          opts.log.warn({ err, mcp_session_id: sid }, 'mcp gc: transport.close() rejected');
        });
        opts.sessionMap.delete(sid);
      }
    }
    if (stale.length > 0) {
      opts.metrics.routerMcpActiveSessions.set(opts.sessionMap.size);
      opts.log.info({ swept_count: stale.length, remaining: opts.sessionMap.size }, 'mcp session gc swept idle sessions');
    }
  }, opts.intervalMs);
  // Don't keep the event loop alive solely for the GC sweep — same pattern as bufferedWriter timer.
  timer.unref?.();
  return timer;
}

export async function shutdownSessions(
  sessionMap: Map<string, SessionEntry>,
  log: Logger,
): Promise<void> {
  const sessions = Array.from(sessionMap.values());
  if (sessions.length === 0) return;
  log.info({ count: sessions.length }, 'mcp shutdown: closing active sessions');
  await Promise.race([
    Promise.allSettled(sessions.map((s) => s.transport.close())),
    new Promise<void>((resolve) =>
      // 5s hard ceiling — Compose's default stop_grace_period is 10s, this leaves room
      // for the bufferedWriter.drain(3_000) to also complete (app.ts onClose chain).
      setTimeout(() => {
        log.warn({ count: sessions.length }, 'mcp shutdown: 5s timeout — abandoning unresponsive sessions');
        resolve();
      }, 5_000),
    ),
  ]);
  sessionMap.clear();
}
```

**Ordering in `app.ts` onClose chain** (existing chain ~line 648):
1. `liveness.stop()`
2. `probeAdapters.clear()`
3. `semaphoreMap.clear()`
4. `opts.usageDailyScheduler?.stop()`
5. **NEW:** MCP plugin's own onClose fires here (since `app.register(mcpHostPlugin)` adds it after the others)
6. `if (opts.valkey) await closeValkey(...)`
7. `await opts.bufferedWriter.drain(3_000)`

The MCP plugin's onClose is registered via `app.addHook('onClose', …)` inside `mcpHostPlugin` — Fastify v5 fires `onClose` hooks in registration order, so this runs **after** the main app.ts onClose body completes. Verified pattern in `app.ts:648-661` already uses identical `await Promise.race([..., setTimeout(...)])` shape for `bufferedWriter.drain`.

### Pattern 3: Tool Registration via `z.toJSONSchema()` Passthrough

**What:** Each tool handler imports the existing route Zod schema and emits its JSON Schema 2020-12 form via `z.toJSONSchema()` (Zod v4 native, no extra dependency). The MCP SDK's `registerTool(...)` accepts the JSON Schema directly as `inputSchema`. This is the D-01 "full passthrough" locked decision.

**When to use:** Always — D-01 is non-negotiable. Hand-authored MCP schemas drift (P1-03 BLOCK).

**Reference implementation sketch:**
```ts
// router/src/mcp/host/tools/chat-completion.ts
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChatCompletionRequestSchema } from '../../../routes/v1/chat-completions.js';
import { openAIRequestToCanonical } from '../../../translation/openai-in.js';
import { canonicalToOpenAIResponse } from '../../../translation/openai-out.js';
import { toOpenAIErrorEnvelope } from '../../../errors/envelope.js';
import { applyPreflight } from '../../../dispatch/preflight.js';
import { computeCostCents } from '../../../cost/computeCostCents.js';
import { deriveStatusClass, mapErrorToCode, truncateAndRedact } from '../../../metrics/recordOutcome.js';
import type { McpHostOpts } from '../plugin.js';

export function registerChatCompletionTool(server: McpServer, deps: McpHostOpts): void {
  server.registerTool(
    'chat_completion',
    {
      title: 'OpenAI-compatible chat completion',
      description:
        'OpenAI-compatible chat completion. Streaming via MCP is NOT supported in v0.11.0 — set stream:false or omit. ' +
        'Use HTTP POST /v1/chat/completions directly for SSE.',
      // D-01: passthrough — every option HTTP callers have is available to MCP callers.
      inputSchema: z.toJSONSchema(ChatCompletionRequestSchema),
    },
    async (args, extra) => {
      const t0 = performance.now();
      const controller = new AbortController();
      extra.signal.addEventListener('abort', () => controller.abort()); // D-14

      // Note: `req` is not in scope here because the SDK calls this from a JSON-RPC
      // dispatch — but the OUTER request context (scopedIds, agentId, pino child)
      // was already established on the /mcp HTTP request. The plugin captures `req`
      // via closure when handing the request to the transport; tool handlers read
      // scoped IDs via the captured request context (see Pattern 4 below for the
      // plumbing detail — this snippet elides it for brevity).

      let backend = 'unknown';
      let model = 'unknown';
      let canonicalResp: import('../../../translation/canonical.js').CanonicalResponse | undefined;
      let caughtErr: Error | undefined;

      try {
        // D-09: applyPreflight = resolve + policy gate + breaker.check (single helper).
        const entry = await applyPreflight(args.model, { registry: deps.registry, breaker: deps.breaker });
        backend = entry.backend;
        model = entry.name;

        // Per-tool capability check stays here (D-09) — chat_completion needs no specific
        // capability check beyond what HTTP /v1/chat/completions enforces today (vision,
        // tools, json_mode are per-message branches; reuse the same pattern).

        // D-12: silent stream coercion.
        const canonical = openAIRequestToCanonical({ ...args, model: entry.backend_model, stream: false });

        const adapter = deps.makeAdapter(entry);
        canonicalResp = await adapter.chatCompletionsCanonical(canonical, controller.signal);

        // D-02 + D-03: dual-shape return.
        const openAiResp = canonicalToOpenAIResponse(canonicalResp);
        const assistantText = extractAssistantText(canonicalResp); // helper: joins text blocks

        return {
          content: [{ type: 'text' as const, text: assistantText }],
          structuredContent: openAiResp,
        };
      } catch (err) {
        caughtErr = err instanceof Error ? err : new Error(String(err));
        // D-04: reuse existing envelope mapping.
        const env = toOpenAIErrorEnvelope(caughtErr);
        // env may be NO_ENVELOPE (client-disconnect); guard.
        const errorPayload =
          typeof env === 'symbol'
            ? { error: 'client_disconnect', code: 'client_disconnect', message: 'client disconnected' }
            : { error: env.error.type, code: env.error.code, message: env.error.message };
        return {
          content: [{ type: 'text' as const, text: errorPayload.message }],
          structuredContent: errorPayload,
          isError: true,
        };
      } finally {
        // D-05: one request_log row per MCP tool call. Push via bufferedWriter.
        const httpStatus = caughtErr ? mapHttpStatusOrDefault(caughtErr, 500) : 200;
        const statusClass = deriveStatusClass(httpStatus, controller.signal.aborted);
        const durationMs = performance.now() - t0;
        const tokensIn = canonicalResp?.usage.input_tokens;
        const tokensOut = canonicalResp?.usage.output_tokens;
        const costCents = canonicalResp
          ? computeCostCents({ entry: deps.registry.resolve(model), tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 }) ?? undefined
          : undefined;

        deps.metrics.requestsTotal.inc({ protocol: 'mcp', backend, model, status_class: statusClass });
        deps.metrics.requestDurationSeconds.observe({ protocol: 'mcp', backend, model }, durationMs / 1000);
        if (tokensIn) deps.metrics.tokensTotal.inc({ protocol: 'mcp', backend, model, direction: 'input' }, tokensIn);
        if (tokensOut) deps.metrics.tokensTotal.inc({ protocol: 'mcp', backend, model, direction: 'output' }, tokensOut);
        deps.metrics.routerMcpToolCallsTotal.inc({ tool: 'chat_completion', status_class: statusClass });

        // bufferedWriter.push — note `protocol: 'mcp'` is a NEW value but requires NO migration
        // because request_log.protocol is free-text TEXT NOT NULL (verified 2026-05-31 against
        // db/migrations/0000_init.sql line 5 — no CHECK constraint).
        deps.bufferedWriter.push({
          ts: new Date(),
          protocol: 'mcp', // <-- the new value; widens OutcomeContext.protocol union
          route: '/mcp',
          backend,
          model,
          status_class: statusClass,
          http_status: httpStatus,
          tokens_in: tokensIn ?? null,
          tokens_out: tokensOut ?? null,
          ttft_ms: null, // not applicable inside non-stream MCP tool
          latency_ms: Math.round(durationMs),
          error_code: caughtErr ? mapErrorToCode(caughtErr) : null,
          error_message: caughtErr ? truncateAndRedact(caughtErr.message) : null,
          agent_id: capturedReq.agentId ?? null,        // closure over /mcp HTTP request — D-06
          tenant_id: capturedReq.tenantId ?? null,
          project_id: capturedReq.projectId ?? null,
          workload_class: capturedReq.workloadClass ?? null,
          request_id: capturedReq.id,
          upstream_message_id: canonicalResp?.id ?? null,
          idempotency_key: null,                         // D-13: MCP-level idempotency is HTTP-only
          cost_cents: costCents ?? null,
        });
      }
    },
  );
}
```

**Note on `capturedReq`:** The MCP SDK's tool handler signature is `async (args, extra) => …` — it does **not** receive the Fastify `req`. The plugin must capture `req` in a closure when handing off to `transport.handleRequest(...)`. Pattern 4 below.

### Pattern 4: Capturing `req` into Tool Handler Scope

**What:** Tool handlers need access to `req.tenantId`, `req.projectId`, `req.agentId`, `req.workloadClass`, `req.id`, `req.log` — all populated by `scopedIdsPreHandler` + `agentIdPreHandler` on the **outer** HTTP request. The MCP SDK does not thread Fastify's `req` into tool handlers. We must build the server + register tools **per-request** for new sessions (closing over `req`), OR build once and pass `req` via an `AsyncLocalStorage` context.

**Recommended approach (simpler):** Build `McpServer` + register tools **once per session** (at initialize time), closing over the request that created the session. All subsequent tool calls on that session use the originating request's scoped IDs.

This is **consistent with D-06**: "All N tool calls in a single JSON-RPC payload share the same scoped identity" — and extends naturally to "All tool calls within the lifetime of a session share the originating request's scoped identity, since the session is bound to a single MCP client connection which sends one set of headers at initialize time."

**Reference sketch:**
```ts
// Inside the multi-method /mcp handler:
if (req.method === 'POST' && isInitializeRequest(req.body)) {
  const transport = new StreamableHTTPServerTransport({ /* ... */ });
  const capturedReq = req;  // closure over the originating Fastify request
  const server = buildServerForRequest(capturedReq, opts);  // <-- new helper
  await server.connect(transport);
  // ...
}

// router/src/mcp/host/plugin.ts
function buildServerForRequest(req: FastifyRequest, opts: McpHostOpts): McpServer {
  const server = new McpServer({ name: 'local-llms-router', version: '0.11.0' }, { capabilities: { tools: {} } });
  // Each tool registration closes over `req` for scoped IDs + req.log child:
  registerChatCompletionTool(server, opts, req);
  registerCreateResponseTool(server, opts, req);
  registerCreateEmbeddingTool(server, opts, req);
  registerRerankTool(server, opts, req);
  registerListModelsTool(server, opts, req);
  return server;
}
```

**Pino child for per-tool-call log lines (D-08):** Each tool handler creates its own child off `req.log` at call time:
```ts
const toolLog = req.log.child({
  tool_name: 'chat_completion',
  mcp_session_id: extra.sessionId,        // SDK exposes this on `extra`
  mcp_request_id: extra._meta?.progressToken ?? null,  // JSON-RPC `id` field; surfaced via _meta or extra
});
```
This **does NOT trip the Pitfall-9 grep gate** (`grep -rn 'req\.log = ' router/src/` must equal 1). The Pitfall-9 invariant gates **reassignment of `req.log`**, not creation of detached child loggers. The tool handler uses `toolLog.info(...)` — it does NOT assign back to `req.log`.

### Pattern 5: `applyPreflight` Helper

**What:** Single shared helper that consolidates the `registry.resolve` → `applyPolicyGate` → `breaker.check` triplet currently duplicated across all 5 HTTP routes. Used by both HTTP routes (after refactor) and MCP tool handlers.

**When to use:** Always — D-09 is locked. Phase 14 surface refactor accepted as in-scope for Phase 15.

**Reference implementation:**
```ts
// router/src/dispatch/preflight.ts
import type { RegistryStore, ModelEntry } from '../config/registry.js';
import type { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { applyPolicyGate } from '../policy/gate.js';

export interface ApplyPreflightOpts {
  registry: RegistryStore;
  breaker: CircuitBreaker;
}

export interface ApplyPreflightResult {
  entry: ModelEntry;
  breakerState: 'closed' | 'half-open' | 'open';  // 'open' would have thrown — included for completeness
}

/**
 * D-09 shared helper. Runs the canonical preflight pipeline:
 *   1. registry.resolve(model)        → throws RegistryUnknownModelError (404)
 *   2. applyPolicyGate(...)           → throws AllowlistViolationError (403) or CloudNotAllowedError (403)
 *   3. await breaker.check(backend)   → throws BreakerOpenError (503)
 *
 * The breaker.check() invocation returns { state: 'closed' | 'half-open' }; on
 * state==='open' the helper throws BreakerOpenError BEFORE returning. The caller
 * stamps Retry-After header on the OUTER reply (HTTP) BEFORE the throw — for MCP
 * the header is not exposed; the structured error envelope carries the cooldown.
 *
 * D-09: capability check stays per-route/per-tool because each surface knows
 * the exact capability it requires (vision / tools / embeddings / rerank / json_mode).
 */
export async function applyPreflight(
  requested_model: string,
  opts: ApplyPreflightOpts,
): Promise<ApplyPreflightResult> {
  const snapshot = opts.registry.get();
  const entry = opts.registry.resolve(requested_model);          // 1
  applyPolicyGate(snapshot.policies, entry, requested_model);    // 2
  const breakerResult = await opts.breaker.check(entry.backend); // 3
  if (breakerResult.state === 'open') {
    // Note: HTTP route currently stamps Retry-After BEFORE throwing. Callers that
    // need the header must stamp it BEFORE invoking applyPreflight (the helper
    // cannot stamp because it doesn't own the reply). MCP callers skip the header.
    throw new (await import('../errors/envelope.js')).BreakerOpenError(entry.backend, 60);
    // ↑ The cooldownSec comes from the caller's context in HTTP routes; for MCP
    //   we use a default. Planner reconciles this minor mismatch — either inject
    //   cooldownSec into ApplyPreflightOpts or keep the throw inside the HTTP route
    //   and have applyPreflight return { state: 'open' } sentinel. Recommend the
    //   second: applyPreflight returns the state, the HTTP route still throws with
    //   its cooldownSec context, the MCP tool throws with a default 60.
  }
  return { entry, breakerState: breakerResult.state };
}
```

**HTTP route refactor (5 files):** Each route's existing
```ts
const entry = opts.registry.resolve(body.model);
// ...
applyPolicyGate(opts.registry.get().policies, entry, body.model);
// ...
const breakerResult = await opts.breaker.check(entry.backend);
if (breakerResult.state === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}
```
becomes
```ts
const { entry, breakerState } = await applyPreflight(body.model, { registry: opts.registry, breaker: opts.breaker });
if (breakerState === 'open') {
  /* unreachable — applyPreflight throws on open — kept defensively or planner picks sentinel pattern */
}
```
The planner picks one of:
- **Option A — Sentinel return:** `applyPreflight` returns `{ entry, breakerState: 'closed' | 'half-open' | 'open' }` and the caller throws (allows HTTP route to stamp Retry-After header pre-throw). Recommended.
- **Option B — Throw inside helper:** `applyPreflight` throws `BreakerOpenError`. HTTP routes lose the ability to stamp Retry-After pre-throw → must use a Fastify `setErrorHandler` extension or co-locate the header stamp.

**Recommendation:** Option A (sentinel) — preserves byte-identical HTTP wire behavior. The plan must specify which option.

### Anti-Patterns to Avoid

- **Hand-authored MCP tool input schemas** — drifts from route Zod schemas (P1-03 BLOCK). Use `z.toJSONSchema()` always.
- **Auto-discovery of routes as tools** — `/v1/models/:id`, `/metrics`, `/healthz`, etc. must NEVER appear in `tools/list`. The five-tool allowlist is hard-coded in `buildServerForRequest`.
- **Streaming inside MCP tool callbacks** — D-12 silently coerces `stream:true` to `false`. Tool descriptions document this.
- **Throwing exceptions out of tool handlers** — MCPS-04 requires `isError:true` structured returns. Always wrap in try/catch.
- **Forwarding the inbound bearer token to MCP tool handlers** — irrelevant here (router IS the bearer-protected surface). Becomes relevant only in Phase 18 MCP client (P2-04 BLOCK).
- **Reassigning `req.log` inside tool handlers** — would trip the Pitfall-9 grep gate (`grep -rn 'req\.log = ' router/src/ | wc -l` must equal 1). Use `req.log.child(...)` to create detached children; assign to a local variable, not back to `req.log`.
- **`compression` middleware on `/mcp`** — same SSE buffering pitfall as `/v1/chat/completions`. The router doesn't currently register `@fastify/compress` (verified — not in package.json), so this is preventive only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Streamable HTTP transport (POST/GET/DELETE + Mcp-Session-Id semantics) | Custom JSON-RPC parser, custom SSE writer | `StreamableHTTPServerTransport.handleRequest(req.raw, reply.raw, req.body)` | The SDK handles JSON-RPC framing, batch requests, SSE event IDs, Last-Event-Id resumption, error frames |
| JSON-RPC tool dispatch | Hand-rolled method switch on `tools/list`, `tools/call` | `McpServer.registerTool(name, opts, handler)` | The SDK owns the JSON-RPC method routing + result envelope serialization |
| Zod → JSON Schema conversion | Custom AST walker | `z.toJSONSchema()` (Zod v4 native) | Built into Zod v4; conformant with JSON Schema 2020-12 which MCP requires |
| MCP initialize handshake | Custom `initialize` JSON-RPC handler | SDK handles automatically via `isInitializeRequest` + `onsessioninitialized` callback | The handshake exchanges protocol versions, capabilities, server info — SDK encodes all 4 |
| Session id generation | Custom ULID/UUID emitter | `crypto.randomUUID()` passed as `sessionIdGenerator: () => randomUUID()` | Standard library; the SDK accepts any string-returning function |
| AbortController plumbing from transport to upstream | Custom abort propagation chain | `extra.signal.addEventListener('abort', () => controller.abort())` then `adapter.X(..., controller.signal)` | Mirrors existing HTTP route pattern (chat-completions.ts) — D-14 |

**Key insight:** The MCP SDK is the canonical reference implementation maintained by the protocol's authors. Every Streamable HTTP edge case (batch requests, partial reads, resumption, idle disconnect) is owned by `StreamableHTTPServerTransport.handleRequest`. The router's only job is to multiplex sessions and surface the existing capabilities.

## Runtime State Inventory

> Phase 15 is a **purely additive** plugin — no rename, no refactor, no string replacement, no data migration. The Phase 14 surface refactor (applyPolicyGate → applyPreflight) is a **code-only restructure of the same call chain** with byte-identical wire behavior; it does NOT touch stored data, OS state, or external service config.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — `request_log.protocol` accepts free-text TEXT NOT NULL today (verified via `db/migrations/0000_init.sql` line 5 — no CHECK constraint; verified across migrations 0001-0005 — none add a CHECK on protocol). The new value `'mcp'` writes cleanly. No data migration needed. | None — verified by grepping all migration SQL files |
| Live service config | None — n8n / Open WebUI / Unsloth Studio consume the router via existing HTTP endpoints; `/mcp` is a brand-new endpoint with no prior config in those services. n8n's MCP Trigger node is the planned consumer (per memory note `project_n8n_integration.md`) — it will be configured **after** Phase 15 ships, with the bearer token already in use for `/v1/*` endpoints. | None — external services wire to `/mcp` only after this phase delivers |
| OS-registered state | None — pm2 / systemd / cloudflared all point at `localhost:3210` (memory note `project_cloudflare_tunnel.md`); the `/mcp` path is served by the same Node process and inherits the tunnel mapping automatically (`https://local-llms.luishelguera.dev/mcp` works without DNS/tunnel changes). | None — verified by reviewing the Cloudflare Tunnel memory note |
| Secrets/env vars | Three NEW env vars introduced (D-15): `MCP_ENABLED`, `MCP_SESSION_TTL_SEC`, `MCP_GC_INTERVAL_MS`. All have safe defaults — operators can deploy without setting them. Existing `ROUTER_BEARER_TOKEN` is reused verbatim (MCPS-02). | Plan: add three Zod-validated entries to `EnvSchema` in `router/src/config/env.ts`; document in `router/.env.example` + DEPLOY.md |
| Build artifacts / installed packages | `@modelcontextprotocol/sdk@^1.29.0` is **not yet installed** in `router/node_modules/` (verified by `ls router/node_modules/@modelcontextprotocol/` → not found). Plan must add it as a production dependency in `router/package.json` and run `npm install`. The package adds ~15 transitive deps (`ajv`, `cors`, `express`, `hono`, `jose`, etc.) but the router imports only from `/server/mcp.js`, `/server/streamableHttp.js`, `/types.js` — tree-shake-safe at the bundler level (tsup). | Plan: `npm install @modelcontextprotocol/sdk@^1.29.0` gated behind slopcheck verification (per package legitimacy gate) |

**The canonical question:** *After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?* — **Nothing.** This phase is additive; no string is being renamed or removed.

## Common Pitfalls

### Pitfall 1: P1-01 BLOCK — Wrong Transport (stdio default)

**What goes wrong:** A developer copies a tutorial that imports `StdioServerTransport` and the router ends up shipping with stdio enabled by env flag. n8n refuses to connect (no stdio support — issue #24967 documented 95M-request retry storm).

**Why it happens:** SDK quickstart examples default to stdio for zero-auth local testing.

**How to avoid:** **Never import `StdioServerTransport` from `@modelcontextprotocol/sdk` anywhere in the router codebase.** The only imports allowed from the SDK are: `McpServer` (from `/server/mcp.js`), `StreamableHTTPServerTransport` (from `/server/streamableHttp.js`), `isInitializeRequest` (from `/types.js`). The plan must include a grep gate: `grep -rn 'StdioServerTransport' router/src/ | wc -l` must equal `0`.

**Mitigation evidence (in this codebase):** No mention of stdio anywhere — verified by searching CONTEXT.md, ROADMAP.md, REQUIREMENTS.md (MCPS-06: "Stdio transport is NOT exposed in v0.11.0").

**Warning signs:** Tutorial-style code adding `StdioServerTransport`; any subprocess-spawn pattern around MCP.

### Pitfall 2: P1-02 BLOCK — Auth Conflict (route exclusion vs inheritance)

**What goes wrong:** The MCP plugin is registered in a child Fastify scope that explicitly skips the root `onRequest` bearer hook → `/mcp` becomes unauthenticated. OR the plugin adds its own bearer hook that doesn't match the root token → 401 storms.

**Why it happens:** Fastify route-level vs root-level hook scope is subtle. Registering via `app.register(plugin, { prefix: '/mcp' })` is a child scope but inherits root hooks UNLESS the plugin explicitly skips them.

**How to avoid:** Use **single-route registration with no child scope** OR register the plugin without disturbing the root-scope auth hook. Verified pattern in this codebase: `app.ts:275` registers `makeBearerHook(opts.bearerToken)` as a root `onRequest` hook with a `PUBLIC_PATHS` set of `{ '/healthz', '/readyz', '/metrics' }` — `/mcp` is **not** in PUBLIC_PATHS, so the bearer hook fires automatically. `auth/bearer.ts:25` is the file to NOT modify.

**Mitigation evidence:** Phase 14 plan-14-06 already added scopedIds + agentId hooks via `app.addHook('preHandler', ...)` at root scope; they fire on every non-public path including the future `/mcp`. The MCPS-02 verification test is straightforward: POST `/mcp` without `Authorization` → 401 envelope (existing `BearerAuthError` → `toOpenAIErrorEnvelope` path).

**Warning signs:** `app.register(plugin, { prefix: '/mcp', /* ... */ })` with any `onRequest`/`preHandler` opt; any modification of `auth/bearer.ts` `PUBLIC_PATHS`.

### Pitfall 3: P1-03 BLOCK — Tool Manifest Drift

**What goes wrong:** Route schema evolves (e.g., adding `return_documents: boolean` to rerank); the hand-authored MCP tool inputSchema does not change; cached clients call with old shape → 400.

**Why it happens:** Two sources of truth.

**How to avoid:** **D-01 makes this impossible by construction.** Every tool calls `z.toJSONSchema(<route schema>)`. The plan must verify each tool file imports its schema from the route module, not from a duplicate location.

**Mitigation evidence:** Grep gate `grep -rn 'inputSchema' router/src/mcp/host/tools/` must show only `z.toJSONSchema(<imported schema>)` patterns — never hand-authored object literals with field names. Add a vitest unit that snapshots each tool's emitted JSON Schema; CI fails on unintended drift.

**Warning signs:** Any hand-authored object literal under `inputSchema:`; any duplicate `z.object({...})` declaration inside `router/src/mcp/host/tools/`.

### Pitfall 4: P1-04 BLOCK — Stale Sessions + SIGTERM Cleanup

**What goes wrong:** Sessions accumulate in `sessionMap` for weeks; memory grows monotonically. SIGTERM kills in-flight tool handlers mid-execution; some MCP clients hang on a never-closed transport.

**Why it happens:** SDK does not provide built-in idle GC (Issue #812); `StdioClientTransport.close()` is known buggy (Issue #532).

**How to avoid:** 
1. **GC sweep** every `MCP_GC_INTERVAL_MS` (30 min default) — Pattern 2 above. `setInterval` with `unref()` so it doesn't keep the event loop alive.
2. **SIGTERM cleanup** via `app.addHook('onClose', …)` — `Promise.race([Promise.allSettled(transport.close), 5s timeout])`. Pattern 2 above.
3. **`router_mcp_active_sessions` gauge** updated on session create / GC / SIGTERM — observable canary.

**Mitigation evidence:** Pattern 2 implementation sketch above. The Compose `stop_grace_period` default is 10s; 5s for MCP + 3s for `bufferedWriter.drain` = 8s fits comfortably.

**Warning signs:** No `setInterval` in `router/src/mcp/host/`; no `clearInterval(gcTimer)` in onClose; no `Promise.race` with `setTimeout` around `transport.close()` calls.

### Pitfall 5: P1-05 FLAG — Exposing Internal Endpoints as MCP Tools

**What goes wrong:** Helpful developer registers `reload_registry`, `get_metrics`, or `delete_session` tools. Any MCP client (potentially compromised n8n agent) can now hot-reload the registry or read internal metrics.

**Why it happens:** Tempting to expose every router capability uniformly.

**How to avoid:** **Hard-code the 5-tool allowlist in `buildServerForRequest`.** Five `register{X}Tool` calls — no loop, no iterate-over-routes pattern. Plan adds a vitest assertion: `expect(toolsList).toHaveLength(5)` and asserts the exact set `{chat_completion, create_response, create_embedding, rerank, list_models}`.

**Mitigation evidence:** CONTEXT D-09 + the Pattern 1 sketch above explicitly lists the 5 tool registrations.

**Warning signs:** Any `for (const route of …) server.registerTool(...)` pattern; any tool name containing `reload`, `admin`, `metrics`, `debug`, `config`, `delete`, `internal`.

### Pitfall 6: P1-06 FLAG — Streaming Backpressure + Abort Propagation

**What goes wrong:** MCP client cancels mid-stream; upstream backend (Ollama, vLLM, llama.cpp) keeps generating tokens until completion or breaker trip; VRAM wasted; concurrent requests may OOM.

**Why it happens:** MCP tool calls are request-response; streaming-inside-tool is invisible to the transport layer; without explicit `AbortController` wiring, upstream abort never fires.

**How to avoid:** **D-12 eliminates this by silently coercing `stream: true` to `false`** — there is no streaming inside an MCP tool handler in v0.11.0, so there is no backpressure to manage. **D-14 wires `extra.signal` → `controller.abort()` → `adapter.X(canonical, controller.signal)`** anyway, so even a non-stream call gets cancelled cleanly if the MCP transport closes.

**Mitigation evidence:** Both decisions locked in CONTEXT.md. Pattern 3 above includes the exact `extra.signal.addEventListener('abort', () => controller.abort())` + `adapter.chatCompletionsCanonical(canonical, controller.signal)` plumbing.

**Warning signs:** Any tool handler that calls `adapter.chatCompletionsCanonicalStream(...)` (must be `chatCompletionsCanonical` non-stream); any tool handler that ignores `extra.signal`.

### Pitfall 7: Outcome row schema drift (`OutcomeContext.protocol` union)

**What goes wrong:** Adding `protocol: 'mcp'` to `bufferedWriter.push(...)` calls without widening `OutcomeContext.protocol` from `'openai' | 'anthropic'` to `'openai' | 'anthropic' | 'mcp'` produces TypeScript errors at every push site — OR worse, an `as any` cast hides the drift.

**Why it happens:** TS union narrowing.

**How to avoid:** Widen `OutcomeContext.protocol` in `router/src/metrics/recordOutcome.ts:64` from `'openai' | 'anthropic'` to `'openai' | 'anthropic' | 'mcp'`. The `metrics.requestsTotal` and `metrics.requestDurationSeconds` label types are not narrowly typed (`prom-client` accepts any string for label values), so no further widening is needed at the metrics layer.

**Mitigation evidence:** Verified by reading `router/src/metrics/recordOutcome.ts:64`.

**Warning signs:** Any `as 'openai' | 'anthropic'` cast on the new MCP code paths; any `// @ts-ignore` near `bufferedWriter.push`.

### Pitfall 8: `agent_id` may be absent on MCP tool log lines (D-06 / D-08 interaction)

**What goes wrong:** MCP clients (n8n, Claude Desktop) may not send `X-Agent-Id` on the outer `POST /mcp` — they have no notion of agent identity. The pino child created by `agentIdPreHandler` has `agent_id: undefined`, which pino silently drops. Tool-call log lines therefore lack `agent_id`. Operators querying logs by agent_id miss MCP tool calls.

**Why it happens:** D-06 inherits agent_id from outer HTTP request; outer request may not carry the header.

**How to avoid:** **Accepted in-scope behavior** (D-06 explicit). Operators wanting MCP tool calls in agent-scoped queries should configure their MCP clients to include `X-Agent-Id`. Document in DEPLOY.md under the MCP host section: "MCP tool calls are scoped by `X-Agent-Id` set on the **initial** `POST /mcp` request; configure your MCP client (n8n MCP Trigger node, etc.) to forward this header."

**Mitigation evidence:** CONTEXT D-06 documents this; `agentIdPreHandler` line 95-104 already does the right thing — `req.agentId` stays `undefined` when header is absent, and the pino child's `.child({agent_id: undefined, ...})` correctly omits the field (verified by reading `agentId.ts:120-125` + pino docs).

**Warning signs:** Operator complaint that MCP tool calls don't appear in agent-scoped queries; resolved by header configuration on the MCP client side.

## Code Examples

### Example 1: `applyPreflight` Helper (Pattern 5)

See Pattern 5 above. File: `router/src/dispatch/preflight.ts`.

### Example 2: MCP Tool Registration (chat_completion)

See Pattern 3 above. File: `router/src/mcp/host/tools/chat-completion.ts`.

### Example 3: `list_models` Tool + HTTP Route Sync (D-10/D-11)

```ts
// router/src/mcp/host/tools/list-models.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpHostOpts } from '../plugin.js';
import type { FastifyRequest } from 'fastify';

export function registerListModelsTool(server: McpServer, deps: McpHostOpts, req: FastifyRequest): void {
  server.registerTool(
    'list_models',
    {
      title: 'List available models',
      description: 'Returns the policy-filtered set of models available via the router, with cloud_allowed annotation per entry. Backend identity is intentionally hidden.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },  // no inputs in v0.11.0 (MCPS-FUT-02 deferred filter_by_capability)
    },
    async (_args, _extra) => {
      const snapshot = deps.registry.get();
      const allow = snapshot.policies?.default?.model_allowlist ?? [];
      const entries = snapshot.models.filter((m) => allow.length === 0 || allow.includes(m.name));
      const data = entries.map((e) => ({
        id: e.name,
        object: 'model' as const,
        created: deps.registry.getCreatedAtSec(),
        owned_by: 'local-llms' as const,
        capabilities: e.capabilities,
        // D-11 + D-10: new policy annotation. Backend stays hidden (T-3-A2).
        policy: { cloud_allowed: e.policy?.cloud_allowed ?? true },
      }));
      const stamp = `${data.length} models available`;
      return {
        content: [{ type: 'text' as const, text: stamp }],
        structuredContent: { object: 'list', data },
      };
    },
  );
}
```

```ts
// router/src/routes/v1/models.ts — MODIFIED (D-11)
export function registerModelsRoute(app: FastifyInstance, registry: RegistryStore): void {
  const filterAndProject = (reg: ReturnType<RegistryStore['get']>) => {
    const allow = reg.policies?.default?.model_allowlist ?? [];
    return reg.models
      .filter((m) => allow.length === 0 || allow.includes(m.name))
      .map((m) => ({
        id: m.name,
        object: 'model' as const,
        created: registry.getCreatedAtSec(),
        owned_by: 'local-llms' as const,
        capabilities: m.capabilities,
        policy: { cloud_allowed: m.policy?.cloud_allowed ?? true },  // D-11 NEW
      }));
  };

  app.get('/v1/models', async () => {
    return { object: 'list' as const, data: filterAndProject(registry.get()) };
  });

  app.get<{ Params: { id: string } }>('/v1/models/:id', async (req, reply) => {
    const reg = registry.get();
    const allow = reg.policies?.default?.model_allowlist ?? [];
    const entry = reg.models.find((m) => m.name === req.params.id);
    // Treat allowlist-excluded models as not-found (single lens with /v1/models filter).
    if (!entry || (allow.length > 0 && !allow.includes(entry.name))) {
      reply.code(404);
      return {
        error: {
          message: `The model '${req.params.id}' does not exist`,
          type: 'invalid_request_error' as const,
          param: null,
          code: 'model_not_found' as const,
        },
      };
    }
    return {
      id: entry.name,
      object: 'model' as const,
      created: registry.getCreatedAtSec(),
      owned_by: 'local-llms' as const,
      capabilities: entry.capabilities,
      policy: { cloud_allowed: entry.policy?.cloud_allowed ?? true },  // D-11 NEW
    };
  });
}
```

### Example 4: Error catch block (D-04)

```ts
// inside any tool handler:
try {
  /* ... */
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const env = toOpenAIErrorEnvelope(e);
  // env may be NO_ENVELOPE (APIUserAbortError — client-disconnect).
  if (typeof env === 'symbol') {
    // Client disconnect — there's no MCP wire to write to anyway because extra.signal
    // is already aborted. Return a minimal error result; the SDK will discard it.
    return {
      content: [{ type: 'text' as const, text: 'client disconnected' }],
      structuredContent: { error: 'client_disconnect', code: 'client_disconnect', message: 'client disconnected' },
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: env.error.message }],
    structuredContent: {
      error: env.error.type,    // e.g., 'policy_violation', 'invalid_request_error', 'api_error'
      code: env.error.code,     // e.g., 'model_not_in_allowlist', 'cloud_not_allowed', 'model_capability_mismatch'
      message: env.error.message,
    },
    isError: true,
  };
}
```

### Example 5: `bufferedWriter.push` from inside a tool handler (D-05)

See Pattern 3 above (the `finally` block of `registerChatCompletionTool`). The key shape:
```ts
deps.bufferedWriter.push({
  ts: new Date(),
  protocol: 'mcp',          // NEW value; no migration needed
  route: '/mcp',            // constant for all MCP tool calls
  backend, model,           // captured from applyPreflight().entry
  status_class: deriveStatusClass(httpStatus, controller.signal.aborted),
  http_status: httpStatus,
  tokens_in, tokens_out,    // from canonicalResp.usage when available
  ttft_ms: null,            // not applicable to non-stream tool calls
  latency_ms: Math.round(durationMs),
  error_code: caughtErr ? mapErrorToCode(caughtErr) : null,
  error_message: caughtErr ? truncateAndRedact(caughtErr.message) : null,
  agent_id: capturedReq.agentId ?? null,
  tenant_id: capturedReq.tenantId ?? null,
  project_id: capturedReq.projectId ?? null,
  workload_class: capturedReq.workloadClass ?? null,
  request_id: capturedReq.id,
  upstream_message_id: canonicalResp?.id ?? null,
  idempotency_key: null,    // D-13: MCP-level idempotency is HTTP-only
  cost_cents: costCents ?? null,
});
```

### Example 6: Env loader extension (D-15)

```ts
// router/src/config/env.ts — APPEND to EnvSchema
  // Phase 15 (v0.11.0 — MCPS-01..06 / D-15): MCP host plugin env knobs.
  // MCP_ENABLED=false skips /mcp registration entirely (→ 404). MCP_SESSION_TTL_SEC
  // is the idle-session GC threshold; MCP_GC_INTERVAL_MS is the GC sweep cadence.
  // All three have safe defaults — zero-config deployment continues to work.
  MCP_ENABLED: z.coerce.boolean().default(true),
  MCP_SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
  MCP_GC_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),
```

Then `BuildAppOpts.env` Pick widens to include `'MCP_ENABLED' | 'MCP_SESSION_TTL_SEC' | 'MCP_GC_INTERVAL_MS'`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTTP+SSE transport (separate POST + GET endpoints, two URLs) | Streamable HTTP transport (single URL, POST/GET/DELETE methods) | Spec rev 2025-06+ | Streamable HTTP is the SDK's recommended path; HTTP+SSE marked deprecated but kept for backward compat |
| `tool()` method (deprecated) | `registerTool(name, opts, handler)` | SDK 1.x | The deprecated form does not support `inputSchema` typing; never use it |
| Stdio-only servers | Streamable HTTP for production agent frameworks | n8n issue #24967 (2025) | n8n, Claude Desktop, Cursor all require Streamable HTTP — stdio is dev-only |
| Hand-authored tool JSON schemas | `z.toJSONSchema(zodSchema)` | Zod v4 (released 2025) | Eliminates schema drift between HTTP routes and MCP tools |
| OAuth 2.1 PKCE for auth | Bearer token over Streamable HTTP | MCP spec allows both | Single-user router uses bearer; OAuth deferred to MCPS-FUT |

**Deprecated / outdated:**
- `SSEServerTransport` (legacy HTTP+SSE) — exists in SDK 1.29 for backward compat; **must NOT be registered by the router** (REQ MCPS-06: stdio NOT exposed; by extension we keep the surface minimal — only `StreamableHTTPServerTransport`).
- `@modelcontextprotocol/fastify@2.0.0-alpha.2` — pre-alpha, targets v2 SDK split that doesn't exist in production; rejected per STACK.md.
- The `tool()` method on `McpServer` — use `registerTool()`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@modelcontextprotocol/sdk@1.29.0` exports `McpServer` at `/server/mcp.js`, `StreamableHTTPServerTransport` at `/server/streamableHttp.js`, `isInitializeRequest` at `/types.js` | Standard Stack + Pattern 1 | [ASSUMED] — sourced from STACK.md inspection of installed 1.29 dist + community examples; planner verifies on first install. If exports differ, the import paths in Pattern 1 must be adjusted. Risk: small (paths confirmed against multiple community examples). |
| A2 | The MCP SDK `extra` argument to `registerTool` handlers exposes `extra.signal` (AbortSignal) and `extra.sessionId` | Pattern 3, Pattern 4 | [ASSUMED] — referenced from STACK.md + research; not verified in this session against installed SDK dist. Planner verifies via TypeScript IntelliSense at first compile. Risk: medium — if `extra.signal` is named differently, the abort propagation pattern needs a renamed property. The pattern itself stands. |
| A3 | `prom-client` Counter `.inc({labels})` accepts arbitrary string label values (not narrowly typed) | Pattern 3, D-07 | [VERIFIED: existing code] — `metrics.requestsTotal.inc({ protocol: ctx.protocol, ... })` works today with `ctx.protocol: 'openai' \| 'anthropic'`; widening to `'mcp'` is a TS union widening only. |
| A4 | `request_log.protocol` is free-text TEXT NOT NULL with no CHECK constraint | D-05, Pattern 3 finally block | [VERIFIED: db/migrations/0000_init.sql line 5 + grep across all migration SQL files showed zero CHECK constraints touching the column] |
| A5 | `OutcomeContext.protocol` is currently typed `'openai' \| 'anthropic'` and must widen to include `'mcp'` | Pitfall 7, recommendation | [VERIFIED: `router/src/metrics/recordOutcome.ts:64`] |
| A6 | `applyPolicyGate` is called at 5 specific lines (chat 225, messages 228, embeddings 236, rerank 140, responses 369) and is always immediately followed by `await opts.breaker.check(entry.backend)` | Pattern 5 / D-09 | [VERIFIED: grep output cited in Phase 14 verification + direct grep run in this research] |
| A7 | Fastify v5 root-scoped `onRequest` hooks (bearer) + root-scoped `preHandler` hooks (scopedIds, agentId) fire on every route registered after them, including a future `/mcp` route | Pattern 1 / MCPS-02 | [VERIFIED: app.ts:268-311 + Fastify v5 docs] |
| A8 | The MCP SDK's `transport.handleRequest(req.raw, reply.raw, req.body)` does NOT conflict with `fastify-sse-v2` because the routes are disjoint (`/mcp` vs `/v1/*`) and `reply.sse` is only called from `/v1/*` paths | Pattern 1, Summary §5 | [VERIFIED: `grep reply.sse router/src/` shows hits only in chat/messages/embeddings/responses handlers; none under `mcp/host/` (file doesn't exist yet)] |
| A9 | `crypto.randomUUID()` is available in Node 22 (project minimum per `engines.node: ">=22.0.0"`) — no need for `ulid` here | Pattern 1 | [VERIFIED: Node 22 docs + project engines field] |
| A10 | Pino's `.child({...})` silently omits keys whose values are `undefined`, so MCP tool log lines without `mcp_request_id` won't emit the field as `null` | Pattern 4 | [CITED: pino docs] |
| A11 | `bufferedWriter.push(row)` validates row shape via the `RequestLogInsert` type at TypeScript compile time but does not validate at runtime — pushing a row with an unknown `protocol` value succeeds as long as the schema TEXT column accepts it | D-05, Pitfall 7 | [VERIFIED: `bufferedWriter.ts:147` push impl + Drizzle `$inferInsert` type derivation] |

**If A1 or A2 fail to match installed SDK reality:** the planner's first task should be `npm install @modelcontextprotocol/sdk@^1.29.0` followed by a TypeScript compile of a minimal `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'; import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';` smoke file. Fix the import paths if they differ, then proceed.

## Open Questions

1. **Should `applyPreflight` throw on `breakerResult.state === 'open'` or return the sentinel?**
   - What we know: HTTP routes stamp `Retry-After` header **before** throwing `BreakerOpenError`. The MCP path cannot stamp the header (no reply context).
   - What's unclear: Whether to (A) sentinel-return + caller throws (preserves HTTP byte-identical behavior + adds 3 lines per route) or (B) helper throws + HTTP route stamps Retry-After in a Fastify `setErrorHandler` extension (centralizes the throw + decentralizes the header).
   - **Recommendation:** Option A (sentinel). Smaller-diff against existing routes; HTTP code keeps the Retry-After stamp where it is today.

2. **Where exactly does `extra.sessionId` and the JSON-RPC `id` field surface on the tool handler signature?**
   - What we know: The SDK exposes session info on the `extra` arg per community examples.
   - What's unclear: Exact property names — research surfaces `extra.signal`, `extra.sessionId`, `extra._meta?.progressToken`. The JSON-RPC `id` field (D-08 `mcp_request_id`) MAY be `extra.requestId`, `extra._meta?.requestId`, or accessible only via the MCP request context.
   - **Recommendation:** Planner verifies on first compile via TypeScript IntelliSense. Pattern 4 above shows `mcp_request_id: extra._meta?.progressToken ?? null` as a placeholder — adjust to the actual field name.

3. **Does the SDK's `transport.close()` call `transport.onsessionclosed` synchronously or async?**
   - What we know: From the community examples, `onsessioninitialized` fires synchronously inside the SDK during initialize handling.
   - What's unclear: Whether the GC sweep needs to `await transport.close()` before deleting from `sessionMap`, OR whether the `onsessionclosed` callback (if it exists) is the authoritative delete point.
   - **Recommendation:** Pattern 2 above uses fire-and-forget `void transport.close().catch(...)` + explicit `sessionMap.delete(sid)`. If `onsessionclosed` exists on the SDK, the planner can switch to callback-driven delete for a tighter contract.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22 LTS | Router runtime (engines.node `>=22.0.0`) | ✓ | (verified in package.json) | — |
| `@modelcontextprotocol/sdk@^1.29.0` | MCP server + transport | ✗ (not yet installed) | latest 1.29.0 on npm | `npm install` task in Phase 15 plan |
| Postgres `request_log` table with TEXT `protocol` column | D-05 writes `protocol='mcp'` | ✓ | TEXT NOT NULL (no CHECK constraint) | — |
| Valkey | Rate limiter (existing) | ✓ | (operational) | — |
| `zod@^4.4.3` | `z.toJSONSchema()` for tool input schemas | ✓ | already installed | — |
| `fastify@^5.8.5` | route registration + hook inheritance | ✓ | already installed | — |
| `prom-client@^15.1.3` | new Counter + Gauge | ✓ | already installed | — |
| Compose `stop_grace_period` ≥ 8s | SIGTERM 5s MCP + 3s bufferedWriter.drain fit | ✓ | Default 10s — confirm in compose.yml | If overridden < 8s: extend it back to 10s |

**Missing dependencies with no fallback:** none

**Missing dependencies with fallback:**
- `@modelcontextprotocol/sdk@^1.29.0` — installed via `npm install` as the first task of the Phase 15 plan, gated behind slopcheck verification per package_legitimacy_protocol.

## Validation Architecture

> `nyquist_validation` is the default (no explicit `false` in config). Section included.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest@^4.1.6` (already installed) |
| Config file | `router/vitest.config.ts` (existing) — exists with separate `tests/unit/` and `tests/integration/` directories |
| Quick run command | `pnpm vitest run tests/unit/mcp/host/ -- --no-coverage` (per-tool fast) |
| Full suite command | `pnpm vitest run` (all tests, ~5-10s) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MCPS-01 | MCP Client connects to POST /mcp, receives tools/list with ≥5 tools | integration | `pnpm vitest run tests/integration/mcp-host.integration.test.ts -- -t "tools/list"` | ❌ Wave 0 |
| MCPS-02 | POST /mcp without Authorization → 401 BEFORE MCP handling | integration | `pnpm vitest run tests/integration/mcp-host.integration.test.ts -- -t "bearer 401"` | ❌ Wave 0 |
| MCPS-03 | 5 tools exposed with correct names + JSON Schema 2020-12 inputSchema | unit + golden fixture | `pnpm vitest run tests/unit/mcp/host/tools/ -- -t "registers all 5"` + `tests/golden/mcp-tools-manifest.json` snapshot | ❌ Wave 0 |
| MCPS-04 | Tool handler error → isError:true + structured content block (not thrown) | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -- -t "policy violation returns isError"` | ❌ Wave 0 |
| MCPS-05 | SIGTERM closes all sessions within 5s; no leaked sessionMap entries | integration | `pnpm vitest run tests/integration/mcp-shutdown.integration.test.ts -- -t "SIGTERM closes sessions"` | ❌ Wave 0 |
| MCPS-06 | Stdio transport NOT registered (grep gate) | linting | `grep -rn 'StdioServerTransport' router/src/ \| wc -l` must equal `0` | ❌ Wave 0 — add to existing grep-gate vitest |
| D-01 (passthrough) | Tool input schema matches `z.toJSONSchema(<route schema>)` | unit + golden | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -- -t "inputSchema mirrors ChatCompletionRequestSchema"` | ❌ Wave 0 |
| D-05 (request_log row) | One row per MCP tool call with protocol='mcp' | integration | `pnpm vitest run tests/integration/mcp-request-log.integration.test.ts` | ❌ Wave 0 |
| D-06 (scoped IDs inherited) | tenant_id/project_id/agent_id from outer /mcp request appear on request_log row | integration | included in mcp-request-log.integration.test.ts | ❌ Wave 0 |
| D-07 (metrics) | router_mcp_active_sessions gauge present; router_mcp_tool_calls_total{tool,status_class} present | integration | `pnpm vitest run tests/integration/mcp-metrics.integration.test.ts` | ❌ Wave 0 |
| D-09 (applyPreflight) | All 5 HTTP routes call applyPreflight + integration test confirms breaker not mutated by 403 | unit + existing Phase 14 integration | `pnpm vitest run tests/unit/dispatch/preflight.test.ts` + replay `tests/integration/policy-gate-integration.test.ts` | unit ❌ Wave 0; integration ✓ exists (Phase 14) |
| D-10/D-11 (list_models filter + cloud_allowed) | list_models tool + GET /v1/models both filter by allowlist + carry policy.cloud_allowed | integration | `pnpm vitest run tests/integration/list-models-policy-filter.integration.test.ts` | ❌ Wave 0 |
| D-12 (stream coercion) | chat_completion tool with stream:true returns non-stream structuredContent | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -- -t "coerces stream:true to false"` | ❌ Wave 0 |
| D-14 (abort propagation) | Tool handler aborts upstream adapter when extra.signal aborts | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -- -t "extra.signal triggers adapter abort"` | ❌ Wave 0 |
| D-15 (env vars) | MCP_ENABLED=false → no /mcp route registered (404) | integration | `pnpm vitest run tests/integration/mcp-disabled.integration.test.ts -- -t "MCP_ENABLED=false"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm vitest run tests/unit/mcp/host/` + `pnpm vitest run tests/unit/dispatch/preflight.test.ts` (fast, ~2s)
- **Per wave merge:** `pnpm vitest run tests/integration/mcp-*` + replay existing Phase 14 integration tests
- **Phase gate:** Full `pnpm vitest run` (all suites green) + `pnpm typecheck` clean + `bin/smoke-test-router.sh` with new MCP section PASSing before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `router/tests/unit/dispatch/preflight.test.ts` — covers D-09 helper behavior (resolve + gate + breaker matrix)
- [ ] `router/tests/unit/mcp/host/plugin.test.ts` — covers Pattern 1 (session map, initialize handling, GC, onClose)
- [ ] `router/tests/unit/mcp/host/tools/chat-completion.test.ts` — covers D-01, D-02, D-04, D-12, D-14
- [ ] `router/tests/unit/mcp/host/tools/create-response.test.ts` — covers same set for /v1/responses surface
- [ ] `router/tests/unit/mcp/host/tools/create-embedding.test.ts` — covers D-02/D-03 stamp shape ("embedded N inputs…")
- [ ] `router/tests/unit/mcp/host/tools/rerank.test.ts` — covers D-02/D-03 stamp + rerank shape
- [ ] `router/tests/unit/mcp/host/tools/list-models.test.ts` — covers D-10 filter + policy.cloud_allowed annotation
- [ ] `router/tests/integration/mcp-host.integration.test.ts` — full MCP client + StreamableHTTPClientTransport round-trip (uses SDK's `Client` class against `app.inject` or a real `listen`)
- [ ] `router/tests/integration/mcp-shutdown.integration.test.ts` — MCPS-05 SIGTERM cleanup
- [ ] `router/tests/integration/mcp-request-log.integration.test.ts` — D-05/D-06 row population
- [ ] `router/tests/integration/mcp-metrics.integration.test.ts` — D-07 gauge + counter
- [ ] `router/tests/integration/mcp-disabled.integration.test.ts` — D-15 MCP_ENABLED=false
- [ ] `router/tests/integration/list-models-policy-filter.integration.test.ts` — D-10/D-11 dual-surface filter
- [ ] `router/tests/golden/mcp-tools-manifest.json` — snapshot of all 5 tools' tools/list output for P1-03 drift gate
- [ ] Bin smoke script extension: `bin/smoke-test-router.sh` adds MCP section (initialize → tools/list → list_models tools/call) per OBSV-01

## Security Domain

> `security_enforcement` default is enabled. Section included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token inherited from existing root `onRequest` hook (`auth/bearer.ts`); same constant-time compare via SHA-256 hashes |
| V3 Session Management | yes | `Mcp-Session-Id` header generated by `crypto.randomUUID()`; idle GC + SIGTERM cleanup (Pattern 2); session map is in-memory per-process (no cross-process leakage in a single-host single-process deployment) |
| V4 Access Control | yes | `applyPolicyGate` (`policy/gate.ts`) — model allowlist + cloud_allowed enforced before tool dispatch; same gate fires on both HTTP and MCP surfaces (D-09 shared helper) |
| V5 Input Validation | yes | `z.toJSONSchema(<route schema>)` exposes the same validation surface to MCP clients as HTTP clients; MCP SDK validates inputs against the JSON Schema before invoking the tool handler |
| V6 Cryptography | yes | `crypto.randomUUID()` (Node native, CSPRNG) for session IDs; no custom crypto |
| V7 Error Handling | yes | `toOpenAIErrorEnvelope` → structured error content block (D-04); no stack traces leaked to MCP clients; bearer-redaction via `truncateAndRedact` applies to `request_log.error_message` |
| V8 Data Protection | yes | No new sensitive data introduced; `request_log` rows inherit the existing redaction discipline; scoped IDs (tenant/project/agent) flow via headers only — never derived from bearer token (Frame-06) |
| V13 API & Web Service | yes | JSON-RPC 2.0 over Streamable HTTP per MCP spec; same bearer auth surface as REST endpoints; no new attack surface beyond what `/v1/*` already exposes |
| V14 Configuration | yes | `MCP_ENABLED=false` disables the plugin entirely (zero attack surface when not in use); no `MCP_BEARER_TOKEN` override (single credential per the `ROUTER_BEARER_TOKEN` discipline) |

### Known Threat Patterns for {Fastify v5 + MCP host}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Bearer token leak via error message | Information Disclosure | Existing `truncateAndRedact` in `recordOutcome.ts` strips `Bearer`/`Authorization`/`apiKey` patterns before writing to `request_log` and pino |
| Session id enumeration | Spoofing | `crypto.randomUUID()` produces 122-bit unguessable IDs; no incremental counters |
| Tool poisoning via crafted inputs | Tampering / Elevation | All five tools have Zod-validated inputSchemas mirroring the existing HTTP route schemas — same validation discipline (regex bounds, strict shapes) applies |
| Memory exhaustion via session accumulation | Denial of Service | `MCP_SESSION_TTL_SEC` + GC sweep + `router_mcp_active_sessions` gauge as canary (P1-04 mitigation) |
| Bypass of policy gate via MCP surface | Elevation of Privilege | D-09 `applyPreflight` ensures policy gate fires on both HTTP and MCP surfaces with identical semantics; integration test asserts `breaker.recordFailure` counter unchanged after 403 from MCP tool call (mirror of Phase 14's existing assertion) |
| Internal endpoint exposure via auto-discovery | Elevation of Privilege | Hard-coded 5-tool allowlist in `buildServerForRequest` — `/metrics`, `/healthz`, `/readyz`, registry-reload, etc. are unreachable via MCP (P1-05 mitigation) |
| Cross-tenant data leakage via request_log query | Information Disclosure | `scopedIdsPreHandler` populates `tenant_id` / `project_id` per request; downstream operator queries filter by these columns; no router-side aggregation that crosses tenant boundaries |
| Stream backpressure / abort orphans VRAM | Denial of Service | D-12 (silent `stream:false` coercion) eliminates intra-tool streaming; D-14 (`extra.signal` → `controller.abort()`) propagates client-disconnect to upstream adapter for clean cancellation |
| Bearer credential leak to external MCP server (Phase 18 concern only — flagged here for cross-phase awareness) | Information Disclosure | Not applicable in Phase 15 (router is the SERVER, not the client). Phase 18 (P2-04) introduces per-server `auth_value`; the inbound bearer is NEVER forwarded outbound |

## Sources

### Primary (HIGH confidence)
- `npm view @modelcontextprotocol/sdk@1.29.0` — version, peer deps, transitive deps — verified 2026-05-31
- Live codebase: `router/src/app.ts`, `router/src/routes/v1/{chat-completions,messages,embeddings,rerank,responses,models}.ts`, `router/src/policy/gate.ts`, `router/src/errors/envelope.ts`, `router/src/backends/adapter.ts`, `router/src/middleware/{agentId,scopedIds}.ts`, `router/src/metrics/{registry,recordOutcome}.ts`, `router/src/db/{bufferedWriter,schema/request_log}.ts`, `router/src/auth/bearer.ts`, `router/src/config/env.ts`, `router/db/migrations/{0000_init,0005_request_log_scoped_ids}.sql`, `router/package.json`
- CONTEXT.md (`15-CONTEXT.md`) — locked decisions D-01..D-15
- DISCUSSION-LOG.md (`15-DISCUSSION-LOG.md`) — alternatives considered
- `.planning/REQUIREMENTS.md` — MCPS-01..06 verbatim
- `.planning/STATE.md` — milestone state + design decisions
- `.planning/ROADMAP.md` — Phase 15 details + Phase 14 dependencies
- `.planning/research/SUMMARY.md` — Phase 15 rationale + the raw `req.raw`/`reply.raw` lock
- `.planning/research/PITFALLS.md` §Section 1 — P1-01..06 verbatim
- `.planning/research/STACK.md` — SDK version + integration pattern
- `.planning/research/ARCHITECTURE.md` — Phase 15 integration point (cited via CONTEXT canonical_refs)
- `.planning/phases/14-policy-primitives-tenant-project-id-foundation/14-{CONTEXT,VERIFICATION}.md` — Phase 14 lock + verification

### Secondary (MEDIUM confidence)
- WebSearch + WebFetch on `modelcontextprotocol/typescript-sdk` GitHub examples — canonical Streamable HTTP boilerplate (POST/GET/DELETE handlers + isInitializeRequest + Mcp-Session-Id) — sourced from multiple community examples (codesignal.com tutorial, mcp.holt.courses, mhart/mcp-hono-stateless, riccardo-larosa/docebo-mcp-server) — pattern is consistent across sources
- [modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) — Streamable HTTP spec referenced in CONTEXT canonical_refs
- [modelcontextprotocol.io/specification/2025-11-25/server/tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — tool result shape (content + structuredContent + isError)

### Tertiary (LOW confidence)
- Exact field name for the JSON-RPC `id` field on `extra` (`extra.requestId` vs `extra._meta.progressToken` vs other) — flagged as Open Question 2; planner verifies via TypeScript IntelliSense on first install

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — SDK version verified on npm registry; project deps verified in package.json
- Architecture: HIGH — CONTEXT.md locks all 15 decisions; live codebase reads confirm every claimed pivot point
- Pitfalls: HIGH — P1-01..06 sourced from PITFALLS.md §Section 1; each mitigation traced to either CONTEXT decision or live code
- Code examples: MEDIUM-HIGH — `applyPreflight`, tool registration, error catch block, bufferedWriter push, env loader extension all cited; the exact `extra.signal` and `extra.sessionId` field names need final SDK type verification (Open Question 2)
- Streamable HTTP pattern: HIGH — sourced from multiple community examples + SDK README, consistent shape

**Research date:** 2026-05-31
**Valid until:** 2026-06-30 (30 days — SDK 1.29 is stable; the npm registry confirmation today caps the staleness window)

## RESEARCH COMPLETE
