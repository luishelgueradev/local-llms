# Phase 19: EmbeddingProvider Formalization + Observability Hardening — Pattern Map

**Mapped:** 2026-06-01
**Files analyzed:** 12 (4 NEW, 7 MODIFIED, 1 NEW migration test extension)
**Analogs found:** 12 / 12 (every new/modified file has at least one exact analog from Phase 14/17/18)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `router/src/providers/embedding-provider.ts` (NEW) | provider (interface + factory) | request-response | `router/src/providers/retriever-provider.ts` (interface) + `router/src/providers/session-store.ts` (interface+factory shape) | exact (Frame-01) |
| `router/src/types/fastify.d.ts` (NEW) | type augmentation | n/a (declarations) | inline `declare module 'fastify'` in `router/src/app.ts:69-78` (existing `app.liveness` / `app.semaphores` / `app.valkey?`) | role-match |
| `router/tests/providers/embedding-provider.test.ts` (NEW) | test (conformance) | n/a | `router/tests/providers/session-store.interface.test.ts` | exact |
| `router/tests/integration/cardinality-live.integration.test.ts` (NEW) | test (integration, in-band scrape) | request-response (`app.inject({GET,/metrics})`) | `router/tests/integration/migrations/0007-hook-log.test.ts` (env-gated integration pattern) + Phase 18 `*.integration.test.ts` glob | role-match |
| `router/src/routes/v1/embeddings.ts` (MODIFIED) | route (controller) | request-response | itself pre-refactor (delegation pattern from `chat-completions.ts` `applyPreflight`) | exact (in-place refactor) |
| `router/src/index.ts` (MODIFIED) | composition root | startup (DI) | self — Phase 17 `sessionStore` block (lines 161-179) + Phase 18 `mcpClientRegistry` + `preCompletionHooks` block (lines 181-220) | exact |
| `router/src/app.ts` (MODIFIED — `BuildAppOpts`) | bootstrap (DI types) | startup | self — `sessionStore?` field (lines 142-154) + `preCompletionHooks?` (lines 306-322) | exact |
| `router/scripts/check-prometheus-cardinality.ts` (MODIFIED) | CLI script + library | batch/transform (text → violations) | self (existing `checkCardinality()` function and CLI entry) | exact (in-place extension) |
| `router/tests/fakes.ts` (EXTENDED) | test fake | n/a | `makeFakeSessionStore` (lines 71-141) + `makeFakeRetrieverProvider` (lines 262-312) | exact |
| `router/tests/unit/grep-gates/embeddings-untouched.test.ts` (MODIFIED — baseline JSON only) | grep gate (SHA-256 guard) | n/a | self (test file logic unchanged; only `embeddings-untouched-baseline.json` SHA rotates) | exact |
| `router/tests/integration/migrations/0007-hook-log.test.ts` (EXTENDED) | test (PG-gated integration) | request-response (SQL) | self (existing `describeMaybe` + sibling describe block append) | exact (in-place extension) |
| `bin/smoke-test-router.sh` (MODIFIED) | smoke gate | request-response (curl + grep) | Phase 17 SESSION section (lines 2289-2431) + Phase 18 MCP/HOOK section (lines 2434-2538) | exact |
| `DEPLOY.md` (MODIFIED) | docs | n/a | Phase 17 §"Sessions + ContextProvider" (line 577) + Phase 18 §"MCP Client + Pre-Completion Hooks" (line 667) | exact |
| `README.md` (MODIFIED) | docs | n/a | §"MCP Client + Hooks (v0.11.0)" (line 458) + Estado del proyecto table (line 37) | exact |

---

## Pattern Assignments

### `router/src/providers/embedding-provider.ts` (NEW — provider interface + factory)

**Primary analog:** `router/src/providers/retriever-provider.ts` (Frame-01 interface skeleton, JSDoc tone, type union exports).
**Secondary analog:** `router/src/providers/session-store.ts` (richer interface + companion option types collocated in same file).

**Header pattern** (mirror `retriever-provider.ts:1-16` voice + Frame-01 binding language):
```typescript
/**
 * Phase 19 (v0.11.0 — EMBP-01 / Frame-01 BLOCK)
 *
 * EmbeddingProvider interface — declarative seam for downstream consumers
 * (future RetrieverProvider implementations) needing vectors without an HTTP
 * round-trip through /v1/embeddings.
 *
 * STRATEGIC FRAME (binding): "Retrieval Interfaces, not Retrieval Logic" —
 * the EmbeddingProvider IS implemented in production (because /v1/embeddings
 * must work) but the implementation is a factory returning an object literal
 * (`makeOpenAIEmbeddingProvider`), NOT a class. Frame-01 spirit preserved:
 * the router doesn't carry retrieval-shaped logic.
 *
 * Composition root (router/src/index.ts) constructs the provider and threads
 * it via BuildAppOpts.embeddingProvider; buildApp calls
 * app.decorate('embeddingProvider', ...) so consumers read it as
 * fastify.embeddingProvider.
 */
```

**Interface pattern** (mirror `retriever-provider.ts:87-89` minimalism — one method, narrow shape):
```typescript
// Locked from CONTEXT.md "Specific Ideas" §EmbeddingProvider interface (lines 282-297)
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: {
      model: string;
      dimensions?: number;
      user?: string;
    },
  ): Promise<{
    embeddings: number[][];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}
```

**Factory opts + factory function pattern** (mirror `session-store.ts` collocation; CONTEXT.md "Specific Ideas" lines 302-362). The factory returns an **object literal**, never a class — preserves Frame-01 spirit:
```typescript
export interface MakeOpenAIEmbeddingProviderOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  valkey?: Redis;
  env?: { ROUTER_EMBED_CACHE_TTL_SEC: number };
  metrics: {
    embeddingsCacheTotal: { inc(labels: { result: 'hit' | 'miss' | 'bypass' }): void };
    embeddingsDimsTotal: { inc(labels: { model: string; dims: string }, value?: number): void };
  };
  log: Logger;
}

export function makeOpenAIEmbeddingProvider(
  opts: MakeOpenAIEmbeddingProviderOpts,
): EmbeddingProvider {
  // Cache plumbing reused unchanged from router/src/embeddings/cache.ts
  // (Phase 12 — `makeEmbeddingsCache` / `embeddingsCacheKey`).
  return {
    async embed(input, callOpts) { /* resolve → capability → cache → adapter → dims → assemble */ },
  };
}
```

