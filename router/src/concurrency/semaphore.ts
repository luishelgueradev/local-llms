/**
 * BackendSemaphore — per-backend FIFO semaphore with per-request timeout + AbortSignal.
 *
 * Design decisions:
 * - Hand-rolled (NOT p-limit / async-sema) — neither supports per-acquire timeout semantics
 *   without slot leakage (RESEARCH §Pattern 1 §Don't Hand-Roll).
 * - `release()` is idempotent via a `released` boolean closure — mirrors heartbeat.ts stop().
 * - Revision 1 (Warning 6): Waiter struct carries `signal` + `onAbort` so drain() can call
 *   `signal.removeEventListener('abort', onAbort)` when promoting a queued waiter, preventing
 *   an abort-after-grant from spuriously rejecting the already-resolved promise.
 */

export class BackendSaturatedError extends Error {
  readonly code = 'backend_saturated';
  constructor(public readonly backend: string, public readonly waitedMs: number) {
    super(`Backend "${backend}" saturated; waited ${waitedMs}ms for a slot`);
    this.name = 'BackendSaturatedError';
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;     // Revision 1 (Warning 6) — needed for removeEventListener in drain()
  onAbort?: () => void;     // Revision 1 (Warning 6) — paired with signal above
}

export class BackendSemaphore {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrency: number,
    private readonly queueMaxWaitMs: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const startedAt = Date.now();

      // Idempotent release closure — captures a `released` boolean.
      // Mirrors heartbeat.ts stop() pattern: calling twice is a no-op.
      const buildRelease = (): (() => void) => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight--;
          this.drain();
        };
      };

      if (this.inFlight < this.maxConcurrency) {
        this.inFlight++;
        resolve(buildRelease());
        return;
      }

      // Queue the waiter with timeout + abort.
      const waiter: Waiter = {
        resolve,
        reject,
        timer: null as unknown as NodeJS.Timeout,
        signal,    // revision 1, Warning 6
      };
      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        // Detach abort listener to avoid spurious double-reject after timeout
        if (waiter.onAbort && waiter.signal) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);   // revision 1, Warning 6
        }
        reject(new BackendSaturatedError(this.name, Date.now() - startedAt));
      }, this.queueMaxWaitMs);

      if (signal) {
        // Short-circuit if already aborted
        if (signal.aborted) {
          clearTimeout(waiter.timer);
          // Don't push to waiters — reject immediately
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          return;
        }
        const onAbort = (): void => {
          clearTimeout(waiter.timer);
          this.removeWaiter(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  private drain(): void {
    if (this.inFlight >= this.maxConcurrency) return;
    const next = this.waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);

    // Revision 1 (Warning 6): detach the abort listener so abort-after-grant is a no-op.
    // Without this, if the caller's AbortController aborts AFTER the waiter has been promoted,
    // the old `onAbort` handler would still fire and attempt to reject a promise that already
    // resolved — causing confusing behavior and potentially leaking AbortSignal listeners
    // for the entire duration of the request.
    if (next.onAbort && next.signal) {
      next.signal.removeEventListener('abort', next.onAbort);
    }

    this.inFlight++;

    // Build a fresh idempotent release for the dequeued waiter.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.drain();
    };
    next.resolve(release);
  }

  private removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }
}
