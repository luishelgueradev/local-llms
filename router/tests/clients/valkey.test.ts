/**
 * Unit tests for makeValkeyClient + closeValkey (Plan 08-01, DATA-06).
 *
 * Four behavioral cases:
 *   1. makeValkeyClient instantiates IORedis with the EXACT RedisOptions
 *      pinned by the plan (lazyConnect: false, enableOfflineQueue: false,
 *      maxRetriesPerRequest: 1, connectTimeout: 2_000, password threaded).
 *   2. Listeners wired: 'error' → log.warn({ err }), 'connect' → log.info({ url }).
 *   3. closeValkey() resolves when client.quit() resolves promptly; quit was
 *      called exactly once.
 *   4. closeValkey() does NOT throw when client.quit() hangs past 1_000 ms
 *      (vi.useFakeTimers + advanceTimersByTime); it logs warn + calls
 *      client.disconnect(false) as the force-fallback.
 *
 * The IORedis constructor is mocked via vi.mock so the test exercises the
 * OPTIONS contract, not the Redis wire protocol. This is the same approach
 * the existing bufferedWriter test takes for the drizzle handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// ioredis mock — captured into a holder so each test can inspect ctor calls
// and replace the on/quit/disconnect spies per-case.
// --------------------------------------------------------------------------

interface MockClient {
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  __listeners: Map<string, (arg: unknown) => void>;
}

const mockHolder: {
  ctorCalls: Array<[string, Record<string, unknown>]>;
  currentClient: MockClient | null;
} = {
  ctorCalls: [],
  currentClient: null,
};

function makeMockClient(): MockClient {
  const listeners = new Map<string, (arg: unknown) => void>();
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      listeners.set(event, cb);
    }),
    quit: vi.fn(() => Promise.resolve('OK')),
    disconnect: vi.fn(),
    __listeners: listeners,
  };
}

vi.mock('ioredis', () => {
  // The IORedis default-export is a CONSTRUCTOR. The router code does
  // `new IORedis(url, opts)`, so we return a class-like factory whose
  // `new` produces the current mock client and records the ctor args.
  const Ctor = vi.fn(function MockIORedis(this: unknown, url: string, opts: Record<string, unknown>) {
    mockHolder.ctorCalls.push([url, opts]);
    // Return the currentClient so the test can assert on the same instance
    // it pre-installed. (Using `return` from a constructor with `new` is
    // valid JS and overrides the implicit `this`.)
    return mockHolder.currentClient ?? makeMockClient();
  });
  return { default: Ctor };
});

import { makeValkeyClient, closeValkey } from '../../src/clients/valkey.js';

function makeSpyLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    // pino's Logger has more fields; vitest doesn't care about extras.
  };
}

// --------------------------------------------------------------------------

beforeEach(() => {
  mockHolder.ctorCalls = [];
  mockHolder.currentClient = makeMockClient();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('makeValkeyClient', () => {
  it('1. constructs IORedis with the pinned RedisOptions', () => {
    const log = makeSpyLog();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeValkeyClient({ url: 'redis://valkey:6379', password: 'x'.repeat(8), log: log as any });

    expect(mockHolder.ctorCalls).toHaveLength(1);
    const [url, opts] = mockHolder.ctorCalls[0]!;
    expect(url).toBe('redis://valkey:6379');
    expect(opts).toMatchObject({
      password: 'xxxxxxxx',
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
  });

  it('2. wires error and connect listeners that delegate to the pino logger', () => {
    const log = makeSpyLog();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeValkeyClient({ url: 'redis://valkey:6379', password: 'x'.repeat(8), log: log as any });

    const client = mockHolder.currentClient!;
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('connect', expect.any(Function));

    const errorCb = client.__listeners.get('error');
    const connectCb = client.__listeners.get('connect');
    expect(errorCb).toBeTypeOf('function');
    expect(connectCb).toBeTypeOf('function');

    const err = new Error('boom');
    errorCb!(err);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ err }, 'valkey client error');

    connectCb!(undefined);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ url: 'redis://valkey:6379' }, 'valkey connected');
  });
});

describe('closeValkey', () => {
  it('3. resolves cleanly when client.quit() resolves promptly', async () => {
    const log = makeSpyLog();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeValkeyClient({ url: 'redis://valkey:6379', password: 'x'.repeat(8), log: log as any });

    const mock = mockHolder.currentClient!;
    // Default mock quit returns Promise.resolve('OK') — fast path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await closeValkey(client, log as any);

    expect(mock.quit).toHaveBeenCalledTimes(1);
    expect(mock.disconnect).not.toHaveBeenCalled();
  });

  it('4. force-disconnects when client.quit() hangs past 1_000 ms', async () => {
    vi.useFakeTimers();
    const log = makeSpyLog();
    // Swap quit() for a hang BEFORE constructing the client so the listener
    // wiring path doesn't accidentally observe a different mock.
    const hangingClient = makeMockClient();
    hangingClient.quit = vi.fn(() => new Promise<string>(() => { /* never resolves */ }));
    mockHolder.currentClient = hangingClient;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeValkeyClient({ url: 'redis://valkey:6379', password: 'x'.repeat(8), log: log as any });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = closeValkey(client, log as any);

    // Advance past the 1s timeout — the Promise.race should reject and
    // closeValkey should swallow the error + force-disconnect.
    await vi.advanceTimersByTimeAsync(1_500);
    await p; // must not throw

    expect(hangingClient.quit).toHaveBeenCalledTimes(1);
    expect(hangingClient.disconnect).toHaveBeenCalledWith(false);
    // The warn path logged "valkey quit wedged".
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'valkey quit wedged; forcing disconnect',
    );
  });
});
