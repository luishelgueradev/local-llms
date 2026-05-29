/**
 * Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency-Key multiplexer end-to-end.
 *
 * Verifies the wire-level behavior of the Idempotency-Key header across the
 * three routes that accept it (/v1/chat/completions, /v1/messages,
 * /v1/embeddings). Task 2 wires the NON-STREAM branches; Task 3 adds the
 * stream-branch tests in this same file.
 *
 * Task 2 coverage (5 tests, all non-stream):
 *   Test 1 (chat 5x): adapter called 1x; all 5 responses byte-identical.
 *   Test 2 (messages 3x): adapter called 1x; all 3 responses byte-identical.
 *   Test 3 (embeddings 2x): adapter called 1x; both responses byte-identical.
 *   Test 4 (invalid key): 400 + envelope code='invalid_idempotency_key'.
 *   Test 5 (no key header): 2 concurrent → 2 adapter calls (no mux engagement).
 *
 * Fixture: buildApp() with the SAME hand-rolled Valkey mock used by rate-limit
 * + circuit-breaker integration, widened to support rpush/lrange/publish/
 * subscribe via a shared EventEmitter bus. A counter-driven fake adapter
 * always returns success — we're testing the multiplexer wiring, not adapter
 * dispatch. duplicate() returns a fresh mock that shares the store + bus
 * (ioredis pub/sub semantics — subscriber connections must be distinct).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import type { CanonicalResponse, CanonicalStreamEvent } from '../../src/translation/canonical.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';
import type { CreateEmbeddingResponse } from 'openai/resources/embeddings';

const TOKEN = 'local-llms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LOCAL_MODEL = 'llama3.2:3b-instruct-q4_K_M';
const EMBED_MODEL = 'bge-m3';
const LOCAL_BASE = 'http://upstream-mock:11434/v1';

const YAML = `
models:
  - name: ${LOCAL_MODEL}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: ${LOCAL_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${EMBED_MODEL}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: ${EMBED_MODEL}
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 1
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

function stubEmbeddingResponse(): CreateEmbeddingResponse {
  // Phase 12 (v0.10.0 — EMB-H02): YAML fixture now declares dims: 1024 for the
  // embeddings entry, enforced at response time. Return a 1024-dim vector so the
  // route doesn't 500-out on dims mismatch.
  return {
    object: 'list',
    data: [{ object: 'embedding', embedding: new Array(1024).fill(0.1), index: 0 }],
    model: EMBED_MODEL,
    usage: { prompt_tokens: 3, total_tokens: 3 },
  };
}

// ── Hand-rolled Valkey mock (subset for breaker + rate-limit + idempotency) ──
//
// Supports: get/set/setnx/incr/expire/pexpire/del/rpush/lrange/publish/subscribe.
// duplicate() returns a fresh mock that SHARES the store + lists + bus (so
// publish from one connection reaches subscribers on another, matching ioredis).

class PubSubBus extends EventEmitter {
  publish(channel: string, message: string): number {
    this.emit(channel, message);
    return this.listenerCount(channel);
  }
}

interface StoredValue {
  value: string;
  expiresAt: number | null;
}

class ValkeyMock {
  store: Map<string, StoredValue>;
  lists: Map<string, string[]>;
  bus: PubSubBus;
  subscribedChannels: Set<string> = new Set();
  messageListeners: ((channel: string, message: string) => void)[] = [];
  busListeners: { channel: string; handler: (msg: string) => void }[] = [];
  public now = 0;
  public incrThrows = false;

  constructor(shared?: { store?: Map<string, StoredValue>; lists?: Map<string, string[]>; bus?: PubSubBus }) {
    this.store = shared?.store ?? new Map();
    this.lists = shared?.lists ?? new Map();
    this.bus = shared?.bus ?? new PubSubBus();
  }

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

  async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> {
    this.sweep(key);
    let ex: number | null = null;
    let px: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'EX' || a === 'ex') {
        ex = Number(args[i + 1]);
        i++;
      } else if (a === 'PX' || a === 'px') {
        px = Number(args[i + 1]);
        i++;
      } else if (a === 'NX' || a === 'nx') {
        nx = true;
      }
    }
    if (nx && this.store.has(key)) return null;
    const expiresAt = px !== null ? this.now + px : ex !== null ? this.now + ex * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async setnx(key: string, value: string): Promise<number> {
    this.sweep(key);
    if (this.store.has(key)) return 0;
    this.store.set(key, { value, expiresAt: null });
    return 1;
  }

  async incr(key: string): Promise<number> {
    if (this.incrThrows) throw new Error('valkey-down');
    this.sweep(key);
    const cur = this.store.get(key);
    const n = (cur ? Number(cur.value) : 0) + 1;
    this.store.set(key, { value: String(n), expiresAt: cur?.expiresAt ?? null });
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
    const had = this.store.has(key) || this.lists.has(key);
    this.store.delete(key);
    this.lists.delete(key);
    return had ? 1 : 0;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const cur = this.lists.get(key) ?? [];
    cur.push(...values);
    this.lists.set(key, cur);
    return cur.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const cur = this.lists.get(key) ?? [];
    const len = cur.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? len + stop : Math.min(len - 1, stop);
    if (s > e) return [];
    return cur.slice(s, e + 1);
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.bus.publish(channel, message);
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel);
    const handler = (msg: string): void => {
      for (const l of this.messageListeners) l(channel, msg);
    };
    this.busListeners.push({ channel, handler });
    this.bus.on(channel, handler);
    return 1;
  }

  async unsubscribe(channel?: string): Promise<number> {
    if (channel) {
      this.subscribedChannels.delete(channel);
      this.busListeners = this.busListeners.filter((entry) => {
        if (entry.channel === channel) {
          this.bus.off(entry.channel, entry.handler);
          return false;
        }
        return true;
      });
    } else {
      for (const { channel: ch, handler } of this.busListeners) this.bus.off(ch, handler);
      this.busListeners = [];
      this.subscribedChannels.clear();
    }
    return 0;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'message') {
      this.messageListeners.push(listener as (channel: string, message: string) => void);
    }
    return this;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  disconnect(): void {
    /* no-op */
  }

  duplicate(): ValkeyMock {
    return new ValkeyMock({ store: this.store, lists: this.lists, bus: this.bus });
  }
}

