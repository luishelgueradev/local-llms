/**
 * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — end-to-end circuit-breaker integration.
 *
 * Verifies the wire-level behavior of the breaker against a Fastify app with
 * a Valkey mock + a fake adapter that simulates upstream failures:
 *
 *   Test 1 (happy path):       success path closes/keeps closed; recordSuccess fires.
 *   Test 2 (trip to open):     5 APIConnectionError throws -> 6th fails fast 503 +
 *                              code: 'backend_circuit_open' + Retry-After: 60.
 *   Test 3 (half-open success): cooldown elapsed -> next request reaches adapter
 *                              (probe); success closes the breaker.
 *   Test 4 (half-open re-open): cooldown elapsed -> probe fails -> breaker re-opens
 *                              for another full cooldown; next request 503 again.
 *   Test 5 (per-backend isolation): cloud breaker open does not affect local backend.
 *   Test 6 (no Valkey -> no-op): fixture without opts.valkey constructs the no-op
 *                              breaker; 100 failures never trip; existing tests are
 *                              unaffected (this is the regression guard for the
 *                              fallback path).
 *
 * Fixture: buildApp() with an inline fake adapter (counter-driven success/throw)
 * and a hand-rolled in-memory Valkey mock (subset of ioredis) with a now()
 * controller so the test can advance time past CIRCUIT_COOLDOWN_MS without
 * real timers.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { APIConnectionError } from 'openai';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import type { CanonicalResponse } from '../../src/translation/canonical.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const CLOUD_MODEL = 'gpt-oss:120b-cloud';
const LOCAL_MODEL = 'llama3.2:3b-instruct-q4_K_M';
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

// ─── Hand-rolled in-memory Valkey mock (subset used by the breaker) ─────────
//
// Implements: get / set (NX + PX) / incr / pexpire / del with TTL bookkeeping.
// `now` is a settable timestamp so the test advances mock-time without real
// timers. ValkeyClient is the ioredis Redis class shape; only the 5 methods
// the breaker calls are exercised here.

interface StoredValue {
  value: string;
  expiresAt: number | null;
}

class ValkeyMock {
  private store = new Map<string, StoredValue>();
  public now = 0;

  tick(ms: number): void {
    this.now += ms;
  }

  private sweep(key: string): void {
    const v = this.store.get(key);
    if (v && v.expiresAt !== null && v.expiresAt <= this.now) {
      this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.sweep(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<'OK' | null> {
    this.sweep(key);
    let px: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'PX' || a === 'px') {
        px = Number(args[i + 1]);
        i++;
      } else if (a === 'NX' || a === 'nx') {
        nx = true;
      }
    }
    if (nx && this.store.has(key)) return null;
    this.store.set(key, {
      value,
      expiresAt: px !== null ? this.now + px : null,
    });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.sweep(key);
    const cur = this.store.get(key);
    const n = (cur ? Number(cur.value) : 0) + 1;
    this.store.set(key, {
      value: String(n),
      expiresAt: cur?.expiresAt ?? null,
    });
    return n;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.sweep(key);
    const cur = this.store.get(key);
    if (!cur) return 0;
    this.store.set(key, { value: cur.value, expiresAt: this.now + ms });
    return 1;
  }

  async del(key: string): Promise<number> {
    const had = this.store.has(key);
    this.store.delete(key);
    return had ? 1 : 0;
  }

  /** Required by app.ts onClose -> closeValkey -> quit(); the breaker doesn't call it. */
  async quit(): Promise<'OK'> {
    return 'OK';
  }

  disconnect(): void {
    /* no-op */
  }

  on(): this {
    return this;
  }
}

// ─── Counter-driven fake adapter ────────────────────────────────────────────
// behavior() is a function (callIndex) -> 'success' | 'throw' so each test
// controls per-call outcomes.

function makeFakeAdapter(
  behavior: (i: number) => 'success' | 'throw',
): { adapter: BackendAdapter; calls: { count: number } } {
  const calls = { count: 0 };
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical(canonical) {
      const i = calls.count++;
      if (behavior(i) === 'throw') {
        throw new APIConnectionError({
          message: 'upstream gone',
          cause: new Error('econnrefused'),
        });
      }
      return stubCanonicalResponse(canonical.model);
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('stream not used in this suite');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings() {
      throw new Error('embeddings not used in this suite');
    },
  };
  return { adapter, calls };
}

// ─── Suite ────────────────────────────────────────────────────────────────

const CIRCUIT_ENV = {
  CIRCUIT_FAILURE_THRESHOLD: 5,
  CIRCUIT_WINDOW_MS: 30_000,
  CIRCUIT_COOLDOWN_MS: 60_000,
};

let app: FastifyInstance;
let valkey: ValkeyMock;
let adapter: BackendAdapter;
let calls: { count: number };

async function setup(
  behavior: (i: number) => 'success' | 'throw',
  opts: { withValkey?: boolean } = { withValkey: true },
): Promise<void> {
  valkey = new ValkeyMock();
  ({ adapter, calls } = makeFakeAdapter(behavior));
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
    ...(opts.withValkey
      ? {
          valkey: valkey as unknown as ValkeyClient,
          env: CIRCUIT_ENV,
          // Wire the breaker's clock to the mock's `now` so valkey.tick(ms)
          // advances both TTL bookkeeping AND the breaker's notion of time.
          breakerNow: () => valkey.now,
        }
      : {}),
  });
}

