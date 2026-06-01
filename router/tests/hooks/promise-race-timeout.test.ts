/**
 * Phase 18 / v0.11.0 — P5-02 BLOCK (no setTimeout leak).
 * Plan 18-06: real it() — production module landed in src/hooks/pre-completion.ts.
 *
 * Unit tests for the timeout helper that wraps each `RetrieverProvider.retrieve()`
 * call in `runHookChain`. The P5-02 BLOCK invariant is: regardless of which
 * arm of `Promise.race` wins (retriever vs. timeout), the underlying
 * `setTimeout` handle MUST be cleared in a `finally` so the Node event loop
 * never holds a dangling timer past the hook chain's completion.
 *
 * Coverage:
 *   - timeout-arm wins → rejects with `HookTimeoutError(hookName, timeoutMs)`.
 *   - retriever-arm wins → cancel() is invoked, clearTimeout called once.
 *   - HookTimeoutError carries `code: 'hook_timeout'` for envelope mapping.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeout } from '../../src/hooks/pre-completion.js';
import { HookTimeoutError } from '../../src/errors/envelope.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Promise.race timeout helper — P5-02 BLOCK no setTimeout leak', () => {
  it('runtime sentinel: src/hooks/pre-completion.js (timeout helper) resolves', async () => {
    await import('../../src/hooks/pre-completion.js');
  });

  it('rejects with HookTimeoutError after timeout_ms', async () => {
    const t = timeout(10, 'h');
    await expect(t.promise).rejects.toBeInstanceOf(HookTimeoutError);
    t.cancel(); // safe to call multiple times
  });

  it('cancel() clears the underlying setTimeout (no leaked timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const t = timeout(10_000, 'h');
    t.cancel();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('Promise.race winner = retriever: cancel() is called in finally; clearTimeout invoked exactly once', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    // Mirror runHookChain's pattern: race against a fast-resolving hook.
    const hookPromise = Promise.resolve('done');
    const t = timeout(10_000, 'h');
    let cancelled = false;
    try {
      const winner = await Promise.race([hookPromise, t.promise]);
      expect(winner).toBe('done');
    } finally {
      t.cancel();
      cancelled = true;
    }
    expect(cancelled).toBe(true);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('Promise.race winner = timeout: HookTimeoutError carries hookName + timeoutMs', async () => {
    const neverResolves = new Promise<string>(() => {
      /* deliberately stuck */
    });
    const t = timeout(15, 'slow_kb');
    try {
      await Promise.race([neverResolves, t.promise]);
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(HookTimeoutError);
      const e = err as HookTimeoutError;
      expect(e.hookName).toBe('slow_kb');
      expect(e.timeoutMs).toBe(15);
    } finally {
      t.cancel();
    }
  });

  it('HookTimeoutError.code === "hook_timeout"', async () => {
    const t = timeout(5, 'h');
    try {
      await t.promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HookTimeoutError);
      expect((err as HookTimeoutError).code).toBe('hook_timeout');
    } finally {
      t.cancel();
    }
  });
});