**Cache lookup loop pattern to MOVE INTO provider** (lines 270-318 of current `embeddings.ts`):
```typescript
// CURRENT location: router/src/routes/v1/embeddings.ts:279-318
// MOVES verbatim into provider's embed() body (D-06).
for (let i = 0; i < inputs.length; i++) {
  const item = inputs[i] as string;
  if (!cacheable) {
    missIndices.push(i);
    if (opts.cache !== undefined) {
      opts.metrics?.embeddingsCacheTotal.inc({ result: 'bypass' });
    }
    continue;
  }
  const key = embeddingsCacheKey({ backend: entry.backend, backend_model: entry.backend_model,
    encoding_format: body.encoding_format, dimensions: body.dimensions, input: item });
  try {
    const cached = await opts.cache!.get(key);
    if (cached !== null) { slots[i] = cached; opts.metrics?.embeddingsCacheTotal.inc({ result: 'hit' }); }
    else { missIndices.push(i); opts.metrics?.embeddingsCacheTotal.inc({ result: 'miss' }); }
  } catch (err) {
    // EMB-H04 fail-open — warn log, fall through, NO metric increment.
    req.log.warn({ err, key }, 'embeddings cache: get failed; falling through to upstream (fail-open)');
    missIndices.push(i);
  }
}
```

