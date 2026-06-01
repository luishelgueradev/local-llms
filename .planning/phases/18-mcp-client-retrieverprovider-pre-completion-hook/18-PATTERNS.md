# Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook — Pattern Map

**Mapped:** 2026-06-01
**Files analyzed:** 27 new/modified files (8 prod src + 1 SQL migration + 1 Drizzle schema patch + 1 YAML widening + 3 route patches + 1 helper + 1 `app.ts` widening + 1 `index.ts` widening + ~22 test files)
**Analogs found:** 27 / 27 — every new file has at least one production analog already shipped in Phase 14/15/16/17. **Zero greenfield production patterns.**

> Strategic frame reminder (Frame-01 BLOCK / project memory `project_retrieval_agnostic_principle.md`): the router exposes a `RetrieverProvider` *interface* + a `runHookChain` execution shape — it ships **NO** real retriever. `NoopRetrieverProvider` lives only in `tests/fakes.ts`. Every analog below preserves that frame.

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `router/src/mcp/client/registry.ts` | service / SDK client | request-response (lazy outbound JSON-RPC) | `router/src/mcp/host/plugin.ts` (Phase 15 — same SDK package, host side) | role-match (Client vs Server transport mirror) |
| `router/src/mcp/client/tool-loop.ts` | dispatcher | request-response (adapter call N times w/ tool-message accumulation) | `router/src/dispatch/preflight.ts` (protocol-agnostic helper) | role-match (isolated dispatch helper shape) |
| `router/src/mcp/client/transport.ts` | factory | request-response | `router/src/clients/valkey.ts` `makeValkeyClient` | role-match (single-purpose client constructor) |
| `router/src/mcp/client/sanitize.ts` | utility | transform | `router/src/translation/openai-in.ts` (input regex + length-cap validators) | partial-match (validation + warn-log shape) |
| `router/src/mcp/client/prefix.ts` | utility | transform | `router/src/mcp/host/tools/list-models.ts` (string mapping helper) | partial-match (pure-fn string transform) |
| `router/src/mcp/client/index.ts` | barrel | n/a | `router/src/providers/index.ts` and `router/src/mcp/host/index.ts` | exact |
| `router/src/providers/retriever-provider.ts` | interface | request-response | `router/src/providers/context-provider.ts` (Phase 17 — interface + opts/result triplet) | exact |
| `router/src/hooks/pre-completion.ts` | service (hook runner) | request-response + audit log | `router/src/providers/context-provider.ts` `provideContext` (sequential trim + invariant checks) | role-match |
| `router/src/hooks/inject.ts` | utility | transform | `router/src/providers/context-provider.ts` `stringifyContent` + system-pin join | role-match |
| `router/src/hooks/index.ts` | barrel | n/a | `router/src/providers/` barrel-style exports | exact |
| `router/src/routes/v1/helpers/pre-completion.ts` | helper (shared 3-route insertion) | request-response | `router/src/routes/v1/helpers/session-attach.ts` (Phase 17 — exact "single change shape repeated three times" precedent) | **exact** |
| `router/src/routes/v1/chat-completions.ts` (modify) | controller (route) | request-response | self — insertion point follows Phase 17 session-attach block (`chat-completions.ts:243-307`) | exact |
| `router/src/routes/v1/messages.ts` (modify) | controller (route) | request-response | self — insertion point follows Phase 17 session-attach block (`messages.ts:259-321`) | exact |
| `router/src/routes/v1/responses.ts` (modify) | controller (route) | request-response | self — insertion point follows Phase 17 session-attach block (`responses.ts:368-420`) | exact |
| `router/src/app.ts` (modify — BuildAppOpts widen) | composition root | n/a | `router/src/app.ts:139-169` (Phase 17 sessionStore/contextProvider/summaryProvider optionals) | **exact** |
| `router/src/index.ts` (modify — production wire-up) | composition root | n/a | `router/src/index.ts:164-190` (Phase 17 `PostgresSessionStore` + `DefaultContextProvider` boot wiring) | **exact** |
| `router/src/errors/envelope.ts` (modify — 4 new error classes) | model (error) | n/a | `router/src/errors/envelope.ts:39-79` (`RegistryUnknownModelError` + `CapabilityNotSupportedError` shape) | exact |
| `router/src/config/registry.ts` (modify — Zod widen) | model (schema) | n/a | `router/src/config/registry.ts:25-110` (Phase 14 `policies.default.model_allowlist` + per-entry `policy.cloud_allowed`) | exact |
| `router/src/db/schema/request_log.ts` (modify — `hook_log` JSONB) | model (Drizzle schema) | n/a | `router/src/db/schema/request_log.ts:56-64` (Phase 14 `tenant_id` / `project_id` / `workload_class` widening) | exact |
| `router/db/migrations/0007_request_log_hook_log.sql` | migration (additive) | n/a | `router/db/migrations/0006_sessions.sql` (Phase 17 — header + COMMENT + breakpoint idiom) | exact |
| `router/db/migrations/meta/_journal.json` (modify — idx=7) | config | n/a | `_journal.json` entries idx=5,6 (Phase 14, 17) | exact |
| `router/src/metrics/registry.ts` (modify — histogram + counter) | model (metrics registry) | n/a | Histogram: `routerSessionAppendFailedTotal` Counter (Phase 17) + `routerMcpToolCallsTotal` Counter (Phase 15) — but new metric is a **Histogram**, mirror shape from `router_request_duration_seconds` (`registry.ts:41-47`) | role-match (histogram shape vs counter shape) |
| `router/models.yaml` (modify — schema widen) | config | n/a | Phase 14 `policies:` top-level + per-entry `policy: { cloud_allowed }` | exact |
| `router/tests/fakes.ts` (extend) | test util | n/a | `tests/fakes.ts:71-141` (`makeFakeSessionStore` Phase 17) + `:143-220` (`makeFakeContextProvider`) | exact |
| `router/tests/fixtures/mcp-server.ts` (NEW) | test fixture | request-response (HTTP) | **MSW fixture pattern from Phase 16 stream tests (`tests/msw/`)** — there is no in-repo MCP-over-HTTP MSW analog yet; documented in 18-RESEARCH §"Pattern" | **no-analog (greenfield)** |
| `router/tests/integration/mcp-*-integration.test.ts` (5+ files) | test | request-response | `router/tests/integration/mcp-host.integration.test.ts` (Phase 15 — `buildApp` + JSON-RPC body + `app.inject`) | exact |
| `router/tests/integration/hook-*.integration.test.ts` (4+ files) | test | request-response | `router/tests/routes/session-attach.integration.test.ts` (Phase 17 — three-route shared fixture, exactly the same insertion-point semantics) | **exact** |
| `router/tests/integration/migrations/0007-hook-log.test.ts` | test (PG-gated) | n/a | `router/tests/migration0005.test.ts` (`PG_TESTS=1` convention) | exact |
| `bin/smoke-test-router.sh` (modify — add PHASE-18 sections) | smoke script | n/a | existing PHASE-15/17 sections in `bin/smoke-test-router.sh` | exact |

