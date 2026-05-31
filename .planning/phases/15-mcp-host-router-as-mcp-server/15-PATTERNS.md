# Phase 15: MCP Host (Router as MCP Server) - Pattern Map

**Mapped:** 2026-05-31
**Files analyzed:** 21 new files + 10 modified files (31 total)
**Analogs found:** 28 / 31 (3 net-new with no direct analog)

## File Classification

| New/Modified File | Status | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|--------|------|-----------|----------------|---------------|
| `router/src/mcp/host/plugin.ts` | NEW | Fastify plugin (multi-method route + session map) | request-response | `router/src/app.ts` (FastifySSEPlugin registration + onClose hook) + `router/src/db/bufferedWriter.ts` (interval timer + drain pattern) | role-match |
| `router/src/mcp/host/session-gc.ts` | NEW | utility (timer-driven sweep + SIGTERM race) | event-driven | `router/src/db/bufferedWriter.ts` (setInterval + unref + drain race) | exact (timer + race shape) |
| `router/src/mcp/host/tools/chat-completion.ts` | NEW | tool handler (request-response, non-stream) | request-response | `router/src/routes/v1/chat-completions.ts` (canonical pipeline lines 159-225 + finally/safeRecord lines 295-310) | role-match |
| `router/src/mcp/host/tools/create-response.ts` | NEW | tool handler | request-response | `router/src/routes/v1/responses.ts` | role-match |
| `router/src/mcp/host/tools/create-embedding.ts` | NEW | tool handler | request-response | `router/src/routes/v1/embeddings.ts` | role-match |
| `router/src/mcp/host/tools/rerank.ts` | NEW | tool handler | request-response | `router/src/routes/v1/rerank.ts` (lines 130-165) | role-match |
| `router/src/mcp/host/tools/list-models.ts` | NEW | tool handler (read-only registry projection) | request-response | `router/src/routes/v1/models.ts` (entire file — projection + T-3-A2 anti-leak) | exact (shared projection logic) |
| `router/src/mcp/host/index.ts` | NEW | barrel re-export | n/a | `router/src/policy/gate.ts` (small single-export module) | role-match |
| `router/src/dispatch/preflight.ts` | NEW | helper (resolve + gate + breaker) | request-response | `router/src/policy/gate.ts` (function signature) + `router/src/routes/v1/chat-completions.ts` lines 161,225,331-338 (the trio being extracted) | exact (code-motion target) |
| `router/src/config/env.ts` | MODIFIED | env config (Zod loader) | n/a | self — existing `EnvSchema` lines 53-63 (`CIRCUIT_*` knobs) | exact (append-pattern) |
| `router/src/metrics/registry.ts` | MODIFIED | metrics registration | n/a | self — existing `makeCounter`/`Histogram` blocks lines 34-122 | exact |
| `router/src/metrics/recordOutcome.ts` | MODIFIED | type widening (`'openai'\|'anthropic'` → +`'mcp'`) | n/a | self — line 64 `protocol` union | exact (single-line widening) |
| `router/src/app.ts` | MODIFIED | plugin registration + onClose chain extension | n/a | self — lines 243 (FastifySSEPlugin) + 648-661 (onClose) | exact |
| `router/src/routes/v1/chat-completions.ts` | MODIFIED | refactor inline preflight → applyPreflight | request-response | self — lines 161, 225, 331-338 (existing inline trio) | exact (motion) |
| `router/src/routes/v1/messages.ts` | MODIFIED | refactor inline preflight → applyPreflight | request-response | self — lines 197, 228, 285 (existing inline trio) | exact |
| `router/src/routes/v1/embeddings.ts` | MODIFIED | refactor inline preflight → applyPreflight | request-response | self — lines 236, 240 | exact |
| `router/src/routes/v1/rerank.ts` | MODIFIED | refactor inline preflight → applyPreflight | request-response | self — lines 140, 142 | exact |
| `router/src/routes/v1/responses.ts` | MODIFIED | refactor inline preflight → applyPreflight | request-response | self — lines 369, 371 | exact |
| `router/src/routes/v1/models.ts` | MODIFIED | widen projection (`cloud_allowed` + allowlist filter) | request-response | self — lines 14-32 (GET /v1/models) + 38-59 (GET /v1/models/:id) | exact |
| `router/package.json` | MODIFIED | dep add `@modelcontextprotocol/sdk@^1.29.0` | n/a | self — existing `dependencies` | exact |
| `router/.env.example` | MODIFIED | docs — 3 new env vars | n/a | self — existing env documentation | exact |
| `DEPLOY.md` | MODIFIED | docs — MCP endpoint section | n/a | self — existing sections | exact |
| `README.md` | MODIFIED | docs — MCP capability mention | n/a | self | exact |
| `bin/smoke-test-router.sh` | MODIFIED | smoke test script | request-response | self — existing curl-based smoke sections | exact |
| `router/tests/unit/dispatch/preflight.test.ts` | NEW | unit test (helper) | n/a | `router/src/policy/__tests__/gate.test.ts` (if exists) — pure-function vitest pattern | role-match |
| `router/tests/unit/mcp/host/plugin.test.ts` | NEW | unit test (session map + GC + onClose) | n/a | `router/tests/integration/shutdown.test.ts` (onClose chain) | role-match |
| `router/tests/unit/mcp/host/tools/chat-completion.test.ts` | NEW | unit test (tool handler) | n/a | `router/tests/integration/rerank.test.ts` (FakeAdapter pattern) | role-match |
| `router/tests/unit/mcp/host/tools/list-models.test.ts` | NEW | unit test (projection + filter) | n/a | `router/tests/integration/models.test.ts` | role-match |
| `router/tests/integration/mcp-host.integration.test.ts` | NEW | integration test (initialize + tools/list + tools/call round-trip) | request-response | `router/tests/integration/rerank.test.ts` (buildApp + inject + assert) | role-match |
| `router/tests/integration/mcp-shutdown.integration.test.ts` | NEW | integration test (SIGTERM session cleanup) | event-driven | `router/tests/integration/shutdown.test.ts` | exact |
| `router/tests/integration/mcp-request-log.integration.test.ts` | NEW | integration test (request_log row shape) | n/a | `router/tests/integration/rerank.test.ts` + `recordOutcome.test.ts` | role-match |
| `router/tests/integration/mcp-metrics.integration.test.ts` | NEW | integration test (Prometheus counter + gauge) | n/a | `router/tests/integration/auth.test.ts` (metrics registry use) | role-match |
| `router/tests/integration/mcp-disabled.integration.test.ts` | NEW | integration test (MCP_ENABLED=false → 404) | n/a | `router/tests/integration/auth.test.ts` | role-match |
| `router/tests/integration/list-models-policy-filter.integration.test.ts` | NEW | integration test (allowlist + cloud_allowed) | n/a | `router/tests/integration/models.test.ts` | role-match |
| `router/tests/golden/mcp-tools-manifest.json` | NEW | snapshot (drift gate per Pitfall 3) | n/a | none — Phase 15 introduces golden-snapshot pattern | no analog |