**Dims enforcement pattern to MOVE INTO provider** (lines 399-429 of current `embeddings.ts` — drop the route's copy per D-03 option (a)):
```typescript
// CURRENT location: router/src/routes/v1/embeddings.ts:406-429
// MOVES into provider; the route's post-loop check is dead code post-refactor.
if (entry.dims !== undefined) {
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i];
    if (Array.isArray(v) && v.length !== entry.dims) {
      req.log.error({ /* … */ }, 'embeddings dims mismatch: refusing to propagate');
      throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, v.length);
    }
  }
  opts.metrics?.embeddingsDimsTotal.inc({ model: entry.name, dims: String(entry.dims) }, inputs.length);
}
```

**Error vocabulary** (D-05 — reuse from `router/src/errors/envelope.ts` — NO new error types):
`RegistryUnknownModelError` (via `registry.resolve(model)`), `CapabilityNotSupportedError(modelName, 'embeddings')`, `EmbeddingsDimsMismatchError(name, expectedDims, actualDims)`, `BreakerOpenError` (defense-in-depth only).

---

### `router/src/types/fastify.d.ts` (NEW — Fastify type augmentation)

**Analog:** inline `declare module 'fastify'` block in `router/src/app.ts:69-78` (existing decorators `app.liveness` / `app.semaphores` / `app.valkey?`). The Phase 19 augmentation moves into its own `.d.ts` file because CONTEXT D-11 calls for a dedicated file mirroring Phase 17's `req.sessionId` + Phase 18's `req.hookLog` typing pattern.

**Existing inline augmentation in app.ts** (lines 69-78) to mirror in tone:
```typescript
// Fastify module augmentation so TypeScript knows about app.liveness + app.semaphores (decorators).
declare module 'fastify' {
  interface FastifyInstance {
    liveness: LivenessScheduler;
    semaphores: { get(backend: string): BackendSemaphore };
    // Plan 08-01 (DATA-06) — optional decorator; test fixtures may omit.
    // Consumed by Plans 08-04 (breaker), 08-06 (rate limit), 08-07 (idempotency),
    // 08-09 (models cache).
    valkey?: ValkeyClient;
  }
}
```

**Required content for `router/src/types/fastify.d.ts`** (from CONTEXT D-11 + RESEARCH §7):
```typescript
import type { EmbeddingProvider } from '../providers/embedding-provider.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Phase 19 (v0.11.0 — EMBP-01): production EmbeddingProvider decorated
     * by buildApp when opts.embeddingProvider is supplied. Consumed by
     * future RetrieverProvider implementations and by /v1/embeddings route
     * post-refactor. Optional in BuildAppOpts (tests may omit) — when
     * undefined no decorator is registered.
     */
    embeddingProvider: EmbeddingProvider;
  }
}
```

**Pattern note:** tsconfig.json's `"include"` glob already picks up `src/**/*` (verify: A4 in RESEARCH §"Assumptions Log"). Create the directory `router/src/types/` (does not exist today).

---

### `router/tests/providers/embedding-provider.test.ts` (NEW — conformance test)

**Analog:** `router/tests/providers/session-store.interface.test.ts` (read in full above). Mirror its `expectTypeOf` + runtime-shape structure verbatim.

**Imports block** (lines 22-42 of analog — single block, type-only from provider, runtime from fakes + errors):
```typescript
import { describe, expect, it, expectTypeOf } from 'vitest';
import type {
  SessionStore,
  Turn,
  SessionSummary,
  AppendTurnResult,
  LoadHistoryOpts,
  ListSessionsFilter,
  CreateSessionInput,
} from '../../src/providers/session-store.js';
import {
  InvalidSessionIdError,
  // …
} from '../../src/providers/session-errors.js';
```

**Signature assertion pattern** (lines 44-83 — one describe block per interface, `expectTypeOf` for type-shape, runtime `expect` for behavior):
```typescript
describe('SessionStore interface — SESS-01', () => {
  it('SessionStore.createSession signature', () => {
    expectTypeOf<SessionStore['createSession']>().toEqualTypeOf<
      (input: CreateSessionInput) => Promise<string>
    >();
  });

  it('SessionStore.appendTurn requires agent_id positional (P4-03 BLOCK)', () => {
    expectTypeOf<Parameters<SessionStore['appendTurn']>[1]>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<SessionStore['appendTurn']>>().toEqualTypeOf<Promise<AppendTurnResult>>();
  });
});
```

**Phase 19 conformance test shape** (from RESEARCH §3 — assemble this from analog patterns):
```typescript
describe('EmbeddingProvider interface — EMBP-01', () => {
  it('EmbeddingProvider.embed signature', () => {
    expectTypeOf<EmbeddingProvider['embed']>().toEqualTypeOf<
      (input: string | string[],
       opts: { model: string; dimensions?: number; user?: string }) =>
        Promise<{ embeddings: number[][]; model: string;
                  usage: { prompt_tokens: number; total_tokens: number } }>
    >();
  });

  it('returns { embeddings: number[][], model, usage } shape', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const result = await provider.embed(['hello'], { model: 'embed-local' });
    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toHaveLength(1024);
    expect(typeof result.model).toBe('string');
    expect(typeof result.usage.prompt_tokens).toBe('number');
  });

  it('handles string input AND array input (matches wire schema union)', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const stringResult = await provider.embed('hello', { model: 'embed-local' });
    const arrayResult = await provider.embed(['hello', 'world'], { model: 'embed-local' });
    expect(stringResult.embeddings).toHaveLength(1);
    expect(arrayResult.embeddings).toHaveLength(2);
  });
});
```

---

### `router/tests/integration/cardinality-live.integration.test.ts` (NEW — live `/metrics` scrape)

**Analog:** `router/tests/integration/migrations/0007-hook-log.test.ts` (env-gated integration test pattern — Postgres counterpart of the Valkey/no-state-needed pattern Phase 19 needs).

**Test scaffolding pattern** (lines 26-44 of analog — env-gated `describeMaybe`):
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const PG_URL =
  process.env.POSTGRES_URL ?? process.env.ROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
const PG_TESTS_ENABLED = process.env.PG_TESTS === '1' && PG_URL !== undefined;
const describeMaybe = PG_TESTS_ENABLED ? describe : describe.skip;

describeMaybe('Migration 0007: request_log.hook_log JSONB column', () => {
  let pool: Pool;
  beforeAll(async () => { pool = new Pool({ connectionString: PG_URL! }); });
  afterAll(async () => { await pool.end(); });
```

**Phase 19 cardinality-live pattern** (RESEARCH §6 confirms `app.inject({GET,/metrics})` works with minimal fixture — no env gate needed because the test does not require Postgres/Valkey):
```typescript
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { checkCardinalityLive } from '../../scripts/check-prometheus-cardinality.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { makeRegistryStore, loadRegistryFromFile } from '../../src/config/registry.js';

describe('OBSV-02: live /metrics cardinality scrape', () => {
  it('rendered /metrics exposition has zero /_id$/ labels', async () => {
    const registry = makeRegistryStore(loadRegistryFromFile(/* test models.yaml fixture */));
    const app = await buildApp({
      registry,
      bearerToken: 'test',
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
    });
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(200);
    const violations = checkCardinalityLive(r.body);
    expect(violations).toEqual([]);
    await app.close();
  });
});
```

---

### `router/src/routes/v1/embeddings.ts` (MODIFIED — route refactor)

**Delegation pattern preserved from current shape** (lines 162-180 of current file — `applyPreflight` already does the heavy lifting, untouched by Phase 19):
```typescript
const { entry, breakerState } = await applyPreflight(body.model, {
  registry: opts.registry,
  breaker: opts.breaker,
});
req.resolvedBackend = entry.backend;
if (breakerState === 'open') {
  void reply.header('Retry-After', String(opts.breakerCooldownSec));
  throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
}
```

**`embeddingsBatchSize.observe` STAYS in route** (D-07 — wire-shape metric, line 267-268 of current file):
```typescript
const inputs = Array.isArray(body.input) ? body.input : [body.input];
opts.metrics?.embeddingsBatchSize.observe(inputs.length);  // ← stays here, BEFORE provider call
```

**Base64 bypass increment STAYS in route** (Risk #2 Option A — RESEARCH §"Must-Haves"). Insert BEFORE the provider call:
```typescript
// D-02 + Risk #2: route owns the base64 bypass metric because the provider always works in float.
if (body.encoding_format === 'base64' && opts.cache !== undefined) {
  for (let i = 0; i < inputs.length; i++) {
    opts.metrics?.embeddingsCacheTotal.inc({ result: 'bypass' });
  }
}
```

**Provider delegation** (replaces lines 270-429 of current file with ~5 lines — CONTEXT.md "Specific Ideas" lines 372-376):
```typescript
const providerResult = await req.server.embeddingProvider.embed(inputs, {
  model: body.model,
  dimensions: body.dimensions,
  user: body.user,
});
```

**Base64 re-encode + OpenAI list re-wrap pattern** (D-02 + lines 433-449 of current file, mutated to consume provider result):
```typescript
const data = providerResult.embeddings.map((vec, i) => ({
  object: 'embedding' as const,
  index: i,
  embedding: body.encoding_format === 'base64' ? encodeBase64(vec) : vec,
}));
result = {
  object: 'list' as const,
  data,
  model: providerResult.model,
  usage: providerResult.usage,
};
```

**Cost stamping STAYS in route** (D-08 + project_fastify_onsend_timing.md memory — stamp BEFORE `.send`, lines 451-459 of current file):
```typescript
// Stamp req.computedCostCents BEFORE reply.send() — Fastify v5 onSend fires
// synchronously inside .send(). Outer finally records the same cost to request_log.
const earlyCost = computeCostCents({
  entry,
  tokensIn: result.usage?.prompt_tokens ?? 0,
  tokensOut: 0,
}) ?? undefined;
req.computedCostCents = earlyCost;
```

**P7-01 BLOCK invariant:** route diff + `embeddings-untouched-baseline.json` SHA-256 update MUST land in the SAME commit (D-24 + RESEARCH §5).

---

### `router/src/index.ts` (MODIFIED — composition root)

**Phase 17 sessionStore construction pattern** (lines 161-179 — exact template to mirror, including `bootLog.info` confirmation):
```typescript
// Phase 17 (v0.11.0 — SESS-01 / CTXP-01 / SUMP-02): production-wired providers.
// PostgresSessionStore consumes the same Drizzle `db` handle already used by
// request_log + bufferedWriter (Pitfall 17-A: single pg.Pool — never construct
// a second handle). DefaultContextProvider is stateless so we use the exported
// singleton; NoopSummaryProvider is the Frame-03 default (never calls a model).
const sessionStore = new PostgresSessionStore(db, {
  defaultTtlSec: env.SESSION_TTL_DAYS * 86400,
  appendTimeoutMs: 1000,
  logger: bootLog,
  metricsRegistry: metrics,
});
const contextProvider = DefaultContextProvider;
const summaryProvider = new NoopSummaryProvider();
bootLog.info(
  { defaultTtlDays: env.SESSION_TTL_DAYS },
  'Phase 17 providers initialized — sessionStore + contextProvider (DefaultSlidingWindow) + summaryProvider (Noop)',
);
```

**Phase 18 mcpClientRegistry construction pattern** (lines 181-220 — second template; Map literal + bootLog confirmation):
```typescript
// Phase 18 (v0.11.0 — MCPC-01..06): MCP client registry. Lazy connect —
// boot proceeds even when external MCP servers are unreachable.
const initialRegistrySnapshot = registry.get();
const mcpClientRegistry = makeMcpClientRegistry({
  servers: new Map(
    (initialRegistrySnapshot.mcp_servers ?? []).map((s) => [s.alias, s]),
  ),
  valkey,
  logger: bootLog.child({ subsystem: 'mcp_client' }),
  cacheTtlSec: 60,
});
```

**Phase 19 construction insertion site** (RESEARCH §7 — between Phase 18 `bootLog.info` at line 220 and `const app = await buildApp({` at line 222). Concrete shape:
```typescript
// Phase 19 (v0.11.0 — EMBP-01): production-wired EmbeddingProvider.
// Frame-01 BLOCK: factory returns an object literal, not a class. Cache
// plumbing moves IN from the route (D-06).
const embeddingProvider = makeOpenAIEmbeddingProvider({
  registry,
  makeAdapter: makeAdapterWithCloudKey,  // see Risk #1 — expose closure at composition root
  valkey,
  env: { ROUTER_EMBED_CACHE_TTL_SEC: env.ROUTER_EMBED_CACHE_TTL_SEC },
  metrics: {
    embeddingsCacheTotal: metrics.embeddingsCacheTotal,
    embeddingsDimsTotal: metrics.embeddingsDimsTotal,
  },
  log: bootLog,
});
bootLog.info({ defaultModel: 'embed-local' }, 'Phase 19 EmbeddingProvider initialized');
```

**Threading into `buildApp({ ... })` call** (mirror Phase 17/18 pattern at lines 222-241):
```typescript
const app = await buildApp({
  registry,
  bearerToken: env.ROUTER_BEARER_TOKEN,
  // … existing fields …
  sessionStore,
  contextProvider,
  summaryProvider,
  mcpClientRegistry,
  preCompletionHooks,
  embeddingProvider,  // ← NEW Phase 19
  cloudApiKey: env.OLLAMA_API_KEY ?? '',
  env, /* … */
});
```

**Risk #1 resolution** (RESEARCH §"Risks"): `makeAdapterWithCloudKey` is currently constructed INSIDE `buildApp` (`app.ts:402-403`). Either expose a helper from `router/src/backends/factory.ts` or duplicate the small closure in `index.ts`. Plan-time read `factory.ts` to pick.

---

### `router/src/app.ts` (MODIFIED — `BuildAppOpts` widening + decorator)

**`BuildAppOpts` field-addition pattern** (Phase 17 `sessionStore?` field at lines 142-154 — mirror tone + JSDoc structure):
```typescript
/**
 * Phase 17 (v0.11.0 — SESS-01 / SESS-06 BuildAppOpts widening): optional
 * Postgres-backed session store. When undefined, the session-attach block
 * in every route is a no-op (SESS-06 stateless contract; byte-identical to
 * Phase 16 wire behavior). Production wiring (index.ts — Plan 17-07)
 * constructs a PostgresSessionStore from the Drizzle db handle and threads
 * it here.
 *
 * Optional: 4 Phase 17 BuildAppOpts fields (sessionStore + contextProvider
 * + summaryProvider + sessionIdPreHandler) are ALL optional so the full
 * Phase 14/15/16 integration test suite continues to build apps without
 * Phase 17 injection and observes byte-identical wire output.
 */
sessionStore?: SessionStore;
```

**Phase 18 `preCompletionHooks?` JSDoc pattern** (lines 306-322 — adds Frame-01 BLOCK + invariant-validator-at-boot note):
```typescript
/**
 * Phase 18 (v0.11.0 — RETR-02/03): per-route pre-completion hook map. The
 * Map key is the route path … Absent → no hooks fire. Frame-01 BLOCK:
 * production composition root (index.ts) constructs an EMPTY Map …
 */
preCompletionHooks?: Map<string, PreCompletionHook[]>;
```

**Phase 19 BuildAppOpts widening** (insert AFTER `preCompletionHooks?` per RESEARCH §7):
```typescript
/**
 * Phase 19 (v0.11.0 — EMBP-01): optional EmbeddingProvider. When provided,
 * buildApp calls app.decorate('embeddingProvider', opts.embeddingProvider)
 * so future RetrieverProvider implementations can read
 * fastify.embeddingProvider without HTTP round-tripping. When undefined
 * (test fixtures), the /v1/embeddings route falls back to opts.embeddingProvider
 * injected directly via RegisterEmbeddingsOpts. Production composition (index.ts)
 * always passes a real provider.
 */
embeddingProvider?: EmbeddingProvider;
```

**Decorator registration pattern** (mirror existing decorators wiring inside `buildApp(...)`. Insert immediately after the Phase 18 decorators block):
```typescript
if (opts.embeddingProvider) {
  app.decorate('embeddingProvider', opts.embeddingProvider);
}
```

**Route opts threading** (current pattern at lines 1052-1066 — mutate to drop `cache` and pass `embeddingProvider`):
```typescript
registerEmbeddingsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
  semaphores,
  recordOutcome,
  breaker,
  breakerCooldownSec,
  idempotency,
  // cache: embeddingsCache,  ← REMOVED (D-06 — cache moves into provider)
  embeddingProvider: opts.embeddingProvider,  // ← NEW; route falls back to its own seam when undefined
  metrics: {
    embeddingsCacheTotal: opts.metrics.embeddingsCacheTotal,
    embeddingsBatchSize: opts.metrics.embeddingsBatchSize,
    embeddingsDimsTotal: opts.metrics.embeddingsDimsTotal,
  },
});
```

The `makeEmbeddingsCache(...)` block at lines 1036-1043 deletes; cache now lives inside the provider factory.

---

### `router/scripts/check-prometheus-cardinality.ts` (MODIFIED — dual-mode CLI)

**Existing static-mode pattern to PRESERVE** (lines 53-85 — keep exported as `checkCardinality`):
```typescript
export function checkCardinality(source: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];
  const metricNames: Array<{ offset: number; name: string }> = [];
  for (const m of source.matchAll(METRIC_NAME_RE)) { /* … */ }
  for (const m of source.matchAll(LABEL_NAMES_RE)) { /* … */ }
  return violations;
}
```

**Existing CLI pattern to EXTEND** (lines 87-104 — keep the `import.meta.url === \`file://...\`` sentinel; dispatch on first arg):
```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.cwd(), 'src/metrics/registry.ts');
  const source = readFileSync(path, 'utf8');
  const violations = checkCardinality(source);
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`cardinality-check: FORBIDDEN _id label "${v.forbiddenLabel}" found in ` +
        `${v.metricNameHint} (${v.location}). …\n`);
    }
    process.exit(1);
  }
  process.stdout.write('cardinality-check: OK — no /_id$/ labels found in src/metrics/registry.ts\n');
}
```

**Phase 19 ADDITION: new `checkCardinalityLive` export** (CONTEXT.md D-14 sketch lines 402-425 + RESEARCH §2 invariants):
```typescript
/**
 * Phase 19 (OBSV-02 / D-13 / D-14): parses a live Prometheus exposition
 * (text rendered by /metrics) and returns all label names ending in /_id$/.
 * Used by:
 *   - tests/integration/cardinality-live.integration.test.ts (CI in-band)
 *   - bin/smoke-test-router.sh OBSV-02-LIVE gate (live-tunnel post-deploy)
 *
 * Hand-rolled regex — zero new deps. Exposition format invariants
 * documented in RESEARCH §2; spec at
 * https://prometheus.io/docs/instrumenting/exposition_formats/.
 */
export function checkCardinalityLive(exposition: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];
  const lines = exposition.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (!line || line.startsWith('#')) continue;  // skip HELP/TYPE/comments
    const labelMatch = line.match(/^([a-z0-9_]+)\{([^}]*)\}/);
    if (!labelMatch) continue;
    const metricName = labelMatch[1]!;
    const labelText = labelMatch[2]!;
    for (const m of labelText.matchAll(/([a-z0-9_]+)\s*=\s*"/g)) {
      const labelName = m[1]!;
      if (FORBIDDEN_LABEL_RE.test(labelName)) {
        violations.push({
          location: `/metrics:${lineNo + 1}`,
          arrayText: `{${labelText}}`,
          forbiddenLabel: labelName,
          metricNameHint: metricName,
        });
      }
    }
  }
  return violations;
}
```

**CLI dispatch widening** (replace the static-only `if (import.meta.url …)` block — argv pattern: `--source <path>` | `--live <url-or-dash-for-stdin>`):
```typescript
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args[0] === '--live' ? 'live' : 'source';
  let violations: CardinalityViolation[];
  if (mode === 'live') {
    const target = args[1];
    let text: string;
    if (!target || target === '-') {
      // Read stdin (so curl|node script works).
      text = readFileSync(0, 'utf8');
    } else {
      const r = await fetch(target);
      text = await r.text();
    }
    violations = checkCardinalityLive(text);
  } else {
    const path = resolve(process.cwd(), args[1] ?? 'src/metrics/registry.ts');
    violations = checkCardinality(readFileSync(path, 'utf8'));
  }
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`cardinality-check: FORBIDDEN _id label "${v.forbiddenLabel}" in ` +
        `${v.metricNameHint} (${v.location}).\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`cardinality-check: OK — no /_id$/ labels found (mode=${mode})\n`);
}
```

**Pattern note:** no clean external analog exists for the dual-mode CLI — `check-prometheus-cardinality.ts` is the only script in `router/scripts/` with this shape. Self-extension is the right path.

---

### `router/tests/fakes.ts` (EXTENDED — add `makeFakeEmbeddingProvider`)

**Phase 17 `makeFakeSessionStore` pattern** (lines 71-141 — opts-builder + interface-conforming return + call-capture array):
```typescript
export interface FakeSessionStoreOpts {
  history?: Turn[];
  appendShouldTimeout?: boolean;
  loadShouldMiss?: boolean;
  appendCalls?: Array<{ session_id: string; agent_id: string; turn: /* … */ }>;
}