---

## Pattern Assignments

### `router/src/mcp/client/registry.ts` (service, request-response)

**Analog:** `router/src/mcp/host/plugin.ts` (Phase 15)

**SDK import + Client construction pattern** (lines 53-57 + 188-209 of `plugin.ts`):

```ts
// Server side (Phase 15 — analog):
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const server = new McpServer(
  { name: 'local-llms-router', version: '0.11.0' },
  { capabilities: { tools: {} } },
);
const transport = new StreamableHTTPServerTransport({ /* ... */ });
await server.connect(transport);
```

→ **Phase 18 mirror** (client side — same SDK, same import-path idiom, same `name/version` literal):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'local-llms-router', version: '0.11.0' });
const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
  requestInit: { headers: buildOutboundHeaders(cfg) },  // P2-04 BLOCK boundary
});
await client.connect(transport);
```

**Lazy construction pattern — DO NOT eager-connect at boot** (P2-01 BLOCK). The Phase 15 host plugin connects at session-initialize-time (not at module load); Phase 18 mirrors by deferring `connect()` to first `getOrConnect(alias)` call.

**Outbound-headers isolation (P2-04 BLOCK):** The helper `buildOutboundHeaders(cfg)` takes **only** the `McpServerConfig` — never a `FastifyRequest`. Grep gate to enforce: `grep -rE "req\.headers|request\.headers" router/src/mcp/client/` MUST return empty.

**Lifecycle `onClose` pattern** (lines 275-279 of `plugin.ts`):

```ts
app.addHook('onClose', async () => {
  clearInterval(gcTimer);
  await shutdownSessions(sessionMap, app.log as Logger);
  opts.metrics.routerMcpActiveSessions.set(0);
});
```

→ Phase 18 mirror in `index.ts`: `app.addHook('onClose', async () => { await mcpRegistry.disposeAll(); });`

---

### `router/src/mcp/client/registry.ts` — Valkey cache pattern

**Analog:** `router/src/clients/valkey.ts` (lines 35-58) + Phase 8 `EX <ttl>` idiom used elsewhere in `embeddings.ts` cache (`routerEmbeddingsCacheTotal`).

**Constructor + `enableOfflineQueue: false` pattern** (lines 47-53):

```ts
const ioRedisOpts: RedisOptions = {
  password,
  lazyConnect: false,
  enableOfflineQueue: false,   // commands REJECT when Valkey down — fail fast
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
};
```

**Usage in `registry.getOrFetchTools`** (mirrors `router/src/embeddings/cache.ts` shape — Phase 12 EMB-H03):

```ts
const cacheKey = `mcp:tools:${alias}`;                        // namespace key (Phase 8 convention)
const cached = await this.opts.valkey.get(cacheKey);
if (cached) {
  const parsed = JSON.parse(cached) as CachedToolList;
  return parsed.tools.map(t => ({ ...t, name: prefixToolName(alias, t.name) }));
}
// … list via SDK …
await this.opts.valkey.set(cacheKey, JSON.stringify({ tools, fetched_at_ms: Date.now() }),
                           'EX', this.opts.cacheTtlSec ?? 60);
```

**Hot-reload invalidation pattern** — DEL key + close transport (Phase 8 `models.yaml` cache uses same idiom in `config/registry.ts` watcher). Stored in user memory `project_models_yaml_hot_edit.md`: edits require **DEL of Valkey cache + `up -d --force-recreate`**; the registry's `onSwap` subscriber handles DEL automatically:

```ts
registry.onSwap((prev, next) => {
  // … per-alias diff …
  if (changedOrRemoved) void mcpRegistry.dispose(alias);   // dispose ⇒ DEL + transport.close()
});
```

---

### `router/src/mcp/client/tool-loop.ts` (dispatcher, request-response)

**Analog:** `router/src/dispatch/preflight.ts` (Phase 15 — protocol-agnostic helper consumed by both HTTP routes and MCP host tools).

**Helper-isolation pattern** (lines 28-31 of `preflight.ts` header):

> "Protocol-agnosticism: this module has NO imports from `router/src/mcp/` and NO imports from `router/src/routes/`. It is consumed by both surfaces."

→ Phase 18 `tool-loop.ts` mirrors: NO imports from `routes/`, accepts `BackendAdapter` + `McpClientRegistry` + `Logger` + metrics in opts (no Fastify reference). The opts contract pattern (lines 37-45):

```ts
export interface ApplyPreflightOpts {
  registry: RegistryStore;
  breaker: CircuitBreaker;
}
export interface ApplyPreflightResult {
  entry: ModelEntry;
  breakerState: BreakerState;
}
```

→ Phase 18 mirror:

```ts
export interface RunMcpToolLoopOpts {
  initial: CanonicalRequest;
  adapter: BackendAdapter;
  signal: AbortSignal;
  registry: McpClientRegistry;
  enabledAliases: readonly string[];
  log: Logger;
  metrics: { routerMcpToolCallsExternalTotal: Counter<'server_alias' | 'status_class'> };
}
```

**Iteration cap pattern** — single-helper invariant similar to `applyPreflight`'s "fixed order, must not be reordered" (preflight.ts:11): `MCP_TOOL_LOOP_MAX = 10` as a module-level const. On cap reached, throw structured error `McpToolLoopExceededError` (same pattern as `BackendSaturatedError` re-export in `envelope.ts:5-6`).

---

### `router/src/providers/retriever-provider.ts` (interface, request-response)

**Analog:** `router/src/providers/context-provider.ts` (Phase 17) — **exact match** for the interface shape.

**Interface + opts/result triplet pattern** (lines 67-139 of `context-provider.ts`):

```ts
export interface ProvideContextOpts {
  entry: ModelEntry;
  max_tokens_reserve?: number;
  strategy?: ContextStrategy;
  has_pending_tool_call?: boolean;
}

