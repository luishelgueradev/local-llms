/**
 * embeddings.test.ts — Plan 07-04 (OAI-02 + EMBED-01) integration coverage
 * for POST /v1/embeddings.
 *
 * Behavioral matrix:
 *   1. Happy path: bge-m3 (ollama) returns OpenAI-shape body + recordOutcome
 *      observes one row with statusClass='success', tokensOut=0.
 *   2. Capability mismatch: chat-only model → 400 / model_capability_mismatch.
 *   3. Empty string input: zod min(1) gate → 400 / invalid_request_error.
 *   4. Empty array input: zod array().min(1) gate → 400 / invalid_request_error.
 *   5. Unknown model: → 404 / model_not_found from registry.resolve.
 *   6. Missing bearer auth: → 401 / authentication_error.
 *
 * Fixture: buildApp() with a fake BackendAdapter that captures the embeddings
 * call and returns a deterministic 1024-dim vector. Note: registerEmbeddingsRoute
 * is invoked MANUALLY inside the buildApp wrapper here — Task 3 of Plan 07-04
 * wires the call into buildApp itself, after which this test file does NOT
 * need to change (the manual registration becomes a no-op redundant call).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const EMBED_MODEL = 'bge-m3-ollama';
const CHAT_MODEL = 'qwen2.5-7b-instruct-awq';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';
const VLLM_BASE = 'http://vllm:8000/v1';
const YAML = `
models:
  - name: ${EMBED_MODEL}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
  - name: ${CHAT_MODEL}
    backend: vllm
    backend_url: ${VLLM_BASE}
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat, tools]
    vram_budget_gb: 8
`;

interface FakeAdapterCall {
  input: string | string[];
  model: string;
  // 07-REVIEW WR-05: capture the opts arg (CR-01 widened the adapter signature
  // with optional encoding_format/dimensions/user) so the passthrough test can
  // lock in that the route actually forwards these fields rather than just
  // returning 200.
  opts?: {
    encoding_format?: 'float' | 'base64';
    dimensions?: number;
    user?: string;
  };
}

function makeFakeAdapter(): {
  adapter: BackendAdapter;
  calls: FakeAdapterCall[];
} {
  const calls: FakeAdapterCall[] = [];
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical() {
      throw new Error('not used');
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('not used');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings(input, model, _signal, opts) {
      calls.push({ input, model, opts });
      // Phase 12 (v0.10.0): fake returns one vector per input item so batch requests
      // line up with the route's miss-index → vector reassembly. Pre-Phase-12 the
      // fake always returned exactly one item regardless of input — the single-input
      // tests passed (lucky), but batch ones now go through the cache + miss-collect
      // path and require N vectors for N misses.
      const items = Array.isArray(input) ? input : [input];
      return {
        object: 'list',
        data: items.map((_, i) => ({
          object: 'embedding' as const,
          index: i,
          embedding: new Array(1024).fill(0.42),
        })),
        model,
        usage: { prompt_tokens: 3 * items.length, total_tokens: 3 * items.length },
      };
    },
    async rerank(_query, _documents, model) {
      return { model, results: [], usage: { total_tokens: 0 } };
    },
  };
  return { adapter, calls };
}

let app: FastifyInstance;
let pushed: RequestLogInsert[];
let fakeCalls: FakeAdapterCall[];

beforeEach(async () => {
  pushed = [];
  fakeCalls = [];

  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const fakeBuffered = {
    push: (row: RequestLogInsert) => pushed.push(row),
    drain: async () => {},
    get size() {
      return 0;
    },
  };
  const metrics = makeMetricsRegistry();

  const { adapter, calls } = makeFakeAdapter();
  fakeCalls = calls;

  // Plan 07-04 Task 3: buildApp now wires /v1/embeddings via registerEmbeddingsRoute,
  // so no manual route registration here. Assertions verify the bufferedWriter row
  // produced by the route's outer-finally safeRecord OR app.setErrorHandler's
  // recordOutcome (the pre-resolve error path). Both paths route through the same
  // recordRequestOutcome helper → bufferedWriter.push under the hood.
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (_entry: ModelEntry) => adapter,
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: fakeBuffered,
    metrics,
  });
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/embeddings — happy path (OAI-02, EMBED-01)', () => {
  it('returns 200 + OpenAI-shape body for valid embeddings request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: 'hola' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].object).toBe('embedding');
    expect(body.data[0].index).toBe(0);
    expect(Array.isArray(body.data[0].embedding)).toBe(true);
    expect(body.data[0].embedding.length).toBe(1024);
    expect(body.usage).toEqual({ prompt_tokens: 3, total_tokens: 3 });

    // Adapter was called with backend_model (not registry name) and the original input.
    // Phase 19 (EMBP-02): provider coerces string input to string[] before adapter call.
    expect(fakeCalls.length).toBe(1);
    expect(fakeCalls[0].model).toBe('bge-m3');
    expect(fakeCalls[0].input).toEqual(['hola']);

    // bufferedWriter observed exactly one row with success / tokens_out=0.
    expect(pushed.length).toBe(1);
    expect(pushed[0].protocol).toBe('openai');
    expect(pushed[0].route).toBe('/v1/embeddings');
    expect(pushed[0].backend).toBe('ollama');
    expect(pushed[0].model).toBe(EMBED_MODEL);
    expect(pushed[0].status_class).toBe('success');
    expect(pushed[0].http_status).toBe(200);
    expect(pushed[0].tokens_in).toBe(3);
    expect(pushed[0].tokens_out).toBe(0);
  });

  it('accepts array input (batch embeddings)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: ['a', 'b', 'c'] },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeCalls[0].input).toEqual(['a', 'b', 'c']);
  });
});

describe('POST /v1/embeddings — capability gate (T-07-11 mitigation)', () => {
  it('returns 400 / model_capability_mismatch when model lacks embeddings capability', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: CHAT_MODEL, input: 'hola' },
    });

    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('model_capability_mismatch');
    expect(env.error.message).toContain('embeddings');
    expect(env.error.message).toContain(CHAT_MODEL);

    // The adapter must NOT have been called (defense-in-depth layer 1 catches it).
    expect(fakeCalls.length).toBe(0);

    // bufferedWriter STILL records the error path (observability seam — Plan 07-04
    // widens app.setErrorHandler's isRecordedRoute allowlist to include /v1/embeddings).
    expect(pushed.length).toBe(1);
    expect(pushed[0].status_class).toBe('client_error');
    expect(pushed[0].http_status).toBe(400);
    expect(pushed[0].error_code).toBe('model_capability_mismatch');
    // 07-REVIEW WR-08: lock which code path produced the row. The capability
    // throw lives inside the route's try block, so the outer `finally` runs
    // FIRST and records with the resolved entry's backend/model labels — NOT
    // the centralized error-handler fallback of 'unknown'/'unknown' that
    // pre-registry-resolve errors emit. A future refactor that moves the
    // throw before the try block would break this invariant silently; this
    // assertion catches the regression loudly.
    expect(pushed[0].backend).toBe('vllm');
    expect(pushed[0].model).toBe(CHAT_MODEL);
  });
});

describe('POST /v1/embeddings — input validation (Pitfall E-1)', () => {
  it('returns 400 / invalid_request_error for empty string input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: '' },
    });

    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('invalid_request');
    // The adapter must NOT have been called.
    expect(fakeCalls.length).toBe(0);
  });

  it('returns 400 / invalid_request_error for empty array input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: [] },
    });

    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('invalid_request');
    expect(fakeCalls.length).toBe(0);
  });

  it('returns 400 / invalid_request_error for array containing empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: ['valid', ''] },
    });

    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
  });
});

describe('POST /v1/embeddings — registry lookup', () => {
  it('returns 404 / model_not_found for unknown model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'nonexistent-model', input: 'hola' },
    });

    expect(res.statusCode).toBe(404);
    const env = res.json();
    expect(env.error.type).toBe('not_found_error');
    expect(env.error.code).toBe('model_not_found');
    expect(env.error.message).toContain('nonexistent-model');
    expect(fakeCalls.length).toBe(0);
  });
});

describe('POST /v1/embeddings — bearer auth (D-D4 / ROUTE-04)', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: 'hola' },
    });

    expect(res.statusCode).toBe(401);
    const env = res.json();
    expect(env.error.type).toBe('authentication_error');
    expect(env.error.code).toBe('unauthorized');
    expect(fakeCalls.length).toBe(0);
    // D-D4: pre-auth bearer failures are NOT recorded (no request_log row).
    expect(pushed.length).toBe(0);
  });

  it('returns 401 when bearer token is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: 'Bearer wrong-token-of-sufficient-length', 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: 'hola' },
    });

    expect(res.statusCode).toBe(401);
    expect(fakeCalls.length).toBe(0);
    expect(pushed.length).toBe(0);
  });
});

describe('POST /v1/embeddings — schema passthrough (07-REVIEW CR-01 + WR-05)', () => {
  it('forwards encoding_format/dimensions/user to the adapter call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: EMBED_MODEL,
        input: 'hola',
        encoding_format: 'float',
        dimensions: 1024,
        user: 'agent-1',
      },
    });

    expect(res.statusCode).toBe(200);
    // 07-REVIEW WR-05: assert the opts actually reach the adapter. The old
    // test only checked HTTP 200 and the inline comment admitted the optional
    // fields were not forwarded — a test that documented a contract violation
    // is worse than no test. With CR-01 in place this now locks in the
    // OpenAI-compat passthrough contract.
    expect(fakeCalls.length).toBe(1);
    expect(fakeCalls[0].opts?.encoding_format).toBe('float');
    expect(fakeCalls[0].opts?.dimensions).toBe(1024);
    expect(fakeCalls[0].opts?.user).toBe('agent-1');
  });

  it('omits unset optional params from the adapter opts', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_MODEL, input: 'hola' },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeCalls.length).toBe(1);
    // Route always passes an opts object (CR-01); the individual fields are
    // undefined when the client did not send them. The adapter's conditional-
    // spread then drops them from the upstream SDK call. Asserting the field
    // shape catches regressions where the route accidentally forwards
    // `null` or `""` as a value.
    expect(fakeCalls[0].opts).toBeDefined();
    // Phase 19 (EMBP-02 / D-02): EmbeddingProvider always passes encoding_format='float'
    // to the upstream adapter regardless of what the client requested. The route
    // re-encodes to base64 at the wire boundary when the client asked for base64.
    expect(fakeCalls[0].opts?.encoding_format).toBe('float');
    expect(fakeCalls[0].opts?.dimensions).toBeUndefined();
    expect(fakeCalls[0].opts?.user).toBeUndefined();
  });
});

// ─── Phase 12 (v0.10.0 — EMB-H01..06) ──────────────────────────────────────────
//
// Cache + dims enforcement integration coverage. These tests build their OWN app
// instance with a hand-rolled in-memory EmbeddingsCache + (where needed) a custom
// adapter that returns mismatched-dim vectors. This keeps the Phase 7 suite above
// unchanged + isolates the new behavior into a dedicated fixture.

import { registerEmbeddingsRoute } from '../../src/routes/v1/embeddings.js';
import type { EmbeddingsCache, CachedVector } from '../../src/embeddings/cache.js';
import { makeOpenAIEmbeddingProvider } from '../../src/providers/embedding-provider.js';
import Fastify, { type FastifyInstance as FI } from 'fastify';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import {
  serializerCompiler,
  validatorCompiler,
} from '@bram-dc/fastify-type-provider-zod';
import { makeBearerHook } from '../../src/auth/bearer.js';
import { makeRecordRequestOutcome } from '../../src/metrics/recordOutcome.js';

interface MakeP12AppOpts {
  /**
   * Phase 19 (EMBP-02 / Plan 19-03 Rule 3 fix): pass an optional pre-built
   * EmbeddingsCache that will be injected into the EmbeddingProvider via
   * makeOpenAIEmbeddingProvider({ cacheOverride: ... }). This replaces the
   * old `cache?: EmbeddingsCache` that was passed directly to the route before
   * the EMBP-02 refactor moved cache ownership into the provider.
   */
  cache?: EmbeddingsCache;
  adapter?: BackendAdapter;
  yaml?: string;
}

