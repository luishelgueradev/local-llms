/**
 * golden.test.ts — Wave-0 scaffold for the round-trip golden test runner (Plan 04-01).
 *
 * Plan 04 (TOOL-05) authors the actual round-trip runner that loads each scenario
 * directory under `router/tests/translation/golden/`, runs canonical-shape identity
 * round-trips, and asserts byte-equivalence with the canonical.json fixture.
 *
 * In Plan 01 the scaffold just verifies the directory tree exists so vitest discovers
 * the file and the empty `golden/` directory is git-tracked via .gitkeep (Plan 04
 * populates each scenario subdirectory).
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('golden round-trip fixtures (TOOL-05 — Plan 04-01 Wave 0 scaffold)', () => {
  it('golden directory exists and is git-tracked (Plan 04 populates scenarios)', () => {
    const goldenDir = resolve(__dirname, 'golden');
    expect(existsSync(goldenDir)).toBe(true);
  });
});
