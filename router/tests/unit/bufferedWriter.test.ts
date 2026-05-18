/**
 * Unit tests for makeBufferedWriter (Plan 05-01, Task 3, DATA-02).
 *
 * 7 numbered cases covering D-A1..D-A7 invariants + RESEARCH Pitfalls 1, 3,
 * 5, 8:
 *
 *   1. Single push + 1s elapse triggers exactly one insert.            (D-A2 interval)
 *   2. 200-row queueMicrotask-deferred flush.                          (D-A2 row trigger)
 *   3. Drop-oldest at capacity 10_000 + droppedCounter.inc.            (D-A1)
 *   4. Flush error → rows STAY in buffer for the next tick.            (D-A7)
 *   5. flushing-lock prevents overlapping flushes.                     (RESEARCH Pitfall 1)
 *   6. drain(3000) races against a hung flush.                         (D-A4)
 *   7. push() after drain() is a no-op.                                 (idempotency)
 *
 * Mirrors the structure of router/tests/unit/semaphore.test.ts (numbered
 * `it('N. ...')` cases) and router/tests/unit/liveness.test.ts (fake-timer
 * boilerplate).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBufferedWriter } from '../../src/db/bufferedWriter.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

interface PendingInsert {
  rows: unknown[];
  resolve: () => void;
  reject: (e: Error) => void;
}

function makeMockDb(): { db: unknown; inserts: PendingInsert[] } {
  const inserts: PendingInsert[] = [];
  const db = {
    insert: () => ({
      values: (rows: unknown[]) => {
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const p = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        inserts.push({ rows, resolve, reject });
        return p;
      },
    }),
  };
  return { db, inserts };
}

function makeDeps() {
  const { db, inserts } = makeMockDb();
  const droppedCounter = { inc: vi.fn() };
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { db, inserts, droppedCounter, logger };
}

// Minimal row shape that satisfies the bufferedWriter's push() contract.
// We don't validate column types in the mock — Drizzle would in a real run.
function row(i: number): RequestLogInsert {
  return {
    protocol: 'openai',
    route: '/v1/chat/completions',
    backend: 'ollama',
    model: 'test',
    status_class: 'success',
    http_status: 200,
    latency_ms: i,
    request_id: `req-${i}`,
  };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

describe('makeBufferedWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------
  // Test 1: 1s flush interval (D-A2)
  // ------------------------------------------------------------------------
  it('1. push() once + 1s tick triggers one insert with one row', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
    });

    w.push(row(1));
    expect(inserts.length).toBe(0); // not yet — interval hasn't fired

    await vi.advanceTimersByTimeAsync(1_000);

    expect(inserts.length).toBe(1);
    expect((inserts[0]?.rows ?? []).length).toBe(1);
    inserts[0]?.resolve();
    await w.drain(100);
  });

  // ------------------------------------------------------------------------
  // Test 2: 200-row queueMicrotask flush trigger (D-A2)
  // ------------------------------------------------------------------------
  it('2. push() x 200 within one tick → microtask-deferred flush fires once with 200 rows', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
    });

    for (let i = 0; i < 200; i++) w.push(row(i));

    // queueMicrotask drains in the microtask queue after the current sync stack
    // — flush microtasks are scheduled. Advance 0 ms with the async helper to
    // let the microtask + the awaited insert promise progress.
    await vi.advanceTimersByTimeAsync(0);

    expect(inserts.length).toBe(1);
    expect((inserts[0]?.rows ?? []).length).toBe(200);
    inserts[0]?.resolve();
    await w.drain(100);
  });

  // ------------------------------------------------------------------------
  // Test 3: drop-oldest at capacity + droppedCounter.inc (D-A1)
  // ------------------------------------------------------------------------
  it('3. push() at capacity drops oldest and increments dropped counter exactly once per overflow', async () => {
    const { db, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
      // shrink capacity for fast test runtime — invariant unchanged
      capacity: 10,
      flushIntervalMs: 60_000, // park the interval so the buffer fills
      flushAtRows: 1_000_000, // park the row trigger so nothing flushes
    });

    for (let i = 0; i < 10; i++) w.push(row(i));
    expect(w.size).toBe(10);
    expect(droppedCounter.inc).not.toHaveBeenCalled();

    w.push(row(10)); // overflow — drops oldest
    expect(w.size).toBe(10);
    expect(droppedCounter.inc).toHaveBeenCalledTimes(1);

    w.push(row(11)); // another overflow
    expect(w.size).toBe(10);
    expect(droppedCounter.inc).toHaveBeenCalledTimes(2);

    // Cleanup: drain races flush (which now fires with force=true) vs the
    // 100ms timeout. Under fake timers we must advance time to let the
    // timeout win — otherwise drain hangs waiting for the never-resolved
    // insert. This is a necessary cleanup-pattern adjustment for the Task 6
    // drain() fix (Option B force-flag); the D-A1 assertions above are
    // unaffected.
    await Promise.all([w.drain(100), vi.advanceTimersByTimeAsync(101)]);
  });

  // ------------------------------------------------------------------------
  // Test 4: D-A7 flush-error: rows stay in buffer, counter NOT incremented
  // ------------------------------------------------------------------------
  it('4. flush failure unshifts rows back into buffer (D-A7) and does NOT increment droppedCounter', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
    });

    // Push 3 rows; first flush will reject — rows must stay.
    w.push(row(1));
    w.push(row(2));
    w.push(row(3));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserts.length).toBe(1);
    expect((inserts[0]?.rows ?? []).length).toBe(3);

    // Reject the first flush.
    inserts[0]?.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0); // let the finally + unshift run

    // logger.warn called with the flush-error event.
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'object' && c[0] !== null && (c[0] as { event?: string }).event === 'log_buffer_flush_error',
    );
    expect(warnCall).toBeDefined();

    // droppedCounter NOT touched on flush failure (D-A7).
    expect(droppedCounter.inc).not.toHaveBeenCalled();

    // Rows are still in buffer — next interval tick flushes them again.
    expect(w.size).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserts.length).toBe(2);
    expect((inserts[1]?.rows ?? []).length).toBe(3);

    inserts[1]?.resolve();
    await w.drain(100);
  });

  // ------------------------------------------------------------------------
  // Test 5: flushing-lock prevents overlapping flushes (RESEARCH Pitfall 1)
  // ------------------------------------------------------------------------
  it('5. flushing lock guards against overlapping flushes — only ONE insert in flight under interval pressure', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
      flushIntervalMs: 1_000,
    });

    w.push(row(1));

    // First tick → first flush starts, insert promise never resolves.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserts.length).toBe(1);

    // 5 more interval ticks while the first flush is still in flight.
    await vi.advanceTimersByTimeAsync(5_000);
    // No new insert promise — the flushing lock blocked the overlapping flush.
    expect(inserts.length).toBe(1);

    inserts[0]?.resolve();
    await w.drain(100);
  });

  // ------------------------------------------------------------------------
  // Test 6: drain(3000) race against a hung flush (D-A4)
  // ------------------------------------------------------------------------
  it('6. drain(3000) resolves even when flush is hung, logs log_buffer_shutdown_drop with remaining count', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
      flushIntervalMs: 1_000,
    });

    w.push(row(1));
    w.push(row(2));
    await vi.advanceTimersByTimeAsync(1_000); // first flush starts (in-flight)
    expect(inserts.length).toBe(1);

    // Call drain(3000) but never resolve the insert. The race against
    // setTimeout(3000) must resolve drain.
    const drainPromise = w.drain(3_000);
    await vi.advanceTimersByTimeAsync(3_001);
    await drainPromise;

    // The shutdown-drop warn must have fired because at the moment drain
    // started, rows had already been spliced into `batch` — so buf is empty
    // at race time. Per CONTEXT D-A4 the warn fires only when buf.length > 0
    // after the race. To assert the warn fires, we need rows that never got
    // into a flush — add some after the in-flight flush started.
    // (Already covered above: w.push(2) was added BEFORE the first tick, so
    // both rows are in `batch`. Add a 3rd row AFTER tick to keep it queued.)
    //
    // Re-spec: after the in-flight insert took the batch, the buf is empty.
    // Drain in this state should NOT emit the shutdown-drop warn. To prove
    // the warn path we need a separate writer with leftover rows. Spawn one:
    const { db: db2, inserts: inserts2, droppedCounter: dc2, logger: log2 } = makeDeps();
    const w2 = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db2 as any,
      droppedCounter: dc2,
      logger: log2,
      flushIntervalMs: 1_000,
    });
    w2.push(row(10));
    w2.push(row(11));
    await vi.advanceTimersByTimeAsync(1_000);
    // After tick: both rows are in `batch`, buf is empty. Add a third row
    // that will sit in buf while the in-flight insert hangs.
    w2.push(row(12));
    expect(w2.size).toBe(1);
    expect(inserts2.length).toBe(1);
    const drain2 = w2.drain(3_000);
    await vi.advanceTimersByTimeAsync(3_001);
    await drain2;
    // The leftover row in buf triggers the shutdown-drop warn (D-A4).
    const shutdownWarn = (log2.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' && c[0] !== null && (c[0] as { event?: string }).event === 'log_buffer_shutdown_drop',
    );
    expect(shutdownWarn).toBeDefined();
    const evtObj = shutdownWarn?.[0] as { buffered_at_shutdown?: number };
    expect(evtObj.buffered_at_shutdown).toBe(1);

    // Clean up the first writer.
    inserts[0]?.resolve();
  });

  // ------------------------------------------------------------------------
  // Test 7: push() after drain() is a no-op (idempotent stop)
  // ------------------------------------------------------------------------
  // Test 7 gates the stopped-flag contract — push() after drain() must be a
  // no-op. Test 8 (below) gates the orthogonal drain-flushes-buffer contract.
  // Both must hold simultaneously after the Task 6 fix.
  it('7. push() after drain() is a no-op (stopped flag set; mirrors semaphore.ts safeRelease)', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
    });

    w.push(row(1));
    await vi.advanceTimersByTimeAsync(1_000);
    inserts[0]?.resolve();
    await w.drain(100);

    // After drain, the writer is stopped.
    w.push(row(2));
    expect(w.size).toBe(0); // push was a no-op

    // Even after another interval cycle, nothing flushes (interval cleared).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(inserts.length).toBe(1); // unchanged
  });

  // ------------------------------------------------------------------------
  // Test 8: drain() flushes a non-empty buffer end-to-end (D-A4 invariant)
  // ------------------------------------------------------------------------
  // This test FAILS against the broken drain() where stopped=true is set
  // BEFORE awaiting flush(), causing flush() to early-return on stopped===true.
  // It passes after the Task 6 fix (Option B: flush({ force: true })).
  it('8. drain() flushes a non-empty buffer end-to-end before resolving (D-A invariant — no silent SIGTERM data loss)', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
      flushIntervalMs: 1_000, // interval must NOT fire on its own at 0ms
    });

    // Push 3 rows — no interval has fired yet.
    w.push(row(1));
    w.push(row(2));
    w.push(row(3));
    expect(inserts.length).toBe(0); // no flush triggered yet
    expect(w.size).toBe(3);         // buffer holds all three

    // Call drain without awaiting — drain() should trigger the flush directly.
    const drainPromise = w.drain(3_000);

    // Advance 0ms to flush microtasks scheduled during drain().
    await vi.advanceTimersByTimeAsync(0);

    // drain() MUST have triggered a flush immediately (not waiting for the
    // 1s interval). Broken drain() sets stopped=true first → flush()
    // short-circuits → inserts.length stays 0.
    expect(inserts.length).toBe(1);
    expect((inserts[0]?.rows ?? []).length).toBe(3);

    // Resolve the insert so drain() can complete.
    inserts[0]?.resolve();

    // drain() must resolve cleanly within the 3s budget.
    await drainPromise;

    // All rows were flushed — buffer must be empty.
    expect(w.size).toBe(0);

    // The shutdown-drop warn must NOT have fired (nothing was dropped).
    const shutdownDropWarn = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { event?: string }).event === 'log_buffer_shutdown_drop',
    );
    expect(shutdownDropWarn).toBeUndefined();
  });

  // ------------------------------------------------------------------------
  // Test 9: WR-01 fix — capacity invariant under flush-failure + new arrivals
  // ------------------------------------------------------------------------
  // Original D-A1+D-A7 trade-off allowed transient overshoot (~1.1x–1.5x
  // capacity) when an in-flight flush failed and the buffer had filled with
  // new arrivals in the meantime. After the WR-01 fix the invariant holds
  // strictly: buf.length <= capacity at all times. New arrivals are dropped
  // (oldest-first) and accounted in droppedCounter to make room for the
  // unshifted failed batch.
  it('9. WR-01 fix — capacity is never exceeded after flush-failure + new arrivals', async () => {
    const { db, inserts, droppedCounter, logger } = makeDeps();
    const w = makeBufferedWriter({
      // biome-ignore lint/suspicious/noExplicitAny: mock db
      db: db as any,
      droppedCounter,
      logger,
      capacity: 5,
      flushIntervalMs: 1_000,
      flushAtRows: 1_000_000, // park row trigger
    });

    // 3 rows queued; interval starts a flush that takes the whole batch.
    w.push(row(1));
    w.push(row(2));
    w.push(row(3));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inserts.length).toBe(1);
    expect(w.size).toBe(0);

    // Fill the buffer to capacity (5) while the flush is in-flight.
    for (let i = 10; i < 15; i++) w.push(row(i));
    expect(w.size).toBe(5);
    expect(droppedCounter.inc).not.toHaveBeenCalled();

    // The in-flight flush fails; unshift the 3 failed rows. With WR-01 fix,
    // 3 oldest new arrivals are dropped first to keep buf.length === capacity.
    inserts[0]?.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0); // run finally

    // Invariant: buf.length is exactly capacity, never more.
    expect(w.size).toBe(5);
    // Counter was incremented for the 3 dropped arrivals.
    expect(droppedCounter.inc).toHaveBeenCalledTimes(1);
    expect((droppedCounter.inc as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(3);

    // Cleanup
    await Promise.all([w.drain(100), vi.advanceTimersByTimeAsync(101)]);
  });
});