## Pattern Assignments

### `router/src/dispatch/preflight.ts` (new helper, request-response)

**Analog A — function shape:** `router/src/policy/gate.ts`
**Analog B — code being extracted:** `router/src/routes/v1/chat-completions.ts` lines 161, 225, 331-338

**Pure-function module header pattern** (`router/src/policy/gate.ts` lines 1-17):
```typescript
/**
 * Phase 14 (v0.11.0 — POL-01 / POL-02): Policy gate helper (CONTEXT.md D-07/D-08).
 *
 * D-07: Exports one function — `applyPolicyGate(policies, entry, requested_model): void`.
 * ...
 * T-14-CIRC-01: One-way import — gate.ts → envelope.ts; envelope.ts does NOT import gate.ts.
 */
import { AllowlistViolationError, CloudNotAllowedError } from '../errors/envelope.js';
import type { Registry, ModelEntry } from '../config/registry.js';
```

**Trio being lifted into applyPreflight** (`router/src/routes/v1/chat-completions.ts`):
```typescript
// Line 161 — resolve
const entry = opts.registry.resolve(body.model);
// ... (lines 162-220: capability + cloud-cap guards that stay in the route)

// Line 225 — policy gate (after capability check, before breaker)
applyPolicyGate(opts.registry.get().policies, entry, body.model);

// Lines 331-338 — breaker (inside try block, after policy gate)
const breakerResult = await opts.breaker.check(entry.backend);
if (breakerResult.state === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}
```

