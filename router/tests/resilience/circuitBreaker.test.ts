/**
 * Plan 08-04 (CLOUD-03, D-B1..D-B4) — circuit breaker unit tests.
 *
 * Coverage:
 *  - classifier (isBreakerTrip): 5xx + network errors trip, 4xx/Zod/abort don't
 *  - state machine: closed -> open -> half-open -> closed
 *  - window expiry: TTL-based counter reset (fixed-window approximation)
 *  - cooldown elapsed: first check transitions to half-open + acquires probe_lock
 *  - half-open concurrency: second concurrent check sees lock held -> returns 'open'
 *  - probe success: closes breaker + clears all 4 keys
 *  - probe failure: re-opens breaker + advances probe_at by cooldown
 *  - record* on non-trip errors / closed state: no-op
 *
 * The test uses a hand-rolled Valkey mock with TTL bookkeeping so we don't
 * pull in ioredis-mock as a devDep. The mock honors PX (millisecond TTL) on
 * SET + PEXPIRE; tick(ms) advances mock-time so TTL-driven expiry fires
 * deterministically. The breaker's optional `now: () => mockTime` ctor arg
 * lets us advance time without touching real timers.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import pino from 'pino';
import {
  isBreakerTrip,
  makeCircuitBreaker,
  type CircuitBreaker,
} from '../../src/resilience/circuitBreaker.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

// ─── In-memory Valkey mock ──────────────────────────────────────────────────
//
// Implements just the surface the breaker uses: get / set (NX + PX) / incr /
// pexpire / del. Honors TTL via a per-key expiresAt timestamp + the shared
// mockNow clock. NOT a complete ioredis fake — only what the breaker calls.

interface StoredValue {
  value: string;
  expiresAt: number | null; // ms timestamp, null = no TTL
}

class ValkeyMock {
  private store = new Map<string, StoredValue>();
  public now = 0;

  tick(ms: number): void {
    this.now += ms;
  }

  /** Compact entries whose TTL elapsed; called before every read. */
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

  /**
   * Supports the SET key value [PX ms] [NX] surface (sufficient for the breaker).
   * Returns 'OK' on success, null if NX was requested and the key exists.
   */
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

  /** Test helper: peek the raw store without TTL sweep. */
  peek(key: string): string | undefined {
    this.sweep(key);
    return this.store.get(key)?.value;
  }
}

// Cast to ValkeyClient — only the methods the breaker uses are exercised.
function makeMock(): ValkeyMock {
  return new ValkeyMock();
}

const env = {
  CIRCUIT_FAILURE_THRESHOLD: 5,
  CIRCUIT_WINDOW_MS: 30_000,
  CIRCUIT_COOLDOWN_MS: 60_000,
};

const log = pino({ level: 'silent' });

function makeBreakerWithMock(): { breaker: CircuitBreaker; mock: ValkeyMock } {
  const mock = makeMock();
  const breaker = makeCircuitBreaker({
    valkey: mock as unknown as ValkeyClient,
    log,
    env,
    now: () => mock.now,
  });
  return { breaker, mock };
}

// ─── isBreakerTrip classifier (D-B1) ────────────────────────────────────────

