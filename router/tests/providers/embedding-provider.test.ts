/**
 * Phase 19 / v0.11.0 — EMBP-01 (Plan 19-01 Wave-0 scaffold; Plan 19-02 flips).
 *
 * Wave-0 conformance test scaffold for the EmbeddingProvider interface.
 * Mirrors `tests/providers/session-store.interface.test.ts` pattern (Phase 17).
 *
 * This file establishes the RED signal: the runtime sentinel
 * (`await import(...)`) surfaces "Cannot find module
 * '../../src/providers/embedding-provider.js'" until Plan 19-02 ships the
 * production interface. The `it.todo` cases are the GREEN targets that
 * Plan 19-02 will flip to real `it()` assertions.
 *
 * Wave-0 convention (Phase 17/18 preserved):
 *   - NO `it.skip` / `xit` — strict Wave-0 convention.
 *   - One sentinel `it()` that MUST fail with "Cannot find module" until the
 *     production file exists.
 *   - Four `it.todo(...)` placeholders that Plan 19-02 flips to real assertions.
 *
 * Tests:
 *   1. (sentinel) runtime: src/providers/embedding-provider.js exists
 *   2. (todo) EmbeddingProvider.embed signature assertion (expectTypeOf)
 *   3. (todo) returns { embeddings: number[][], model, usage } shape
 *   4. (todo) handles string input (single embedding returned)
 *   5. (todo) handles array input (multiple embeddings returned)
 */
import { describe, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/providers/embedding-provider.js';

// Silence the "unused import" lint for the type-only import above.
// The import is load-bearing: once Plan 19-02 ships the module, `tsc --noEmit`
// will confirm the type-import is valid. Until then, both tsc and vitest
// surface the expected Wave-0 RED signal.
type _EmbeddingProviderRef = EmbeddingProvider;

describe('EmbeddingProvider interface — EMBP-01', () => {
  /**
   * Wave-0 runtime sentinel: forces a "Cannot find module" failure until
   * Plan 19-02 ships `router/src/providers/embedding-provider.ts`.
   *
   * Using `await import(...)` (not `import type`) so vitest surfaces the
   * runtime error — `import type` is erased by esbuild and would silently
   * pass before the file exists (same Rule-2 deviation applied in Phase 17-01).
   */
  it('runtime sentinel: src/providers/embedding-provider.js exists', async () => {
    await import('../../src/providers/embedding-provider.js');
  });

  it.todo(
    'EmbeddingProvider.embed signature: (input: string | string[], opts: { model, dimensions?, user? }) => Promise<{ embeddings, model, usage }>',
  );

  it.todo('returns { embeddings: number[][], model: string, usage: { prompt_tokens, total_tokens } } shape on fake provider');

  it.todo('handles string input — single embedding returned (stringResult.embeddings.length === 1)');

  it.todo('handles array input — multiple embeddings returned (arrayResult.embeddings.length === inputs.length)');
});