export interface ProvideContextResult {
  messages: CanonicalMessage[];
  system?: string;
  dropped_count: number;
  estimated_tokens: number;
  has_pending_tool_call: boolean;
}

export interface ContextProvider {
  provideContext(
    history: Turn[],
    incomingMessages: CanonicalMessage[],
    incomingSystem: string | undefined,
    opts: ProvideContextOpts,
  ): ProvideContextResult;
}
```

→ **Phase 18 mirror — `retriever-provider.ts`** uses the identical triplet shape (`RetrieverRequest` / `RetrieverResponse` / `RetrieverProvider`):

```ts
export interface RetrieverRequest {
  query: string;
  top_k?: number;          // default 5 (orchestrator-resolved)
  filters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  hybrid?: { sparse_weight?: number; dense_weight?: number; rerank?: boolean };
}
export interface RetrievedDocument { content: string; score?: number; metadata?: Record<string, unknown>; }
export interface RetrieverResponse { documents: RetrievedDocument[]; retrieved_at: string; }
export interface RetrieverProvider { retrieve(request: RetrieverRequest): Promise<RetrieverResponse>; }
```

**Strategic frame guard** — Phase 17 ships `DefaultContextProvider` because a sliding-window trim is router-internal (token-budget arithmetic, no external retrieval). Phase 18 ships **NO `DefaultRetrieverProvider`** because retrieval is downstream concern. Grep gate (Frame-01 BLOCK):

```
grep -rE "class \w+RetrieverProvider" router/src/
# MUST yield ONLY the interface file retriever-provider.ts, NO impls
```

---

### `router/src/hooks/pre-completion.ts` (service, request-response + audit log)

**Analog:** `router/src/providers/context-provider.ts` `provideContext` function (lines 209-318 — sequential algorithm with invariant assertion).

**Sequential-with-mutation pattern** (lines 244-296 of `context-provider.ts`):

```ts
// Step N: ...
while (evictable.length > incomingCount && runningTokens > budget) {
  const dropped = perMessageTokens.shift() ?? 0;
  evictable.shift();
  runningTokens -= dropped;
  droppedCount++;
}

// Pitfall 17-G runtime invariant (defense-in-depth):
for (const inc of incomingMessages) {
  if (!evictable.includes(inc)) {
    throw new Error('ContextProvider invariant violated: ...');
  }
}
```

→ Phase 18 mirror in `runHookChain` (sequential — each hook sees prior hook's injections):

```ts
let working = canonical;
const hook_log: HookLogEntry[] = [];
for (const hook of hooks) {
  // … Promise.race([hook.retriever.retrieve(req), timeout]) …
  working = injectRetrievedContent(working, hook.name, resp, hook.max_chars);
  hook_log.push({ hook_name, context_hash, latency_ms, chars_retrieved, status });
}
return { canonical: working, hook_log, fail_open_signaled, fail_open_hook_name };
```

**`Promise.race` + timer-cancel pattern (P5-02 BLOCK) — analog:** `router/src/clients/valkey.ts` `closeValkey` (lines 60-76):

```ts
await Promise.race([
  client.quit(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('valkey-quit-timeout-1s')), 1_000),
  ),
]);
```

**Improvement for P5-02:** Valkey's analog leaks the `setTimeout` handle when `client.quit()` wins the race. Phase 18 **MUST** use the cancel-able `timeout()` helper documented in 18-RESEARCH §"Critical detail" (lines 605-619) — the leaked-timer bug is specifically called out as the #1 race-timeout bug.

**Fail-open observability pattern — analog:** `router/src/providers/postgres-session-store.ts` lines 95-99 + pino `event:` field convention (P17-E warn-log pattern):

```ts
req.log.warn(
  { hook_name, err: errorMessage, status, event: 'hook_fail_open' },
  'pre-completion hook failed-open',
);
```

(Same `event: '...'` field convention as `session_append_failed_open` per Phase 17, and `mcp_tool_name_rejected` per RESEARCH §Pattern 3.)

---

### `router/src/hooks/inject.ts` (utility, transform)

**Analog:** `router/src/providers/context-provider.ts` `stringifyContent` (lines 199-205) + system-pin join logic (lines 271, 311-313).

**Pinned-system join pattern** (lines 271-272):

```ts
const systemStr = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
```

→ Phase 18 mirror — concatenate prior system + new fenced block with `\n\n`:

```ts
const existingSystem = canonical.system ?? '';
const newSystem = existingSystem ? `${existingSystem}\n\n${final}` : final;
return { canonical: { ...canonical, system: newSystem }, content: final, was_truncated: truncated };
```

**Critical canonical-shape invariant (CTXP-03 BLOCK carry-over from Phase 17):** retrieved content lands in `canonical.system` **NEVER** in `canonical.messages[]` with `role:'system'`. `canonical.ts:108-118` rejects `role:'system'` in messages. Phase 17 enforces this via `extractIncomingSystemFromOpenAIMessages` (`helpers/session-attach.ts:78-100`); Phase 18 follows the same rule.

---

### `router/src/routes/v1/helpers/pre-completion.ts` (helper — 3-route insertion)

**Analog:** `router/src/routes/v1/helpers/session-attach.ts` (Phase 17) — **EXACT** match. The header comment (lines 5-9) is the prescription for Phase 18:

> "Shared helpers used by /v1/chat/completions, /v1/messages, /v1/responses to implement the 'session attach' block in a single insertion shape (PATTERNS line 773 — single change shape repeated three times)."

**Pattern:** every public function in `session-attach.ts` is **STATELESS and side-effect-free** — they translate between route-specific shapes and canonical. Phase 18's `runPreCompletionAndInjectMcpTools` helper mirrors:

```ts
export async function runPreCompletionAndInjectMcpTools(
  req: FastifyRequest,
  reply: FastifyReply,
  canonical: CanonicalRequest,
  entry: ModelEntry,
  opts: {
    routeKey: string;
    preCompletionHooks?: Map<string, PreCompletionHook[]>;
    mcpClientRegistry?: McpClientRegistry;
    metrics: MetricsRegistry;
  },
): Promise<{ canonical: CanonicalRequest; hook_log: HookLogEntry[]; mcpToolLoopEnabled: boolean }>
```

**Single change shape repeated three times** — exactly the Phase 17 prescription. The 3 routes call this helper once each, immediately AFTER the session-attach block, BEFORE the adapter call.

---

### `router/src/routes/v1/chat-completions.ts` (modify — controller, request-response)

**Analog:** `router/src/routes/v1/chat-completions.ts` self — Phase 17 session-attach block at lines 243-307.

**Insertion-point map** (chat-completions; messages + responses follow the same lines):

```
Line 201:  const { entry, breakerState } = await applyPreflight(body.model, …);
Line 241:  const adapter: BackendAdapter = opts.makeAdapter(entry);
Line 243:  // ─── Phase 17 (SESS-01..06 + CTXP-01..03 + SUMP-02): session attach ──
… lines 243-307 — session-attach block …
Line 307:  // ─── End session attach ──────────────────────────────────────────────

   ↓ ↓ ↓ Phase 18 INSERTS HERE — between session-attach end and openAIRequestToCanonical ↓ ↓ ↓
   //   const { canonical: c2, hook_log, mcpToolLoopEnabled } =
   //     await runPreCompletionAndInjectMcpTools(req, reply, canonicalDraft, entry, {
   //       routeKey: '/v1/chat/completions',
   //       preCompletionHooks: opts.preCompletionHooks,
   //       mcpClientRegistry: opts.mcpClientRegistry,
   //       metrics: opts.metrics,
   //     });

