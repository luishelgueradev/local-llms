/**
 * Phase 19 (v0.11.0 — EMBP-01 / Frame-01 BLOCK)
 *
 * EmbeddingProvider interface — declarative seam for downstream consumers
 * (future RetrieverProvider implementations) needing vectors without an HTTP
 * round-trip through /v1/embeddings.
 *
 * STRATEGIC FRAME (binding): "Retrieval Interfaces, not Retrieval Logic" —
 * the EmbeddingProvider IS implemented in production (because /v1/embeddings
 * must work) but the implementation is a factory returning an object literal
 * (`makeOpenAIEmbeddingProvider`), NOT a class. Frame-01 spirit preserved:
 * the router doesn't carry retrieval-shaped logic.
 *
 * Composition root (router/src/index.ts) constructs the provider and threads
 * it via BuildAppOpts.embeddingProvider; buildApp calls
 * app.decorate('embeddingProvider', ...) so consumers read it as
 * fastify.embeddingProvider.
 *
 * Frame-01 BLOCK: router/src/ contains NO classes implementing this
 * interface. The factory returns an object literal, never a class.
 * A test-only fake lives in tests/fakes.ts (makeFakeEmbeddingProvider).
 */

import type { Logger } from 'pino';
import type { ValkeyClient } from '../clients/valkey.js';
import type { RegistryStore } from '../config/registry.js';
import type { AdapterFactory } from '../backends/adapter.js';
import { makeEmbeddingsCache, embeddingsCacheKey, type EmbeddingsCache } from '../embeddings/cache.js';
import {
  RegistryUnknownModelError,
  CapabilityNotSupportedError,
  EmbeddingsDimsMismatchError,
} from '../errors/envelope.js';

// Re-export RegistryUnknownModelError + CapabilityNotSupportedError so callers
// that import from this file can catch provider errors without a second import.
export { RegistryUnknownModelError, CapabilityNotSupportedError, EmbeddingsDimsMismatchError };

// ── EmbeddingProvider interface (D-01..D-05 — LOCKED) ────────────────────────

/**
 * The interface every embedding implementation must satisfy.
 *
 * D-01: Returns normalized { embeddings: number[][], model, usage }.
 * D-02: Provider always works in float — never accepts encoding_format='base64'.
 * D-03: Dims enforcement lives inside the provider (throws EmbeddingsDimsMismatchError).
 * D-04: embed(input, opts) — provider runs registry.resolve + capability check internally.
 * D-05: Error vocabulary reuses existing types only; NO new error classes.
 */
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: { model: string; dimensions?: number; user?: string },
  ): Promise<{
    embeddings: number[][];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}

// ── Factory opts ──────────────────────────────────────────────────────────────

/**
 * Options for makeOpenAIEmbeddingProvider.
 *
 * valkey is optional — when absent the cache is bypassed entirely and every
 * input goes to the upstream adapter (Phase 7 / pre-cache behavior).
 *
 * env.ROUTER_EMBED_CACHE_TTL_SEC controls the Valkey key TTL; defaults to
 * 86400 (24 h) when the field is absent, mirroring the route's env fallback.
 *
 * metrics.embeddingsCacheTotal and metrics.embeddingsDimsTotal accept any
 * object satisfying the narrow { inc } shape — production wires the
 * prometheus-client Counter instances; tests may pass a stub.
 */
export interface MakeOpenAIEmbeddingProviderOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  valkey?: ValkeyClient;
  env?: { ROUTER_EMBED_CACHE_TTL_SEC: number };
  /**
   * Plan 19-03 (Rule 3 — test backward-compat): when provided, this pre-built
   * EmbeddingsCache is used directly instead of constructing one from `valkey`.
   * Intended for test fixtures that build an in-memory cache and need to inject
   * it into the provider without a ValkeyClient (P12 regression suite).
   * Production paths always use `valkey` instead.
   */
  cacheOverride?: EmbeddingsCache;
  metrics: {
    embeddingsCacheTotal: { inc(labels: { result: 'hit' | 'miss' | 'bypass' }): void };
    embeddingsDimsTotal: { inc(labels: { model: string; dims: string }, value?: number): void };
  };
  log: Logger;
}