describe('isBreakerTrip (Plan 08-04, D-B1)', () => {
  it('returns true for APIConnectionTimeoutError', () => {
    expect(isBreakerTrip(new APIConnectionTimeoutError({ message: 'timeout' }))).toBe(true);
  });

  it('returns true for APIConnectionError', () => {
    expect(
      isBreakerTrip(new APIConnectionError({ message: 'econnrefused', cause: new Error() })),
    ).toBe(true);
  });

  it('returns true for Error with status >= 500', () => {
    expect(isBreakerTrip(Object.assign(new Error('500'), { status: 500 }))).toBe(true);
    expect(isBreakerTrip(Object.assign(new Error('502'), { status: 502 }))).toBe(true);
    expect(isBreakerTrip(Object.assign(new Error('503'), { status: 503 }))).toBe(true);
    expect(isBreakerTrip(Object.assign(new Error('504'), { status: 504 }))).toBe(true);
  });

  it('returns true for Error with statusCode >= 500 (Node-style)', () => {
    expect(isBreakerTrip(Object.assign(new Error('500'), { statusCode: 500 }))).toBe(true);
  });

  it('returns true for Node fetch errors (ENOTFOUND / ECONNREFUSED / ECONNRESET)', () => {
    expect(isBreakerTrip(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isBreakerTrip(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isBreakerTrip(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('returns false for APIUserAbortError (client gone, not a backend problem)', () => {
    expect(isBreakerTrip(new APIUserAbortError({ message: 'abort' }))).toBe(false);
  });

  it('returns false for ZodError (validation, not backend)', () => {
    const r = z.object({ x: z.string() }).safeParse({ x: 1 });
    if (r.success) throw new Error('zod should fail');
    expect(isBreakerTrip(r.error)).toBe(false);
  });

  it('returns false for HTTP 4xx (400/401/404)', () => {
    expect(isBreakerTrip(Object.assign(new Error('400'), { status: 400 }))).toBe(false);
    expect(isBreakerTrip(Object.assign(new Error('401'), { status: 401 }))).toBe(false);
    expect(isBreakerTrip(Object.assign(new Error('404'), { status: 404 }))).toBe(false);
  });

  it('returns false for a generic Error with no status/code', () => {
    expect(isBreakerTrip(new Error('whatever'))).toBe(false);
  });
});

// ─── State machine (D-B2, D-B3, D-B4) ───────────────────────────────────────

describe('CircuitBreaker state machine (Plan 08-04)', () => {
  let breaker: CircuitBreaker;
  let mock: ValkeyMock;

  beforeEach(() => {
    ({ breaker, mock } = makeBreakerWithMock());
  });

  // Test 3 — open after threshold
  it('opens after CIRCUIT_FAILURE_THRESHOLD failures in the window', async () => {
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');

    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 4; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    expect((await breaker.check('ollama-cloud')).state).toBe('closed'); // 4 < 5

    await breaker.recordFailure('ollama-cloud', err); // 5th
    expect((await breaker.check('ollama-cloud')).state).toBe('open');
  });

  // Test 4 — window expiry resets counter (TTL-based fixed-window approximation)
  it('window expiry resets the failure counter (TTL-based)', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 4; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');

    // Advance past the window — the fail_count TTL should fire.
    mock.tick(env.CIRCUIT_WINDOW_MS + 1);

    // The 5th failure now lands on a fresh counter (count=1, not threshold) — still closed.
    await breaker.recordFailure('ollama-cloud', err);
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');
  });

  // Test 5 — cooldown elapsed -> half-open on first check
  it('transitions to half-open on first check after cooldown elapses', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    expect((await breaker.check('ollama-cloud')).state).toBe('open');

    // Advance past the cooldown.
    mock.tick(env.CIRCUIT_COOLDOWN_MS + 1);

    expect((await breaker.check('ollama-cloud')).state).toBe('half-open');
    // probe_lock should be set now (SETNX succeeded on the half-open transition).
    expect(mock.peek('breaker:ollama-cloud:probe_lock')).toBeDefined();
  });

  // Test 6 — concurrent half-open lock
  it('serializes the half-open probe: second concurrent check returns open', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    mock.tick(env.CIRCUIT_COOLDOWN_MS + 1);

    const first = await breaker.check('ollama-cloud');
    const second = await breaker.check('ollama-cloud');
    expect(first.state).toBe('half-open');
    expect(second.state).toBe('open');
  });

  // Test 7 — probe success closes the breaker
  it('probe success closes the breaker and clears all keys', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    mock.tick(env.CIRCUIT_COOLDOWN_MS + 1);
    expect((await breaker.check('ollama-cloud')).state).toBe('half-open');

    await breaker.recordSuccess('ollama-cloud');

    expect(mock.peek('breaker:ollama-cloud:state')).toBeUndefined();
    expect(mock.peek('breaker:ollama-cloud:fail_count')).toBeUndefined();
    expect(mock.peek('breaker:ollama-cloud:probe_at')).toBeUndefined();
    expect(mock.peek('breaker:ollama-cloud:probe_lock')).toBeUndefined();
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');
  });

  // Test 8 — probe failure re-opens with a fresh cooldown window
  it('probe failure re-opens the breaker and advances probe_at by cooldown', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    mock.tick(env.CIRCUIT_COOLDOWN_MS + 1);
    expect((await breaker.check('ollama-cloud')).state).toBe('half-open');

    await breaker.recordFailure('ollama-cloud', err);

    expect((await breaker.check('ollama-cloud')).state).toBe('open');
    // probe_at should be at now+cooldown — i.e. > current time, so the next
    // check still returns 'open' until the new cooldown elapses.
    const probeAt = Number(mock.peek('breaker:ollama-cloud:probe_at'));
    expect(probeAt).toBeGreaterThan(mock.now);
    expect(probeAt).toBe(mock.now + env.CIRCUIT_COOLDOWN_MS);
  });

  // Test 9 — non-trip errors are no-ops on recordFailure
  it('recordFailure with a ZodError is a no-op (non-trip)', async () => {
    const r = z.object({ x: z.string() }).safeParse({ x: 1 });
    if (r.success) throw new Error('zod should fail');
    await breaker.recordFailure('ollama-cloud', r.error);

    expect((await breaker.check('ollama-cloud')).state).toBe('closed');
    expect(mock.peek('breaker:ollama-cloud:fail_count')).toBeUndefined();
  });

  // Test 10 — recordSuccess on closed is a no-op
  it('recordSuccess on a closed breaker is a no-op', async () => {
    await breaker.recordSuccess('ollama-cloud');
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');
    expect(mock.peek('breaker:ollama-cloud:state')).toBeUndefined();
    expect(mock.peek('breaker:ollama-cloud:fail_count')).toBeUndefined();
  });

  // Per-backend isolation (D-B4 belt-and-suspenders)
  it('per-backend isolation: tripping ollama-cloud leaves ollama (local) closed', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    expect((await breaker.check('ollama-cloud')).state).toBe('open');
    expect((await breaker.check('ollama')).state).toBe('closed');
  });

  // reset() helper coverage — exposed for tests, no-op at runtime
  it('reset(backend) clears all 4 keys for that backend', async () => {
    const err = new APIConnectionError({ message: 'fail', cause: new Error() });
    for (let i = 0; i < 5; i++) {
      await breaker.recordFailure('ollama-cloud', err);
    }
    await breaker.reset('ollama-cloud');
    expect(mock.peek('breaker:ollama-cloud:state')).toBeUndefined();
    expect(mock.peek('breaker:ollama-cloud:fail_count')).toBeUndefined();
    expect((await breaker.check('ollama-cloud')).state).toBe('closed');
  });
});