Line 314:  const canonical = openAIRequestToCanonical({ … });
Line 1026: canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
   ↓ ↓ ↓ Phase 18 wraps this call in runMcpToolLoop when mcpToolLoopEnabled ↓ ↓ ↓
```

**Symmetric insertion points for the other two routes** (verified from grep above):
- `messages.ts:270-307` ← session-attach block; insert AFTER
- `responses.ts:374-420` ← session-attach block; insert AFTER

**Stream-path treatment (A4 RESOLVED):** Phase 18 MCP tool loop ships **non-stream only**. The route's stream branch (`adapter.chatCompletionsCanonicalStream` at line 627) is **unchanged**. Plan must add `!canonical.stream` guard in the helper.

---

### `router/src/app.ts` (modify — BuildAppOpts widen)

**Analog:** `router/src/app.ts:139-169` (Phase 17 BuildAppOpts widening — optional `sessionStore` / `contextProvider` / `summaryProvider`).

**Pattern — optional providers in BuildAppOpts** (read from grep above):

```ts
// Phase 17 (v0.11.0 — SESS-01 / SESS-06 BuildAppOpts widening):
sessionStore?: SessionStore;
// Phase 17 (v0.11.0 — CTXP-01 BuildAppOpts widening):
contextProvider?: ContextProvider;
```

→ Phase 18 mirror — add to BuildAppOpts:

```ts
/** Phase 18 (v0.11.0 — MCPC-01): optional MCP client registry. Absent → no external MCP tools injected. */
mcpClientRegistry?: McpClientRegistry;
/** Phase 18 (v0.11.0 — RETR-02 / RETR-03): per-route hook map. Absent → no hooks fire. */
preCompletionHooks?: Map<string, PreCompletionHook[]>;
```

**Route registration pattern** — pass-through to routes (lines 884-918 of `app.ts`):

```ts
registerChatCompletionsRoute(app, {
  // …existing wires…
  sessionStore: opts.sessionStore,
  contextProvider: opts.contextProvider,
  // NEW Phase 18:
  mcpClientRegistry: opts.mcpClientRegistry,
  preCompletionHooks: opts.preCompletionHooks,
});
```

---

### `router/src/index.ts` (modify — production wire-up)

**Analog:** `router/src/index.ts:164-190` (Phase 17 PostgresSessionStore + DefaultContextProvider boot wiring).

**Pattern from grep:**

```ts
const sessionStore = new PostgresSessionStore(db, { /* … */ });
const contextProvider = DefaultContextProvider;
bootLog.info('Phase 17 providers initialized — sessionStore + contextProvider …');

const app = await buildApp({
  // …
  sessionStore,
  contextProvider,
  // …
});
```

→ Phase 18 mirror (see 18-RESEARCH Example 6 for exact lines):

```ts
// Phase 18 (MCPC-01..06): MCP client registry — lazy, never connects at boot.
const mcpRegistry = makeMcpClientRegistry({
  servers: new Map((initialRegistry.mcp_servers ?? []).map(s => [s.alias, s])),
  valkey,
  logger: bootLog.child({ subsystem: 'mcp_client' }),
  cacheTtlSec: 60,
});

// Hot-reload wiring
registry.onSwap((prev, next) => { /* dispose changed aliases */ });

