/**
 * Phase 18 / v0.11.0 — RETR-01. Wave 0 scaffold (Plan 18-01).
 *
 * Interface-shape assertions for `RetrieverProvider` + companion types.
 * Mirrors the Phase 17 SESS-01 convention (`tests/providers/session-store.interface.test.ts`):
 * this file ships REAL `it()` with `expectTypeOf` assertions (NOT `it.todo`)
 * because the test surface is the production type-shape itself.
 *
 * Wave-0 expectation:
 *   The `import type { ... } from '../../src/providers/retriever-provider.js'`
 *   below INTENTIONALLY FAILS until Plan 18-03 lands the production module.
 *   esbuild strips type-only imports, so we ALSO include an explicit runtime
 *   sentinel (`await import('../../src/providers/retriever-provider.js')`)
 *   inside a real `it(...)` so vitest surfaces the missing-module failure
 *   instead of silently passing on the type-level assertions.
 *
 * Type-level coverage (RESEARCH §"Pattern 2" lines 369-403 + §"Code Examples
 * Example 2" lines 752-810):
 *   1. RetrieverProvider.retrieve signature returns Promise<RetrieverResponse>
 *   2. RetrieverRequest.query is required string
 *   3. RetrieverRequest.top_k is optional number
 *   4. RetrievedDocument shape: content required, score+metadata optional
 *   5. RetrieverResponse.documents is RetrievedDocument[] + retrieved_at ISO string
 *   6. OnTimeout is the literal union "fail-open" | "fail-closed" (P5-01 BLOCK)
 *
 * Lock convention (Plan 18-01 lock): each it() case-name string below is the
 * authoritative wording. Plans 18-02..18-08 MUST NOT rename these when adding
 * runtime tests around them.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type {
  RetrieverProvider,
  RetrieverRequest,
  RetrieverResponse,
  RetrievedDocument,
  OnTimeout,
} from '../../src/providers/retriever-provider.js';

describe('RetrieverProvider interface — RETR-01', () => {
  it('runtime sentinel: src/providers/retriever-provider.js resolves (Wave-0 fails until Plan 18-03)', async () => {
    // esbuild strips the `import type` above. This dynamic import surfaces the
    // missing-module error at runtime so vitest reports it during Wave 0 —
    // mirrors Phase 17 Plan 17-01 Rule-2 deviation (PATTERNS line 41).
    await import('../../src/providers/retriever-provider.js');
  });

  it('RetrieverProvider.retrieve signature returns Promise<RetrieverResponse>', () => {
    expectTypeOf<RetrieverProvider['retrieve']>().toEqualTypeOf<
      (request: RetrieverRequest) => Promise<RetrieverResponse>
    >();
  });

  it('RetrieverRequest.query is required string', () => {
    expectTypeOf<RetrieverRequest['query']>().toEqualTypeOf<string>();
  });

  it('RetrieverRequest.top_k is optional number', () => {
    expectTypeOf<RetrieverRequest['top_k']>().toEqualTypeOf<number | undefined>();
  });

  it('RetrievedDocument shape: content required, score+metadata optional', () => {
    expectTypeOf<RetrievedDocument['content']>().toEqualTypeOf<string>();
    expectTypeOf<RetrievedDocument['score']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RetrievedDocument['metadata']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >();
  });

  it('RetrieverResponse.documents is RetrievedDocument[] + retrieved_at ISO string', () => {
    expectTypeOf<RetrieverResponse['documents']>().toEqualTypeOf<RetrievedDocument[]>();
    expectTypeOf<RetrieverResponse['retrieved_at']>().toEqualTypeOf<string>();
  });

  it('OnTimeout is the literal union "fail-open" | "fail-closed" (NOT including undefined)', () => {
    // P5-01 BLOCK type-level proof: the union does NOT permit `undefined`.
    // Hook configuration requires an explicit on_timeout value at boot.
    expectTypeOf<OnTimeout>().toEqualTypeOf<'fail-open' | 'fail-closed'>();
  });
});