/** Test-controlled canonical stream events for the stream-branch tests. */
function makeStreamEvents(model: string): CanonicalStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
}

function makeFakeAdapter(): {
  adapter: BackendAdapter;
  calls: { chat: number; embeddings: number; stream: number };
  resolveNext: (() => void)[];
  pauseAdapter: boolean;
  streamHook: { pauseBetweenEvents: boolean; releaseEvent: (() => void)[] };
} {
  const calls = { chat: 0, embeddings: 0, stream: 0 };
  const resolveNext: (() => void)[] = [];
  const state = { pauseAdapter: false };
  const streamHook = {
    pauseBetweenEvents: false,
    releaseEvent: [] as (() => void)[],
  };
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical(canonical) {
      calls.chat++;
      if (state.pauseAdapter) {
        await new Promise<void>((resolve) => resolveNext.push(resolve));
      }
      return stubCanonicalResponse(canonical.model);
    },
    async chatCompletionsCanonicalStream(canonical) {
      calls.stream++;
      if (state.pauseAdapter) {
        await new Promise<void>((resolve) => resolveNext.push(resolve));
      }
      const events = makeStreamEvents(canonical.model);
      async function* iter(): AsyncGenerator<CanonicalStreamEvent> {
        for (const ev of events) {
          // Read flag live so the test can flip pauseBetweenEvents=false
          // mid-stream and have subsequent events flow without pause.
          if (streamHook.pauseBetweenEvents) {
            await new Promise<void>((resolve) =>
              streamHook.releaseEvent.push(resolve),
            );
          }
          yield ev;
        }
      }
      return iter();
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings() {
      calls.embeddings++;
      if (state.pauseAdapter) {
        await new Promise<void>((resolve) => resolveNext.push(resolve));
      }
      return stubEmbeddingResponse();
    },
    async rerank(_query: string, _documents: string[], model: string) {
      return { model, results: [], usage: { total_tokens: 0 } };
    },
  };
  return {
    adapter,
    calls,
    resolveNext,
    streamHook,
    get pauseAdapter() {
      return state.pauseAdapter;
    },
    set pauseAdapter(v: boolean) {
      state.pauseAdapter = v;
    },
  } as unknown as {
    adapter: BackendAdapter;
    calls: { chat: number; embeddings: number; stream: number };
    resolveNext: (() => void)[];
    pauseAdapter: boolean;
    streamHook: { pauseBetweenEvents: boolean; releaseEvent: (() => void)[] };
  };
}

