/**
 * Unit tests for makeLivenessScheduler (Plan 03-03, ROUTE-06).
 * Uses vitest fake timers for deterministic scheduling.
 * 12 test cases covering: immediate-first-probe, interval-driven probes, cache,
 * de-dup (Pitfall 6), URL-set shrinkage, transition logging, overlapping-probe
 * guard (A9), stop(), refresh().
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { makeLivenessScheduler } from '../../src/backends/liveness.js';
import type { MakeLivenessSchedulerOpts } from '../../src/backends/liveness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeOkProbe(latencyMs = 5): MakeLivenessSchedulerOpts['probe'] {
  return vi.fn().mockResolvedValue({ ok: true, latencyMs });
}

function makeErrProbe(error = 'ECONNREFUSED', latencyMs = 100): MakeLivenessSchedulerOpts['probe'] {
  return vi.fn().mockResolvedValue({ ok: false, latencyMs, error });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('makeLivenessScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Immediate first probe
  // -------------------------------------------------------------------------
  it('1. immediately calls probe on start() (not after intervalMs)', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['urlA']);
    // Flush microtasks only — do NOT advance timer (would include interval ticks)
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledWith('urlA', expect.any(AbortController['prototype'].signal.constructor ?? Object));
    // probe was called at least once (immediately)
    expect(probe).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 2: Interval-driven probes
  // -------------------------------------------------------------------------
  it('2. fires probe on each interval tick after the immediate probe', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['urlA']);
    // Advance 250ms: 1 immediate + 2 interval ticks = 3 calls (tolerance ±1)
    await vi.advanceTimersByTimeAsync(250);

    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(4);

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 3: Cache populated on success
  // -------------------------------------------------------------------------
  it('3. get() returns alive entry after a successful probe', async () => {
    const probe = makeOkProbe(5);
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 10_000, probe, logger });

    scheduler.start(['urlA']);
    await vi.advanceTimersByTimeAsync(0); // flush immediate probe

    const result = scheduler.get('urlA');
    expect(result).toBeDefined();
    expect(result!.status).toBe('alive');
    expect(result!.latencyMs).toBe(5);
    expect(result!.lastProbeAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 4: Cache populated on failure
  // -------------------------------------------------------------------------
  it('4. get() returns down entry after a failing probe', async () => {
    const probe = makeErrProbe('ECONNREFUSED', 100);
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 10_000, probe, logger });

    scheduler.start(['urlA']);
    await vi.advanceTimersByTimeAsync(0);

    const result = scheduler.get('urlA');
    expect(result).toBeDefined();
    expect(result!.status).toBe('down');
    expect(result!.latencyMs).toBe(100);
    expect(result!.error).toBe('ECONNREFUSED');

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 5: De-dup on repeated start (Pitfall 6)
  // -------------------------------------------------------------------------
  it('5. start([A,B]) twice results in exactly 2 timers, not 4 (Pitfall 6)', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['A', 'B']);
    // Flush the immediate probes from first start
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = probe.mock.calls.length; // 2

    scheduler.start(['A', 'B']); // idempotent — should NOT add new timers or trigger new probes
    await vi.advanceTimersByTimeAsync(0);
    const afterSecond = probe.mock.calls.length; // should still be 2 (no new immediate runs)

    expect(scheduler.urls().length).toBe(2);
    expect(afterSecond).toBe(afterFirst); // second start did not fire immediate probes

    // After one interval tick: only 2 more probes from the existing timers
    await vi.advanceTimersByTimeAsync(100);
    // Total: 2 (immediate) + 2 (first interval) = 4
    expect(probe.mock.calls.length).toBe(4);

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 6: URL set shrinkage
  // -------------------------------------------------------------------------
  it('6. start([A]) after start([A,B]) clears B timer; no further B probes', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0);

    scheduler.start(['A']); // B removed
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.urls()).toEqual(['A']);

    // Reset call count then advance time — only A should be probed
    probe.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    const bCalls = probe.mock.calls.filter(([url]: [string]) => url === 'B').length;
    expect(bCalls).toBe(0);

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 7: Transition log at info
  // -------------------------------------------------------------------------
  it('7. logs info on status transitions (alive→down and down→alive)', async () => {
    const logger = makeLogger();
    const probe = vi.fn()
      .mockResolvedValueOnce({ ok: true, latencyMs: 5 })        // first: alive
      .mockResolvedValueOnce({ ok: false, latencyMs: 100, error: 'err' }); // second: down

    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['urlA']);
    await vi.advanceTimersByTimeAsync(0); // alive (first probe)
    await vi.advanceTimersByTimeAsync(100); // down (interval tick)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'backend_liveness', previous: 'alive', current: 'down' }),
      expect.any(String),
    );

    // Now alive→down transition seen. Mock one more ok response for down→alive
    probe.mockResolvedValueOnce({ ok: true, latencyMs: 5 });
    await vi.advanceTimersByTimeAsync(100);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'backend_liveness', previous: 'down', current: 'alive' }),
      expect.any(String),
    );

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 8: Sustained-down logs at debug (not info)
  // -------------------------------------------------------------------------
  it('8. sustained-down probes log at debug, NOT info', async () => {
    const probe = makeErrProbe('ECONNREFUSED');
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['urlA']);
    await vi.advanceTimersByTimeAsync(0); // first probe (no previous — no log)
    logger.info.mockClear();
    logger.debug.mockClear();

    await vi.advanceTimersByTimeAsync(100); // second probe (still down — sustained)

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 9: Overlapping-probe guard (A9)
  // -------------------------------------------------------------------------
  it('9. overlapping-probe guard: if probe is in-flight, subsequent ticks skip (A9)', async () => {
    // probe never resolves
    let probeCallCount = 0;
    const probe: MakeLivenessSchedulerOpts['probe'] = vi.fn(() => {
      probeCallCount++;
      return new Promise(() => {}); // never resolves
    });
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['urlA']);
    // Advance 3 intervals: immediate + 3 ticks = 4 opportunities
    // But since first probe never completes, subsequent ticks should skip
    await vi.advanceTimersByTimeAsync(350);

    expect(probeCallCount).toBe(1); // only the immediate one was called

    scheduler.stop();
  });

  // -------------------------------------------------------------------------
  // Test 10: stop() clears timers
  // -------------------------------------------------------------------------
  it('10. stop() clears timers; no further probes after stop', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    scheduler.start(['A']);
    await vi.advanceTimersByTimeAsync(100); // immediate + 1 interval = 2 calls

    scheduler.stop();
    probe.mockClear();

    await vi.advanceTimersByTimeAsync(500); // advance time after stop
    expect(probe).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 11: stop() is idempotent
  // -------------------------------------------------------------------------
  it('11. stop() is idempotent — calling twice does not throw', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 100, probe, logger });

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    scheduler.start(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0);

    scheduler.stop();
    const callsAfterFirst = clearIntervalSpy.mock.calls.length;

    // second + third stop should be no-ops
    scheduler.stop();
    scheduler.stop();

    // no additional clearInterval calls
    expect(clearIntervalSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  // -------------------------------------------------------------------------
  // Test 12: refresh()
  // -------------------------------------------------------------------------
  it('12. refresh() calls probe once per registered URL immediately', async () => {
    const probe = makeOkProbe();
    const logger = makeLogger();
    const scheduler = makeLivenessScheduler({ intervalMs: 10_000, probe, logger });

    scheduler.start(['A', 'B']);
    await vi.advanceTimersByTimeAsync(0); // flush immediate probes

    probe.mockClear();
    await scheduler.refresh();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith('A', expect.anything());
    expect(probe).toHaveBeenCalledWith('B', expect.anything());

    scheduler.stop();
  });
});
