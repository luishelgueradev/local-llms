/**
 * messages.count-tokens.test.ts — Integration tests for POST /v1/messages/count_tokens.
 *
 * Covers Plan 04-02 requirements (ANTHR-02 + D-E2 + D-F1):
 *   - Wire shape: { input_tokens: number }
 *   - Response header X-Token-Count-Method: gpt-tokenizer/cl100k_base
 *   - +340 token overhead when tools are declared
 *   - System prompt counted on top of message tokens
 *   - URL images → 1568 constant (no fetch)
 *   - base64 PNG with measurable dims → ceil(w*h/750)
 *   - Unknown model → 404 + Anthropic envelope
 *   - Empty messages → 400 + Anthropic envelope
 *   - D-F1: no semaphore — high concurrency does NOT 429
 *
 * No msw upstream — count_tokens never calls a backend.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { BackendSemaphore } from '../../src/concurrency/semaphore.js';
import type { ModelEntry } from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const MODEL_NAME = 'llama3.2:3b-instruct-q4_K_M';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';

// `concurrency: 1` exercises D-F1 — count_tokens must NOT acquire the semaphore.
// If it did, a single-slot semaphore would queue/reject the second+ concurrent call.
const YAML = `
models:
  - name: ${MODEL_NAME}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${MODEL_NAME}
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    concurrency: 1
    queue_max_wait_ms: 1000
`;

// Minimal valid 1×1 white PNG (matches count-tokens.test.ts fixture).
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app: FastifyInstance;

beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  // Use the REAL BackendSemaphore here (not a fake) so D-F1's "no semaphore acquire"
  // is observable: if count_tokens were to acquire, the concurrency:1 cap would
  // queue/reject the parallel calls in test #9.
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    semaphoreFactory: (n, c, w) => new BackendSemaphore(n, c, w),
    bufferedWriter: makeFakeBufferedWriter(),
  });
});
afterEach(async () => {
  await app.close();
});

describe('POST /v1/messages/count_tokens — happy path (ANTHR-02)', () => {
  it('returns { input_tokens: number } for a simple text message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hello world' }],
        max_tokens: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('sets X-Token-Count-Method response header (D-E2)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-token-count-method']).toBe('gpt-tokenizer/cl100k_base');
  });
});

describe('POST /v1/messages/count_tokens — token-count deltas', () => {
  it('tools array adds ~340 token overhead (FINDING 2.3)', async () => {
    const baseRes = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    const withToolsRes = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get current weather',
            input_schema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      },
    });
    expect(baseRes.statusCode).toBe(200);
    expect(withToolsRes.statusCode).toBe(200);
    const delta = withToolsRes.json().input_tokens - baseRes.json().input_tokens;
    expect(delta).toBeGreaterThanOrEqual(300);
  });

  it('system prompt adds tokens beyond messages alone', async () => {
    const baseRes = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    const withSysRes = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
        system: 'this is a system prompt',
      },
    });
    expect(withSysRes.json().input_tokens).toBeGreaterThan(baseRes.json().input_tokens);
  });
});

describe('POST /v1/messages/count_tokens — image overhead', () => {
  it('URL image source falls back to 1568 constant (NEVER fetches)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
              { type: 'text', text: '.' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().input_tokens).toBeGreaterThanOrEqual(1568);
  });

  it('base64 1×1 PNG computes ceil(1*1/750) === 1 image-token overhead', async () => {
    // Compare with and without the image: delta should be exactly 1.
    const withoutImage = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'see image' }] }],
      },
    });
    const withImage = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 },
              },
              { type: 'text', text: 'see image' },
            ],
          },
        ],
      },
    });
    expect(withoutImage.statusCode).toBe(200);
    expect(withImage.statusCode).toBe(200);
    expect(withImage.json().input_tokens - withoutImage.json().input_tokens).toBe(1);
  });
});

describe('POST /v1/messages/count_tokens — error mapping (Anthropic envelope)', () => {
  it('unknown model returns 404 with Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: 'nonexistent:9b',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(404);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('not_found_error');
  });

  it('empty messages returns 400 with Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [] },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
  });
});

describe('POST /v1/messages/count_tokens — D-F1 (no semaphore acquisition)', () => {
  it('10 concurrent count_tokens calls all return 200 against concurrency:1 backend', async () => {
    // The YAML pins ollama's concurrency to 1. If count_tokens were to acquire
    // a slot, calls 2..10 would queue (queue_max_wait_ms=1000) — and we'd see at
    // least one 429 in the response set. Pure-CPU count_tokens does NOT acquire,
    // so all 10 return 200 in parallel.
    const promises = Array.from({ length: 10 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/messages/count_tokens',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: MODEL_NAME,
          messages: [{ role: 'user', content: 'hello' }],
        },
      }),
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.statusCode).toBe(200);
    }
  });
});
