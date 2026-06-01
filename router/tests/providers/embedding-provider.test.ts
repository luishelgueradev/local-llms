/**
 * Phase 19 / v0.11.0 — EMBP-01 (Plan 19-01 Wave-0 scaffold; Plan 19-02 flips).
 *
 * Conformance test for the EmbeddingProvider interface + makeOpenAIEmbeddingProvider
 * factory. Mirrors `tests/providers/session-store.interface.test.ts` pattern
 * (Phase 17).
 *
 * Wave-0 convention (Phase 17/18 preserved):
 *   - NO `it.skip` / `xit`.
 *   - Sentinel `it()` that verifies the module resolves at runtime.
 *   - Four real `it()` assertions (flipped from it.todo by Plan 19-02).
 *
 * Tests:
 *   1. (sentinel) runtime: src/providers/embedding-provider.js exports makeOpenAIEmbeddingProvider
 *   2. EmbeddingProvider.embed signature (expectTypeOf)
 *   3. returns { embeddings: number[][], model, usage } shape on fake provider (array input)
 *   4. handles string input — single embedding returned (stringResult.embeddings.length === 1)
 *   5. handles batch array input preserving order (arrayResult.embeddings.length === inputs.length)
 */
import { describe, expect, it, expectTypeOf } from 'vitest';
import type { EmbeddingProvider } from '../../src/providers/embedding-provider.js';
import { makeFakeEmbeddingProvider } from '../fakes.js';

describe('EmbeddingProvider interface — EMBP-01', () => {
  /**
   * Wave-0 runtime sentinel: verifies the module resolves AND the factory
   * is exported. Plan 19-01 used a bare import(); Plan 19-02 expands it to
   * assert the factory is a function so the sentinel is informative when
   * the module exists but the export is missing.
   */
  it('runtime sentinel: src/providers/embedding-provider.js exports makeOpenAIEmbeddingProvider', async () => {
    const mod = await import('../../src/providers/embedding-provider.js');
    expect(typeof mod.makeOpenAIEmbeddingProvider).toBe('function');
  });

  it('EmbeddingProvider.embed signature: (input: string | string[], opts: { model, dimensions?, user? }) => Promise<{ embeddings, model, usage }>', () => {
    expectTypeOf<EmbeddingProvider['embed']>().toEqualTypeOf<
      (
        input: string | string[],
        opts: { model: string; dimensions?: number; user?: string },
      ) => Promise<{
        embeddings: number[][];
        model: string;
        usage: { prompt_tokens: number; total_tokens: number };
      }>
    >();
  });

  it('returns { embeddings: number[][], model: string, usage: { prompt_tokens, total_tokens } } shape on fake provider', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const r = await provider.embed(['hello'], { model: 'embed-local' });
    expect(r.embeddings).toHaveLength(1);
    expect(r.embeddings[0]).toHaveLength(1024);
    expect(typeof r.model).toBe('string');
    expect(typeof r.usage.prompt_tokens).toBe('number');
    expect(typeof r.usage.total_tokens).toBe('number');
  });

  it('handles string input — single embedding returned (stringResult.embeddings.length === 1)', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const r = await provider.embed('hello', { model: 'embed-local' });
    expect(r.embeddings).toHaveLength(1);
  });

  it('handles batch array input preserving order (arrayResult.embeddings.length === inputs.length)', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const r = await provider.embed(['a', 'b', 'c'], { model: 'embed-local' });
    expect(r.embeddings).toHaveLength(3);
    expect(r.embeddings.every((v) => v.length === 1024)).toBe(true);
  });
});