// Phase 18 (RETR-02/03): NO hooks registered by default (Frame-01 BLOCK).
const preCompletionHooks: Map<string, PreCompletionHook[]> = new Map();
```

**Key Frame-01 enforcement:** the production `preCompletionHooks` Map is **empty** — no `Map.set(...)` calls in production code. Operators extend it locally; the repo ships zero retrievers.

---

### `router/src/errors/envelope.ts` (modify — 4 new error classes)

**Analog:** `router/src/errors/envelope.ts:39-79` (`RegistryUnknownModelError` + `CapabilityNotSupportedError` shape).

**Class-with-readonly-code pattern** (lines 39-48):

```ts
export class RegistryUnknownModelError extends Error {
  readonly code = 'model_not_found';
  constructor(
    public readonly modelName: string,
    public readonly knownNames: string[],
  ) {
    super(`Unknown model "${modelName}"; registered: ${knownNames.join(', ')}`);
    this.name = 'RegistryUnknownModelError';
  }
}
```

→ Phase 18 mirror — 4 new classes:

```ts
export class McpServerUnreachableError extends Error {
  readonly code = 'mcp_server_unreachable';
  constructor(public readonly alias: string, public readonly url: string, public readonly cause: unknown) {
    super(`MCP server "${alias}" at ${url} unreachable`);
    this.name = 'McpServerUnreachableError';
  }
}
export class McpToolLoopExceededError extends Error {
  readonly code = 'mcp_tool_loop_exceeded';
  constructor(public readonly maxIter: number) {
    super(`MCP tool-call loop exceeded ${maxIter} iterations`);
    this.name = 'McpToolLoopExceededError';
  }
}
export class HookTimeoutError extends Error {
  readonly code = 'hook_timeout';
  constructor(public readonly hookName: string, public readonly timeoutMs: number) {
    super(`pre-completion hook "${hookName}" exceeded ${timeoutMs}ms`);
    this.name = 'HookTimeoutError';
  }
}
export class HookConfigError extends Error {
  readonly code = 'hook_config_error';
  constructor(public readonly hookName: string, public readonly reason: string) {
    super(`pre-completion hook "${hookName}" misconfigured: ${reason}`);
    this.name = 'HookConfigError';
  }
}
```

Add each to the central `mapToHttpStatus` switch (the same place `RegistryUnknownModelError` and `CapabilityNotSupportedError` map). Status codes: `McpServerUnreachableError` → 502; `McpToolLoopExceededError` → 502; `HookTimeoutError` (fail-closed) → 502; `HookConfigError` (startup-only) → throws on `buildApp`, never hits HTTP.

---

### `router/src/config/registry.ts` (modify — Zod widen)

**Analog:** `router/src/config/registry.ts:25-110` — Phase 14 `policies.default.model_allowlist` (top-level new field) + Phase 14 per-entry `policy.cloud_allowed` (per-entry new field).

**Top-level new section pattern** (lines 96-110):

```ts
export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
  backends: BackendsSection,
  // Phase 14 (v0.11.0 — POL-01, D-01, D-02, D-04): top-level allowlist
  policies: z
    .object({
      default: z.object({
        model_allowlist: z.array(z.string()).default([]),
      }).optional(),
    })
    .optional(),
}).superRefine((reg, ctx) => { /* … cross-field refinements … */ });
```

→ Phase 18 mirror — add new top-level `mcp_servers:` array + per-entry `mcp_servers_enabled` + `pre_completion_hooks` fields + a new `superRefine` clause that validates every model's `mcp_servers_enabled` reference resolves to a declared alias. Exact code in 18-RESEARCH Example 5 (lines 916-955).

**Per-entry policy widen pattern** (lines 57-62):

```ts
policy: z
  .object({ cloud_allowed: z.boolean().default(true) })
  .optional(),
```

→ Phase 18 mirror on `ModelEntrySchema`:

```ts
mcp_servers_enabled: z.array(z.string()).optional(),   // names must match mcp_servers[].alias
pre_completion_hooks: z.array(z.string()).optional(),  // names must match BuildAppOpts.preCompletionHooks keys
```

**Cross-field validation pattern** (lines 111-120 — VRAM envelope superRefine):

```ts
.superRefine((reg, ctx) => {
  // … sums map, ctx.addIssue on overage …
});
```

→ Phase 18 mirror — alias-reference check inside the same superRefine, OR a new chained `.superRefine`. Exact code in 18-RESEARCH lines 942-954.

---

### `router/src/db/schema/request_log.ts` (modify — `hook_log` JSONB)

**Analog:** `router/src/db/schema/request_log.ts:56-64` — Phase 14 `tenant_id` / `project_id` / `workload_class` columns AND Phase 13 `cost_cents` (lines 47-55).

**Column-add pattern with comment block:**

```ts
// Phase 14 (v0.11.0 — POL-04): scoped-ID columns from X-Tenant-ID / X-Project-ID headers.
tenant_id: text('tenant_id'),
project_id: text('project_id'),
```

→ Phase 18 mirror:

```ts
// Phase 18 (v0.11.0 — RETR-04): per-request pre-completion hook audit trail.
// JSONB; nullable (NULL when no hooks ran). JSON-array shape:
// [{hook_name, context_hash, latency_ms, chars_retrieved, status, error_message?}].
// See router/src/hooks/pre-completion.ts HookLogEntry[] for schema-by-convention.
hook_log: jsonb('hook_log'),
```

**Import addition needed:** `jsonb` from `drizzle-orm/pg-core` — already used elsewhere; check imports.

**P9-01 BLOCK indivisible tuple:** SQL + Drizzle schema diff + `_journal.json` idx=7 land in ONE commit. Test enforcement: extend `router/tests/db/migration-journal.test.ts` with an idx=7 assertion (already in Wave 0 list).

---

### `router/db/migrations/0007_request_log_hook_log.sql` (new — additive)

**Analog:** `router/db/migrations/0006_sessions.sql` (Phase 17) — header + breakpoint + COMMENT idiom.

**Header pattern** (lines 1-26 of 0006):

```sql
-- Migration 0006: sessions + conversation_turns
--   (Phase 17 / v0.11.0 — SESS-02, SESS-03, P4-01 BLOCK, P4-06 FLAG,
--    SUMP-03 BLOCK, P9-01 BLOCK indivisible-tuple invariant).
-- …
-- Idempotent: CREATE TABLE IF NOT EXISTS — re-running this migration is a no-op.
```

**`COMMENT ON COLUMN` for schema-by-convention** (lines 72-79):

```sql
COMMENT ON COLUMN "sessions"."has_pending_tool_call" IS
  'SUMP-03 / P6-01 BLOCK: …';