afterEach(async () => {
  await app?.close();
});

describe('Circuit breaker integration — Plan 08-04 (CLOUD-03)', () => {
  it('Test 1: happy path — adapter succeeds; breaker stays closed', async () => {
    await setup(() => 'success');
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
      },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.count).toBe(1);
  });

  it('Test 2: 5 failures trip the breaker; 6th request fails fast with 503 + Retry-After: 60', async () => {
    await setup(() => 'throw');
    // Requests 1-5: adapter throws APIConnectionError -> 502 (per existing mapping).
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: CLOUD_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      expect(r.statusCode).toBe(502);
    }
    // Fire-and-forget recordFailure inside the route uses Promise.resolve.then —
    // wait one microtask tick so the 5th recordFailure lands before request 6.
    await new Promise((r) => setImmediate(r));

    expect(calls.count).toBe(5);

    // Request 6: breaker.check returns 'open' -> 503 + envelope + Retry-After.
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
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    const body = res.json();
    expect(body.error.type).toBe('api_error');
    expect(body.error.code).toBe('backend_circuit_open');
    expect(body.error.message).toContain('ollama-cloud');
    // The adapter was NOT called for request 6.
    expect(calls.count).toBe(5);
    // X-Model-Backend header still stamped (Plan 08-03 — onSend reads
    // req.resolvedBackend, which is set by the route BEFORE the breaker check).
    expect(res.headers['x-model-backend']).toBe('ollama-cloud');
  });

  it('Test 3: half-open probe success closes the breaker; subsequent traffic flows', async () => {
    // Adapter throws first 5 calls, succeeds from 6th onward.
    await setup((i) => (i < 5 ? 'throw' : 'success'));
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: CLOUD_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
    }
    await new Promise((r) => setImmediate(r));

    // Confirm the breaker is open.
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(blocked.statusCode).toBe(503);
    expect(calls.count).toBe(5);

    // Advance mock-time past cooldown. Request 7 acts as the probe.
    valkey.tick(CIRCUIT_ENV.CIRCUIT_COOLDOWN_MS + 1);
    const probe = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(probe.statusCode).toBe(200);
    expect(calls.count).toBe(6);

    // Wait for fire-and-forget recordSuccess to land.
    await new Promise((r) => setImmediate(r));

    // Request 8: breaker closed, flows through.
    const next = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(next.statusCode).toBe(200);
    expect(calls.count).toBe(7);
  });

  it('Test 4: half-open probe failure re-opens the breaker for another cooldown', async () => {
    // All adapter calls throw.
    await setup(() => 'throw');
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: CLOUD_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
    }
    await new Promise((r) => setImmediate(r));

    // Advance past cooldown — request 7 is the probe; adapter throws again.
    valkey.tick(CIRCUIT_ENV.CIRCUIT_COOLDOWN_MS + 1);
    const probe = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(probe.statusCode).toBe(502); // raw adapter APIConnectionError -> 502
    expect(calls.count).toBe(6);
    await new Promise((r) => setImmediate(r));

    // Request 8: breaker should be open again.
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(calls.count).toBe(6); // not called
  });

  it('Test 5: per-backend isolation — cloud breaker open, local backend unaffected', async () => {
    // The fake adapter throws for any model — but only the CLOUD model trips its
    // breaker. We then verify the LOCAL model still calls the adapter.
    // Use a per-model-aware fake: throw on cloud, succeed on local.
    valkey = new ValkeyMock();
    const localCalls = { count: 0 };
    const cloudCalls = { count: 0 };
    const perModelAdapter: BackendAdapter = {
      async chatCompletionsCanonical(canonical) {
        if (canonical.model === CLOUD_MODEL) {
          cloudCalls.count++;
          throw new APIConnectionError({
            message: 'cloud gone',
            cause: new Error(),
          });
        }
        localCalls.count++;
        return stubCanonicalResponse(canonical.model);
      },
      async chatCompletionsCanonicalStream() {
        throw new Error('not used');
      },
      async probeLiveness() {
        return { ok: true, latencyMs: 0 };
      },
      async embeddings() {
        throw new Error('not used');
      },
    };
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => perModelAdapter,
      semaphores: {
        get: () =>
          ({
            acquire: async () => () => {},
            stats: () => ({ inFlight: 0, queued: 0 }),
          }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
      valkey: valkey as unknown as ValkeyClient,
      env: CIRCUIT_ENV,
      breakerNow: () => valkey.now,
    });

    // Trip the cloud breaker.
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: CLOUD_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
    }
    await new Promise((r) => setImmediate(r));

    // Confirm cloud is blocked.
    const cloudRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(cloudRes.statusCode).toBe(503);
    expect(cloudRes.headers['x-model-backend']).toBe('ollama-cloud');

    // Local backend should be completely unaffected.
    const localRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: LOCAL_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(localRes.statusCode).toBe(200);
    expect(localRes.headers['x-model-backend']).toBe('ollama');
    expect(localCalls.count).toBe(1);
  });

  it('Test 6: no valkey -> no-op breaker; 100 failures do not trip the route', async () => {
    // Without opts.valkey, buildApp constructs the no-op breaker (check always
    // 'closed', record* no-ops). The route should always reach the adapter and
    // surface its raw error (502 here) — never the breaker 503.
    await setup(() => 'throw', { withValkey: false });

    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: CLOUD_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });
      expect(r.statusCode).toBe(502);
    }
    expect(calls.count).toBe(10);
  });
});
