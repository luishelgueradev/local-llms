/**
 * x-model-backend.test.ts — Plan 08-03 (ROUTE-10) integration coverage for the
 * `X-Model-Backend` response header.
 *
 * Behavior:
 *   - Test 1: POST /v1/chat/completions success → 200 + `x-model-backend: ollama`.
 *   - Test 2: POST /v1/messages success → 200 + `x-model-backend: ollama`.
 *   - Test 3: POST /v1/embeddings success → 200 + `x-model-backend: ollama`.
 *   - Test 4: POST /v1/chat/completions with unknown model → 404 + header ABSENT
 *     (resolve threw before the route stamp ever ran).
 *   - Test 5: POST /v1/chat/completions without Authorization → 401 + header ABSENT
 *     (bearer onRequest hook rejects before any preHandler/handler runs).
 *   - Test 6: POST /v1/messages/count_tokens → 200 + header ABSENT
 *     (count-tokens route doesn't stamp resolvedBackend — D-F1).
 *   - Test 7: POST /v1/chat/completions against an ollama-cloud entry → 200 +
 *     `x-model-backend: ollama-cloud` (the canonical CLOUD-02 transparency signal).
 *
 * Fixture: buildApp() with an inline fake BackendAdapter that returns a stub
 * CanonicalResponse for chat/messages and a deterministic vector for embeddings.
 * No msw — the adapter is fully synchronous and avoids any upstream wire.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import type { CanonicalResponse } from '../../src/translation/canonical.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const CHAT_MODEL = 'llama3.2:3b-instruct-q4_K_M';
const EMBED_MODEL = 'bge-m3-ollama';
const CLOUD_MODEL = 'gpt-oss:120b-cloud';
const OLLAMA_BASE = 'http://upstream-mock:11434/v1';
const CLOUD_BASE = 'https://ollama.com/v1';

const YAML = `
models:
  - name: ${CHAT_MODEL}
    backend: ollama
    backend_url: ${OLLAMA_BASE}
    backend_model: ${CHAT_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${EMBED_MODEL}
    backend: ollama
    backend_url: ${OLLAMA_BASE}
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: ${CLOUD_MODEL}
    capabilities: [chat]
    vram_budget_gb: 0
`;

function stubCanonicalResponse(model: string): CanonicalResponse {
  return {
    id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi from fake' }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

function makeFakeAdapter(): BackendAdapter {
  return {
    async chatCompletionsCanonical(canonical) {
      return stubCanonicalResponse(canonical.model);
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('stream not used in this suite');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings(input, model) {
      // Phase 12 (v0.10.0 — EMB-H02): dims is now required for embeddings models
      // (registry.ts.superRefine) AND enforced at response time. Fake returns 1024-dim
      // vectors (matches the bge-m3-ollama dims declared in the YAML fixture above).
      // One vector per input item so batch requests don't trip the count-mismatch gate.
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
    // Phase 11 (v0.10.0 — RERANK-02): not exercised by this suite.
    async rerank(_query: string, _documents: string[], model: string) {
      return { model, results: [], usage: { total_tokens: 0 } };
    },
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => makeFakeAdapter(),
    semaphores: {
      get: () =>
        ({
          acquire: async () => () => {},
          stats: () => ({ inFlight: 0, queued: 0 }),
        }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
});

afterEach(async () => {
  await app.close();
});

describe('X-Model-Backend response header — Plan 08-03 (ROUTE-10)', () => {
  it('Test 1: POST /v1/chat/completions success → 200 + x-model-backend: ollama', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });

  it('Test 2: POST /v1/messages success → 200 + x-model-backend: ollama', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CHAT_MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });

  it('Test 3: POST /v1/embeddings success → 200 + x-model-backend: ollama', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { model: EMBED_MODEL, input: 'embed me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });

  it('Test 4: unknown model → 404 + header ABSENT (resolve threw pre-stamp)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'nonexistent:9b',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-model-backend']).toBeUndefined();
  });

  it('Test 5: missing bearer → 401 + header ABSENT (auth gates before handler)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-model-backend']).toBeUndefined();
  });

  it('Test 6: POST /v1/messages/count_tokens → 200 + header ABSENT (no stamp by design)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'hello world' }],
        max_tokens: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBeUndefined();
  });

  it('Test 7: cloud entry → 200 + x-model-backend: ollama-cloud (CLOUD-02 transparency)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { model: CLOUD_MODEL, messages: [{ role: 'user', content: 'hi cloud' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama-cloud');
  });
});
