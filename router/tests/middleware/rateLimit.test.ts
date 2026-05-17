/**
 * Plan 08-06 (ROUTE-11 / D-D2 / D-D3) — rateLimit.ts middleware unit tests.
 *
 * Coverage:
 *   Test 1 (hash deterministic): bearerHash returns 8 hex chars; same input ->
 *     same hash.
 *   Test 2 (hash differs): different inputs -> different hashes.
 *   Test 3 (under-limit): counts 1..rpmLimit do NOT throw.
 *   Test 4 (over-limit): count > rpmLimit throws RateLimitExceededError
 *     with currentCount + limit on the error.
 *   Test 5 (first call sets TTL): valkey.expire(key, 65) fires only on the
 *     FIRST call of the bucket (count === 1), not on subsequent INCRs.
 *   Test 6 (fail-open): valkey.incr throws -> hook does NOT throw; log.warn
 *     called once with `{ err, hash, minute }`.
 *   Test 7 (public path bypass): /healthz / /readyz / /metrics -> no Valkey
 *     calls.
 *   Test 8 (no Authorization header): hook returns without Valkey calls
 *     (bearer hook would have already rejected, defensive).
 *   Test 9 (epoch rollover): advance now() past 60_000 ms -> new key uses
 *     next minute; counter resets to 1.
 *
 * Uses a hand-rolled ValkeyMock (incr + expire only — the hook's surface).
 * Hook factory accepts a custom `now: () => number` for deterministic
 * time control without vi.useFakeTimers polluting other suites.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { bearerHash, makeRateLimitPreHandler } from '../../src/middleware/rateLimit.js';
import { RateLimitExceededError } from '../../src/errors/envelope.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

const TOKEN = 'local-llms_abc123_secret';
const RPM_LIMIT = 5;

// ── Hand-rolled Valkey mock (subset of ValkeyClient used by the hook) ──
class ValkeyMock {
  public counts = new Map<string, number>();
  public ttls = new Map<string, number>();
  public incrThrows = false;

  async incr(key: string): Promise<number> {
    if (this.incrThrows) {
      throw new Error('valkey-down: connect ECONNREFUSED');
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.ttls.set(key, ttl);
    return 1;
  }
}

function makeMockLog(): Logger & { _calls: { warn: unknown[][] } } {
  const calls = { warn: [] as unknown[][] };
  const fn = (level: 'warn') =>
    vi.fn((...args: unknown[]) => {
      calls[level].push(args);
    });
  const log = {
    warn: fn('warn'),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    _calls: calls,
  } as unknown as Logger & { _calls: { warn: unknown[][] } };
  return log;
}

function makeReq(opts: { url?: string; authorization?: string } = {}): FastifyRequest {
  return {
    url: opts.url ?? '/v1/chat/completions',
    headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
  } as unknown as FastifyRequest;
}
const FAKE_REPLY = {} as FastifyReply;

// ── Tests 1-2: bearerHash ──────────────────────────────────────────────

describe('bearerHash (Plan 08-06)', () => {
  it('returns 8 hex chars; deterministic for the same input', () => {
    const a = bearerHash('local-llms_abc');
    const b = bearerHash('local-llms_abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('different inputs produce different hashes', () => {
    const a = bearerHash('local-llms_abc');
    const b = bearerHash('local-llms_xyz');
    expect(a).not.toBe(b);
  });

  it('hash is 8 hex chars even for very long input (truncation)', () => {
    const h = bearerHash('x'.repeat(1024));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ── Tests 3-9: makeRateLimitPreHandler behavior ─────────────────────────

describe('makeRateLimitPreHandler (Plan 08-06 / ROUTE-11)', () => {
  let valkey: ValkeyMock;
  let log: ReturnType<typeof makeMockLog>;
  let mockTime: number;

  beforeEach(() => {
    valkey = new ValkeyMock();
    log = makeMockLog();
    mockTime = 0;
  });

  function makeHook() {
    return makeRateLimitPreHandler({
      valkey: valkey as unknown as ValkeyClient,
      log,
      rpmLimit: RPM_LIMIT,
      now: () => mockTime,
    });
  }

  it('Test 3: counts 1..rpmLimit pass without throwing', async () => {
    const hook = makeHook();
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    for (let i = 0; i < RPM_LIMIT; i++) {
      await expect(hook(req, FAKE_REPLY)).resolves.toBeUndefined();
    }
    // After 5 calls, the bucket count should be exactly 5 (still <= limit).
    const expectedHash = bearerHash(TOKEN);
    const expectedKey = `ratelimit:${expectedHash}:0`;
    expect(valkey.counts.get(expectedKey)).toBe(RPM_LIMIT);
  });

  it('Test 4: (rpmLimit+1)th call throws RateLimitExceededError with currentCount + limit', async () => {
    const hook = makeHook();
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    for (let i = 0; i < RPM_LIMIT; i++) {
      await hook(req, FAKE_REPLY);
    }
    // The 6th call should throw.
    await expect(hook(req, FAKE_REPLY)).rejects.toBeInstanceOf(RateLimitExceededError);
    // Re-throw to inspect fields.
    try {
      await hook(req, FAKE_REPLY);
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof RateLimitExceededError)) throw err;
      expect(err.currentCount).toBeGreaterThan(RPM_LIMIT);
      expect(err.limit).toBe(RPM_LIMIT);
      expect(err.bearerHash).toBe(bearerHash(TOKEN));
    }
  });

  it('Test 5: TTL set ONLY on first call of the bucket (count === 1)', async () => {
    const hook = makeHook();
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const expectedHash = bearerHash(TOKEN);
    const expectedKey = `ratelimit:${expectedHash}:0`;

    // Spy the expire fn directly.
    const expireSpy = vi.spyOn(valkey, 'expire');
    await hook(req, FAKE_REPLY);
    expect(expireSpy).toHaveBeenCalledTimes(1);
    expect(expireSpy).toHaveBeenCalledWith(expectedKey, expect.any(Number));
    // The TTL value must be 60+ (per the implementation, 65s with race margin).
    const callArg = expireSpy.mock.calls[0]?.[1];
    expect(typeof callArg).toBe('number');
    expect(callArg as number).toBeGreaterThanOrEqual(60);

    // Subsequent calls do NOT call expire.
    await hook(req, FAKE_REPLY);
    await hook(req, FAKE_REPLY);
    expect(expireSpy).toHaveBeenCalledTimes(1);
  });

  it('Test 6: fail-open — valkey.incr throws -> hook does NOT throw; log.warn fires once', async () => {
    valkey.incrThrows = true;
    const hook = makeHook();
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });

    await expect(hook(req, FAKE_REPLY)).resolves.toBeUndefined();
    // log.warn should have been called exactly once with the err + hash + minute context.
    expect(log._calls.warn.length).toBe(1);
    const [ctxArg, msgArg] = log._calls.warn[0] as [Record<string, unknown>, string];
    expect(typeof ctxArg).toBe('object');
    expect(ctxArg).toHaveProperty('hash');
    expect(ctxArg).toHaveProperty('minute');
    expect(typeof msgArg).toBe('string');
    expect(msgArg).toContain('valkey');
  });

  it('Test 7: public-path bypass — /healthz, /readyz, /metrics do NOT call Valkey', async () => {
    const hook = makeHook();
    const incrSpy = vi.spyOn(valkey, 'incr');
    for (const url of ['/healthz', '/readyz', '/metrics']) {
      const req = makeReq({ url, authorization: `Bearer ${TOKEN}` });
      await expect(hook(req, FAKE_REPLY)).resolves.toBeUndefined();
    }
    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('Test 7b: query strings on public paths still bypass (strip ?)', async () => {
    const hook = makeHook();
    const incrSpy = vi.spyOn(valkey, 'incr');
    const req = makeReq({ url: '/healthz?probe=k8s', authorization: `Bearer ${TOKEN}` });
    await expect(hook(req, FAKE_REPLY)).resolves.toBeUndefined();
    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('Test 8: missing Authorization header — hook returns without Valkey call (defensive)', async () => {
    const hook = makeHook();
    const incrSpy = vi.spyOn(valkey, 'incr');
    const req = makeReq({}); // no auth header
    await expect(hook(req, FAKE_REPLY)).resolves.toBeUndefined();
    expect(incrSpy).not.toHaveBeenCalled();
  });

  it('Test 9: epoch rollover — advancing now() past 60_000 creates a new bucket', async () => {
    const hook = makeHook();
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const expectedHash = bearerHash(TOKEN);

    // First minute: 3 requests.
    for (let i = 0; i < 3; i++) await hook(req, FAKE_REPLY);
    expect(valkey.counts.get(`ratelimit:${expectedHash}:0`)).toBe(3);

    // Advance to next minute boundary.
    mockTime = 60_001;
    await hook(req, FAKE_REPLY);
    // New bucket key with minute=1; counter resets to 1.
    expect(valkey.counts.get(`ratelimit:${expectedHash}:1`)).toBe(1);
    // Old bucket count is preserved in the mock (TTL not actually swept here),
    // but the hook is now writing only to the new bucket — the limit applies
    // per-minute, so 1 < RPM_LIMIT and no throw.
  });

  it('Test 10: different bearer tokens isolate their buckets', async () => {
    const hook = makeHook();
    const reqA = makeReq({ authorization: `Bearer ${TOKEN}` });
    const reqB = makeReq({ authorization: `Bearer ${TOKEN}_OTHER` });

    for (let i = 0; i < RPM_LIMIT; i++) await hook(reqA, FAKE_REPLY);
    // reqB should still pass (separate bucket).
    await expect(hook(reqB, FAKE_REPLY)).resolves.toBeUndefined();
    const hashA = bearerHash(TOKEN);
    const hashB = bearerHash(`${TOKEN}_OTHER`);
    expect(hashA).not.toBe(hashB);
    expect(valkey.counts.get(`ratelimit:${hashA}:0`)).toBe(RPM_LIMIT);
    expect(valkey.counts.get(`ratelimit:${hashB}:0`)).toBe(1);
  });
});
