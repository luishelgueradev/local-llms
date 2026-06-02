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
import type { ModelEntry, RegistryStore } from '../config/registry.js';
import type { AdapterFactory } from '../backends/adapter.js';
import type { BackendSemaphore } from '../concurrency/semaphore.js';
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
 * D-02: Provider always works in float internally — when the client requested
 *       encoding_format='base64' the provider is informed via callOpts and
 *       responds by skipping the cache (EMB-H06: base64 bypasses cache) and
 *       still returning number[][] (route re-encodes at the wire boundary).
 * D-03: Dims enforcement lives inside the provider (throws EmbeddingsDimsMismatchError).
 * D-04: embed(input, opts) — provider runs registry.resolve + capability check internally.
 * D-05: Error vocabulary reuses existing types only; NO new error classes.
 *
 * Phase 19 review fix:
 *   - `signal` added so the provider can forward client-disconnect cancellation
 *     into the upstream adapter call (SC3 propagation), instead of the previous
 *     `undefined as unknown as AbortSignal` cast.
 *   - `encoding_format` added so the provider can honor EMB-H06 (base64 bypasses
 *     cache) without the route having to emit a parallel bypass metric.
 */
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: {
      model: string;
      dimensions?: number;
      user?: string;
      /** Forwarded to adapter; provider also uses this to detect EMB-H06 base64 bypass. */
      encoding_format?: 'float' | 'base64';
      /** Route's AbortController.signal — wired to req.raw.socket 'close' for SC3 propagation. */
      signal?: AbortSignal;
      /**
       * Phase 19 review-deferred fix: pre-resolved ModelEntry from the route's
       * applyPreflight. When provided, the provider SKIPS its own
       * registry.resolve(model) call, preventing a torn-snapshot race where
       * a hot-reload between the route's resolve and the provider's resolve
       * yields different entries (semaphore acquired on one backend, upstream
       * call against another, recordOutcome stamped with a third). Optional
       * for backward compatibility — providers without an upstream resolver
       * (e.g. the test fake) can still ignore it.
       */
      entry?: ModelEntry;
      /**
       * Phase 19 review-deferred fix: per-call BackendSemaphore. When
       * provided, the provider acquires a slot ONLY when an upstream call
       * is needed (missIndices.length > 0), restoring EMB-H01 hot-cache
       * free-path. Pre-fix the route acquired before delegating, charging
       * a concurrency slot to all-cache-hit requests too. Threaded
       * per-call (not at factory level) so the route can resolve the
       * correct semaphore from its already-resolved `entry.backend`.
       */
      semaphore?: BackendSemaphore;
    },
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
 *
 * Phase 19 review fix:
 *   - Reject non-multiple-of-4 byteLength explicitly instead of silently
 *     truncating the trailing 1–3 bytes (corrupt payloads must fail loudly,
 *     not poison the cache).
 *   - Copy bytes into a fresh ArrayBuffer before wrapping as Float32Array.
 *     `Buffer.from(str, 'base64')` may return a Buffer whose `byteOffset` is
 *     not 4-byte aligned (Node Buffer pool stride is implementation-defined),
 *     and `new Float32Array(buffer, byteOffset, len)` requires alignment or
 *     throws `RangeError: start offset of Float32Array should be a multiple
 *     of 4`. Copying into a fresh ArrayBuffer guarantees offset 0.
 */
