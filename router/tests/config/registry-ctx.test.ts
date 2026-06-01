/**
 * Phase 17 / v0.11.0 — CTXP-04.
 *
 * Unit tests for the ModelEntrySchema Zod widening that adds `ctx_size` +
 * `context_strategy` with built-in `.default(...)` values. Mirrors the
 * Phase 14 POL-01/POL-02 Zod-parse idiom in
 * `src/config/__tests__/registry.policies.test.ts` (PATTERNS lines 670-699).
 *
 * Defaults under test (RESEARCH §Standard Stack lines 76-92):
 *   - ctx_size: z.number().int().positive().default(8192)
 *   - context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window')
 *
 * Critical: the schema does NOT wrap these in an outer `.optional()` — the
 * keys may be omitted but the runtime value is always populated, so the
 * route handler / ContextProvider can read them unconditionally (no `?? 8192`
 * fallback at the call site).
 *
 * Path-pattern correction (mirrors PATTERNS line 701): this file lives at
 * `tests/config/registry-ctx.test.ts` to match vitest.config.ts's
 * `tests/**\/*.test.ts` include pattern (NOT `src/config/__tests__/`).
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { ModelEntrySchema } from '../../src/config/registry.js';

// ---------------------------------------------------------------------------
// Minimal valid model entry shape (reused across tests). No ctx_size or
// context_strategy — those are the fields under test.
// ---------------------------------------------------------------------------
const BASE_ENTRY_YAML = `
name: chat-local
backend: ollama
backend_url: http://ollama:11434/v1
backend_model: qwen2.5:7b-instruct-q4_K_M
capabilities: [chat]
vram_budget_gb: 4
`;

describe('CTXP-04: ModelEntrySchema — ctx_size + context_strategy widening', () => {
  // -------------------------------------------------------------------------
  // Test 1: absent ctx_size → 8192 default
  // -------------------------------------------------------------------------
  it('Test 1: absent ctx_size → defaults to 8192', () => {
    const parsed = ModelEntrySchema.parse(yaml.load(BASE_ENTRY_YAML));
    expect(parsed.ctx_size).toBe(8192);
  });

  // -------------------------------------------------------------------------
  // Test 2: absent context_strategy → sliding-window default
  // -------------------------------------------------------------------------
  it('Test 2: absent context_strategy → defaults to sliding-window', () => {
    const parsed = ModelEntrySchema.parse(yaml.load(BASE_ENTRY_YAML));
    expect(parsed.context_strategy).toBe('sliding-window');
  });

  // -------------------------------------------------------------------------
  // Test 3: explicit ctx_size: 65536 → parses
  // -------------------------------------------------------------------------
  it('Test 3: explicit ctx_size: 65536 → parses', () => {
    const parsed = ModelEntrySchema.parse(
      yaml.load(`${BASE_ENTRY_YAML}ctx_size: 65536\n`),
    );
    expect(parsed.ctx_size).toBe(65536);
  });

  // -------------------------------------------------------------------------
  // Test 4: explicit context_strategy: truncate → parses
  // -------------------------------------------------------------------------
  it('Test 4: explicit context_strategy: truncate → parses', () => {
    const parsed = ModelEntrySchema.parse(
      yaml.load(`${BASE_ENTRY_YAML}context_strategy: truncate\n`),
    );
    expect(parsed.context_strategy).toBe('truncate');
  });

  // -------------------------------------------------------------------------
  // Test 5: ctx_size: 0 → ZodError (must be positive)
  // -------------------------------------------------------------------------
  it('Test 5: ctx_size: 0 → ZodError (not positive)', () => {
    expect(() =>
      ModelEntrySchema.parse(yaml.load(`${BASE_ENTRY_YAML}ctx_size: 0\n`)),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 6: ctx_size: -1 → ZodError (must be positive)
  // -------------------------------------------------------------------------
  it('Test 6: ctx_size: -1 → ZodError (not positive)', () => {
    expect(() =>
      ModelEntrySchema.parse(yaml.load(`${BASE_ENTRY_YAML}ctx_size: -1\n`)),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 7: context_strategy: "invalid-name" → ZodError (enum violation)
  // -------------------------------------------------------------------------
  it('Test 7: context_strategy: "invalid-name" → ZodError', () => {
    expect(() =>
      ModelEntrySchema.parse(
        yaml.load(`${BASE_ENTRY_YAML}context_strategy: invalid-name\n`),
      ),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Test 8: ctx_size: 1.5 → ZodError (must be integer)
  // -------------------------------------------------------------------------
  it('Test 8: ctx_size: 1.5 → ZodError (must be integer)', () => {
    expect(() =>
      ModelEntrySchema.parse(yaml.load(`${BASE_ENTRY_YAML}ctx_size: 1.5\n`)),
    ).toThrow();
  });
});
