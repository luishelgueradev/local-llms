// router/src/db/bufferedWriter.ts — in-process FIFO + interval flush + drain
// (Plan 05-01 Task 3; load-bearing for SC2).
//
// Invariants encoded here (cross-referenced to CONTEXT D-A1..D-A7 +
// RESEARCH §Pattern 1 + RESEARCH §Common Pitfalls 1, 3, 5):
//
//   D-A1  Bounded FIFO with drop-oldest on overflow. Default capacity 10_000
//         (planner discretion; documented here).
//   D-A2  Dual-trigger flush: setInterval(1_000ms) OR 200-row microtask-
//         deferred flush from push(). queueMicrotask (NOT process.nextTick,
//         NOT synchronous, NOT setImmediate) so the caller's stack returns
//         before the flush starts.
//   D-A3  Multi-row parameterized INSERT via Drizzle .values(batch). Batch
//         size capped at 1_000 rows to stay well under Postgres's 65_535
//         parameter limit (RESEARCH Assumption A9).
//   D-A4  drain(3_000) on SIGTERM raced against setTimeout(timeoutMs).
//         Logs `log_buffer_shutdown_drop` warn when buf has leftover rows.
//   D-A5  In-process — NOT a worker_thread.
//   D-A6  Single shared FIFO across all backends.
//   D-A7  Flush failure: rows STAY in buffer (buf.unshift(...batch)) for the
//         next interval tick retry. droppedCounter NOT incremented on flush
//         failures — only on capacity-overflow drops.
//
//   Pitfall 1 — `flushing: boolean` re-entrancy lock prevents
//               overlapping flushes when Postgres is slow.
//   Pitfall 3 — connectionTimeoutMillis on the pool is set in db/index.ts.
//   Pitfall 5 — batch cap + flushing-lock keeps pool occupancy at 1 per
//               writer.
//
// Trade-off documented (D-A1 + D-A7 interaction): when the buffer is at
// capacity and an in-flight flush fails, unshift(...batch) restores the
// failed rows to the head of the FIFO — the OLDEST rows ahead of `batch`
// may already have been drop-oldest evicted. Acceptable per D-A1: single
// host, single user, manual maintenance acceptable; losing the last few
// seconds of request_log rows under a Postgres-down + buffer-overflow
// pile-up is preferable to blocking SSE streams.
import { requestLog, type RequestLogInsert } from './schema/index.js';

/**
 * Minimal counter surface — matches prom-client's Counter#inc.
 * Plan 05-01 wires a STUB ({ inc: () => {} }) at boot; Plan 05-02 will
 * replace it with the real metrics.logBufferDroppedTotal counter (D-C3).
 */
export interface BufferedWriterCounter {
  inc(value?: number): void;
}

/**
 * Minimal pino-compatible logger surface. Tests inject vi.fn()-backed mocks.
 */
export interface BufferedWriterLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/**
 * Minimal db handle surface. Real callers pass the NodePgDatabase from
 * makeDb(); tests pass an in-memory mock that exposes the same
 * .insert(table).values(rows) chain.
 */
export interface BufferedWriterDb {
  // biome-ignore lint/suspicious/noExplicitAny: matches Drizzle's variadic insert chain
  insert(table: any): { values(rows: unknown[]): Promise<unknown> };
}

export interface MakeBufferedWriterOpts {
  db: BufferedWriterDb;
  droppedCounter: BufferedWriterCounter;
  logger: BufferedWriterLogger;
  /** D-A1 default 10_000. */
  capacity?: number;
  /** D-A2 default 1_000 ms. */
  flushIntervalMs?: number;
  /** D-A2 default 200 rows. */
  flushAtRows?: number;
}

export interface BufferedWriter {
  push(row: RequestLogInsert): void;
  drain(timeoutMs?: number): Promise<void>;
  readonly size: number;
}

/** D-A3 single-statement batch cap (RESEARCH Assumption A9). */
const MAX_BATCH_ROWS = 1_000;

export function makeBufferedWriter(opts: MakeBufferedWriterOpts): BufferedWriter {
  const capacity = opts.capacity ?? 10_000;
  const flushIntervalMs = opts.flushIntervalMs ?? 1_000;
  const flushAtRows = opts.flushAtRows ?? 200;

  const buf: RequestLogInsert[] = [];
  let flushing = false; // re-entrancy lock (RESEARCH Pitfall 1)
  let stopped = false;

  const flush = async (): Promise<void> => {
    if (flushing || buf.length === 0 || stopped) return;
    flushing = true;
    const batch = buf.splice(0, Math.min(buf.length, MAX_BATCH_ROWS));
    try {
      // Multi-row parameterized INSERT via Drizzle (D-A3).
      await opts.db.insert(requestLog).values(batch);
    } catch (err) {
      // D-A7: rows STAY in buffer; next interval tick retries.
      // droppedCounter NOT incremented for flush failures (only D-A1
      // capacity-overflow drops touch it).
      opts.logger.warn(
        { event: 'log_buffer_flush_error', err, count: batch.length },
        'flush failed',
      );
      buf.unshift(...batch);
    } finally {
      flushing = false;
    }
  };

  const timer: NodeJS.Timeout = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Don't keep the event loop alive solely for the writer (RESEARCH Pattern 1).
  timer.unref?.();

  return {
    push(row: RequestLogInsert): void {
      if (stopped) return;
      // D-A1 drop-oldest at capacity. The drop happens BEFORE the new row is
      // pushed so the buffer never exceeds capacity.
      if (buf.length >= capacity) {
        buf.shift();
        opts.droppedCounter.inc();
      }
      buf.push(row);
      // D-A2 row-trigger: microtask-deferred so the caller's stack returns
      // first. NOT process.nextTick (more eager — fires before microtasks),
      // NOT setImmediate (less eager — fires after I/O), NOT synchronous
      // (defeats the purpose: the route's sseCleanup must not block on a
      // flush).
      if (buf.length >= flushAtRows) {
        queueMicrotask(() => {
          void flush();
        });
      }
    },

    async drain(timeoutMs = 3_000): Promise<void> {
      // Idempotent: subsequent push() calls become no-ops; subsequent drain()
      // is allowed (the second call also waits flush + race, which is cheap
      // when buf is already empty).
      stopped = true;
      clearInterval(timer);
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (buf.length > 0) {
        // D-A4: best-effort drain — log the warn so operators can see how
        // many rows were lost on a hard shutdown.
        opts.logger.warn(
          { event: 'log_buffer_shutdown_drop', buffered_at_shutdown: buf.length },
          'drain timeout — dropping buffered rows',
        );
      }
    },

    get size(): number {
      return buf.length;
    },
  };
}