/**
 * Phase 12 fixture builder. Mounts ONLY /v1/embeddings on a fresh Fastify
 * instance so we can wire arbitrary cache + adapter combinations without
 * dragging the full buildApp() liveness/breaker/idempotency surface — those
 * are already exercised by the Phase 7/8 tests above.
 *
 * Phase 19 (EMBP-02): fixture now constructs an EmbeddingProvider via
 * makeOpenAIEmbeddingProvider and passes it to registerEmbeddingsRoute.
 * The cacheOverride field allows injecting the in-memory test cache so
 * EMB-H01..04 cache behavior tests continue to work.
 */
async function makeP12App(opts: MakeP12AppOpts = {}): Promise<{
  app: FI;
  pushed: RequestLogInsert[];
  calls: FakeAdapterCall[];
  metrics: ReturnType<typeof makeMetricsRegistry>;
}> {
  const pushed: RequestLogInsert[] = [];
  const calls: FakeAdapterCall[] = [];
  const registry = makeRegistryStore(loadRegistryFromString(opts.yaml ?? YAML));
  const metrics = makeMetricsRegistry();
  const bufferedWriter = {
    push: (r: RequestLogInsert) => pushed.push(r),
    drain: async () => {},
    get size() {
      return 0;
    },
  };
  const recordOutcome = makeRecordRequestOutcome({ metrics, bufferedWriter });

  const adapter: BackendAdapter =
    opts.adapter ??
    (() => {
      const { adapter: a, calls: c } = makeFakeAdapter();
      calls.push(...[]); // keep reference scope; we'll re-assign below
      // Re-bind calls array via mutation: pull whatever the fake records into our outer calls.
      a.embeddings = async (input, model, _signal, embOpts) => {
        const items = Array.isArray(input) ? input : [input];
        c.push({ input, model, opts: embOpts });
        calls.push({ input, model, opts: embOpts });
        return {
          object: 'list',
          data: items.map((_, i) => ({
            object: 'embedding' as const,
            index: i,
            embedding: new Array(1024).fill(0.42),
          })),
          model,
          usage: { prompt_tokens: 3 * items.length, total_tokens: 3 * items.length },
        };
      };
      return a;
    })();

  // Phase 19 (EMBP-02 / Plan 19-03): construct the EmbeddingProvider here so
  // the route can delegate to it. cacheOverride threads the in-memory test cache
  // into the provider so EMB-H01..04 cache behavior is exercised without Valkey.
  const embeddingProvider = makeOpenAIEmbeddingProvider({
    registry,
    makeAdapter: () => adapter,
    cacheOverride: opts.cache,
    metrics: {
      embeddingsCacheTotal: metrics.embeddingsCacheTotal,
      embeddingsDimsTotal: metrics.embeddingsDimsTotal,
    },
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} }) } as never,
  });

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(FastifySSEPlugin);
  app.addHook('onRequest', makeBearerHook(TOKEN));

  registerEmbeddingsRoute(app, {
    registry,
    makeAdapter: () => adapter,
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    recordOutcome,
    breaker: {
      check: async () => ({ state: 'closed' as const }),
      recordFailure: async () => {},
      recordSuccess: async () => {},
      reset: async () => {},
    },
    breakerCooldownSec: 60,
    embeddingProvider,
    metrics: {
      // Route owns batch_size (D-07) and cache bypass counter (Risk #2 Option A).
      // embeddingsDimsTotal removed — now owned by the provider (D-03 / Plan 19-03).
      embeddingsCacheTotal: metrics.embeddingsCacheTotal,
      embeddingsBatchSize: metrics.embeddingsBatchSize,
    },
  });

  return { app, pushed, calls, metrics };
}