**Same trio in `router/src/routes/v1/rerank.ts` lines 140-146** (verifies pattern is duplicated identically):
```typescript
applyPolicyGate(opts.registry.get().policies, entry, body.model);

const breakerResult = await opts.breaker.check(entry.backend);
if (breakerResult.state === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}
```

**Recommended return shape (RESEARCH Open Question 1, Option A — sentinel return):**
Helper returns `{ entry, breakerState }`; HTTP routes inspect `breakerState === 'open'`, stamp `Retry-After` on `reply`, then throw `BreakerOpenError(entry.backend, opts.breakerCooldownSec)`. MCP tool handlers inspect `breakerState === 'open'` and throw without header stamping. Preserves byte-identical HTTP wire behavior.

---

### `router/src/mcp/host/plugin.ts` (new Fastify plugin, request-response)

**Analog A — plugin registration:** `router/src/app.ts` line 243

**Plugin registration call site precedent** (`router/src/app.ts` line 243):
```typescript
// SSE plugin — registered now so plan 02-04's stream branch can call reply.sse(...)
// without re-registering. No options — defaults are correct.
await app.register(FastifySSEPlugin);
```

**Analog B — onClose hook chain:** `router/src/app.ts` lines 648-661

**Existing onClose pattern with timer cleanup + ordered teardown** (`router/src/app.ts`):
```typescript
app.addHook('onClose', async () => {
  liveness.stop();
  probeAdapters.clear();
  semaphoreMap.clear();
  opts.usageDailyScheduler?.stop();
  // Plan 08-01 (DATA-06) — close Valkey BEFORE bufferedWriter.drain so any
  // pending Valkey-bound writes (breaker / rate-limit / idempotency state)
  // settle before the pg drain runs.
  if (opts.valkey) await closeValkey(opts.valkey, app.log as Logger);
  await opts.bufferedWriter.drain(3_000);
});
```

**Apply to plugin:** The MCP plugin's own `app.addHook('onClose', …)` runs in addition to this — Fastify v5 fires onClose hooks in registration order, so the MCP plugin's onClose runs AFTER `bufferedWriter.drain` returns. (Verified in RESEARCH §Pattern 2 ordering.)

**Multi-method route registration target** (per RESEARCH §Pattern 1):
```typescript
app.route({
  method: ['POST', 'GET', 'DELETE'],
  url: '/mcp',
  handler: async (req, reply) => { /* delegate to transport */ },
});
```

This single-route registration inherits the root-scoped `onRequest` bearer hook + `preHandler` scopedIds/agentId hooks per Fastify v5 hook propagation (verified at `app.ts:275` + `app.ts:303` + `app.ts:311`).

---

### `router/src/mcp/host/session-gc.ts` (new utility, event-driven)

**Analog:** `router/src/db/bufferedWriter.ts` lines 140-144 + 168-184

**setInterval + unref pattern** (`router/src/db/bufferedWriter.ts` lines 140-144):
```typescript
const timer: NodeJS.Timeout = setInterval(() => {
  void flush();
}, flushIntervalMs);
// Don't keep the event loop alive solely for the writer (RESEARCH Pattern 1).
timer.unref?.();
```

**Drain-race pattern (timeout vs settled close)** (`router/src/db/bufferedWriter.ts` lines 168-184):
```typescript
async drain(timeoutMs = 3_000): Promise<void> {
  stopped = true;
  clearInterval(timer);
  await Promise.race([
    flush({ force: true }),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
```

**Apply to session-gc.ts:**
- `startSessionGc({ ttlMs, intervalMs, sessionMap, metrics, log }): NodeJS.Timeout` — `setInterval` + `unref()`
- `shutdownSessions(sessionMap, log)` — `Promise.race([Promise.allSettled(transport.close), setTimeout(5_000)])`
- Update `metrics.routerMcpActiveSessions.set(sessionMap.size)` on every sweep that removed entries

---

### `router/src/mcp/host/tools/chat-completion.ts` (new tool handler, request-response)

**Analog:** `router/src/routes/v1/chat-completions.ts`

**Schema import + reuse pattern** (`router/src/routes/v1/chat-completions.ts` lines 80-87):
```typescript
export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
```

