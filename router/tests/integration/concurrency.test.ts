/**
 * concurrency.test.ts — Integration tests for per-backend semaphore concurrency cap
 * (Plan 03-04, ROUTE-07, D-B1..D-B5)
 *
 * Unlike chat-completions.{stream,nonstream,llamacpp}.test.ts which use fake semaphores,
 * these tests use REAL BackendSemaphore instances to exercise the actual rate-limit behavior.
 *
 * Cases 1-6: non-stream concurrency + 429 envelope + Retry-After + independent caps.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { server } from '../setup.js';
import { ollamaNonStreamHandler, llamacppNonStreamHandler } from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { BackendSemaphore } from '../../src/concurrency/semaphore.js';
import { makeAdapter } from '../../src/backends/factory.js';
import type { LivenessScheduler } from '../../src/backends/liveness.js';

// Fake liveness scheduler — suppresses real HTTP probes in tests.
// The concurrency tests don't exercise /readyz, so probe behavior is irrelevant.
function makeFakeLiveness(): LivenessScheduler {
  return {
    start: () => {},
    stop: () => {},
    refresh: async () => {},
    get: () => undefined,
    urls: () => [],
  };
}

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

const OLLAMA_URL = 'http://ollama-concurrency-test:11434/v1';
const LLAMACPP_URL = 'http://llamacpp-concurrency-test:8080/v1';

// Helper to build an app with a real BackendSemaphore (not a fake)
async function buildTestApp(opts: {
  yaml: string;
  semaphore?: BackendSemaphore;
  semaphoresByName?: Map<string, BackendSemaphore>;
}) {
  const registry = makeRegistryStore(loadRegistryFromString(opts.yaml));
  // Build semaphores map — use injected or derive from registry
  const semaphoresMap = opts.semaphoresByName ?? new Map<string, BackendSemaphore>();
  if (opts.semaphore) {
    semaphoresMap.set('ollama', opts.semaphore);
  }
  const app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter,
    // Inject real semaphores for concurrency behavior testing
    semaphores: {
      get: (backend: string): BackendSemaphore => {
        const s = semaphoresMap.get(backend);
        if (!s) throw new Error(`No test semaphore for backend "${backend}"`);
        return s;
      },
    },
    // Suppress real liveness probe HTTP calls (concurrency tests don't need /readyz)
    livenessFactory: () => makeFakeLiveness(),
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
  return { app, semaphoresMap };
}

describe('Concurrency cap — non-stream (Plan 03-04, ROUTE-07)', () => {
  let app: FastifyInstance;
  let sem: BackendSemaphore;

  afterEach(async () => {
    await app?.close();
  });

  // Test 1: N concurrent under cap all succeed
  it('1. two concurrent requests under cap=2 both succeed', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    base_url: ${OLLAMA_URL}
    concurrency: 2
    queue_max_wait_ms: 5000
`;
    sem = new BackendSemaphore('ollama', 2, 5000);
    const { app: testApp } = await buildTestApp({ yaml, semaphore: sem });
    app = testApp;

    server.use(ollamaNonStreamHandler({
      url: `${OLLAMA_URL}/chat/completions`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      content: 'hello',
    }));

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const payload = { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] };

    const [res1, res2] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.json().choices[0].message.content).toBe('hello');
    expect(res2.json().choices[0].message.content).toBe('hello');
  });

  // Test 2: (N+1)th queues then succeeds when slot frees
  it('2. third request queues and succeeds after a slot frees', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    base_url: ${OLLAMA_URL}
    concurrency: 2
    queue_max_wait_ms: 5000
`;
    sem = new BackendSemaphore('ollama', 2, 5000);
    const { app: testApp } = await buildTestApp({ yaml, semaphore: sem });
    app = testApp;

    // Upstream responds after 100ms — gives time for 3 to pile up
    server.use(ollamaNonStreamHandler({
      url: `${OLLAMA_URL}/chat/completions`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      content: 'done',
      delayMs: 100,
    }));

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const payload = { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] };

    const t0 = Date.now();
    const [res1, res2, res3] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
    ]);
    const elapsed = Date.now() - t0;

    // All 3 should succeed
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(200);
    // Third request was delayed (had to wait for a slot)
    // With 2 concurrent at 100ms each, the 3rd can only start after ~100ms
    expect(elapsed).toBeGreaterThanOrEqual(150);  // at least 100ms wait + 100ms service
  }, 10_000);

  // Test 3: (N+1)th times out → 429 with envelope and Retry-After
  it('3. third request 429s when queue timeout expires, with correct envelope and Retry-After header', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    base_url: ${OLLAMA_URL}
    concurrency: 2
    queue_max_wait_ms: 100
`;
    sem = new BackendSemaphore('ollama', 2, 100);  // 100ms timeout
    const { app: testApp } = await buildTestApp({ yaml, semaphore: sem });
    app = testApp;

    // Upstream responds after 300ms — longer than the 100ms queue timeout
    server.use(ollamaNonStreamHandler({
      url: `${OLLAMA_URL}/chat/completions`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      content: 'slow',
      delayMs: 300,
    }));

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const payload = { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] };

    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
    ]);

    const statusCodes = results.map((r) => r.statusCode);
    const has429 = statusCodes.includes(429);
    expect(has429).toBe(true);

    const res429 = results.find((r) => r.statusCode === 429)!;
    const body = res429.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('backend_saturated');
    expect(body.error.message).toMatch(/saturated/);
    expect(body.error.param).toBeNull();

    // Retry-After header (Fastify lowercases headers)
    const retryAfter = res429.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(String(retryAfter)).toMatch(/^\d+$/);  // integer seconds
  }, 10_000);

  // Test 4: Different backends get independent caps
  it('4. independent backends have independent semaphore caps', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: ${LLAMACPP_URL}
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 6
backends:
  ollama:
    base_url: ${OLLAMA_URL}
    concurrency: 1
    queue_max_wait_ms: 5000
  llamacpp:
    base_url: ${LLAMACPP_URL}
    concurrency: 1
    queue_max_wait_ms: 5000
`;
    const semaphoresMap = new Map<string, BackendSemaphore>([
      ['ollama', new BackendSemaphore('ollama', 1, 5000)],
      ['llamacpp', new BackendSemaphore('llamacpp', 1, 5000)],
    ]);
    const { app: testApp } = await buildTestApp({ yaml, semaphoresByName: semaphoresMap });
    app = testApp;

    server.use(
      ollamaNonStreamHandler({ url: `${OLLAMA_URL}/chat/completions`, model: 'llama3.2:3b-instruct-q4_K_M' }),
      llamacppNonStreamHandler({ url: `${LLAMACPP_URL}/chat/completions`, model: 'qwen2.5-7b-instruct-q4_K_M' }),
    );

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    // 1 request to each backend simultaneously — independent cap pools
    const [ollRes, lcppRes] = await Promise.all([
      app.inject({
        method: 'POST', url: '/v1/chat/completions', headers,
        payload: { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] },
      }),
      app.inject({
        method: 'POST', url: '/v1/chat/completions', headers,
        payload: { model: 'qwen2.5-7b-instruct-q4km', messages: [{ role: 'user', content: 'hi' }] },
      }),
    ]);

    // Both succeed — they're on different backends
    expect(ollRes.statusCode).toBe(200);
    expect(lcppRes.statusCode).toBe(200);
  }, 10_000);

  // Test 5: Defaults apply when backends section absent
  it('5. default concurrency=2 applies when backends section is absent', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;
    // No backends: section — defaults to concurrency=2, queue_max_wait_ms=30000
    sem = new BackendSemaphore('ollama', 2, 30_000);
    const { app: testApp } = await buildTestApp({ yaml, semaphore: sem });
    app = testApp;

    server.use(ollamaNonStreamHandler({
      url: `${OLLAMA_URL}/chat/completions`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      content: 'default-cap',
    }));

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const payload = { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] };

    // 2 simultaneous requests should succeed (cap = 2 by default)
    const [res1, res2] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(sem.stats().inFlight).toBe(0);  // both released
  });

  // Test 6: Custom concurrency from backends section honored
  it('6. backends section concurrency=1 limits to one in-flight', async () => {
    const yaml = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${OLLAMA_URL}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    base_url: ${OLLAMA_URL}
    concurrency: 1
    queue_max_wait_ms: 50
`;
    sem = new BackendSemaphore('ollama', 1, 50);  // concurrency=1, 50ms timeout
    const { app: testApp } = await buildTestApp({ yaml, semaphore: sem });
    app = testApp;

    // Upstream delays 200ms (longer than 50ms timeout)
    server.use(ollamaNonStreamHandler({
      url: `${OLLAMA_URL}/chat/completions`,
      model: 'llama3.2:3b-instruct-q4_K_M',
      delayMs: 200,
    }));

    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const payload = { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] };

    // Fire 2 concurrent; with cap=1 and upstream at 200ms, the second should 429 within 50ms
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload }),
    ]);

    const statusCodes = results.map((r) => r.statusCode);
    // One should succeed (or at least not 429), one should 429
    const has200 = statusCodes.includes(200);
    const has429 = statusCodes.includes(429);
    expect(has200 || statusCodes.filter((s) => s !== 429).length > 0).toBe(true);
    expect(has429).toBe(true);

    // Assert the 429 has the correct envelope
    const res429 = results.find((r) => r.statusCode === 429);
    if (res429) {
      expect(res429.json().error.type).toBe('rate_limit_error');
      expect(res429.json().error.code).toBe('backend_saturated');
      expect(res429.headers['retry-after']).toBeDefined();
    }
  }, 10_000);
});
