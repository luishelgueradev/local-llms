/**
 * Plan 08-05 (CLOUD-04 / D-C1, D-C2) — end-to-end max_tokens cap integration.
 *
 * Verifies the wire-level behavior of the per-route guard against a Fastify
 * app with a fake adapter that records spy call counts so each test can
 * assert whether the cap was enforced BEFORE the adapter was called.
 *
 *   Test 1 (cloud, over cap, OpenAI surface):
 *     POST /v1/chat/completions {model: cloud, max_tokens: 32768}
 *     → 400 + OpenAI envelope code='cloud_max_tokens_exceeded' + param='max_tokens';
 *       fake adapter is NEVER called.
 *
 *   Test 2 (cloud, over cap, Anthropic surface):
 *     POST /v1/messages {model: cloud, max_tokens: 32768}
 *     → 400 + Anthropic envelope type='invalid_request_error'.
 *
 *   Test 3 (local, over cap):
 *     POST /v1/chat/completions {model: local, max_tokens: 32768}
 *     → adapter called (cap is cloud-only — D-C2 per-cloud-backend, not global).
 *
 *   Test 4 (cloud, exact cap):
 *     POST /v1/chat/completions {model: cloud, max_tokens: 16384}
 *     → adapter called (cap is strict `>`, not `>=` — the documented Ollama
 *       Cloud ceiling is INCLUSIVE per PITFALLS Pitfall 9).
 *
 *   Test 5 (cloud, no max_tokens):
 *     POST /v1/chat/completions {model: cloud} (no max_tokens key)
 *     → adapter called (typeof body.max_tokens !== 'number' skips the guard;
 *       Ollama Cloud will silently apply its own default, but D-C1 only
 *       requires we don't ADD a cap to undefined inputs).
 *
 *   Test 6 (embeddings):
 *     POST /v1/embeddings (against a cloud-embeddings hypothetical entry)
 *     → adapter called; embeddings route has no max_tokens parameter and
 *       must NOT carry the cap (the guard lives only in chat-completions +
 *       messages routes).
 *
 *   Test 7 (X-Model-Backend header on cap rejection):
 *     The 400 response from a cloud-cap rejection still carries the
 *     X-Model-Backend: ollama-cloud header (Plan 08-03 onSend), proving
 *     the cap fires AFTER req.resolvedBackend is stamped.
 *
 * Fixture: buildApp() with an inline fake adapter (spy-counted) and a
 * registry containing both an ollama-cloud chat entry, a local ollama chat
 * entry, and a cloud embedding entry.
 */
import { describe, expect, it, afterEach } from 'vitest';
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
const CLOUD_MODEL = 'gpt-oss:120b-cloud';
const LOCAL_MODEL = 'llama3.2:3b-instruct-q4_K_M';
const CLOUD_EMBED_MODEL = 'nomic-embed-text-cloud'; // hypothetical for Test 6
const CLOUD_BASE = 'https://ollama.com/v1';
const LOCAL_BASE = 'http://upstream-mock:11434/v1';

const YAML = `
models:
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: ${CLOUD_MODEL}
    capabilities: [chat]
    vram_budget_gb: 0
  - name: ${LOCAL_MODEL}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: ${LOCAL_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${CLOUD_EMBED_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: ${CLOUD_EMBED_MODEL}
    capabilities: [embeddings]
    vram_budget_gb: 0
backends:
  ollama:
    concurrency: 2
    queue_max_wait_ms: 30000
  ollama-cloud:
    concurrency: 2
    queue_max_wait_ms: 30000
`;

function stubCanonicalResponse(model: string): CanonicalResponse {
  return {
    id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

interface SpyCounts {
  chat: number;
  embeddings: number;
}

function makeSpyAdapter(counts: SpyCounts): BackendAdapter {
  return {
    async chatCompletionsCanonical(canonical) {
      counts.chat++;
      return stubCanonicalResponse(canonical.model);
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('stream not exercised in this suite');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings() {
      counts.embeddings++;
      return {
        object: 'list',
        data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
        model: 'stub',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      } as never;
    },
  };
}

let app: FastifyInstance;
let counts: SpyCounts;

async function setup(): Promise<void> {
  counts = { chat: 0, embeddings: 0 };
  const adapter = makeSpyAdapter(counts);
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => adapter,
    semaphores: {
      get: () =>
        ({
          acquire: async () => () => {},
          stats: () => ({ inFlight: 0, queued: 0 }),
        }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
    // No valkey → no-op breaker (closed). Per Plan 08-04 Test 6 pattern: the
    // breaker fallback is closed for all requests so we can isolate the cap
    // guard cleanly without time-advancing a mock.
  });
}

afterEach(async () => {
  await app?.close();
});

describe('Cloud max_tokens cap integration — Plan 08-05 (CLOUD-04)', () => {
  it('Test 1: /v1/chat/completions cloud + max_tokens=32768 → 400 + OpenAI envelope; adapter NOT called', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32768,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('cloud_max_tokens_exceeded');
    expect(body.error.param).toBe('max_tokens');
    expect(body.error.message).toContain('32768');
    expect(body.error.message).toContain('16384');
    // Adapter never called (guard fires pre-adapter).
    expect(counts.chat).toBe(0);
    // X-Model-Backend header still stamped (Plan 08-03 onSend, Test 7 coverage).
    expect(res.headers['x-model-backend']).toBe('ollama-cloud');
  });

  it('Test 2: /v1/messages cloud + max_tokens=32768 → 400 + Anthropic envelope; adapter NOT called', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        max_tokens: 32768,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('32768');
    expect(body.error.message).toContain('16384');
    expect(counts.chat).toBe(0);
    expect(res.headers['x-model-backend']).toBe('ollama-cloud');
  });

  it('Test 3: /v1/chat/completions LOCAL + max_tokens=32768 → 200; adapter called (cap is cloud-only)', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: LOCAL_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32768,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(counts.chat).toBe(1);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });

  it('Test 4: /v1/chat/completions cloud + max_tokens=16384 (exact cap) → 200; adapter called', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16384,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(counts.chat).toBe(1);
  });

  it('Test 5: /v1/chat/completions cloud + no max_tokens → 200; adapter called (guard skips undefined)', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        // no max_tokens key
      },
    });
    expect(res.statusCode).toBe(200);
    expect(counts.chat).toBe(1);
  });

  it('Test 6: /v1/embeddings cloud → 200; cap NOT applied (embeddings route not gated)', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_EMBED_MODEL,
        input: 'embed this',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(counts.embeddings).toBe(1);
    expect(counts.chat).toBe(0);
  });
});