export function makeFakeSessionStore(opts: FakeSessionStoreOpts = {}): SessionStore {
  const history: Turn[] = opts.history ?? [];
  const appendCalls = opts.appendCalls ?? [];
  let turnIndex = history.length;
  return {
    async createSession(input) { return input.session_id ?? `fake-${input.agent_id}-${Date.now()}`; },
    // … other methods returning interface-conforming shapes …
  };
}
```

**Phase 18 `makeFakeRetrieverProvider` pattern** (lines 262-312 — narrower interface, error/timeout/latency seams):
```typescript
export interface FakeRetrieverProviderOpts {
  documents?: RetrievedDocument[];
  shouldTimeout?: boolean;
  shouldThrow?: Error;
  latencyMs?: number;
  calls?: RetrieverRequest[];
}

export function makeFakeRetrieverProvider(opts: FakeRetrieverProviderOpts = {}): RetrieverProvider {
  const calls = opts.calls ?? [];
  return {
    async retrieve(request) {
      calls.push(request);
      if (opts.shouldTimeout) return new Promise<RetrieverResponse>(() => { /* never */ });
      if (opts.shouldThrow) throw opts.shouldThrow;
      if (opts.latencyMs && opts.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, opts.latencyMs));
      }
      return { documents: opts.documents ?? [], retrieved_at: new Date(0).toISOString() };
    },
  };
}
```

**Phase 19 `makeFakeEmbeddingProvider` to add** (mirror both — RESEARCH §3 + CONTEXT.md "Specific Ideas"):
```typescript
import type { EmbeddingProvider } from '../src/providers/embedding-provider.js';