```

→ Phase 18 mirror — exact form in 18-RESEARCH Example 4 (lines 852-860):

```sql
-- router/db/migrations/0007_request_log_hook_log.sql
-- Phase 18 (v0.11.0 — RETR-04): per-request hook audit trail.
ALTER TABLE "request_log" ADD COLUMN "hook_log" JSONB NULL;
COMMENT ON COLUMN "request_log"."hook_log" IS
  'Phase 18 (RETR-04): array of HookLogEntry … NULL when no hooks ran. JSON-array shape: [{hook_name, context_hash, latency_ms, chars_retrieved, status, error_message?}].';
-- No index — write-heavy column, queries are operator forensics (rare jsonb extracts).
```

**Critical:** `ADD COLUMN` on Postgres 17 is metadata-only for nullable columns (no table rewrite); safe even on a large `request_log`.

---

### `router/db/migrations/meta/_journal.json` (modify — idx=7)

**Analog:** existing entries idx=5 (Phase 14) and idx=6 (Phase 17 — `0006_sessions`).

**Entry shape** (verified from `_journal.json` lines 47-53):

```json
{ "idx": 6, "version": "7", "when": 1780281151546, "tag": "0006_sessions", "breakpoints": true }
```

→ Phase 18 mirror — new entry to append:

```json
{ "idx": 7, "version": "7", "when": <UNIX_MS>, "tag": "0007_request_log_hook_log", "breakpoints": true }
```

The `when` value uses `Date.now()` at commit time. The `meta/0007_snapshot.json` snapshot file also needs to exist (Drizzle creates it via `drizzle-kit generate` OR commit-hand-rolled snapshot file). Project memory `project_drizzle_migration_journal.md`: **new migration needs SQL + schema + `_journal.json` entry as an indivisible tuple**, else migrator silently skips. Wave 0 test `tests/db/migration-journal.test.ts` enforces.

---

### `router/src/metrics/registry.ts` (modify — histogram + counter)

**Analogs (two — different shapes):**

**Counter analog** (lines 124-134 — Phase 15 `routerMcpToolCallsTotal`):

```ts
const routerMcpToolCallsTotal = new Counter({
  name: 'router_mcp_tool_calls_total',
  help: 'MCP tool calls observed by tool + status_class',
  labelNames: ['tool', 'status_class'] as const,
  registers: [register],
});
```

→ Phase 18 mirror for `router_mcp_tool_calls_external_total` (new label set: `server_alias` + `status_class`):

```ts
const routerMcpToolCallsExternalTotal = new Counter({
  name: 'router_mcp_tool_calls_external_total',
  help: 'External MCP tool calls observed by server_alias + status_class',
  labelNames: ['server_alias', 'status_class'] as const,
  registers: [register],
});
```

**Histogram analog** (lines 41-47 — `router_request_duration_seconds`):

```ts
const requestDurationSeconds = new Histogram({
  name: 'router_request_duration_seconds',
  help: 'End-to-end request latency (s)',
  labelNames: ['protocol', 'backend', 'model'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [register],
});
```

→ Phase 18 mirror for `router_hook_duration_ms{hook_name, status}` (note: histogram, not counter — the parent agent's note is correct):

```ts
const routerHookDurationMs = new Histogram({
  name: 'router_hook_duration_ms',
  help: 'Pre-completion hook execution latency (ms)',
  labelNames: ['hook_name', 'status'] as const,
  // ms-scale buckets — hooks are sub-second per design (timeout default 2000ms)
  buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
  registers: [register],
});
```

**Cold-boot pre-warm pattern** (lines 165-166 — Phase 17 fix):

```ts
routerSessionAppendFailedTotal.labels({ reason: 'timeout' }).inc(0);
routerSessionAppendFailedTotal.labels({ reason: 'error' }).inc(0);
```

→ Phase 18 follow-up: pre-warm `routerMcpToolCallsExternalTotal` for known aliases (resolvable at registry construction). The histogram does NOT need pre-warm — `observe()` creates series lazily and histograms with no observations don't emit a line; that's expected.

**POL-06 CI guard (cardinality):** `labelNames` MUST NOT contain `_id`-suffixed entries. `server_alias` and `hook_name` are OPERATOR-DECLARED labels with bounded cardinality (small enum); safe. `status_class` is the existing taxonomy enum. CI gate at `scripts/check-prometheus-cardinality.ts` validates.

---

### `router/tests/fakes.ts` (extend — `makeFakeRetrieverProvider` + `makeFakeMcpClientRegistry`)

**Analog:** `router/tests/fakes.ts:96-141` `makeFakeSessionStore` + `:156-220` `makeFakeContextProvider`.

**Opts-based factory pattern** (lines 71-96):

```ts
export interface FakeSessionStoreOpts {
  history?: Turn[];
  appendShouldTimeout?: boolean;
  loadShouldMiss?: boolean;
  appendCalls?: Array<{ session_id: string; agent_id: string; turn: …; }>;
}

export function makeFakeSessionStore(opts: FakeSessionStoreOpts = {}): SessionStore {
  // … returns object implementing interface, captures calls in opts arrays for assertion …
}
```

→ Phase 18 mirror:

```ts
export interface FakeRetrieverProviderOpts {
  documents?: RetrievedDocument[];   // returned by retrieve(); default []
  shouldTimeout?: boolean;            // simulates P5-02 hook timeout
  shouldThrow?: Error;
  calls?: RetrieverRequest[];         // captures every call
  latencyMs?: number;                 // simulated delay
}
export function makeFakeRetrieverProvider(opts: FakeRetrieverProviderOpts = {}): RetrieverProvider { /* … */ }

export interface FakeMcpClientRegistryOpts {
  toolsByAlias?: Record<string, CanonicalTool[]>;
  toolResultsByAlias?: Record<string, Record<string, unknown>>;
  callTrace?: Array<{ alias: string; toolName: string; args: unknown }>;
  shouldFailOn?: { alias: string; on: 'connect' | 'list' | 'call' };
}
export function makeFakeMcpClientRegistry(opts: FakeMcpClientRegistryOpts = {}): McpClientRegistry { /* … */ }
```

---

### `router/tests/integration/mcp-*-integration.test.ts` (Wave 0 — 5+ files)

**Analog:** `router/tests/integration/mcp-host.integration.test.ts` (Phase 15 — 486 lines).

**Shared `buildMcpApp` fixture pattern** (lines 85-102 of mcp-host.integration.test.ts):

```ts
async function buildMcpApp(overrides?: { mcpEnabled?: boolean; metrics?: MetricsRegistry; }): Promise<{ app: FastifyInstance; metrics: MetricsRegistry }> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const metrics = overrides?.metrics ?? makeMetricsRegistry();
  const app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
    env: overrides?.mcpEnabled !== undefined
      ? ({ MCP_ENABLED: overrides.mcpEnabled } as never)
      : undefined,
  });
  return { app, metrics };
}
```

→ Phase 18 mirror — `buildMcpClientApp` fixture takes overrides for `mcpClientRegistry` (typically the fake) and `preCompletionHooks` (typically a Map with the rag-stub fake).

**JSON-RPC SSE-or-JSON envelope parser** (lines 71-83):

```ts
function extractFirstJsonRpcFrame(body: string): { jsonrpc: string; id: …; result?: unknown; error?: unknown } {
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLine = trimmed.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine.slice(5).trim());
}
```

→ Phase 18 reuses this exact helper for tests against the MSW MCP fixture.

---

### `router/tests/routes/session-attach.integration.test.ts` (analog for 3-route hook tests)

**Analog:** `router/tests/routes/session-attach.integration.test.ts` (Phase 17 — 846 lines) — **EXACT** prior-art for "three-route insertion point integration test".

**Shared adapter spy pattern** (lines 79-100):

```ts
interface AdapterSpy { calls: { canonical: CanonicalRequest; signal: AbortSignal }[]; streamCalls: number; }
function makeAdapterFactory(spy: AdapterSpy): { factory: AdapterFactory; setResponseId(id: string): void; } {
  // … returns factory + setResponseId helper …
}
```

→ Phase 18 mirror in `hook-position.integration.test.ts`, `hook-and-mcp-coexist.integration.test.ts`: the SAME adapter spy. Plus, capture `canonical.system` to assert the hook's fenced content landed there (and ONLY there). Per route, assert that the spy's last canonical contains the `<retrieved_context source="…">` marker AFTER session-attach merged history.

---

### `router/tests/fixtures/mcp-server.ts` (NEW — MSW MCP Streamable HTTP fixture)

**Analog (partial):** `msw` is already a dev-dep (Phase 16); see existing MSW handlers in `router/tests/msw/` for the request-handler signature. **There is NO in-repo MSW-over-MCP-JSON-RPC analog yet** — this is the only greenfield test pattern.

**Documentation source:** 18-RESEARCH §"Pattern" — Frame-02 BLOCK explicitly rejects in-process `MemoryRetriever` fixtures; the MSW fixture is the test boundary. The fixture must serve:
- `POST /mcp` → `initialize` → JSON-RPC `{ result: { protocolVersion, capabilities, serverInfo } }`
- `POST /mcp` → `tools/list` → JSON-RPC `{ result: { tools: [{ name, description, inputSchema }] } }`
- `POST /mcp` → `tools/call` → JSON-RPC `{ result: { content: [...] } }`
- Honor `Authorization: Bearer <per-server-token>` and **assert** the inbound bearer is **NOT** present (P2-04 BLOCK test).

**Implementation hint:** define the handler in a module that exports `setMcpMockResponses({ tools, callResult })` for per-test override (mirrors the upstream-backend stub patterns in `tests/msw/upstream-handlers.ts`).

---

## Shared Patterns

### Phase 17 session-attach insertion shape (CRITICAL — three routes)

**Source:** `router/src/routes/v1/chat-completions.ts:243-307`, `router/src/routes/v1/messages.ts:259-321`, `router/src/routes/v1/responses.ts:368-420`

**Apply to:** the three route handlers — Phase 18 inserts the `runPreCompletionAndInjectMcpTools` call IMMEDIATELY after these blocks, BEFORE the `*RequestToCanonical(...)` call (so the fenced content lands in `canonical.system`, not in messages).

**Pattern:** every block opens with `// ─── Phase 17 (SESS-01..06 + CTXP-01..03 + SUMP-02): session attach ──` and closes with `// ─── End session attach ──` comment fences. Phase 18 mirrors with `// ─── Phase 18 (MCPC-01..06 + RETR-01..06): hook chain + MCP tool injection ──` fences. Easy to grep, easy to remove in future refactors.