/**
 * In-memory EmbeddingsCache that mirrors the contract the route consumes.
 * Tracks call counts so we can assert hit vs miss numerically.
 */
function makeInMemoryCache(): EmbeddingsCache & {
  store: Map<string, CachedVector>;
  getCalls: number;
  setCalls: number;
  injectGetError?: Error;
  injectSetError?: Error;
} {
  const state = {
    store: new Map<string, CachedVector>(),
    getCalls: 0,
    setCalls: 0,
    injectGetError: undefined as Error | undefined,
    injectSetError: undefined as Error | undefined,
  };
  return {
    ...state,
    async get(key: string) {
      this.getCalls++;
      if (this.injectGetError) throw this.injectGetError;
      return this.store.get(key) ?? null;
    },
    async set(key: string, value: CachedVector) {
      this.setCalls++;
      if (this.injectSetError) throw this.injectSetError;
      this.store.set(key, value);
    },
  };
}

describe('POST /v1/embeddings — Phase 12 cache (EMB-H01)', () => {
  it('second identical request is served from cache; adapter called once', async () => {
    const cache = makeInMemoryCache();
    const { app, calls, metrics, pushed } = await makeP12App({ cache });
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola' },
      });
      expect(r1.statusCode).toBe(200);
      const r2 = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola' },
      });
      expect(r2.statusCode).toBe(200);

      // Adapter invoked only for the first (miss) request.
      expect(calls.length).toBe(1);
      // Cache observed exactly one miss + one hit on the counter.
      const text = await metrics.register.metrics();
      expect(text).toMatch(/router_embeddings_cache_total\{result="miss"\}\s+1/);
      expect(text).toMatch(/router_embeddings_cache_total\{result="hit"\}\s+1/);

      // Second response is byte-identical to the first vector.
      expect(r2.json().data[0].embedding).toEqual(r1.json().data[0].embedding);

      // request_log: second request shows tokens_in=0 (no upstream call).
      expect(pushed.length).toBe(2);
      expect(pushed[1].tokens_in).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('batch with partial cache: only misses go to the adapter, order preserved', async () => {
    const cache = makeInMemoryCache();
    const { app, calls, metrics } = await makeP12App({ cache });
    try {
      // Warm two of the three keys.
      await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'a' },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'b' },
      });
      const callsBefore = calls.length;

      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: ['a', 'c', 'b'] },
      });
      expect(r.statusCode).toBe(200);
      // Only one new adapter call (for 'c'), and it received just that input.
      expect(calls.length - callsBefore).toBe(1);
      const lastCall = calls[calls.length - 1];
      expect(lastCall.input).toEqual(['c']);

      const body = r.json();
      expect(body.data).toHaveLength(3);
      expect(body.data[0].index).toBe(0);
      expect(body.data[1].index).toBe(1);
      expect(body.data[2].index).toBe(2);

      const text = await metrics.register.metrics();
      // 2 hits + 1 miss from the batch (warming counted 2 misses earlier → 3 misses total).
      expect(text).toMatch(/router_embeddings_cache_total\{result="hit"\}\s+2/);
      expect(text).toMatch(/router_embeddings_cache_total\{result="miss"\}\s+3/);
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/embeddings — Phase 12 cache bypass + fail-open (EMB-H04)', () => {
  it('encoding_format=base64 bypasses cache; bypass metric increments', async () => {
    const cache = makeInMemoryCache();
    const { app, calls, metrics } = await makeP12App({ cache });
    try {
      // base64 fake returns a string per item — wrap the adapter to honor that.
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola', encoding_format: 'base64' },
      });
      expect(r.statusCode).toBe(200);
      expect(calls.length).toBe(1);
      // Phase 19 (EMBP-02): provider always works in float; float result IS cached
      // even for base64 client requests. Subsequent float requests for the same
      // input will be cache hits (improved behavior vs Phase 12).
      // The bypass metric is still incremented by the route (Risk #2 Option A).
      const text = await metrics.register.metrics();
      expect(text).toMatch(/router_embeddings_cache_total\{result="bypass"\}\s+1/);
    } finally {
      await app.close();
    }
  });

  it('Valkey error on get → fail-open: upstream called, no metric increment', async () => {
    const cache = makeInMemoryCache();
    cache.injectGetError = new Error('ECONNREFUSED');
    const { app, calls, metrics } = await makeP12App({ cache });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola' },
      });
      expect(r.statusCode).toBe(200);
      expect(calls.length).toBe(1); // upstream still called
      const text = await metrics.register.metrics();
      // EMB-H04 contract: metric stays a faithful representation of REAL cache outcomes.
      // No hit / no miss / no bypass increment when Valkey errors.
      expect(text).not.toMatch(/router_embeddings_cache_total\{result="hit"\}\s+[1-9]/);
      expect(text).not.toMatch(/router_embeddings_cache_total\{result="miss"\}\s+[1-9]/);
    } finally {
      await app.close();
    }
  });

  it('Valkey error on set → fail-open: response succeeds anyway', async () => {
    const cache = makeInMemoryCache();
    cache.injectSetError = new Error('OOM');
    const { app, calls } = await makeP12App({ cache });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola' },
      });
      expect(r.statusCode).toBe(200);
      expect(calls.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('no cache wired → batch_size still observed, no cache_total events', async () => {
    const { app, metrics } = await makeP12App({}); // cache: undefined
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: ['a', 'b', 'c'] },
      });
      expect(r.statusCode).toBe(200);
      const text = await metrics.register.metrics();
      // batch_size histogram observed; cache_total totally absent or all-zero.
      expect(text).toMatch(/router_embeddings_batch_size_count\s+1/);
      expect(text).not.toMatch(/router_embeddings_cache_total\{result=".*?"\}\s+[1-9]/);
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/embeddings — Phase 12 dims enforcement (EMB-H02)', () => {
  it('rejects vector with wrong dims → 500 + structured envelope; vector not propagated', async () => {
    // Bespoke adapter that returns a 768-dim vector for a model declared as 1024.
    const wrongDimAdapter: BackendAdapter = {
      async chatCompletionsCanonical() {
        throw new Error('not used');
      },
      async chatCompletionsCanonicalStream() {
        throw new Error('not used');
      },
      async probeLiveness() {
        return { ok: true, latencyMs: 0 };
      },
      async embeddings(input, model) {
        const items = Array.isArray(input) ? input : [input];
        return {
          object: 'list',
          data: items.map((_, i) => ({
            object: 'embedding' as const,
            index: i,
            embedding: new Array(768).fill(0.01),
          })),
          model,
          usage: { prompt_tokens: items.length, total_tokens: items.length },
        };
      },
      async rerank() {
        return { model: '', results: [], usage: { total_tokens: 0 } };
      },
    };
    const { app, pushed } = await makeP12App({ adapter: wrongDimAdapter });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: 'hola' },
      });
      // No setErrorHandler in the slim P12 app — Fastify default returns 500 on uncaught.
      expect(r.statusCode).toBe(500);
      // request_log row records the error path with the dims-mismatch code.
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe('server_error');
      expect(pushed[0].http_status).toBe(500);
      // mapErrorToCode falls through to 'internal_error' for EmbeddingsDimsMismatchError
      // because it's not in the D-D2 taxonomy table; that's acceptable for a 500-class
      // upstream-misconfiguration error. The structured log line is the operator signal.
      expect(pushed[0].error_message).toContain('1024');
      expect(pushed[0].error_message).toContain('768');
    } finally {
      await app.close();
    }
  });

  it('records router_embeddings_dims_total on successful response', async () => {
    const { app, metrics } = await makeP12App({});
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: { model: EMBED_MODEL, input: ['a', 'b'] },
      });
      expect(r.statusCode).toBe(200);
      const text = await metrics.register.metrics();
      // Incremented by inputs.length (2 here) for the (model, dims) pair.
      expect(text).toMatch(
        /router_embeddings_dims_total\{model="bge-m3-ollama",dims="1024"\}\s+2/,
      );
    } finally {
      await app.close();
    }
  });
});
