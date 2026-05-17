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
  registerEmbeddingsRoute,
  type RegisterEmbeddingsOpts,
} from '../../src/routes/v1/embeddings.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import {
  makeRecordRequestOutcome,
  type OutcomeContext,
} from '../../src/metrics/recordOutcome.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';

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
    async embeddings(input, model) {
      calls.push({ input, model });
      return {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: new Array(1024).fill(0.42) }],
        model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };
    },
  };
  return { adapter, calls };
}

let app: FastifyInstance;
let recorded: OutcomeContext[];
let pushed: unknown[];
let fakeCalls: FakeAdapterCall[];

beforeEach(async () => {
  recorded = [];
  pushed = [];
  fakeCalls = [];

  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const fakeBuffered = {
    push: (row: unknown) => pushed.push(row),
    drain: async () => {},
    get size() {
      return 0;
    },
  };
  const metrics = makeMetricsRegistry();
  // Real recordOutcome — exercises the metrics + bufferedWriter pipeline AND
  // captures the OutcomeContext via a tee'd spy so tests can assert on the
  // ctx shape the route emitted.
  const realRecord = makeRecordRequestOutcome({
    metrics,
    bufferedWriter: fakeBuffered,
  });
  const recordOutcome = (ctx: OutcomeContext): void => {
    recorded.push(ctx);
    realRecord(ctx);
  };

  const { adapter, calls } = makeFakeAdapter();
  fakeCalls = calls;

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

  // Plan 07-04 Task 2: register the route manually until Task 3 wires it into
  // buildApp itself. Pass the SAME recordOutcome wrapper so route-level
  // observability assertions hold.
  const opts: RegisterEmbeddingsOpts = {
    registry,
    makeAdapter: (_entry: ModelEntry) => adapter,
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    recordOutcome,
  };
  registerEmbeddingsRoute(app, opts);
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
    expect(fakeCalls.length).toBe(1);
    expect(fakeCalls[0].model).toBe('bge-m3');
    expect(fakeCalls[0].input).toBe('hola');

    // recordOutcome observed exactly one row with success / tokensOut=0.
    expect(recorded.length).toBe(1);
    expect(recorded[0].protocol).toBe('openai');
    expect(recorded[0].route).toBe('/v1/embeddings');
    expect(recorded[0].backend).toBe('ollama');
    expect(recorded[0].model).toBe(EMBED_MODEL);
    expect(recorded[0].statusClass).toBe('success');
    expect(recorded[0].httpStatus).toBe(200);
    expect(recorded[0].tokensIn).toBe(3);
    expect(recorded[0].tokensOut).toBe(0);
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

    // recordOutcome STILL records the error path (observability seam).
    expect(recorded.length).toBe(1);
    expect(recorded[0].statusClass).toBe('client_error');
    expect(recorded[0].httpStatus).toBe(400);
    expect(recorded[0].errorCode).toBe('model_capability_mismatch');
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
    expect(recorded.length).toBe(0);
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
    expect(recorded.length).toBe(0);
  });
});

describe('POST /v1/embeddings — schema passthrough', () => {
  it('accepts optional encoding_format/dimensions/user without changing behavior', async () => {
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
    // The adapter wrapper does not currently forward encoding_format/dimensions
    // (the SDK call uses {model, input} only). This is a passthrough at the
    // schema layer, not the call layer — verified by the route still returning
    // 200 instead of a 400 from the zod schema rejecting unknown keys.
  });
});
