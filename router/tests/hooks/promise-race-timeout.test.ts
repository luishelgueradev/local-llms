/**
 * Phase 18 / v0.11.0 — P5-02 BLOCK (no setTimeout leak).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-06 lands the impl.
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
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string below
 * is the authoritative wording for Plan 18-06's flip.
 */
import { describe, it } from 'vitest';

describe('Promise.race timeout helper — P5-02 BLOCK no setTimeout leak', () => {
  it('runtime sentinel: src/hooks/pre-completion.js (timeout helper) resolves (Wave-0 fails until Plan 18-06)', async () => {
    // Wave-0 missing-module sentinel — the timeout helper colocates with the
    // hook chain runner (Plan 18-06 finalizes the exact module boundary).
    await import('../../src/hooks/pre-completion.js');
  });
  it.todo('rejects with HookTimeoutError after timeout_ms');
  it.todo('cancel() clears the underlying setTimeout (no leaked timer)');
  it.todo(
    'Promise.race winner = retriever: cancel() is called in finally; clearTimeout invoked exactly once',
  );
  it.todo('Promise.race winner = timeout: HookTimeoutError carries hookName + timeoutMs');
  it.todo('HookTimeoutError.code === "hook_timeout"');
});
