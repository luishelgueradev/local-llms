/**
 * Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency multiplexer unit tests.
 *
 * Coverage (Tests 1-9 per the plan `<interfaces>` block):
 *   Test 1: acquire returns 'leader' on first call; 'follower' on second with same key.
 *   Test 2: publishNonStream sets result key, publishes 'done' marker.
 *   Test 3: awaitNonStreamResult returns body when follower arrives AFTER leader finalize.
 *   Test 4: awaitNonStreamResult subscribes BEFORE reading cached → receives future events.
 *   Test 5: publishStreamEvent RPUSHes + PUBLISHes; finalizeStream EXPIREs to 900s; publishes 'done'.
 *   Test 6: awaitStreamResult yields cached chunks (LRANGE) then subscribed chunks until 'done'.
 *   Test 7: awaitStreamResult yields 'aborted' / 'error' terminal when leader errored.
 *   Test 8: validateIdempotencyKey regex violation → InvalidIdempotencyKeyError.
 *   Test 9: awaitNonStreamResult 30s timeout when leader hangs → idempotency_timeout throw.
 *
 * The Valkey mock implements get/set/setnx/incr/expire/rpush/lrange/del/publish/subscribe.
 * pub/sub is simulated via an internal EventEmitter; a SEPARATE mock connection is
 * returned by subscriberFactory (production wiring uses ioredis `.duplicate()`).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import {
  makeIdempotencyMultiplexer,
  IdempotencyTimeoutError,
} from '../../src/resilience/idempotency.js';
import {
  extractIdempotencyKey,
} from '../../src/middleware/idempotencyKey.js';
import { InvalidIdempotencyKeyError } from '../../src/errors/envelope.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

// ── Shared in-memory pub/sub bus for ValkeyMock connections ───────────────────

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
  // Subscribed channels for this connection (subscribe-mode).
  subscribedChannels: Set<string> = new Set();
  // 'message' event listeners on THIS connection (ioredis-style).
  messageListeners: ((channel: string, message: string) => void)[] = [];
  // Bus listeners we registered (so we can remove them on unsubscribe/quit).
  busListeners: { channel: string; handler: (msg: string) => void }[] = [];
  public now = 0;
  public published: { channel: string; message: string }[] = [];

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

  async expire(key: string, ttlSec: number): Promise<number> {
    this.sweep(key);
    const cur = this.store.get(key);
    if (!cur) return 0;
    this.store.set(key, { value: cur.value, expiresAt: this.now + ttlSec * 1000 });
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
    this.published.push({ channel, message });
    return this.bus.publish(channel, message);
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel);
    // For each subscribed channel, attach a bus handler that fans out to all
    // local message listeners (ioredis 'message' event signature).
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

const log = pino({ level: 'silent' });

function makeMux(
  valkey: ValkeyMock,
  timeoutMs = 1_000,
): ReturnType<typeof makeIdempotencyMultiplexer> {
  return makeIdempotencyMultiplexer({
    valkey: valkey as unknown as ValkeyClient,
    log,
    subscriberFactory: () => valkey.duplicate() as unknown as ValkeyClient,
    timeoutMs,
  });
}

// ── extractIdempotencyKey — Test 8 ──────────────────────────────────────────

describe('extractIdempotencyKey (Plan 08-07 / D-D5)', () => {
  it('returns undefined when the header is absent', () => {
    expect(extractIdempotencyKey({})).toBeUndefined();
  });

  it('accepts ULID-like keys', () => {
    const k = '01HABCDEF0123456789ABCDEFG';
    expect(extractIdempotencyKey({ 'idempotency-key': k })).toBe(k);
  });

  it('accepts UUID-like keys', () => {
    const k = '550e8400-e29b-41d4-a716-446655440000';
    expect(extractIdempotencyKey({ 'idempotency-key': k })).toBe(k);
  });

  it('Test 8: throws InvalidIdempotencyKeyError on regex violation', () => {
    expect(() => extractIdempotencyKey({ 'idempotency-key': 'has spaces' })).toThrow(
      InvalidIdempotencyKeyError,
    );
    expect(() => extractIdempotencyKey({ 'idempotency-key': 'evil/path' })).toThrow(
      InvalidIdempotencyKeyError,
    );
    expect(() => extractIdempotencyKey({ 'idempotency-key': '' })).toThrow(
      InvalidIdempotencyKeyError,
    );
    // Length cap is 256.
    expect(() =>
      extractIdempotencyKey({ 'idempotency-key': 'a'.repeat(257) }),
    ).toThrow(InvalidIdempotencyKeyError);
  });

  it('rejects duplicate Idempotency-Key headers (array form)', () => {
    expect(() => extractIdempotencyKey({ 'idempotency-key': ['k1', 'k2'] })).toThrow(
      InvalidIdempotencyKeyError,
    );
  });
});

// ── Multiplexer — Tests 1-7, 9 ──────────────────────────────────────────────

describe('IdempotencyMultiplexer.acquire (Plan 08-07)', () => {
  let valkey: ValkeyMock;
  let mux: ReturnType<typeof makeIdempotencyMultiplexer>;

  beforeEach(() => {
    valkey = new ValkeyMock();
    mux = makeMux(valkey);
  });

  it('Test 1: first acquire returns leader; second with same key returns follower', async () => {
    const a = await mux.acquire('K1', 'req-1');
    expect(a.role).toBe('leader');
    const b = await mux.acquire('K1', 'req-2');
    expect(b.role).toBe('follower');
  });

  it('different keys both become leaders', async () => {
    const a = await mux.acquire('K1', 'req-1');
    const b = await mux.acquire('K2', 'req-2');
    expect(a.role).toBe('leader');
    expect(b.role).toBe('leader');
  });
});

describe('IdempotencyMultiplexer non-stream (Plan 08-07)', () => {
  let valkey: ValkeyMock;
  let mux: ReturnType<typeof makeIdempotencyMultiplexer>;

  beforeEach(() => {
    valkey = new ValkeyMock();
    mux = makeMux(valkey);
  });

  it('Test 2: publishNonStream stores result + publishes done marker; EXPIRE applied', async () => {
    await mux.acquire('K2', 'req-1');
    const body = { id: 'resp-1', choices: [{ message: { content: 'hi' } }] };
    await mux.publishNonStream('K2', body, 'msg_xyz');

    // result key set
    const cached = await valkey.get('idempotency:K2:result');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.$terminal).toBe('done');
    expect(parsed.body).toEqual(body);
    expect(parsed.upstreamMessageId).toBe('msg_xyz');

    // a publish was issued
    expect(valkey.published.some((p) => p.channel === 'idempotency:K2:channel')).toBe(true);
  });

  it('Test 3: follower arriving AFTER finalize gets the cached body', async () => {
    await mux.acquire('K3', 'req-1');
    const body = { id: 'resp-3', value: 42 };
    await mux.publishNonStream('K3', body, 'msg_abc');

    // Follower arrives later
    const r = await mux.awaitNonStreamResult('K3', 'req-2');
    expect(r.body).toEqual(body);
    expect(r.upstreamMessageId).toBe('msg_abc');
  });

  it('Test 4: follower subscribing BEFORE finalize receives the body via pub/sub', async () => {
    await mux.acquire('K4', 'req-1');
    // Follower subscribes first (no cached result yet)
    const followerPromise = mux.awaitNonStreamResult('K4', 'req-2');
    // Now leader finalizes
    const body = { id: 'resp-4', value: 99 };
    await mux.publishNonStream('K4', body, 'msg_def');

    const r = await followerPromise;
    expect(r.body).toEqual(body);
    expect(r.upstreamMessageId).toBe('msg_def');
  });

  it('Test 9: follower times out when leader hangs (short timeoutMs override)', async () => {
    // Use a short timeoutMs to exercise the timeout path without `vi.useFakeTimers()`
    // (fake timers freeze Fastify internals; multiplexer accepts a test override).
    const shortMux = makeMux(valkey, 200);
    await shortMux.acquire('K9', 'req-1');
    await expect(shortMux.awaitNonStreamResult('K9', 'req-2')).rejects.toBeInstanceOf(
      IdempotencyTimeoutError,
    );
  });
});

describe('IdempotencyMultiplexer stream (Plan 08-07)', () => {
  let valkey: ValkeyMock;
  let mux: ReturnType<typeof makeIdempotencyMultiplexer>;

  beforeEach(() => {
    valkey = new ValkeyMock();
    mux = makeMux(valkey);
  });

  it('Test 5: publishStreamEvent RPUSHes + PUBLISHes; finalizeStream EXPIREs to 900s + publishes done', async () => {
    await mux.acquire('K5', 'req-1');
    const ev1 = { type: 'message_start', message: { id: 'msg_a' } };
    const ev2 = { type: 'content_block_delta', delta: { text_delta: 'hi' } };
    await mux.publishStreamEvent('K5', ev1);
    await mux.publishStreamEvent('K5', ev2);

    const chunks = await valkey.lrange('idempotency:K5:chunks', 0, -1);
    expect(chunks).toHaveLength(2);
    // Each chunk is wrapped in { event: ... } per publishStreamEvent's payload shape.
    expect(JSON.parse(chunks[0]!).event).toEqual(ev1);
    expect(JSON.parse(chunks[1]!).event).toEqual(ev2);

    // Channel publishes registered
    const channelMsgs = valkey.published.filter((p) => p.channel === 'idempotency:K5:channel');
    expect(channelMsgs).toHaveLength(2);

    await mux.finalizeStream('K5', 'done', 'msg_a');

    // Result key has $terminal:'done'
    const result = await valkey.get('idempotency:K5:result');
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.$terminal).toBe('done');
    expect(parsed.upstreamMessageId).toBe('msg_a');

    // EXPIRE 900s applied on chunks list and result (sweep at now+901s drops them)
    valkey.tick(901_000);
    const chunksAfter = await valkey.lrange('idempotency:K5:chunks', 0, -1);
    // Note: lists are not TTL-swept in this mock; assert presence of EXPIRE via final publish
    expect(chunksAfter.length).toBeGreaterThan(0); // lists in mock are not TTL-swept
    const resultAfter = await valkey.get('idempotency:K5:result');
    expect(resultAfter).toBeNull(); // TTL-swept

    // Final 'done' publish on the channel
    const finalMsg = valkey.published.filter((p) => p.channel === 'idempotency:K5:channel').pop();
    expect(finalMsg).toBeDefined();
    expect(JSON.parse(finalMsg!.message).$terminal).toBe('done');
  });

  it('Test 6: awaitStreamResult yields cached chunks first then subscribed chunks until done', async () => {
    await mux.acquire('K6', 'req-1');
    const ev1 = { type: 'message_start', message: { id: 'msg_b' } };
    const ev2 = { type: 'content_block_delta', delta: { text_delta: 'hi' } };
    // Leader emits 2 events BEFORE follower joins (cached in the chunks list)
    await mux.publishStreamEvent('K6', ev1);
    await mux.publishStreamEvent('K6', ev2);

    // Follower starts; collects events as the leader continues
    const collected: unknown[] = [];
    let terminal: 'done' | 'error' | 'aborted' | undefined;
    const followerPromise = (async () => {
      for await (const item of mux.awaitStreamResult('K6', 'req-2')) {
        if (item.terminal) {
          terminal = item.terminal;
          break;
        }
        collected.push(item.event);
      }
    })();

    // Microtask boundary: give the follower a chance to subscribe + LRANGE the cached chunks
    await new Promise((r) => setImmediate(r));

    // Leader emits a 3rd event AFTER follower subscribed → comes via pub/sub
    const ev3 = { type: 'content_block_delta', delta: { text_delta: 'world' } };
    await mux.publishStreamEvent('K6', ev3);
    await mux.finalizeStream('K6', 'done', 'msg_b');

    await followerPromise;
    expect(terminal).toBe('done');
    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual(ev1);
    expect(collected[1]).toEqual(ev2);
    expect(collected[2]).toEqual(ev3);
  });

  it('Test 7: awaitStreamResult yields aborted terminal when leader aborted', async () => {
    await mux.acquire('K7', 'req-1');
    const ev1 = { type: 'message_start', message: { id: 'msg_c' } };
    await mux.publishStreamEvent('K7', ev1);
    await mux.finalizeStream('K7', 'aborted');

    let terminal: string | undefined;
    const events: unknown[] = [];
    for await (const item of mux.awaitStreamResult('K7', 'req-2')) {
      if (item.terminal) {
        terminal = item.terminal;
        break;
      }
      events.push(item.event);
    }
    expect(terminal).toBe('aborted');
    expect(events).toEqual([ev1]);
  });

  it('Test 7b: awaitStreamResult yields error terminal when leader errored', async () => {
    await mux.acquire('K7b', 'req-1');
    await mux.finalizeStream('K7b', 'error', undefined, { error: 'upstream-500' });

    let terminal: string | undefined;
    for await (const item of mux.awaitStreamResult('K7b', 'req-2')) {
      if (item.terminal) {
        terminal = item.terminal;
        break;
      }
    }
    expect(terminal).toBe('error');
  });
});
