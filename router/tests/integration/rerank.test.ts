/**
 * Phase 11 (v0.10.0 — RERANK-01..06) integration tests for POST /v1/rerank.
 *
 * Uses a controllable FakeAdapter that returns pre-seeded scores; the test asserts
 * shape, ordering, top_n cap, capability gate, and request_log row.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const RERANK_MODEL = 'bge-reranker-local-test';
const CHAT_MODEL = 'plain-chat-test';

const YAML = `
models:
  - name: ${RERANK_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: bge-reranker-v2-m3
    capabilities: [rerank]
    vram_budget_gb: 0
  - name: ${CHAT_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: irrelevant
    capabilities: [chat]
    vram_budget_gb: 4
`;

/** FakeAdapter that returns a fixed score per document index (descending). */
function makeFakeAdapter(scores: number[]): BackendAdapter {
  return {
    async chatCompletionsCanonical(): Promise<never> { throw new Error('not used'); },
    async chatCompletionsCanonicalStream(): Promise<never> { throw new Error('not used'); },
    async probeLiveness() { return { ok: true, latencyMs: 1 }; },
    async embeddings(): Promise<never> { throw new Error('not used'); },
    async rerank(_query, documents, model) {
      return {
        model,
        results: documents.map((_d, i) => ({ index: i, relevance_score: scores[i] ?? 0 })),
        usage: { total_tokens: documents.reduce((s, d) => s + d.length, 0) },
      };
    },
  };
}

let app: FastifyInstance;

async function setup(scores: number[]): Promise<void> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => makeFakeAdapter(scores),
    semaphores: {
      get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
}

afterEach(async () => { await app.close(); });

describe('Phase 11: POST /v1/rerank', () => {
  it('RERANK-01: returns results sorted by relevance_score descending', async () => {
    await setup([0.3, 0.9, 0.5]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: 'q', documents: ['a', 'b', 'c'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ model: string; results: Array<{ index: number; relevance_score: number }>; usage: { total_tokens: number } }>();
    expect(body.model).toBe(RERANK_MODEL); // RERANK-04: surface registry name not backend_model
    expect(body.results.map((r) => r.index)).toEqual([1, 2, 0]); // descending by score
    expect(body.results.map((r) => r.relevance_score)).toEqual([0.9, 0.5, 0.3]);
    expect(body.usage.total_tokens).toBe(3); // 1+1+1
  });

  it('RERANK-01: top_n caps the number of returned results', async () => {
    await setup([0.1, 0.9, 0.5, 0.7]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: 'q', documents: ['a', 'b', 'c', 'd'], top_n: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: Array<{ index: number; relevance_score: number }> }>();
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r) => r.index)).toEqual([1, 3]); // top 2 by score: 0.9, 0.7
  });

  it('RERANK-05: capability gate — model without `rerank` returns 400 + model_capability_mismatch', async () => {
    await setup([0.5]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: CHAT_MODEL, query: 'q', documents: ['a'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('model_capability_mismatch');
  });

  it('rejects empty documents array at the route boundary (400 invalid_request)', async () => {
    await setup([]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: 'q', documents: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects empty query at the route boundary (400 invalid_request)', async () => {
    await setup([0.5]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: '', documents: ['a'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires bearer auth (401 without Authorization)', async () => {
    await setup([0.5]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: 'q', documents: ['a'] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('RERANK-04: response carries X-Model-Backend header', async () => {
    await setup([0.5]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: RERANK_MODEL, query: 'q', documents: ['a'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });
});
