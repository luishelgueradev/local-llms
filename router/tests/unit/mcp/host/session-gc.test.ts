/**
 * Phase 15 (v0.11.0 — MCPS-05) — Unit tests for session-gc.ts.
 *
 * Covers:
 *  1. startSessionGc returns a timer; expired entries are removed + close()d on sweep.
 *  2. Non-expired entries remain on sweep.
 *  3. shutdownSessions calls close() on every entry and clears the map.
 *  4. shutdownSessions resolves within ~5s even when one transport.close() never resolves.
 *  5. The metrics gauge `routerMcpActiveSessions.set` is updated with sessionMap.size
 *     after a sweep that removed entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { startSessionGc, shutdownSessions, type SessionEntry } from '../../../../src/mcp/host/session-gc.js';
import { makeMetricsRegistry, type MetricsRegistry } from '../../../../src/metrics/registry.js';

/**
 * Builds a minimal SessionEntry with a controllable `transport.close()` spy.
 * The transport/server types are cast through `as unknown as ...` because we
 * only exercise the .close() surface inside the GC sweep — the SDK's real
 * Transport contract is verified by the integration tests in Wave 4.
 */
function makeEntry(opts: {
  lastActivityAt: number;
  closeImpl?: () => Promise<void>;
}): { entry: SessionEntry; closeSpy: ReturnType<typeof vi.fn> } {
  const closeSpy = vi.fn(opts.closeImpl ?? (async () => undefined));
  const entry: SessionEntry = {
    transport: { close: closeSpy } as unknown as SessionEntry['transport'],
    server: {} as SessionEntry['server'],
    lastActivityAt: opts.lastActivityAt,
    capturedReq: {} as SessionEntry['capturedReq'],
  };
  return { entry, closeSpy };
}

/** Silent pino-shaped logger — every level is a no-op vi.fn(). */
function makeFakeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('session-gc — Phase 15 MCPS-05', () => {
  let metrics: MetricsRegistry;
  let log: Logger;

  beforeEach(() => {
    metrics = makeMetricsRegistry();
    log = makeFakeLog();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Test 1: startSessionGc removes expired entries + calls transport.close() on sweep', async () => {
    vi.useFakeTimers();
    const now0 = 1_000_000_000;
    vi.setSystemTime(now0);

    const sessionMap = new Map<string, SessionEntry>();
    // ttlSec = 1 (1000 ms) — anything older than 1s is stale.
    // Place an entry with lastActivityAt = now0 - 5_000 (5s old → stale).
    const { entry: e1, closeSpy: close1 } = makeEntry({ lastActivityAt: now0 - 5_000 });
    sessionMap.set('sid-expired', e1);

    const timer = startSessionGc({
      sessionMap,
      ttlSec: 1,
      intervalMs: 100,
      metrics,
      log,
    });

    expect(timer).toBeDefined();
    // Advance one interval to fire the sweep.
    vi.advanceTimersByTime(100);

    expect(close1).toHaveBeenCalledTimes(1);
    expect(sessionMap.has('sid-expired')).toBe(false);

    clearInterval(timer);
  });

  it('Test 2: non-expired entries remain after a sweep', async () => {
    vi.useFakeTimers();
    const now0 = 2_000_000_000;
    vi.setSystemTime(now0);

    const sessionMap = new Map<string, SessionEntry>();
    // Fresh entry: lastActivityAt = now0 → 0ms old, far below 60s TTL.
    const { entry: e1, closeSpy: close1 } = makeEntry({ lastActivityAt: now0 });
    sessionMap.set('sid-fresh', e1);

    const timer = startSessionGc({
      sessionMap,
      ttlSec: 60,
      intervalMs: 100,
      metrics,
      log,
    });

    vi.advanceTimersByTime(100);

    expect(close1).not.toHaveBeenCalled();
    expect(sessionMap.has('sid-fresh')).toBe(true);

    clearInterval(timer);
  });

  it('Test 3: shutdownSessions calls close() on every entry + clears the map', async () => {
    const sessionMap = new Map<string, SessionEntry>();
    const { entry: e1, closeSpy: close1 } = makeEntry({ lastActivityAt: Date.now() });
    const { entry: e2, closeSpy: close2 } = makeEntry({ lastActivityAt: Date.now() });
    sessionMap.set('sid-A', e1);
    sessionMap.set('sid-B', e2);

    await shutdownSessions(sessionMap, log);

    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
    expect(sessionMap.size).toBe(0);
  });

  it('Test 4: shutdownSessions resolves within ~5s when one transport.close() never resolves (Promise.race winner is the timeout)', async () => {
    vi.useFakeTimers();
    const sessionMap = new Map<string, SessionEntry>();
    // Entry A: close resolves immediately.
    const { entry: eA, closeSpy: closeA } = makeEntry({ lastActivityAt: Date.now() });
    // Entry B: close NEVER resolves — `new Promise(() => {})` is the canonical
    // forever-pending promise. The 5s timeout MUST win the race.
    const { entry: eB, closeSpy: closeB } = makeEntry({
      lastActivityAt: Date.now(),
      closeImpl: () => new Promise<void>(() => { /* never resolve */ }),
    });
    sessionMap.set('sid-A', eA);
    sessionMap.set('sid-B', eB);

    const shutdownPromise = shutdownSessions(sessionMap, log);

    // Advance fake timers past the 5s ceiling.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(sessionMap.size).toBe(0);
    // The warn log fires when the timeout wins. (vi.fn assertion — log.warn was called at least once.)
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('Test 5: gauge routerMcpActiveSessions.set is updated with sessionMap.size after a sweep that removed entries', async () => {
    vi.useFakeTimers();
    const now0 = 3_000_000_000;
    vi.setSystemTime(now0);

    const sessionMap = new Map<string, SessionEntry>();
    // 2 expired + 1 fresh — sweep should remove 2 and leave 1.
    sessionMap.set('e1', makeEntry({ lastActivityAt: now0 - 10_000 }).entry);
    sessionMap.set('e2', makeEntry({ lastActivityAt: now0 - 10_000 }).entry);
    sessionMap.set('fresh', makeEntry({ lastActivityAt: now0 }).entry);

    // Spy on the gauge to assert the set() call.
    const setSpy = vi.spyOn(metrics.routerMcpActiveSessions, 'set');

    const timer = startSessionGc({
      sessionMap,
      ttlSec: 1,
      intervalMs: 100,
      metrics,
      log,
    });

    vi.advanceTimersByTime(100);

    expect(setSpy).toHaveBeenCalledWith(1); // map size after removal
    expect(sessionMap.size).toBe(1);
    expect(sessionMap.has('fresh')).toBe(true);

    clearInterval(timer);
  });
});
