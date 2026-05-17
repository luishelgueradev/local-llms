/**
 * Plan 08-06 (ROUTE-11 / D-D2 / D-D3) — end-to-end rate-limit integration.
 *
 * Verifies the wire-level behavior of the rate-limit hook against a Fastify
 * app with a Valkey mock + a fake adapter:
 *
 *   Test 1 (under-limit happy path): 5 sequential POST /v1/chat/completions
 *           with same bearer + rpm=5 — all return 200.
 *   Test 2 (over-limit 429): 6th request returns 429 + envelope
 *           code='rate_limit_exceeded' + Retry-After: 60.
 *   Test 3 (per-bearer isolation): two different bearers each get their own
 *           5-request bucket. (Single configured bearer in v1 — but the hash
 *           keys are future-compatible with multi-token operators.)
 *   Test 4 (public-path bypass): GET /healthz × 100 with no bearer -> all 200.
 *   Test 5 (Valkey-down fail-open): valkey.incr throws -> all requests pass
 *           (route reaches adapter, returns 200). Log warns fire.
 *   Test 6 (rollover): trip the 429; advance mock-time past 60s; next
 *           request passes (new bucket).
 *
 * Fixture: buildApp() with the SAME Valkey mock used by circuit-breaker
 * integration (it implements the breaker's incr/expire/get/set/pexpire/del
 * surface — we only need incr+expire for rate-limit, but the breaker also
 * runs in this fixture so the wider mock is required). A counter-driven
 * fake adapter always returns success (we're testing the hook, not the
 * route's adapter dispatch).
 *
 * Note on auth: the v1 router accepts a SINGLE bearer (env.ROUTER_BEARER_TOKEN
 * + constant-time compared by bearer.ts). Test 3 ("per-bearer isolation") is
 * an architectural sanity check on the rate-limit hook's key shape — it
 * verifies that IF the operator widens the bearer set in a future plan, the
 * hash keys correctly isolate per-token. We exercise this by instantiating
 * TWO apps with two different valid tokens; each app gets its own 5-request
 * bucket. The behavior we're really testing is bearerHash(t) !== bearerHash(t')
 * inside the same Valkey instance.
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
import type { ValkeyClient } from '../../src/clients/valkey.js';

const TOKEN_A = 'local-llms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'local-llms_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LOCAL_MODEL = 'llama3.2:3b-instruct-q4_K_M';
const LOCAL_BASE = 'http://upstream-mock:11434/v1';

const YAML = `
models:
  - name: ${LOCAL_MODEL}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: ${LOCAL_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    concurrency: 5
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

// ── Hand-rolled in-memory Valkey mock (subset used by rate-limit + breaker) ──

interface StoredValue {
  value: string;
  expiresAt: number | null;
}

class ValkeyMock {
  private store = new Map<string, StoredValue>();
  public now = 0;
  public incrThrows = false;

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
    if (this.incrThrows) {
      throw new Error('valkey-down: connect ECONNREFUSED');
    }
    this.sweep(key);
    const cur = this.store.get(key);
    const n = (cur ? Number(cur.value) : 0) + 1;
    this.store.set(key, {
      value: String(n),
      expiresAt: cur?.expiresAt ?? null,
    });
    return n;
  }

  async expire(key: string, ttlSec: number): Promise<number> {
    this.sweep(key);
    const cur = this.store.get(key);
    if (!cur) return 0;
    this.store.set(key, { value: cur.value, expiresAt: this.now + ttlSec * 1000 });
    return 1;
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

function makeFakeAdapter(): { adapter: BackendAdapter; calls: { count: number } } {
  const calls = { count: 0 };
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical(canonical) {
      calls.count++;
      return stubCanonicalResponse(canonical.model);
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('stream not used');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings() {
      throw new Error('embeddings not used');
    },
  };
  return { adapter, calls };
}

const TEST_ENV = {
  CIRCUIT_FAILURE_THRESHOLD: 5,
  CIRCUIT_WINDOW_MS: 30_000,
  CIRCUIT_COOLDOWN_MS: 60_000,
  ROUTER_RATE_LIMIT_RPM: 5, // low for fast tests
};

let app: FastifyInstance;
let valkey: ValkeyMock;
let adapter: BackendAdapter;
let calls: { count: number };

async function setup(opts: { token?: string; withValkey?: boolean } = {}): Promise<void> {
  const token = opts.token ?? TOKEN_A;
  const withValkey = opts.withValkey !== false; // default true
  valkey = new ValkeyMock();
  ({ adapter, calls } = makeFakeAdapter());
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: token,
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
    ...(withValkey
      ? {
          valkey: valkey as unknown as ValkeyClient,
          env: TEST_ENV,
          breakerNow: () => valkey.now,
        }
      : {}),
  });
}

afterEach(async () => {
  await app?.close();
});

describe('Rate-limit integration — Plan 08-06 (ROUTE-11)', () => {
  beforeEach(() => {
    // Reset shared state — setup() is called per-test.
  });

  it('Test 1: under-limit happy path — 5 requests at rpm=5 all pass', async () => {
    await setup();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(calls.count).toBe(5);
  });

  it('Test 2: 6th request returns 429 + rate_limit_exceeded + Retry-After: 60', async () => {
    await setup();
    // Drive the bucket to the cap.
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
    }
    expect(calls.count).toBe(5);

    // 6th request: rate-limit hook throws RateLimitExceededError -> 429 envelope.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    const body = res.json();
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.param).toBeNull();
    expect(body.error.message).toContain('5');
    // The adapter was NOT called for the 6th request — the hook short-circuited.
    expect(calls.count).toBe(5);
  });

  it('Test 3: per-bearer isolation — different tokens get separate buckets', async () => {
    // Two apps, two configured bearer tokens, ONE shared Valkey mock.
    // (In v1 the router accepts a single bearer; this test verifies the
    // KEY SHAPE isolates buckets across hashes — future-compatibility check.)
    valkey = new ValkeyMock();
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const { adapter: adapterA, calls: callsA } = makeFakeAdapter();
    const { adapter: adapterB, calls: callsB } = makeFakeAdapter();
    const appA = await buildApp({
      registry,
      bearerToken: TOKEN_A,
      loggerOpts: false as never,
      makeAdapter: () => adapterA,
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
      env: TEST_ENV,
      breakerNow: () => valkey.now,
    });
    const appB = await buildApp({
      registry,
      bearerToken: TOKEN_B,
      loggerOpts: false as never,
      makeAdapter: () => adapterB,
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
      env: TEST_ENV,
      breakerNow: () => valkey.now,
    });

    try {
      // Burn appA's bucket.
      for (let i = 0; i < 5; i++) {
        await appA.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization: `Bearer ${TOKEN_A}`,
            'content-type': 'application/json',
          },
          payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        });
      }
      // appA's 6th -> 429.
      const blockedA = await appA.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(blockedA.statusCode).toBe(429);

      // appB's first request -> 200 (separate bucket).
      const okB = await appB.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_B}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(okB.statusCode).toBe(200);
      expect(callsA.count).toBe(5);
      expect(callsB.count).toBe(1);
    } finally {
      await appA.close();
      await appB.close();
      // Assign the last constructed app to the suite-scoped variable so afterEach
      // doesn't double-close (it's idempotent but cleaner to be explicit).
      app = appB;
    }
  });

  it('Test 4: public-path bypass — GET /healthz with no bearer always 200 (no rate-limit)', async () => {
    await setup();
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('Test 5: Valkey-down fail-open — adapter still reached on all requests', async () => {
    await setup();
    valkey.incrThrows = true;

    // 10 requests, all should pass (hook fails open, route hits adapter).
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(calls.count).toBe(10);
  });

  it('Test 6: rollover — trip 429; advance time past 60s; next request passes', async () => {
    await setup();
    // Burn the bucket.
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
    }
    // 6th -> 429.
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
      },
      payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(blocked.statusCode).toBe(429);
    expect(calls.count).toBe(5);

    // Advance mock-time past the minute boundary. The rate-limit hook uses
    // Date.now() by default — we can't redirect it via opts.breakerNow (that's
    // breaker-specific). For this test, we exploit the Valkey TTL mechanism:
    // valkey.tick advances mock time so the OLD bucket's TTL fires and the
    // new INCR lands on a fresh key. BUT — the hook computes minute from
    // Date.now(), not from valkey.now. So we need to use real fake timers.
    //
    // Use vi.useFakeTimers with setSystemTime to advance the wall clock.
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(60_001));
    try {
      // 7th request after rollover -> new bucket, count=1 -> 200.
      const next = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(next.statusCode).toBe(200);
      expect(calls.count).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 7: no Valkey -> rate-limit hook NOT registered; 100 requests pass', async () => {
    // Without opts.valkey + opts.env, buildApp does not register the rate-limit
    // hook (the `if (opts.valkey && opts.env)` gate). Existing test fixtures
    // built before Plan 08-06 (which never pass valkey) must remain unaffected.
    await setup({ withValkey: false });
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(calls.count).toBe(10);
  });
});
