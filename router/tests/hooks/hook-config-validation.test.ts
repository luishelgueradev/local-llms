/**
 * Phase 18 / v0.11.0 — RETR-03 / P5-01 BLOCK (on_timeout mandatory).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-02/18-06 lands the impl.
 *
 * Configuration-validation tests for `PreCompletionHook` entries passed
 * through `buildApp({ preCompletionHooks })`. The P5-01 BLOCK invariant is:
 * a hook without an explicit `on_timeout` value MUST throw `HookConfigError`
 * at boot — the type union `'fail-open' | 'fail-closed'` deliberately
 * excludes `undefined` so a misconfigured registry never silently
 * fail-closes on the first request.
 *
 * The envelope-mapping assertion (HookConfigError.code === 'hook_config_error')
 * mirrors the Phase 17 SessionStore error-class convention from
 * `tests/providers/session-store.interface.test.ts:88-145`.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string below
 * is the authoritative wording for Plan 18-02/18-06's flip.
 */
import { describe, it } from 'vitest';

describe('Hook configuration validation — RETR-03 / P5-01 BLOCK', () => {
  it('runtime sentinel: src/hooks/pre-completion.js (HookConfigError export) resolves (Wave-0 fails until Plan 18-02/06)', async () => {
    // Wave-0 missing-module sentinel — HookConfigError lives alongside the
    // PreCompletionHook orchestrator (Plan 18-06 finalizes location).
    await import('../../src/hooks/pre-completion.js');
  });
  it.todo('buildApp with hook missing on_timeout throws HookConfigError at boot');
  it.todo('buildApp with hook on_timeout = undefined throws HookConfigError');
  it.todo('buildApp with valid on_timeout: "fail-open" boots successfully');
  it.todo('buildApp with valid on_timeout: "fail-closed" boots successfully');
  it.todo('HookConfigError.code === "hook_config_error" (envelope mapping)');
  it.todo('multiple hooks: validation enforces on_timeout on EVERY hook, not just first');
});