**Adapter call shape** (`router/src/routes/v1/chat-completions.ts` line 511 stream + an analogous non-stream call elsewhere):
```typescript
upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
```

The MCP tool handler uses the non-stream sibling: `await adapter.chatCompletionsCanonical(canonical, controller.signal)` (D-12 stream coercion).

**Adapter type contract** (`router/src/backends/adapter.ts` lines 17-27):
```typescript
export interface BackendAdapter {
  chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse>;
  // ... stream sibling + embeddings + rerank + probeLiveness
}
```

**Error catch pattern** (`router/src/errors/envelope.ts` lines 428-434):
```typescript
export function toOpenAIErrorEnvelope(err: unknown): EnvelopeOrSkip {
  if (err instanceof APIUserAbortError) return NO_ENVELOPE;
  if (err instanceof BearerAuthError) {
    return { error: { message: err.message, type: 'authentication_error', code: 'unauthorized', param: null } };
  }
  // ...
}
```

**Apply to tool handler catch block (D-04):**
```typescript
} catch (err) {
  const env = toOpenAIErrorEnvelope(err);
  if (typeof env === 'symbol') {  // NO_ENVELOPE → client disconnect
    return { content: [{ type: 'text', text: 'client disconnected' }],
             structuredContent: { error: 'client_disconnect', code: 'client_disconnect', message: 'client disconnected' },
             isError: true };
  }
  return { content: [{ type: 'text', text: env.error.message }],
           structuredContent: { error: env.error.type, code: env.error.code, message: env.error.message },
           isError: true };
}
```

**Request-log finally-block pattern** (`router/src/routes/v1/chat-completions.ts` lines 295-310):
```typescript
let recorded = false;
const safeRecord = (ctx: OutcomeContext): void => {
  if (recorded) return;
  recorded = true;
  req.__recorded = true;
  opts.recordOutcome(ctx);
};
```

The MCP tool handler skips the `req.__recorded` flag (no centralized error handler covers MCP tool returns) but keeps the `recorded` idempotency boolean and pushes directly via `deps.bufferedWriter.push(row)`. Row shape mirrors `OutcomeContext` but uses `'mcp'` for `protocol`.

---

### `router/src/mcp/host/tools/list-models.ts` (new tool handler, request-response)

**Analog:** `router/src/routes/v1/models.ts` (entire file)

**Projection + T-3-A2 anti-leak pattern** (`router/src/routes/v1/models.ts` lines 13-32):
```typescript
export function registerModelsRoute(app: FastifyInstance, registry: RegistryStore): void {
  app.get('/v1/models', async () => {
    const reg = registry.get();
    const created = registry.getCreatedAtSec();
    return {
      object: 'list' as const,
      data: reg.models.map((m) => ({
        id: m.name,
        object: 'model' as const,
        created,
        owned_by: 'local-llms' as const,
        // T-3-A2: explicitly listed fields — no spread of ModelEntry,
        // so backend_url, backend, backend_model never leak to clients.
        capabilities: m.capabilities,
      })),
    };
  });
  // GET /v1/models/:id — same projection + 404 envelope
}
```

**Apply to BOTH `list-models` tool AND HTTP route (D-10 / D-11):**
- Add `policy: { cloud_allowed: m.policy?.cloud_allowed ?? true }` to the projection object (one field add).
- Pre-projection filter: `const allow = reg.policies?.default?.model_allowlist ?? []; reg.models.filter(m => allow.length === 0 || allow.includes(m.name))`.
- Backend remains explicitly omitted (do NOT spread `ModelEntry`).
- `GET /v1/models/:id`: extend the 404 condition to `if (!entry || (allow.length > 0 && !allow.includes(entry.name)))` so single-model lookup respects the allowlist with the same lens.

---

### `router/src/metrics/registry.ts` (modified, add 2 metrics)

**Analog:** Same file, lines 34-47 + lines 64-68 (Counter + Gauge precedents)

**Counter registration pattern** (`router/src/metrics/registry.ts` lines 34-39):
```typescript
const requestsTotal = new Counter({
  name: 'router_requests_total',
  help: 'Total number of model requests by protocol/backend/model/status_class',
  labelNames: ['protocol', 'backend', 'model', 'status_class'] as const,
  registers: [register],
});
```

