/**
 * semaphore.test.ts — Unit tests for BackendSemaphore (Plan 03-04, ROUTE-07)
 *
 * 13 cases:
 *   1-6: basic mechanics (constructor, under-cap, queuing, idempotent release)
 *   7:   timeout -> BackendSaturatedError
 *   8:   AbortSignal abort mid-wait
 *   9:   AbortSignal already aborted
 *   10:  FIFO drain order
 *   11:  timeout clears abort listener (no double-reject)
 *   12:  release after rejection is a no-op
 *   13:  Revision 1 (Warning 6) — abort-listener cleanup on drain promotion
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BackendSemaphore, BackendSaturatedError } from '../../src/concurrency/semaphore.js';

describe('BackendSemaphore', () => {
  // Test 1: constructor + initial stats
  it('1. constructor produces zero-state stats', () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 2: single acquire under cap resolves immediately
  it('2. acquire under cap resolves immediately', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    const r1 = await sem.acquire();
    expect(sem.stats()).toEqual({ inFlight: 1, queued: 0 });
    r1();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 3: two acquires under cap
  it('3. two acquires under cap - both resolve immediately', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats()).toEqual({ inFlight: 2, queued: 0 });
    r1();
    r2();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 4: third acquire queues when at cap
  it('4. third acquire queues when cap is reached', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    await sem.acquire();
    await sem.acquire();
    // Do NOT await — it should queue
    let resolved = false;
    const p3 = sem.acquire().then((r) => { resolved = true; return r; });
    // Give microtasks a chance to run
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.stats()).toEqual({ inFlight: 2, queued: 1 });
    // Cleanup to avoid test leaks
    void p3;
  });

  // Test 5: release transfers slot to queued waiter
  it('5. releasing a slot promotes the queued waiter', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    // Queue a third
    const p3 = sem.acquire();
    await Promise.resolve();
    expect(sem.stats()).toEqual({ inFlight: 2, queued: 1 });
    // Release r1 -> p3 should resolve
    r1();
    const r3 = await p3;
    expect(sem.stats()).toEqual({ inFlight: 2, queued: 0 });
    r2();
    r3();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 6: idempotent release — calling release() twice must not corrupt state
  it('6. release() is idempotent - double call does not corrupt inFlight', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats().inFlight).toBe(2);
    // Double-call r1
    r1();
    r1();  // second call must be a no-op
    // Only one slot should have been released
    expect(sem.stats().inFlight).toBe(1);
    r2();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 7: queue timeout -> BackendSaturatedError
  it('7. queue timeout emits BackendSaturatedError', async () => {
    vi.useFakeTimers();
    const sem = new BackendSemaphore('ollama', 2, 50);
    await sem.acquire();
    await sem.acquire();
    const p3 = sem.acquire();
    // Advance by 60ms past the 50ms timeout
    vi.advanceTimersByTime(60);
    await expect(p3).rejects.toMatchObject({
      code: 'backend_saturated',
      backend: 'ollama',
    });
    const err = await p3.catch((e) => e as BackendSaturatedError);
    expect(err).toBeInstanceOf(BackendSaturatedError);
    expect(err.waitedMs).toBeGreaterThanOrEqual(50);
    expect(err.code).toBe('backend_saturated');
    expect(err.backend).toBe('ollama');
    // inFlight is unchanged — waiter never had a slot
    expect(sem.stats().inFlight).toBe(2);
    expect(sem.stats().queued).toBe(0);
    vi.useRealTimers();
  });

  // Test 8: AbortSignal abort mid-wait
  it('8. aborting signal mid-wait rejects with abort reason (not BackendSaturatedError)', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    await sem.acquire();
    await sem.acquire();
    const ac = new AbortController();
    const p3 = sem.acquire(ac.signal);
    await Promise.resolve();
    expect(sem.stats()).toEqual({ inFlight: 2, queued: 1 });
    // Abort
    const abortReason = new Error('client-disconnected');
    ac.abort(abortReason);
    await expect(p3).rejects.toThrow('client-disconnected');
    // Waiter removed from queue
    expect(sem.stats().queued).toBe(0);
    // inFlight unchanged (aborted waiter never got a slot)
    expect(sem.stats().inFlight).toBe(2);
  });

  // Test 9: AbortSignal already aborted on acquire call
  it('9. already-aborted signal rejects immediately without queuing', async () => {
    const sem = new BackendSemaphore('ollama', 2, 30_000);
    await sem.acquire();
    await sem.acquire();
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    const p3 = sem.acquire(ac.signal);
    await expect(p3).rejects.toThrow('pre-aborted');
    // No waiter queued
    expect(sem.stats().queued).toBe(0);
    expect(sem.stats().inFlight).toBe(2);
  });

  // Test 10: FIFO drain order with multiple waiters
  it('10. drain promotes waiters in FIFO order', async () => {
    const sem = new BackendSemaphore('ollama', 1, 30_000);
    const r1 = await sem.acquire();
    // Queue 3 waiters
    const order: number[] = [];
    const p2 = sem.acquire().then((r) => { order.push(2); return r; });
    const p3 = sem.acquire().then((r) => { order.push(3); return r; });
    const p4 = sem.acquire().then((r) => { order.push(4); return r; });
    await Promise.resolve();
    expect(sem.stats()).toEqual({ inFlight: 1, queued: 3 });
    // Release -> p2 should be promoted first
    r1();
    const r2 = await p2;
    expect(order).toEqual([2]);
    r2();
    const r3 = await p3;
    expect(order).toEqual([2, 3]);
    r3();
    const r4 = await p4;
    expect(order).toEqual([2, 3, 4]);
    r4();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  // Test 11: timeout clears abort listener — no double-reject
  it('11. timeout clears abort listener so abort-after-timeout is a no-op', async () => {
    vi.useFakeTimers();
    const sem = new BackendSemaphore('ollama', 2, 50);
    await sem.acquire();
    await sem.acquire();
    const ac = new AbortController();
    let rejectCount = 0;
    const p3 = sem.acquire(ac.signal).catch((e) => { rejectCount++; return e; });
    // Advance to timeout
    vi.advanceTimersByTime(60);
    await p3;  // resolves with the caught error
    expect(rejectCount).toBe(1);
    // Now abort the controller — should be a no-op (listener already detached)
    ac.abort(new Error('after-timeout'));
    // Microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectCount).toBe(1);  // still 1 — no second rejection
    vi.useRealTimers();
  });

  // Test 12: release after rejection is a no-op
  it('12. releasing an acquired slot after a rejected waiter does not corrupt state', async () => {
    vi.useFakeTimers();
    const sem = new BackendSemaphore('ollama', 2, 50);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const p3 = sem.acquire();
    vi.advanceTimersByTime(60);
    await p3.catch(() => {/* expected rejection */});
    // Now release the holders
    r1();
    r2();
    // Should not go negative
    expect(sem.stats().inFlight).toBeGreaterThanOrEqual(0);
    expect(sem.stats().inFlight).toBe(0);
    vi.useRealTimers();
  });

  // Test 13: Revision 1 (Warning 6) — abort-listener cleanup on drain promotion
  it('13. drain() detaches abort listener when promoting a queued waiter (Warning 6)', async () => {
    const sem = new BackendSemaphore('ollama', 1, 30_000);
    // Fill the one slot
    const r1 = await sem.acquire();
    expect(sem.stats().inFlight).toBe(1);

    // Create an AbortController and spy on removeEventListener
    const ac = new AbortController();
    const removeListenerSpy = vi.spyOn(ac.signal, 'removeEventListener');

    // Queue p2 with the signal
    const p2 = sem.acquire(ac.signal);
    await Promise.resolve();
    expect(sem.stats()).toEqual({ inFlight: 1, queued: 1 });

    // Release r1 — drain() should promote p2 and detach the abort listener
    r1();
    const r2 = await p2;
    // p2 resolved with a release function
    expect(typeof r2).toBe('function');

    // Verify removeEventListener was called with 'abort' and a function
    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // Fire abort AFTER the promotion — must be a no-op
    ac.abort(new Error('after-the-fact'));
    // Microtask flush
    await new Promise((r) => setTimeout(r, 10));
    // p2 already resolved — no re-rejection
    expect(sem.stats().inFlight).toBe(1);  // r2 still holds the slot

    // Release r2
    r2();
    expect(sem.stats()).toEqual({ inFlight: 0, queued: 0 });
  });
});

describe('BackendSaturatedError', () => {
  it('has correct shape (name, code, backend, waitedMs)', () => {
    const err = new BackendSaturatedError('llamacpp', 1500);
    expect(err.name).toBe('BackendSaturatedError');
    expect(err.code).toBe('backend_saturated');
    expect(err.backend).toBe('llamacpp');
    expect(err.waitedMs).toBe(1500);
    expect(err.message).toContain('llamacpp');
    expect(err.message).toContain('1500');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BackendSaturatedError);
  });
});