---

### Helper-isolation (protocol-agnosticism)

**Source:** `router/src/dispatch/preflight.ts:28-31` header comment

**Apply to:** `router/src/mcp/client/registry.ts`, `router/src/mcp/client/tool-loop.ts`, `router/src/hooks/pre-completion.ts`, `router/src/routes/v1/helpers/pre-completion.ts`

```
NO imports from `router/src/mcp/`.
NO imports from `router/src/routes/`.
This module is consumed by both surfaces.
```

For Phase 18 specifically: `router/src/hooks/` MUST NOT import from `router/src/routes/`. The route helper at `router/src/routes/v1/helpers/pre-completion.ts` is the ONLY file allowed to glue the two together.

---

### Optional-provider-with-stateless-fallback (Phase 17 SESS-06 contract)

**Source:** `router/src/routes/v1/chat-completions.ts:259-261`

```ts
if (req.sessionId && opts.sessionStore && req.agentId) {
  // … session attach …
}
```

**Apply to:** Phase 18 route patches. Hook chain fires ONLY when `opts.preCompletionHooks?.get(routeKey)?.length > 0`. MCP tool injection fires ONLY when `entry.mcp_servers_enabled?.length && opts.mcpClientRegistry && !canonical.stream`. ALL paths must remain byte-identical to Phase 17 when the providers are absent — Phase 17 tests already in `tests/routes/session-attach.integration.test.ts` give the regression gate.

---

### Structured pino warn-log on fail-open (`event: '...'` discipline)

**Sources:**
- `router/src/routes/v1/chat-completions.ts:293-305` — `event: 'session_attach_failed'`
- `router/src/providers/postgres-session-store.ts` Pitfall 17-E — `event: 'session_append_failed_open'`
- 18-RESEARCH §Pattern 3 line 458 — `event: 'mcp_tool_name_rejected'`