**No-label Counter pattern** (`router/src/metrics/registry.ts` lines 64-68):
```typescript
const logBufferDroppedTotal = new Counter({
  name: 'router_log_buffer_dropped_total',
  help: 'Rows dropped by the bufferedWriter due to overflow (D-A1 drop-oldest)',
  registers: [register],
});
```

**Add to `makeMetricsRegistry()` body and to the returned object literal:**
```typescript
// Phase 15 (v0.11.0 — MCPS-01..06 / D-07): MCP tool-call counter.
// Cardinality: 5 tools × ~5 status_classes ≈ 25 series — well under POL-06 cap.
// labelNames MUST NOT contain '_id'-suffixed entries (POL-06 invariant, enforced
// by scripts/check-prometheus-cardinality.ts).
const routerMcpToolCallsTotal = new Counter({
  name: 'router_mcp_tool_calls_total',
  help: 'MCP tool calls observed by tool + status_class',
  labelNames: ['tool', 'status_class'] as const,
  registers: [register],
});

// Phase 15 (v0.11.0 — MCPS-05 / D-07): active MCP session count.
// Updated on session create / GC sweep / onClose. Operational canary for P1-04.
const routerMcpActiveSessions = new Gauge({
  name: 'router_mcp_active_sessions',
  help: 'Currently-tracked MCP Streamable HTTP sessions',
  registers: [register],
});
```

**Note:** `Gauge` is not imported in the current file — extend the `import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client'` line to add `Gauge`.

---

### `router/src/metrics/recordOutcome.ts` (modified, type widening only)

**Analog:** Same file, line 64

**Current shape** (`router/src/metrics/recordOutcome.ts` line 64):
```typescript
export interface OutcomeContext {
  protocol: 'openai' | 'anthropic';
  ...
}
```

**Widening (per Pitfall 7):**
```typescript
protocol: 'openai' | 'anthropic' | 'mcp';
```

prom-client label values accept arbitrary strings — no further widening required at the metrics layer (RESEARCH §Assumption A3, verified).

---

### `router/src/config/env.ts` (modified, append 3 env vars)

**Analog:** Same file, lines 53-63 (`CIRCUIT_*` knobs — numeric env with `.coerce`).

**Existing coerce pattern** (`router/src/config/env.ts` lines 53-55):
```typescript
CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(30_000),
CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(1_000).default(60_000),
```

**Apply (D-15):**
```typescript
// Phase 15 (v0.11.0 — MCPS-01..06 / D-15): MCP host plugin env knobs.
// MCP_ENABLED=false skips /mcp registration entirely (→ 404). Defaults make
// zero-config deployment continue to work.
MCP_ENABLED: z.coerce.boolean().default(true),
MCP_SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
MCP_GC_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000),
```

---

### `router/src/app.ts` (modified, plugin registration + opts widening)

**Analog:** Same file, line 243 (FastifySSEPlugin registration) + lines 648-661 (onClose chain).

Register `mcpHostPlugin` AFTER `FastifySSEPlugin` and AFTER hook registrations (so root-scoped onRequest+preHandler hooks all fire on `/mcp`):
```typescript
await app.register(mcpHostPlugin, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
  bufferedWriter: opts.bufferedWriter,
  metrics: opts.metrics,
  breaker,
  env: {
    MCP_ENABLED: opts.env?.MCP_ENABLED ?? true,
    MCP_SESSION_TTL_SEC: opts.env?.MCP_SESSION_TTL_SEC ?? 3600,
    MCP_GC_INTERVAL_MS: opts.env?.MCP_GC_INTERVAL_MS ?? 1_800_000,
  },
});
```

`BuildAppOpts.env` Pick needs widening to include the three new keys.

---

### `router/tests/integration/mcp-host.integration.test.ts` (new integration test)

**Analog:** `router/tests/integration/rerank.test.ts` lines 1-66 (buildApp + FakeAdapter + inject) + `router/tests/integration/auth.test.ts` lines 26-42 (buildApp + bearer + cleanup).

