// router/src/config/registryCache.ts — Plan 08-09 (DATA-06).
//
// 30s Valkey-backed read-through cache for the parsed models.yaml.
//
// File is the source of truth (D-D4 — "fs.watch invalidates the cache on file
// change"); the cache is a derivative. The factory exposes:
//
//   get():   Promise<Registry | null>  — read-through; null on miss or any
//                                          recoverable failure (malformed
//                                          JSON, schema mismatch, Valkey down).
//   set():   Promise<void>             — SETEX (EX 30) the JSON-serialized
//                                          Registry. Non-fatal on Valkey error.
//   clear(): Promise<void>             — DEL the cache key. Non-fatal on
//                                          Valkey error. Used by future
//                                          fs.watch-triggered invalidation
//                                          callbacks.
//
// Why JSON serialization + re-validate on read (defense in depth):
//   An attacker with Valkey write access could plant a tampered Registry
//   blob. The RegistrySchema.safeParse(parsed) gate catches malformed /
//   tampered values; the caller falls back to the file load. Plan 08-00's
//   superRefine (shared-backend_url-across-distinct-backends) re-runs at
//   the safeParse call so cache-injected ambiguity is caught here, not
//   only at boot from disk.
//
// Cache key is versioned with a trailing `:v1` integer so a future
// schema-breaking change can invalidate ALL cached blobs by bumping the
// version. Not env-configurable in v1.
import type { Logger } from 'pino';
import type { ValkeyClient } from '../clients/valkey.js';
import { RegistrySchema, type Registry } from './registry.js';

const CACHE_KEY = 'registry:models-yaml:cache:v1';
const TTL_SEC = 30;

export interface RegistryCache {
  get(): Promise<Registry | null>;
  set(reg: Registry): Promise<void>;
  clear(): Promise<void>;
}

export interface MakeRegistryCacheOpts {
  valkey: ValkeyClient;
  log: Logger;
}

export function makeRegistryCache(opts: MakeRegistryCacheOpts): RegistryCache {
  const { valkey, log } = opts;
  return {
    async get(): Promise<Registry | null> {
      let raw: string | null;
      try {
        raw = await valkey.get(CACHE_KEY);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'registry cache: get failed (valkey down), returning null',
        );
        return null;
      }
      if (!raw) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'registry cache: malformed JSON in Valkey; returning null',
        );
        return null;
      }
      // Re-validate through RegistrySchema — defense in depth.
      // safeParse never throws; on failure result.error.issues[0] carries the first zod issue.
      const result = RegistrySchema.safeParse(parsed);
      if (!result.success) {
        log.warn(
          { issue: result.error.issues[0] },
          'registry cache: schema mismatch; returning null',
        );
        return null;
      }
      return result.data;
    },
    async set(reg: Registry): Promise<void> {
      try {
        await valkey.set(CACHE_KEY, JSON.stringify(reg), 'EX', TTL_SEC);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'registry cache: set failed (non-fatal)',
        );
      }
    },
    async clear(): Promise<void> {
      try {
        await valkey.del(CACHE_KEY);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'registry cache: clear failed (non-fatal)',
        );
      }
    },
  };
}
