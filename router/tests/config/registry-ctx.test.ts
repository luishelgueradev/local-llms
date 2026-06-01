/**
 * Phase 17 / v0.11.0 — CTXP-04. Wave 0 scaffold (Plan 17-01).
 *
 * Unit tests for the ModelEntrySchema Zod widening that adds `ctx_size` +
 * `context_strategy` with built-in `.default(...)` values. Mirrors the
 * Phase 14 POL-01/POL-02 Zod-parse idiom in
 * `src/config/__tests__/registry.policies.test.ts` (PATTERNS lines 670-699).
 *
 * Wave 0 = it.todo only. Plan 17-03 widens the schema; this test goes green
 * at that point.
 *
 * Defaults under test (RESEARCH §Standard Stack lines 76-92):
 *   - ctx_size: z.number().int().positive().default(8192)
 *   - context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window')
 *
 * Critical: the schema does NOT wrap these in an outer .optional() — the
 * keys may be omitted but the runtime value is always populated, so the
 * route handler can read them unconditionally (no `?? 8192` at call site).
 *
 * Path-pattern correction (mirrors PATTERNS line 701): this file lives at
 * `tests/config/registry-ctx.test.ts` to match vitest.config.ts's
 * `tests/**\/*.test.ts` include pattern (NOT `src/config/__tests__/`).
 */
import { describe, it } from 'vitest';
import { ModelEntrySchema } from '../../src/config/registry.js';

// Wave-0 sentinel: keep the schema reachable so Plan 17-03 can flip
// it.todo → real assertions without import-order churn.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _waveZeroSchema = ModelEntrySchema;

describe('CTXP-04: ModelEntrySchema — ctx_size + context_strategy widening', () => {
  it.todo('Test 1: absent ctx_size → defaults to 8192');
  it.todo('Test 2: absent context_strategy → defaults to sliding-window');
  it.todo('Test 3: explicit ctx_size: 65536 → parses');
  it.todo('Test 4: explicit context_strategy: truncate → parses');
  it.todo('Test 5: ctx_size: 0 → ZodError (not positive)');
  it.todo('Test 6: ctx_size: -1 → ZodError (not positive)');
  it.todo('Test 7: context_strategy: "invalid-name" → ZodError');
  it.todo('Test 8: ctx_size: 1.5 → ZodError (must be integer)');
});