// ── Local helper — base64 → number[] ─────────────────────────────────────────

/**
 * Decode a base64-encoded float32 embedding vector to number[].
 *
 * The provider always requests encoding_format='float' from upstream (D-02),
 * but some adapters return base64 regardless. This helper is the defensive
 * boundary: if the upstream ignores our float request and returns a string,
 * we decode it here so the provider's callers always receive number[].
 *
 * Each float32 is 4 bytes little-endian, matching the OpenAI base64 encoding
 * convention used by sentence-transformer servers and the OpenAI API itself.
 */
function decodeBase64Float32(encoded: string): number[] {
  const binaryString = Buffer.from(encoded, 'base64');
  const floats = new Float32Array(
    binaryString.buffer,
    binaryString.byteOffset,
    binaryString.byteLength / 4,
  );
  return Array.from(floats);
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Phase 19 (EMBP-01) — production EmbeddingProvider factory.
 *
 * Returns an object literal (Frame-01: never a class). The returned
 * embed() method:
 *
 *   1. Resolves the model via opts.registry.get().resolve(callOpts.model)
 *      — throws RegistryUnknownModelError on miss.
 *   2. Gates capability: 'embeddings' must be in entry.capabilities
 *      — throws CapabilityNotSupportedError if absent.
 *   3. Per-input Valkey cache lookup (EMB-H01 + EMB-H04 fail-open):
 *      cache hit → slot filled; miss → queued for upstream.
 *      Valkey errors: warn log + fall through, NO metric increment.
 *   4. Calls adapter.embeddings() for all misses with encoding_format:'float'
 *      (D-02). Decodes base64 response defensively if upstream ignores float.
 *   5. Dims enforcement (D-03): throws EmbeddingsDimsMismatchError for any
 *      vector whose length !== entry.dims. Increments embeddingsDimsTotal
 *      per served vector.
 *   6. Populates cache for each miss result (EMB-H04 fail-open on set).
 *   7. Returns { embeddings, model: entry.name, usage } where usage sums
 *      only the upstream-billed tokens (cache hits contribute 0).
 */
export function makeOpenAIEmbeddingProvider(
  opts: MakeOpenAIEmbeddingProviderOpts,
): EmbeddingProvider {
  const { registry, makeAdapter, metrics, log } = opts;

  // Build the EmbeddingsCache wrapper. Priority: cacheOverride (test injection) >
  // valkey (production). When neither is present the cache path is bypassed entirely.
  const cache: EmbeddingsCache | undefined = opts.cacheOverride
    ? opts.cacheOverride
    : opts.valkey
      ? makeEmbeddingsCache({
          valkey: opts.valkey,
          ttlSec: opts.env?.ROUTER_EMBED_CACHE_TTL_SEC ?? 86400,
          log,
        })
      : undefined;

  return {
    async embed(input, callOpts) {
      // 1. Coerce input to array for uniform handling.
      const inputs: string[] = Array.isArray(input) ? input : [input];

      // 2. Resolve model — throws RegistryUnknownModelError on miss.
      const entry = registry.resolve(callOpts.model);

      // 3. Capability gate — throws CapabilityNotSupportedError if absent.
      if (!entry.capabilities.includes('embeddings')) {
        throw new CapabilityNotSupportedError(entry.name, 'embeddings');
      }

      // 4. Build upstream adapter.
      const adapter = makeAdapter(entry);

      // 5. Allocate slots + miss queue.
      const slots: Array<number[] | null> = new Array(inputs.length).fill(null);
      const missIndices: number[] = [];

      // 6. Per-input cache lookup (only when Valkey is wired).
      if (cache) {
        for (let i = 0; i < inputs.length; i++) {
          const item = inputs[i] as string;
          const key = embeddingsCacheKey({
            backend: entry.backend,
            backend_model: entry.backend_model,
            encoding_format: 'float',
            dimensions: callOpts.dimensions,
            input: item,
          });
          try {
            const cached = await cache.get(key);
            if (cached !== null) {
              // Cache hit — slot filled; decode if somehow stored as base64.
              const vec: number[] = Array.isArray(cached)
                ? cached
                : decodeBase64Float32(cached);
              slots[i] = vec;
              metrics.embeddingsCacheTotal.inc({ result: 'hit' });
            } else {
              // Cache miss — queue for upstream.
              missIndices.push(i);
              metrics.embeddingsCacheTotal.inc({ result: 'miss' });
            }
          } catch (err) {
            // EMB-H04 fail-open: warn log + fall through to upstream.
            // NO metric increment — the metric stays a faithful representation
            // of real cache outcomes; Valkey errors are infrastructure noise.
            log.warn(
              { err, key },
              'embeddings cache: get failed; falling through to upstream (fail-open)',
            );
            missIndices.push(i);
          }
        }
      } else {
        // No Valkey — every input is a miss. No cache metrics emitted.
        for (let i = 0; i < inputs.length; i++) {
          missIndices.push(i);
        }
      }

      // 7. Upstream call for cache misses.
      let upstreamUsage = { prompt_tokens: 0, total_tokens: 0 };

      if (missIndices.length > 0) {
        const missInputs = missIndices.map((i) => inputs[i] as string);

        // D-02: always request float from upstream.
        const upstreamResult = await adapter.embeddings(
          missInputs,
          entry.backend_model,
          undefined as unknown as AbortSignal,
          {
            encoding_format: 'float',
            dimensions: callOpts.dimensions,
            user: callOpts.user,
          },
        );

        // Accumulate upstream usage (cache hits contribute 0).
        upstreamUsage = {
          prompt_tokens:
            upstreamUsage.prompt_tokens + (upstreamResult.usage?.prompt_tokens ?? 0),
          total_tokens:
            upstreamUsage.total_tokens + (upstreamResult.usage?.total_tokens ?? 0),
        };

        if (upstreamResult.data.length !== missIndices.length) {
          throw new Error(
            `embeddings provider: upstream returned ${upstreamResult.data.length} vectors ` +
              `for ${missIndices.length} inputs (count mismatch)`,
          );
        }

        for (let j = 0; j < upstreamResult.data.length; j++) {
          const item = upstreamResult.data[j]!;
          // Decode base64 defensively — provider asked for 'float' (D-02),
          // but some adapters return base64 regardless.
          const rawEmbedding = item.embedding;
          const vec: number[] = Array.isArray(rawEmbedding)
            ? rawEmbedding
            : decodeBase64Float32(rawEmbedding);

          // 8. Dims enforcement (D-03): throw before storing the vector.
          if (entry.dims !== undefined && vec.length !== entry.dims) {
            throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, vec.length);
          }

          // Record per-(model,dims) success metric — once per served vector.
          metrics.embeddingsDimsTotal.inc(
            { model: entry.name, dims: String(vec.length) },
          );

          const origIdx = missIndices[j]!;
          slots[origIdx] = vec;

          // 9. Populate cache (fail-open on set error — EMB-H04).
          if (cache) {
            const key = embeddingsCacheKey({
              backend: entry.backend,
              backend_model: entry.backend_model,
              encoding_format: 'float',
              dimensions: callOpts.dimensions,
              input: inputs[origIdx] as string,
            });
            try {
              await cache.set(key, vec);
            } catch (err) {
              log.warn(
                { err, key },
                'embeddings cache: set failed; vector served but not cached',
              );
            }
          }
        }
      } else {
        // All slots filled from cache — also run dims check on cached vectors.
        // Cache keys are keyed by (backend, model, encoding_format, dims, input);
        // a model's dims change in models.yaml would change the key, so this
        // branch is defense-in-depth rather than a hot path.
        if (entry.dims !== undefined) {
          for (let i = 0; i < slots.length; i++) {
            const vec = slots[i]!;
            if (vec.length !== entry.dims) {
              throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, vec.length);
            }
            metrics.embeddingsDimsTotal.inc(
              { model: entry.name, dims: String(vec.length) },
            );
          }
        }
      }

      // 10. Return normalized shape (D-01).
      // slots is fully populated at this point — the `?? []` is a defensive
      // fallback that cannot be reached by any non-buggy code path.
      return {
        embeddings: slots.map((v) => v ?? []) as number[][],
        model: entry.name,
        usage: upstreamUsage,
      };
    },
  };
}
