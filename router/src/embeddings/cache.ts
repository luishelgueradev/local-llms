// router/src/embeddings/cache.ts — Phase 12 (v0.10.0 — EMB-H01, EMB-H04, EMB-H05).
//
// Valkey-backed per-input-item cache for POST /v1/embeddings. The cache key is a
// truncated SHA-256 of (backend|backend_model|encoding_format|dimensions|input) so:
//
//   EMB-H05 — swapping the alias's `backend_model` in models.yaml changes the key
//             implicitly, invalidating the cache for that alias automatically. Same
//             for a change in encoding_format / dimensions on the wire request.
//
//   EMB-H01 — two consecutive /v1/embeddings calls with the same (model, input)
//             hit the cache on the second call.
//
//   EMB-H04 — the route is the fail-open boundary: cache.get() / set() may throw
//             (Valkey down, AUTH failed, network blip); the route catches and falls
//             back to upstream + emits a warn log. This module's API exposes the raw
//             throw so the route's per-call try/catch can decide the metric semantics
//             (the EMB-H04 contract is "no metric increment on Valkey error").
//
// Cache value shape: just the vector (number[] for encoding_format=float | string
// for base64). Usage tokens are NOT cached — on a cache hit the upstream
// {prompt_tokens, total_tokens} of THAT item is 0 (the request didn't cost any
// upstream tokens). The route sums tokens only across cache misses, which is the
// honest accounting: cache hits don't incur compute.
//
// Key prefix `emb:` keeps the namespace separate from rate-limit / breaker /
// idempotency keys so a `SCAN MATCH emb:*` from operators surfaces just the cache.
import { createHash } from 'node:crypto';
import type { ValkeyClient } from '../clients/valkey.js';

/** Cached value: a single embedding vector, in the same shape the wire request asked for. */
export type CachedVector = number[] | string;

/**
 * Build the deterministic cache key for a single (backend, backend_model, encoding_format,
 * dimensions, input) tuple. SHA-256 truncated to 32 hex chars (128 bits of entropy) is
 * collision-resistant for the entire keyspace any single operator will ever store.
 *
 * Exported for unit tests so the route's key construction can be asserted byte-identical.
 */
export function embeddingsCacheKey(args: {
  backend: string;
  backend_model: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  input: string;
}): string {
  // The `|` separator is safe: backend, backend_model, encoding_format are all ASCII
  // identifiers without `|`; `dimensions` is a number stringified; `input` is the only
  // free-form field but it's hashed entirely so a `|` inside it doesn't ambiguate.
  const buf =
    `${args.backend}|${args.backend_model}|${args.encoding_format ?? 'float'}|` +
    `${args.dimensions ?? ''}|${args.input}`;
  return `emb:${createHash('sha256').update(buf, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Cache surface consumed by routes/v1/embeddings.ts. The route catches throws to
 * implement EMB-H04 fail-open semantics; this module deliberately does NOT swallow
 * Valkey errors so the route can decide the metric/log story for each call.
 */
export interface EmbeddingsCache {
  /**
   * Returns the cached vector if present, `null` on a clean miss, or throws on a
   * Valkey error (network blip, AUTH failed, OOM). Parse errors (a corrupt value
   * that fails JSON.parse) surface as null + a logged warn so the route treats them
   * as misses; this prevents a single bad cache entry from poisoning subsequent
   * requests.
   */
  get(key: string): Promise<CachedVector | null>;
  /**
   * Writes the vector to Valkey with the configured TTL. Throws on Valkey error;
   * the route's fail-open catch logs and continues. NOT called for cached items
   * (only for items the route just fetched fresh from the adapter).
   */
  set(key: string, value: CachedVector): Promise<void>;
}

export interface EmbeddingsCacheDeps {
  valkey: ValkeyClient;
  /** TTL in seconds; from env.ROUTER_EMBED_CACHE_TTL_SEC (default 86400). */
  ttlSec: number;
  /** Pino logger (used only for parse errors; route handles network errors). */
  log: { warn: (...args: unknown[]) => void };
}

export function makeEmbeddingsCache(deps: EmbeddingsCacheDeps): EmbeddingsCache {
  const { valkey, ttlSec, log } = deps;
  return {
    async get(key) {
      const raw = await valkey.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as CachedVector;
      } catch (err) {
        // Corrupt cached value — treat as miss. Don't propagate the parse error so
        // a single bad row doesn't 500 the request; do log so operators see the
        // pattern if it recurs (suggests a serializer bug or a manual Valkey edit).
        log.warn({ err, key }, 'embeddings cache: JSON.parse failed; treating as miss');
        return null;
      }
    },
    async set(key, value) {
      // ioredis's EX argument is in seconds; consistent with rate-limit + idempotency
      // patterns elsewhere (clients/valkey.ts header).
      await valkey.set(key, JSON.stringify(value), 'EX', ttlSec);
    },
  };
}