export interface FakeEmbeddingProviderOpts {
  /** Vector dimension. Default 1024 (bge-m3 / embed-local). */
  dims?: number;
  /** When set, embed() rejects with this error. */
  shouldThrow?: Error;
  /** Captures every embed() call for assertion. */
  calls?: Array<{ input: string | string[]; opts: Parameters<EmbeddingProvider['embed']>[1] }>;
}

export function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOpts = {}): EmbeddingProvider {
  const dims = opts.dims ?? 1024;
  const calls = opts.calls ?? [];
  return {
    async embed(input, embedOpts) {
      calls.push({ input, opts: embedOpts });
      if (opts.shouldThrow) throw opts.shouldThrow;
      const inputs = Array.isArray(input) ? input : [input];
      return {
        embeddings: inputs.map(() => Array<number>(dims).fill(0.42)),
        model: embedOpts.model,
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      };
    },
  };
}
```

---

### `router/tests/unit/grep-gates/embeddings-untouched.test.ts` (MODIFIED — baseline JSON only)

**Test logic UNCHANGED** — only the SHA-256 in `embeddings-untouched-baseline.json` rotates atomically with the Plan 19-03 route refactor (D-24). Existing test (lines 47-65) reads the baseline JSON, recomputes SHA, compares.

**Baseline JSON current shape** (the only file that changes):
```json
{
  "file": "router/src/routes/v1/embeddings.ts",
  "sha256": "b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970",
  "captured_at": "2026-06-01",
  "phase": "18",
  "plan": "18-01",
  "rationale": "P7-01 BLOCK — Phase 18 (MCP client + RetrieverProvider + pre-completion hooks) MUST NOT modify /v1/embeddings route. EMBP (embeddings provider) work is scoped to Phase 19."
}
```

**Post-Plan-19-03 shape** (RESEARCH §5 procedure):
```json
{
  "file": "router/src/routes/v1/embeddings.ts",
  "sha256": "<NEW_SHA from `shasum -a 256 router/src/routes/v1/embeddings.ts | awk '{print $1}'`>",
  "captured_at": "2026-06-XX",
  "phase": "19",
  "plan": "19-03",
  "rationale": "P7-01 BLOCK — baseline rotated as part of EMBP-02 route refactor (delegates to fastify.embeddingProvider per CONTEXT D-09). Wire shape verified byte-identical by full vitest regression on router/tests/routes/embeddings.test.ts + smoke Phase 7 EMBED-01 + Phase 12 EMB-H01..06 gates."
}
```

**Atomic-commit rule:** route diff + baseline diff land in ONE commit (D-24 + test's own contract at lines 60-61 of `embeddings-untouched.test.ts`).

---

### `router/tests/integration/migrations/0007-hook-log.test.ts` (EXTENDED — sibling describe block)

**Existing PG-gated pattern to PRESERVE** (lines 26-44 — the whole `describeMaybe` scaffolding):
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const PG_URL = process.env.POSTGRES_URL ?? process.env.ROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
const PG_TESTS_ENABLED = process.env.PG_TESTS === '1' && PG_URL !== undefined;
const describeMaybe = PG_TESTS_ENABLED ? describe : describe.skip;

describeMaybe('Migration 0007: request_log.hook_log JSONB column', () => {
  let pool: Pool;
  beforeAll(async () => { pool = new Pool({ connectionString: PG_URL! }); });
  afterAll(async () => { await pool.end(); });
  // … 7 existing cases (data_type=jsonb, is_nullable=YES, COMMENT, no index, JSON round-trip, NULL, Drizzle parity) …
});
```