```ts
req.log.warn(
  { hook_name, err: errorMessage, status, event: 'hook_fail_open' },
  'pre-completion hook failed-open',
);
```

**Apply to:** every Phase 18 fail-open path — `hook_fail_open`, `hook_timeout`, `mcp_tool_name_rejected`, `mcp_tool_description_truncated`, `mcp_servers_change` (hot-reload event analog to existing `policy_change` warn).

---

### Indivisible-tuple migration commit (P9-01 BLOCK)

**Source:** `router/db/migrations/0006_sessions.sql` + `router/src/db/schema/index.ts` re-exports + `_journal.json` idx=6 — all landed in one Phase 17 commit.

**Apply to:** Phase 18 migration 0007 — SQL file + `request_log.ts` schema diff + `_journal.json` idx=7 in ONE commit. Project memory `project_drizzle_migration_journal.md` warns: missing journal entry causes Drizzle migrator to silently skip the migration.

---

### `models.yaml` schema widen audit pattern (Phase 14)

**Source:** Phase 14 added (a) top-level `policies.default.model_allowlist`, (b) per-entry `policy.cloud_allowed` (existing in `config/registry.ts:57-62`).

**Apply to:** Phase 18 — top-level `mcp_servers: [...]` array + per-entry `mcp_servers_enabled: [...]` + `pre_completion_hooks: [...]`. Cross-field `superRefine` validates that every per-entry alias reference resolves to a declared `mcp_servers[]` alias (same VRAM-envelope-style cross-field pattern as `RegistrySchema.superRefine` at lines 111+).

User memory `project_models_yaml_hot_edit.md`: editing `models.yaml` requires **DEL of Valkey cache + `up -d --force-recreate`** of the router (not `restart`). Phase 18's `mcp:tools:{alias}` cache MUST also be DEL'd by the registry `onSwap` subscriber on alias removal/change.

---

### Three-route shared-fixture integration test (Phase 17 pattern)

**Source:** `router/tests/routes/session-attach.integration.test.ts` lines 33-77 (shared YAML + TOKEN + adapter spy), lines 79-100 (`makeAdapterFactory`).

**Apply to:** Phase 18 integration tests for `hook-position`, `hook-and-mcp-coexist`, `mcp-client-prefix-routing`, `mcp-client-auth-isolation`. The pattern is: SAME YAML/TOKEN/adapter-spy across the 3 routes; per-route subdescribe block; assert the spy's last canonical reflects the expected system/tools.

---

### Project memory carry-overs (load-bearing)

- `project_fastify_onsend_timing.md` — onSend fires sync inside `reply.send()`; stamp request-data BEFORE `.send()`, not in `finally`. Relevant to Phase 18 because the X-Hook-Error header MUST be stamped BEFORE the route's reply path (mirror Pitfall 17-D: stamp X-Session-ID BEFORE `reply.sse/reply.send`).
- `project_gapclosure_state_regression.md` — `phase.complete` on an earlier phase of a finished milestone regresses STATE.md; verify after.
- `project_retrieval_agnostic_principle.md` — the load-bearing frame for Phase 18: NO real retriever ships.

---

## No Analog Found

Files with no close in-repo match — planner should use 18-RESEARCH patterns directly (note: only 1 of 27 files is truly greenfield):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `router/tests/fixtures/mcp-server.ts` | test fixture | request-response (HTTP) | MSW exists in dev-deps (Phase 16) but no in-repo MSW-over-MCP-JSON-RPC handler exists. Build greenfield per 18-RESEARCH §Frame-02 BLOCK. Closest documentation: MCP SDK's own test fixtures + 18-RESEARCH lines 86-100 (MSW pattern). |

Everything else maps to a Phase 14/15/16/17 prior-art. The deepest pattern reuse is for Phase 17's three-route helper shape (`session-attach.ts` → `pre-completion.ts`) and Phase 15's MCP SDK install + lifecycle (`host/plugin.ts` → `client/registry.ts`).

---

## Metadata

**Analog search scope:**
- `router/src/mcp/` (host + tools)
- `router/src/providers/` (session-store, context-provider, summary-provider)
- `router/src/routes/v1/` (chat-completions, messages, responses, embeddings, rerank, helpers)
- `router/src/dispatch/`
- `router/src/clients/`
- `router/src/metrics/`
- `router/src/errors/`
- `router/src/config/`
- `router/src/db/schema/`
- `router/db/migrations/`
- `router/tests/integration/`
- `router/tests/routes/`
- `router/tests/fakes.ts`

**Files read (no duplicates, no re-reads):**
- `router/src/mcp/host/plugin.ts` (290 lines, full)
- `router/src/providers/context-provider.ts` (337 lines, full)
- `router/src/providers/session-store.ts` (232 lines, full)
- `router/src/providers/postgres-session-store.ts` (lines 1-100)
- `router/src/clients/valkey.ts` (141 lines, full)
- `router/db/migrations/0006_sessions.sql` (82 lines, full)
- `router/db/migrations/meta/_journal.json` (55 lines, full)
- `router/src/db/schema/request_log.ts` (83 lines, full)
- `router/src/routes/v1/helpers/session-attach.ts` (379 lines, full)
- `router/src/dispatch/preflight.ts` (78 lines, full)
- `router/src/metrics/registry.ts` (185 lines, full)
- `router/src/errors/envelope.ts` (lines 1-100)
- `router/src/config/registry.ts` (lines 1-120)
- `router/src/routes/v1/chat-completions.ts` (lines 240-325 — Phase 17 session-attach block)
- `router/tests/fakes.ts` (lines 60-170)
- `router/tests/integration/mcp-host.integration.test.ts` (lines 1-120)
- `router/tests/routes/session-attach.integration.test.ts` (lines 1-100)
- Grep-only inspection of `router/src/routes/v1/messages.ts` and `router/src/routes/v1/responses.ts` (insertion-point line numbers verified)
- Grep-only inspection of `router/src/app.ts` and `router/src/index.ts` (BuildAppOpts widening pattern + index.ts composition root)

**Pattern extraction date:** 2026-06-01