const TEST_ENV = {
  CIRCUIT_FAILURE_THRESHOLD: 100, // keep breaker quiet
  CIRCUIT_WINDOW_MS: 30_000,
  CIRCUIT_COOLDOWN_MS: 60_000,
  ROUTER_RATE_LIMIT_RPM: 10_000, // keep rate-limit quiet
  ROUTER_EMBED_CACHE_TTL_SEC: 60,
};

let app: FastifyInstance;
let valkey: ValkeyMock;
let fixture: ReturnType<typeof makeFakeAdapter>;

async function setup(): Promise<void> {
  valkey = new ValkeyMock();
  fixture = makeFakeAdapter();
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => fixture.adapter,
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
    rateLimitNow: () => valkey.now,
  });
}

afterEach(async () => {
  await app?.close();
});

describe('Idempotency-Key multiplexer integration — Plan 08-07 (ROUTE-12)', () => {
  beforeEach(() => {
    /* setup() invoked per-test */
  });

  it('Test 1 (chat non-stream 5x same key): adapter called once; 5 identical responses', async () => {
    await setup();
    fixture.pauseAdapter = true;

    // Fire 5 concurrent requests with the same Idempotency-Key. Only the
    // first will reach the (paused) adapter; the other 4 become followers
    // and subscribe to the channel.
    const promises = Array.from({ length: 5 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': '01HABCDEF0123456789ABCDEFG',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      }),
    );

    // Give the followers a chance to acquire + subscribe + start awaiting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Release the leader's adapter call (the only one that landed).
    fixture.pauseAdapter = false;
    while (fixture.resolveNext.length > 0) fixture.resolveNext.shift()!();

    const responses = await Promise.all(promises);

    // Adapter called exactly once.
    expect(fixture.calls.chat).toBe(1);
    // All 5 responses 200 + same body.
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('Test 2 (messages non-stream 3x same key): adapter called once; 3 identical responses', async () => {
    await setup();
    fixture.pauseAdapter = true;

    const promises = Array.from({ length: 3 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': '01HABCDEF0123456789ABCDEFH',
        },
        payload: {
          model: LOCAL_MODEL,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
        },
      }),
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    fixture.pauseAdapter = false;
    while (fixture.resolveNext.length > 0) fixture.resolveNext.shift()!();

    const responses = await Promise.all(promises);
    expect(fixture.calls.chat).toBe(1);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('Test 3 (embeddings 2x same key): adapter called once; both identical', async () => {
    await setup();
    fixture.pauseAdapter = true;

    const promises = Array.from({ length: 2 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': '01HABCDEF0123456789ABCDEFI',
        },
        payload: { model: EMBED_MODEL, input: 'hello world' },
      }),
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    fixture.pauseAdapter = false;
    while (fixture.resolveNext.length > 0) fixture.resolveNext.shift()!();

    const responses = await Promise.all(promises);
    expect(fixture.calls.embeddings).toBe(1);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('Test 4 (invalid Idempotency-Key): 400 + envelope code=invalid_idempotency_key', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'has spaces and slashes / not ok',
      },
      payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_idempotency_key');
    expect(body.error.param).toBe('Idempotency-Key');
    // Adapter must NOT have been called — extraction throws before the route's
    // try block.
    expect(fixture.calls.chat).toBe(0);
  });

  it('Test 5 (no Idempotency-Key): 2 concurrent → 2 adapter calls (no mux)', async () => {
    await setup();
    fixture.pauseAdapter = false; // adapter runs fast

    const promises = Array.from({ length: 2 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      }),
    );

    const responses = await Promise.all(promises);
    expect(fixture.calls.chat).toBe(2);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });

  it('Test 6 (chat stream 3x same key): adapter called once; 3 identical SSE sequences', async () => {
    await setup();
    // Pause between events so the leader's stream stays in-flight while
    // followers subscribe to the channel.
    fixture.streamHook.pauseBetweenEvents = true;

    const promises = Array.from({ length: 3 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': '01HABCDEF0123456789ABCDEFS',
        },
        payload: {
          model: LOCAL_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      }),
    );

    // Give followers a chance to subscribe.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Release all paused events.
    fixture.streamHook.pauseBetweenEvents = false;
    while (fixture.streamHook.releaseEvent.length > 0) {
      fixture.streamHook.releaseEvent.shift()!();
    }

    const responses = await Promise.all(promises);
    // Adapter stream invoked exactly once.
    expect(fixture.calls.stream).toBe(1);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // All 3 SSE bodies byte-identical.
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
    // The SSE body contains the expected text token.
    expect(bodies[0]).toContain('hello');
    expect(bodies[0]).toContain('[DONE]');
  });

  it('Test 7 (messages stream 3x same key): adapter called once; 3 identical SSE sequences', async () => {
    await setup();
    fixture.streamHook.pauseBetweenEvents = true;

    const promises = Array.from({ length: 3 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'idempotency-key': '01HABCDEF0123456789ABCDEFT',
        },
        payload: {
          model: LOCAL_MODEL,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      }),
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    fixture.streamHook.pauseBetweenEvents = false;
    while (fixture.streamHook.releaseEvent.length > 0) {
      fixture.streamHook.releaseEvent.shift()!();
    }

    const responses = await Promise.all(promises);
    expect(fixture.calls.stream).toBe(1);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
    // Anthropic SSE body has typed events.
    expect(bodies[0]).toContain('message_start');
    expect(bodies[0]).toContain('message_stop');
  });

  it('Test 8 (sequential stream): second request replays cached chunks after leader finishes', async () => {
    await setup();
    // Adapter runs immediately; leader finalizes before follower joins.
    fixture.streamHook.pauseBetweenEvents = false;

    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': '01HABCDEF0123456789ABCDEFU',
      },
      payload: {
        model: LOCAL_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    expect(r1.statusCode).toBe(200);
    expect(fixture.calls.stream).toBe(1);

    // Second request — leader already finalized; follower reads chunks list
    // + result key and replays without invoking the adapter.
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': '01HABCDEF0123456789ABCDEFU',
      },
      payload: {
        model: LOCAL_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    expect(r2.statusCode).toBe(200);
    expect(fixture.calls.stream).toBe(1); // still ONE
    // SSE bodies byte-identical.
    expect(r2.body).toBe(r1.body);
  });

  it('Test 5b (sequential same-key): second request becomes follower after leader finishes', async () => {
    await setup();
    fixture.pauseAdapter = false; // adapter runs fast

    // First request (leader) — completes immediately.
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': '01HABCDEF0123456789ABCDEFJ',
      },
      payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r1.statusCode).toBe(200);
    expect(fixture.calls.chat).toBe(1);

    // Second request (follower) — same key, leader's result is cached.
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': '01HABCDEF0123456789ABCDEFJ',
      },
      payload: { model: LOCAL_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r2.statusCode).toBe(200);
    // Adapter NOT called again — follower replayed the cached body.
    expect(fixture.calls.chat).toBe(1);
    // Bodies identical.
    expect(r2.body).toBe(r1.body);
  });
});