**Existing query pattern to REUSE** (lines 46-55 — `information_schema.columns` lookup; mirror this for the re-verify):
```typescript
const r = await pool.query(
  `SELECT data_type
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'request_log'
      AND column_name = 'hook_log'`,
);
expect(r.rowCount).toBe(1);
expect(r.rows[0].data_type).toBe('jsonb');
```

**Phase 19 SIBLING describe block to APPEND** (RESEARCH §8 — extend the existing file, do NOT create a new one):
```typescript
// APPENDED at end of file — Phase 19 OBSV-04 re-verification.
describeMaybe('Migration 0007: re-verified by Phase 19 (OBSV-04)', () => {
  let pool: Pool;
  beforeAll(async () => { pool = new Pool({ connectionString: PG_URL! }); });
  afterAll(async () => { await pool.end(); });

  it('Phase 19 OBSV-04: hook_log column still present + still JSONB + still nullable', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_log'
          AND column_name = 'hook_log'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].data_type).toBe('jsonb');
    expect(r.rows[0].is_nullable).toBe('YES');
  });
});
```

---

### `bin/smoke-test-router.sh` (MODIFIED — new Phase 19 section)

**Phase 17 SESSION section pattern** (lines 2289-2431 — header banner + N pass gates + section-complete banner):
```bash
# ============================================================================
# Phase 17 (v0.11.0 — SESS-01..06 + CTXP-01..04 + SUMP-01..03) — SessionStore +
# ContextProvider + SummaryProvider session attach
# ============================================================================
# Proves the Plan 17-06 three-route wire-up is live end-to-end at HTTP level:
#
#   SESS-05: X-Session-ID response header echoed on non-stream chat-completions.
#   …
# ============================================================================

echo ""
echo "[smoke-test-router] === Phase 17 — SessionStore + ContextProvider + SummaryProvider (SESS-01..06 + CTXP-01..04 + SUMP-01..03) ==="

SESS_ID="smoke-sess-$(date +%s)"
AGENT_ID="smoke-agent-1"
# … curl + grep + pass/fail …
echo "[smoke-test-router] === Phase 17 SESSION section complete ==="
```

**Phase 18 section complete banner** (line 2538) — Phase 19 section inserts directly after this:
```bash
echo "[smoke-test-router] === Phase 18 MCP-CLIENT + HOOK section complete ==="
```

**Helper functions to REUSE** (defined at lines 188-190 — `pass` / `fail` / `skip` and counters `FAILURES` / `SKIPS`):
```bash
fail() { echo "[smoke-test-router] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-router] PASS: $*"; }
skip() { echo "[smoke-test-router] SKIP: $*"; SKIPS=$((SKIPS + 1)); }
```

**Soft-skip-on-cloud pattern** (Phase 8 cloud gates use this shape — RESEARCH §1 confirms mirror for Phase 19):
```bash
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  skip "RESS-WITH-TOOLS: OLLAMA_API_KEY absent — skipping cloud function-call smoke"
elif ! grep -q "^[[:space:]]*-[[:space:]]*name:[[:space:]]*gpt-oss:20b-cloud" router/models.yaml; then
  skip "RESS-WITH-TOOLS: gpt-oss:20b-cloud not declared in models.yaml — skipping"
else
  # … live curl + SSE parse + assert …
fi
```

**Phase 19 section insertion site** (between line 2538 Phase 18 complete + line 2544 summary banner — CONTEXT.md "Specific Ideas" lines 437-465):
```bash
echo ""
echo "[smoke-test-router] === Phase 19 — EmbeddingProvider + Observability hardening (EMBP-01..02 + OBSV-01..04) ==="

# Cite-only banner — prior phases satisfy slices of OBSV-01
echo "[smoke-test-router] OBSV-01 MCP slice: satisfied by Phase 15 MCP-01..03 (cited)"
echo "[smoke-test-router] OBSV-01 Session slice: satisfied by Phase 17 SESSION SC-1..SC-4 (cited)"
echo "[smoke-test-router] EMBP-02 regression: Phase 7 EMBED-01 + Phase 12 EMB-H01..06 gates re-asserted (above)"

# OBSV-02-LIVE: live /metrics cardinality scrape
OBSV02_LIVE=$(curl -sS "${ROUTER_URL}/metrics" \
  | node router/scripts/check-prometheus-cardinality.ts --live - 2>&1 \
  && echo OK || echo FAIL)
if [[ "${OBSV02_LIVE}" == "OK" ]]; then
  pass "OBSV-02-LIVE: /metrics exposition has no /_id$/ labels (live parser)"
else
  fail "OBSV-02-LIVE: ${OBSV02_LIVE}"
fi

# RESS-WITH-TOOLS: streaming /v1/responses with a function-calling cloud model
# (soft-skip predicate as above)
# … live SSE round-trip with gpt-oss:20b-cloud + assert response.function_call_arguments.delta
#     + final response.completed { status:'incomplete', incomplete_details:{reason:'tool_calls'} } …

echo "[smoke-test-router] === Phase 19 section complete ==="
```

**Summary banner update** (line 2544):
```bash
echo "[smoke-test-router]  Phase 2/3/4/5/7/8/12/13/15/16/17/18/19 router verification: COMPLETE."
```

---

### `DEPLOY.md` (MODIFIED — new §"EmbeddingProvider (Phase 19 — v0.11.0)")

**Phase 17 §"Sessions + ContextProvider (Phase 17 — v0.11.0)" pattern** (line 577 — read 90 lines above). Mirror its structure verbatim: one-paragraph intro → env var table → models.yaml field table → hot-edit gotcha → lifecycle → Prometheus signal → verification matrix.