function decodeBase64Float32(encoded: string): number[] {
  const binaryString = Buffer.from(encoded, 'base64');
  if (binaryString.byteLength % 4 !== 0) {
    throw new Error(
      `decodeBase64Float32: payload byteLength ${binaryString.byteLength} is not a multiple of 4 ` +
        `(corrupt upstream base64 vector — refusing to truncate silently)`,
    );
  }
  // Copy into a fresh ArrayBuffer (offset 0) — defensive against Node Buffer
  // pool alignment quirks. Float32Array length is byteLength / 4.
  const aligned = new ArrayBuffer(binaryString.byteLength);
  new Uint8Array(aligned).set(binaryString);
  const floats = new Float32Array(aligned);
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
      // Phase 19 review-deferred fix: when the route already resolved an
      // entry in applyPreflight, reuse it instead of re-resolving here. A
      // models.yaml hot-reload between the two .resolve() calls would
      // otherwise return different ModelEntries — the route's semaphore,
      // recordOutcome, and request_log stamp would all reference entry A
      // while the upstream call goes to entry B. Pre-resolved entry passed
      // via callOpts.entry collapses that window.
      const entry = callOpts.entry ?? registry.resolve(callOpts.model);

      // 3. Capability gate — throws CapabilityNotSupportedError if absent.
      // When entry came from the route's applyPreflight the gate already
      // ran there; re-checking is cheap defense-in-depth.
      if (!entry.capabilities.includes('embeddings')) {
        throw new CapabilityNotSupportedError(entry.name, 'embeddings');
      }

      // 4. Build upstream adapter.
      const adapter = makeAdapter(entry);

      // 5. Allocate slots + miss queue.
      const slots: Array<number[] | null> = new Array(inputs.length).fill(null);
      const missIndices: number[] = [];

      // Phase 19 review fix (EMB-H06): when the client requested base64,
      // skip the cache entirely (both get and set) and emit `bypass` per
      // input from inside the provider — restoring the pre-Phase-19 contract
      // and eliminating the route-side double-count. `cacheActive` gates the
      // cache get/set + the hit/miss metric; the bypass metric is emitted
      // here exactly once per input when the cache would otherwise apply.
      const cacheActive = cache !== undefined && callOpts.encoding_format !== 'base64';

      // 6. Per-input cache lookup (only when cache is active for this request).
      if (cacheActive) {
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
            const cached = await cache!.get(key);
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
        // Cache not active (no Valkey, OR base64 client request — EMB-H06).
        // Every input is a miss; if the cache is wired but skipped (base64),
        // emit `bypass` per input from the provider.
        const cacheWiredButSkipped = cache !== undefined && !cacheActive;
        for (let i = 0; i < inputs.length; i++) {
          missIndices.push(i);
          if (cacheWiredButSkipped) {
            metrics.embeddingsCacheTotal.inc({ result: 'bypass' });
          }
        }
      }

      // 7. Upstream call for cache misses.
      let upstreamUsage = { prompt_tokens: 0, total_tokens: 0 };
      // Phase 19 review fix (response model regression): preserve the
      // upstream-reported model id so the wire response is byte-identical
      // to the pre-Phase-19 implementation. Falls back to entry.name only
      // when no upstream call happened (all-cache-hit path).
      let upstreamModel: string | undefined;

      if (missIndices.length > 0) {
        const missInputs = missIndices.map((i) => inputs[i] as string);

        // Phase 19 review-deferred fix: acquire the backend semaphore ONLY
        // when an upstream call is actually needed. Pre-fix the route held a
        // slot through the cache-lookup path, throttling cache-only requests
        // (inverting EMB-H01: hot cache should be effectively free). When
        // callOpts.semaphore is absent (test fixtures that don't care), the
        // provider skips this and goes straight to the adapter.
        const release = callOpts.semaphore
          ? await callOpts.semaphore.acquire(callOpts.signal)
          : null;

        try {
          // D-02: always request float from upstream. Phase 19 review fix:
          // forward the route's AbortSignal so client disconnects actually
          // cancel the upstream HTTP call (SC3 propagation).
          const upstreamResult = await adapter.embeddings(
            missInputs,
            entry.backend_model,
            callOpts.signal ?? new AbortController().signal,
            {
              encoding_format: 'float',
              dimensions: callOpts.dimensions,
              user: callOpts.user,
            },
          );

          upstreamModel = upstreamResult.model;

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

            const origIdx = missIndices[j]!;
            slots[origIdx] = vec;

            // Populate cache only when cache is active for this request
            // (EMB-H06: base64 requests do not pollute the float cache).
            if (cacheActive) {
              const key = embeddingsCacheKey({
                backend: entry.backend,
                backend_model: entry.backend_model,
                encoding_format: 'float',
                dimensions: callOpts.dimensions,
                input: inputs[origIdx] as string,
              });
              try {
                await cache!.set(key, vec);
              } catch (err) {
                log.warn(
                  { err, key },
                  'embeddings cache: set failed; vector served but not cached',
                );
              }
            }
          }
        } finally {
          // Idempotent release — buildRelease() inside the semaphore is
          // already idempotent, so calling here unconditionally is safe.
          if (release) release();
        }
      }

      // 8. Dims enforcement + dims metric — single post-loop sweep over EVERY
      // slot (cache hits AND fresh upstream vectors). Phase 19 review fix:
      // pre-refactor sweep ran on every slot once; the refactored version
      // split into two branches that skipped hits in mixed batches, dropping
      // both the safety check and the metric on cached vectors. Restoring
      // the single-sweep pattern restores both invariants and emits a single
      // .inc({...}, inputs.length) per request (cheaper + matches pre shape).
      if (entry.dims !== undefined) {
        for (let i = 0; i < slots.length; i++) {
          const vec = slots[i]!;
          if (vec.length !== entry.dims) {
            // Structured operator log — was dropped when the throw moved
            // into the provider; restored here so operators can correlate
            // the 500 in request_log with the upstream + slot index.
            log.error(
              {
                model: entry.name,
                backend: entry.backend,
                expected_dims: entry.dims,
                actual_dims: vec.length,
                index: i,
              },
              'embeddings dims mismatch: refusing to propagate',
            );
            throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, vec.length);
          }
        }
        // Single per-batch inc covers hits + misses — matches pre-Phase-19.
        metrics.embeddingsDimsTotal.inc(
          { model: entry.name, dims: String(entry.dims) },
          inputs.length,
        );
      }

      // 9. Return normalized shape (D-01).
      // slots is fully populated at this point — the `?? []` is a defensive
      // fallback that cannot be reached by any non-buggy code path.
      // model: prefer upstream-reported id when available (byte-identical
      // wire compat with pre-Phase-19 route); fall back to entry.name on the
      // all-cache-hit path where no upstream call happened.
      return {
        embeddings: slots.map((v) => v ?? []) as number[][],
        model: upstreamModel ?? entry.name,
        usage: upstreamUsage,
      };
    },
  };
}
