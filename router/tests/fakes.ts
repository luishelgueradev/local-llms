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

export function makeFakeBufferedWriter(): BufferedWriter {
  return {
    push: () => {},
    drain: async () => {},
    get size() {
      return 0;
    },
  };
}