**Phase 18 §"MCP Client + Pre-Completion Hooks" header** (line 667) — Phase 19 section inserts BETWEEN Phase 18 and "Backups + retención":
```markdown
## MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)
[… existing Phase 18 content …]

---

## EmbeddingProvider (Phase 19 — v0.11.0)

[Phase 19 section inserts here]

---

## Backups + retención
[existing]
```

**Phase 19 section structure to write** (CONTEXT.md D-21 + RESEARCH §"Phase Requirements"):
- Strategic frame citation (binding): "Retrieval Interfaces, not Retrieval Logic" + Frame-01 invariant.
- Interface TypeScript signature (copy from `embedding-provider.ts`).
- Code example: how a pre-completion hook calls `fastify.embeddingProvider.embed` from a custom retriever.
- Wire-shape regression invariant (P7-01): `/v1/embeddings` byte-identical.
- Observability surface table:
  ```
  | Metric | Labels | Owned by | Notes |
  |--------|--------|----------|-------|
  | router_embeddings_cache_total | result | provider | hit/miss/bypass; bypass increments at route for base64 |
  | router_embeddings_batch_size | (histogram) | route | EMB-H03 — inbound batch size; route owns wire-shape metric |
  | router_embeddings_dims_total | model, dims | provider | per-served-vector increment |
  ```
- Verification matrix: EMBP-01 → `tests/providers/embedding-provider.test.ts`; EMBP-02 → regression suite + smoke Phase 7/12 gates.

---

### `README.md` (MODIFIED — new §"EmbeddingProvider (v0.11.0)" + status banner flip)

**Existing "MCP Client + Hooks (v0.11.0)" pattern** (line 458 — read in full above). Mirror its structure: strategic-frame citation + quick reference bullets + Frame-01 invariant + link to DEPLOY.md operator section.

**Phase 19 section insertion site:** between "MCP Client + Hooks (v0.11.0)" (line 458) and "Operacion" (line 520).

**Estado del proyecto table flip pattern** (lines 37-43):
```markdown
## Estado del proyecto

| Milestone | Status | Highlights |
|-----------|--------|------------|
| **v0.9.0** MVP | ✅ shipped 2026-05-28 | 76 reqs / 9 phases / 55 plans · router multi-backend + cloud + observability + ops |
| **v0.10.0** Cognitive Primitives | ✅ shipped 2026-05-29 | 26 reqs / 4 phases · JSON mode · Reranker · Embeddings hardening · Cost obs + `/v1/responses` |
| **v0.11.0** TBD | — | candidatos: `/v1/responses` streaming + tools · `/v1/audio/transcriptions` · MCP-as-server |
```

**Phase 19 row flip** (D-21 banner update — mirror v0.9.0/v0.10.0 row format exactly):
```markdown
| **v0.11.0** Retrieval-Ready Infrastructure | ✅ shipped 2026-06-0X | 48 reqs / 6 phases · Policy primitives · MCP host + client · Streaming Responses · Sessions/Context · Pre-completion hooks · EmbeddingProvider |
```

---

## Shared Patterns

### Frame-01 (Provider Interface, No Production Class)

**Sources:** `router/src/providers/retriever-provider.ts` (interface only) + `router/src/providers/session-store.ts` (interface + companion types; the `PostgresSessionStore` class lives in a sibling file `postgres-session-store.ts`, NOT the interface file).
**Apply to:** `router/src/providers/embedding-provider.ts` — interface stays clean; the `makeOpenAIEmbeddingProvider` factory returns an OBJECT LITERAL (Frame-01 spirit: no class). RESEARCH §"Established Patterns" line 246 explicitly notes EmbeddingProvider is a factory-of-object-literal, NOT a class.

**Excerpt** (`retriever-provider.ts:80-89`):
```typescript
/**
 * The interface every external retriever implementation must satisfy.
 *
 * Frame-01 BLOCK: router/src/ contains NO classes implementing this
 * interface. Implementations live in caller-supplied modules attached to
 * BuildAppOpts.preCompletionHooks (see router/src/hooks/pre-completion.ts).
 * A test-only fake lives in tests/fakes.ts.
 */
export interface RetrieverProvider {
  retrieve(request: RetrieverRequest): Promise<RetrieverResponse>;
}
```

### Composition-Root Construction → BuildAppOpts Thread → app.decorate

**Sources:** `router/src/index.ts:161-179` (Phase 17 `sessionStore`) + `router/src/index.ts:181-220` (Phase 18 `mcpClientRegistry` + `preCompletionHooks`).
**Apply to:** Phase 19 `embeddingProvider` construction in `index.ts` between line 220 (Phase 18 `bootLog.info`) and line 222 (`const app = await buildApp({`).

**Excerpt** (Phase 17 — lines 168-179 of `index.ts`):
```typescript
const sessionStore = new PostgresSessionStore(db, {
  defaultTtlSec: env.SESSION_TTL_DAYS * 86400,
  appendTimeoutMs: 1000,
  logger: bootLog,
  metricsRegistry: metrics,
});
const contextProvider = DefaultContextProvider;
const summaryProvider = new NoopSummaryProvider();
bootLog.info(
  { defaultTtlDays: env.SESSION_TTL_DAYS },
  'Phase 17 providers initialized — sessionStore + contextProvider (DefaultSlidingWindow) + summaryProvider (Noop)',
);
```

### Fastify Module Augmentation (`declare module 'fastify'`)

**Source:** `router/src/app.ts:69-78` (inline augmentation for `app.liveness` / `app.semaphores` / `app.valkey?`).
**Apply to:** new file `router/src/types/fastify.d.ts` augmenting `FastifyInstance.embeddingProvider`. Phase 19 moves to a dedicated `.d.ts` per CONTEXT D-11 — Phase 17 used `req.sessionId` (request decorator) and Phase 18 used `req.hookLog` (request decorator); both relied on file-level `declare module 'fastify'` blocks living near their decorator call site. EmbeddingProvider is an INSTANCE-level decorator (server-wide, not per-request), so the dedicated `.d.ts` is the right home.

**Excerpt** (existing — `app.ts:69-78`):
```typescript
declare module 'fastify' {
  interface FastifyInstance {
    liveness: LivenessScheduler;
    semaphores: { get(backend: string): BackendSemaphore };
    valkey?: ValkeyClient;
  }
}
```

### Test Fake Factory (Opts-Builder Returning Interface-Conforming Object)

