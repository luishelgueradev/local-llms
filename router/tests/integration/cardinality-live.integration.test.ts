/**
 * Phase 19 / v0.11.0 — OBSV-02 (Plan 19-01 Wave-0 scaffold; Plan 19-05 flips).
 *
 * Wave-0 integration test scaffold for the live Prometheus cardinality scrape
 * (`checkCardinalityLive`). Mirrors the `tests/integration/migrations/
 * 0007-hook-log.test.ts` file-scaffolding tone (Phase 18).
 *
 * This file establishes the RED signal: the runtime sentinel
 * (`await import(...)`) surfaces "Cannot find module
 * '../../scripts/check-prometheus-cardinality.js'" (the named export
 * `checkCardinalityLive` does NOT yet exist in that module) until Plan 19-05
 * extends the script with dual-mode CLI support.
 *
 * Wave-0 convention (Phase 17/18 preserved):
 *   - NO `it.skip` / `xit`.
 *   - One sentinel `it()` that MUST fail because `checkCardinalityLive` is not
 *     yet exported from the script module.
 *   - Two `it.todo(...)` placeholders that Plan 19-05 flips to real assertions.
 *
 * Note: this test does NOT require a Postgres or Valkey env gate — the live
 * cardinality scrape uses `app.inject({ method: 'GET', url: '/metrics' })`
 * which requires no external services (buildApp with minimal fakes suffices).
 *
 * Tests:
 *   1. (sentinel) checkCardinalityLive is exported from scripts/check-prometheus-cardinality.js
 *   2. (todo) live /metrics scrape returns zero /_id$/ violations
 *   3. (todo) /metrics exposition contains at least one labelled series (sanity)
 */
import { describe, expect, it } from 'vitest';

describe('OBSV-02: live /metrics cardinality scrape', () => {
  /**
   * Wave-0 runtime sentinel: forces a failure until Plan 19-05 adds the
   * `checkCardinalityLive` named export to
   * `router/scripts/check-prometheus-cardinality.ts`.
   *
   * Asserts `typeof mod.checkCardinalityLive === 'function'` rather than just
   * importing — this way the test fails with a clear assertion message ("expected
   * undefined to be 'function'") once the module exists but lacks the export,
   * and fails with "Cannot find module" before the module exists. Both signal
   * Wave-0 RED.
   */
  it('runtime sentinel: checkCardinalityLive is exported', async () => {
    const mod = await import('../../scripts/check-prometheus-cardinality.js');
    expect(typeof (mod as Record<string, unknown>).checkCardinalityLive).toBe('function');
  });

  it.todo(
    'live /metrics scrape via app.inject returns zero /_id$/ label violations (OBSV-02 in-band CI gate)',
  );

  it.todo(
    '/metrics exposition contains at least one labelled series (sanity: prom-client actually rendered metrics)',
  );
});
