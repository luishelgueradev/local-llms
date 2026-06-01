/**
 * Phase 19 (v0.11.0 — EMBP-01 / D-11)
 *
 * Fastify module augmentation: adds `FastifyInstance.embeddingProvider` so
 * consumers (future RetrieverProvider implementations, the /v1/embeddings
 * route post-refactor) can call `fastify.embeddingProvider.embed(...)` with
 * full TypeScript type safety.
 *
 * STRATEGIC FRAME (binding): "Retrieval Interfaces, not Retrieval Logic" —
 * the EmbeddingProvider IS implemented in production (because /v1/embeddings
 * must work), but the implementation is a factory returning an object literal
 * (`makeOpenAIEmbeddingProvider` — Plan 19-02). Frame-01 spirit preserved:
 * the router doesn't carry retrieval-shaped logic in classes.
 *
 * Wiring:
 *   - Plan 19-04 (composition root): `router/src/index.ts` constructs
 *     `makeOpenAIEmbeddingProvider(...)` and threads it into `buildApp`
 *     via `BuildAppOpts.embeddingProvider`.
 *   - `buildApp` (router/src/app.ts) calls
 *     `app.decorate('embeddingProvider', opts.embeddingProvider)` when the
 *     field is present. Optional in BuildAppOpts — test fixtures that do not
 *     need embeddings may omit it.
 *
 * Wave-0 note: the import below references `../providers/embedding-provider.js`
 * which does NOT yet exist (Plan 19-02 ships it). `tsc --noEmit` is expected
 * to flag `Cannot find module '../providers/embedding-provider.js'` from BOTH
 * this file AND `tests/fakes.ts` until Plan 19-02 lands. These are intentional
 * Wave-0 RED signals.
 *
 * tsconfig coverage: `"include": ["src/**/*"]` in router/tsconfig.json already
 * picks up this file (verified: tsconfig.json includes `src/**/*` glob which
 * covers `src/types/*.d.ts`). No tsconfig change required.
 */

import type { EmbeddingProvider } from '../providers/embedding-provider.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Phase 19 (v0.11.0 — EMBP-01): production EmbeddingProvider decorated
     * by buildApp when opts.embeddingProvider is supplied. Consumed by
     * future RetrieverProvider implementations and by the /v1/embeddings route
     * post-refactor (Plan 19-03). Optional in BuildAppOpts (test fixtures may
     * omit) — when undefined, no decorator is registered and the route reads
     * its provider from route-level opts.
     *
     * Construction site: router/src/index.ts (Plan 19-04, composition root).
     */
    embeddingProvider: EmbeddingProvider;
  }
}