**Sources:** `router/tests/fakes.ts:96-141` (`makeFakeSessionStore`) + `router/tests/fakes.ts:288-312` (`makeFakeRetrieverProvider`).
**Apply to:** Phase 19 `makeFakeEmbeddingProvider` appended to `router/tests/fakes.ts` (NOT a sibling file — RESEARCH §"User Constraints" → Claude's Discretion + CONTEXT D-12).

**Excerpt** (Phase 18 — `tests/fakes.ts:262-273` + 288-312):
```typescript
export interface FakeRetrieverProviderOpts {
  documents?: RetrievedDocument[];
  shouldTimeout?: boolean;
  shouldThrow?: Error;
  latencyMs?: number;
  calls?: RetrieverRequest[];
}

export function makeFakeRetrieverProvider(opts: FakeRetrieverProviderOpts = {}): RetrieverProvider {
  const calls = opts.calls ?? [];
  return {
    async retrieve(request: RetrieverRequest): Promise<RetrieverResponse> {
      calls.push(request);
      if (opts.shouldTimeout) return new Promise<RetrieverResponse>(() => { /* never */ });
      if (opts.shouldThrow) throw opts.shouldThrow;
      if (opts.latencyMs && opts.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, opts.latencyMs));
      }
      return { documents: opts.documents ?? [], retrieved_at: new Date(0).toISOString() };
    },
  };
}
```

### Conformance Test (`expectTypeOf` + Runtime Shape)

**Source:** `router/tests/providers/session-store.interface.test.ts` (read in full).
**Apply to:** `router/tests/providers/embedding-provider.test.ts`. One describe block (`'EmbeddingProvider interface — EMBP-01'`), `expectTypeOf<T>().toEqualTypeOf<...>()` for signature, runtime `expect(...)` for shape on a fake instance.

**Excerpt** (lines 44-49):
```typescript
describe('SessionStore interface — SESS-01', () => {
  it('SessionStore.createSession signature', () => {
    expectTypeOf<SessionStore['createSession']>().toEqualTypeOf<
      (input: CreateSessionInput) => Promise<string>
    >();
  });
```

### Smoke-Section Banner + Pass/Fail/Skip + Cite-Lines

**Source:** Phase 17 SESSION section (`bin/smoke-test-router.sh:2289-2431`) + Phase 18 MCP-CLIENT + HOOK section (lines 2434-2538).
**Apply to:** Phase 19 section inserted between line 2538 (Phase 18 complete) and line 2544 (final summary banner).

**Excerpt** (Phase 17 — opening banner + first gate at lines 2309-2335):
```bash
echo ""
echo "[smoke-test-router] === Phase 17 — SessionStore + ContextProvider + SummaryProvider (SESS-01..06 + CTXP-01..04 + SUMP-01..03) ==="

SESS_ID="smoke-sess-$(date +%s)"
AGENT_ID="smoke-agent-1"
SESSION_GATE_OK=1

# Test 1 — non-stream round-trip; X-Session-ID header echoed (SESS-05).
RESP1_FILE=$(mktemp /tmp/sess-smoke-XXXXXX.txt)
trap 'rm -f "${RESP1_FILE}"' EXIT
RESP1_CODE=$(curl -sS -i -o "${RESP1_FILE}" -w '%{http_code}' \
  --max-time 60 \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "X-Agent-Id: ${AGENT_ID}" \
  -H "X-Session-ID: ${SESS_ID}" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"messages\":[…]}" \
  "${ROUTER_URL}/v1/chat/completions" 2>/dev/null || echo "000")

if [[ "${RESP1_CODE}" != "200" ]]; then
  fail "SESS-05: first round-trip failed (HTTP ${RESP1_CODE}); body head: $(head -c 200 "${RESP1_FILE}")"
  SESSION_GATE_OK=0
fi

if [[ "${SESSION_GATE_OK}" -eq 1 ]]; then
  if grep -qi "^x-session-id: ${SESS_ID}" "${RESP1_FILE}"; then
    pass "SESS-05: X-Session-ID response header present on non-stream"
  else
    fail "SESS-05: X-Session-ID response header missing on non-stream (Pitfall 17-D regression?)"
  fi
fi
```

### Wire-Shape Preservation (project_fastify_onsend_timing memory)

**Apply to:** all routes that stamp `req.computedCostCents` for the onSend hook. Phase 19 route refactor MUST stamp BEFORE `reply.send()`, not in `finally`.

**Excerpt** (current `embeddings.ts:451-459`):
```typescript
// Phase 13 (v0.10.0 — COST-02/04): stamp req.computedCostCents BEFORE
// reply.send() — Fastify v5 onSend fires synchronously inside .send().
// Outer finally still records the same cost to the request_log row.
const earlyCost = computeCostCents({
  entry,
  tokensIn: result.usage?.prompt_tokens ?? 0,
  tokensOut: 0,
}) ?? undefined;
```

---

## No Analog Found

| File / Concern | Why no clean analog | Plan-time path |
|----------------|---------------------|----------------|
| Dual-mode CLI script | `router/scripts/check-prometheus-cardinality.ts` is the ONLY script in `router/scripts/` with this CLI-entry shape. `gc-classify.ts` is single-mode. | Self-extension; CLI dispatch sketch in CONTEXT.md "Specific Ideas" §`check-prometheus-cardinality.ts` already locked. |
| Live Prometheus exposition regex | New parser; no prior in-repo Prometheus parsing. Closest external analog is `prom-client` itself (no exposition-parsing helper). | Hand-rolled regex per CONTEXT D-14; invariants from spec captured in RESEARCH §2. |
| `RESS-WITH-TOOLS` live cloud SSE assertion | Phase 16 vitest `tests/routes/responses-stream.test.ts:361-402` covers the FSM invariants but uses a FAKE adapter. No analog exists for a SMOKE gate hitting a real cloud function-calling model with SSE tool-call delta assertions. | Soft-skip predicate from Phase 8 cloud gates (RESEARCH §1) + SSE event-parsing pattern from existing Phase 16 RESS section in smoke (lines 2194-2287). |

---

## Metadata

**Analog search scope:**
- `router/src/providers/` (all 6 files)
- `router/src/{app.ts, index.ts}` (composition root + bootstrap)
- `router/src/routes/v1/embeddings.ts` (refactor target)
- `router/src/types/` (does not exist — pattern mirrored from inline augmentation in `app.ts`)
- `router/src/metrics/registry.ts` (metric ownership map)
- `router/scripts/` (CLI scripts — 2 files)
- `router/tests/{fakes.ts, providers/, integration/, unit/grep-gates/}` (test fakes + conformance + grep gates)
- `bin/smoke-test-router.sh` (2558 lines — Phase 17 + 18 sections inspected)
- `DEPLOY.md` + `README.md` (Phase 17 + 18 sections + status banner)

**Files scanned (full or targeted reads):** 18
**Phases referenced for pattern mirrors:** 14 (cardinality discipline), 17 (SessionStore + ContextProvider + composition root), 18 (RetrieverProvider + preCompletionHooks + Frame-01 BLOCK + migration 0007 test)
**Pattern extraction date:** 2026-06-01