**buildApp + FakeAdapter pattern** (`router/tests/integration/rerank.test.ts` lines 35-66):
```typescript
function makeFakeAdapter(scores: number[]): BackendAdapter {
  return {
    async chatCompletionsCanonical(): Promise<never> { throw new Error('not used'); },
    async chatCompletionsCanonicalStream(): Promise<never> { throw new Error('not used'); },
    async probeLiveness() { return { ok: true, latencyMs: 1 }; },
    async embeddings(): Promise<never> { throw new Error('not used'); },
    async rerank(_query, documents, model) {
      return { model, results: documents.map((_d, i) => ({ index: i, relevance_score: scores[i] ?? 0 })),
               usage: { total_tokens: documents.reduce((s, d) => s + d.length, 0) } };
    },
  };
}

async function setup(scores: number[]): Promise<void> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => makeFakeAdapter(scores),
    semaphores: { get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
}
```

**Bearer-enforcement assertion pattern** (`router/tests/integration/auth.test.ts` lines 62-69):
```typescript
it('Any /v1/* request returns 401 with NO Authorization header', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/chat/completions' });
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe('unauthorized');
});
```

**Apply to MCP integration test:** Replace path with `/mcp`; bearer-less POST → 401 (MCPS-02). For `tools/list`, send an initialize JSON-RPC request with a bearer + capture the `Mcp-Session-Id` reply header, then `tools/list` JSON-RPC over the same session → assert all 5 tool names present (MCPS-01 + MCPS-03).

---

## Shared Patterns

### Pattern S1 — Bearer auth (applied to all MCP routes)

**Source:** `router/src/auth/bearer.ts` (registered at root scope in `router/src/app.ts:275`)

**Existing root-scoped registration** (`router/src/app.ts` lines 268-275):
```typescript
app.addHook('onRequest', async (req) => {
  if (req._t0 === undefined) req._t0 = performance.now();
});
// Bearer auth — onRequest hook runs BEFORE body parsing and zod validation.
app.addHook('onRequest', makeBearerHook(opts.bearerToken));
```

**Apply to:** No new code — `/mcp` automatically inherits this via root-scope propagation. The plan must NOT modify `auth/bearer.ts` `PUBLIC_PATHS`. (Verified at `auth/bearer.ts` — `/mcp` is not listed, so the bearer hook fires.)

### Pattern S2 — Scoped IDs preHandler (applied to all MCP routes for tenant/project/agent IDs)

**Source:** `router/src/middleware/scopedIds.ts` lines 109-129 + `router/src/middleware/agentId.ts` lines 120-125

