/**
 * Shared test fakes for Phase 5+ BuildAppOpts dependencies.
 *
 * Plan 05-01 added a REQUIRED `bufferedWriter` field on BuildAppOpts (D-A4).
 * Every existing buildApp() caller in tests needs the field — this module
 * provides the canonical fake so the fixup is one import + one call per
 * test file rather than 30 ad-hoc inline shapes.
 *
 * The fake is intentionally minimal: push is a no-op, drain resolves
 * immediately, size always reports 0. Tests that care about writer behavior
 * (e.g., bufferedWriter.test.ts) build their own mock with vi.fn() spies.
 */
import type { BufferedWriter } from '../src/db/bufferedWriter.js';
import { makeMetricsRegistry, type MetricsRegistry } from '../src/metrics/registry.js';

export function makeFakeBufferedWriter(): BufferedWriter {
  return {
    push: () => {},
    drain: async () => {},
    get size() {
      return 0;
    },
  };
}

/**
 * Plan 05-02 — shared metrics registry factory for integration tests.
 *
 * Calls the real `makeMetricsRegistry()` (lightweight: fresh Registry +
 * 5 metrics + Node defaults). Each call returns a NEW registry — Pitfall 2
 * regression gate. Tests that need to inspect specific metric values
 * construct their own `makeMetricsRegistry()` directly so they have a
 * named reference.
 */
export function makeFakeMetrics(): MetricsRegistry {
  return makeMetricsRegistry();
}