**Root-scoped preHandler registration** (`router/src/app.ts` lines 303 + 311):
```typescript
app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);
app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**Pino child enrichment (single source of truth — Pitfall-9 grep gate)** (`router/src/middleware/agentId.ts` lines 120-125):
```typescript
// THIS IS THE ONLY pino child reassignment in router/src/ production source
// (grep gate: grep -rn 'req\.log = ' router/src/ | grep -v '__tests__' | wc -l  == 1).
req.log = req.log.child({
  agent_id: value,
  tenant_id: req.tenantId,
  project_id: req.projectId,
  workload_class: req.workloadClass,
});
```

**Apply to MCP tool handlers (D-06 / D-08):**
- Tool handlers MUST NOT reassign `req.log` — they create detached children: `const toolLog = req.log.child({ tool_name, mcp_session_id, mcp_request_id })`.
- Plugin captures `req` in closure at session-initialize time; tool handlers read `capturedReq.tenantId / projectId / agentId / workloadClass / id` for the bufferedWriter row.

### Pattern S3 — Error envelope mapping (applied to every tool handler catch block)

**Source:** `router/src/errors/envelope.ts:429` (`toOpenAIErrorEnvelope`)

**Existing class-to-envelope mapping** (`router/src/errors/envelope.ts` lines 459-472):
```typescript
if (err instanceof RegistryUnknownModelError) {
  return { error: { message: err.message, type: 'not_found_error', code: 'model_not_found', param: 'model' } };
}
if (err instanceof CapabilityNotSupportedError) {
  return { error: { message: err.message, type: 'invalid_request_error', code: 'model_capability_mismatch', param: 'model' } };
}
```

**Apply to:** All 5 MCP tool handlers — D-04 mandates `toOpenAIErrorEnvelope(err)` is called inside the catch block; the envelope's `{type, code, message}` is stamped into both `content` and `structuredContent` (per the catch-block pattern in §`chat-completion.ts` above). Single error vocabulary across HTTP + MCP surfaces.

### Pattern S4 — Buffered request_log push (applied to every tool handler finally block)

**Source:** `router/src/db/bufferedWriter.ts` lines 146-166 (`push()` API)

**Push API surface** (`router/src/db/bufferedWriter.ts` lines 82-86):
```typescript
export interface BufferedWriter {
  push(row: RequestLogInsert): void;
  drain(timeoutMs?: number): Promise<void>;
  readonly size: number;
}
```

**Apply to MCP tool handler `finally` block (D-05 / D-06):**
- Row shape mirrors `OutcomeContext` (recordOutcome.ts:63) with `protocol: 'mcp'`, `route: '/mcp'`.
- `request_log.protocol` is free-text TEXT NOT NULL — no migration required (verified at `db/migrations/0000_init.sql:5`, no CHECK constraint).
- Fail-safe: bufferedWriter drops on full FIFO + emits warn — no exception bubbles out of `push()`.

### Pattern S5 — AbortController + abort propagation (applied to every tool handler)

**Source:** `router/src/routes/v1/chat-completions.ts` lines 230-265

**Existing HTTP route abort pattern** (`router/src/routes/v1/chat-completions.ts` lines 230-249):
```typescript
const controller = new AbortController();
let stopHeartbeat: (() => void) | null = null;
const onClose = (): void => {
  controller.abort(new Error('client-disconnect'));
  stopHeartbeat?.();
};
```

**Apply to tool handler (D-14):**
```typescript
const controller = new AbortController();
extra.signal.addEventListener('abort', () => controller.abort());
const result = await adapter.chatCompletionsCanonical(canonical, controller.signal);
```

The `extra.signal` is provided by the MCP SDK; it fires when the MCP transport detects client disconnect, session DELETE, or SIGTERM-driven transport close. Confirmed in RESEARCH §Pattern 3 + §Open Question 2.

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns instead):

| File | Role | Data Flow | Reason / Source to Use |
|------|------|-----------|------------------------|
| MCP transport delegation in `plugin.ts` (`transport.handleRequest(req.raw, reply.raw, req.body)`) | route handler core | request-response | No existing raw `req.raw`/`reply.raw` integration. Source: RESEARCH §Pattern 1 (Streamable HTTP boilerplate) + MCP SDK example `simpleStreamableHttp.ts`. |
| Session map (`Map<string, SessionEntry>` with `Mcp-Session-Id` keying + `isInitializeRequest` branching) | in-process state | event-driven | No existing in-process session-map pattern. Source: RESEARCH §Pattern 1. Closest shape is the `idempotencyMultiplexer` Map (router/src/resilience/idempotency.ts) but the semantics differ (request-response keyed vs session-lifecycle keyed). |
| `mcp-tools-manifest.json` golden snapshot | test fixture | n/a | Phase 15 introduces the golden-snapshot pattern. Source: RESEARCH §Pitfall 3 + §Validation Architecture Wave 0 Gaps (vitest snapshot serializer; no analog in `router/tests/golden/` because directory does not yet exist). |

## Metadata

**Analog search scope:** `router/src/` (app.ts, routes/v1/*, policy/, middleware/, metrics/, db/, errors/, backends/, config/, resilience/), `router/tests/integration/`, `router/tests/unit/`
**Files scanned:** 38 source files + 20 test files (read or grep-confirmed)
**Pattern extraction date:** 2026-05-31
**Key files verified by direct Read:** `app.ts:230-345`, `app.ts:600-680`, `routes/v1/chat-completions.ts:75-340,505-545`, `routes/v1/models.ts (full)`, `routes/v1/rerank.ts:130-165`, `policy/gate.ts (full)`, `middleware/scopedIds.ts (full)`, `middleware/agentId.ts:85-127`, `metrics/registry.ts (full)`, `metrics/recordOutcome.ts:40-130`, `config/env.ts (full)`, `db/bufferedWriter.ts:1-180`, `errors/envelope.ts:295-475`, `backends/adapter.ts:1-50`, `tests/integration/rerank.test.ts:1-80`, `tests/integration/auth.test.ts:1-80`
