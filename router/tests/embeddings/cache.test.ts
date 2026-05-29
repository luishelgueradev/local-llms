/**
 * cache.test.ts — Phase 12 (v0.10.0 — EMB-H01, EMB-H04, EMB-H05) unit tests for
 * the embeddings cache module. Asserts:
 *
 *   1. Key construction is deterministic AND varies with every input dimension
 *      (backend, backend_model, encoding_format, dimensions, input). Different
 *      values in ANY field produce a different key. (EMB-H05)
 *   2. get/set round-trip via a hand-rolled Valkey mock (same shape as the real
 *      ioredis surface: get/set with optional EX seconds).
 *   3. get returns null on a clean miss (Valkey returned null).
 *   4. get treats a corrupt cached value (un-parseable JSON) as a miss + logs warn.
 *   5. get propagates Valkey errors so the caller's fail-open catch can fire.
 *      (EMB-H04 — the route is the fail-open boundary, not this module.)
 *
 * The Valkey mock here intentionally implements ONLY the get/set surface the
 * cache uses. Adding methods later (DEL on TTL expiry, SCAN for ops tools) is
 * additive and won't break these tests.
 */
import { describe, expect, it } from 'vitest';
import {
  embeddingsCacheKey,
  makeEmbeddingsCache,
  type CachedVector,
} from '../../src/embeddings/cache.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

class ValkeyMock {
  public store = new Map<string, string>();
  public lastEx?: number;
  public getThrows: Error | null = null;
  public setThrows: Error | null = null;

  async get(key: string): Promise<string | null> {
    if (this.getThrows) throw this.getThrows;
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: 'EX', ex: number): Promise<'OK'> {
    if (this.setThrows) throw this.setThrows;
    this.lastEx = ex;
    this.store.set(key, value);
    return 'OK';
  }
}

const makeMock = (): { valkey: ValkeyClient; mock: ValkeyMock } => {
  const mock = new ValkeyMock();
  return { valkey: mock as unknown as ValkeyClient, mock };
};

/** Plain logger spy — vitest's vi.fn() doesn't satisfy the cache's narrow logger
 * shape `(...args: unknown[]) => void` cleanly under strict TS. */
function makeLog(): { warn: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    warn: (...args: unknown[]) => {
      calls.push(args);
    },
    calls,
  };
}

describe('embeddingsCacheKey — determinism + sensitivity to every dimension (EMB-H05)', () => {
  const base = {
    backend: 'ollama',
    backend_model: 'bge-m3',
    encoding_format: 'float' as const,
    dimensions: undefined,
    input: 'hola',
  };

  it('produces a stable key for identical args', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base });
    expect(a).toBe(b);
    expect(a.startsWith('emb:')).toBe(true);
    // sha256 truncated to 32 hex chars + `emb:` prefix → 36 chars total.
    expect(a.length).toBe(36);
  });

  it('changes the key when backend changes', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base, backend: 'vllm-embed' });
    expect(a).not.toBe(b);
  });

  it('changes the key when backend_model changes (EMB-H05 — alias hot-swap invalidation)', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base, backend_model: 'bge-m3-v2' });
    expect(a).not.toBe(b);
  });

  it('changes the key when encoding_format changes', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base, encoding_format: 'base64' });
    expect(a).not.toBe(b);
  });

  it('changes the key when dimensions changes', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base, dimensions: 512 });
    expect(a).not.toBe(b);
  });

  it('changes the key when input changes', () => {
    const a = embeddingsCacheKey(base);
    const b = embeddingsCacheKey({ ...base, input: 'adios' });
    expect(a).not.toBe(b);
  });

  it('treats omitted encoding_format as "float" (default canonical form)', () => {
    const a = embeddingsCacheKey({ ...base, encoding_format: undefined });
    const b = embeddingsCacheKey({ ...base, encoding_format: 'float' });
    expect(a).toBe(b);
  });
});

describe('makeEmbeddingsCache — get/set round trip', () => {
  it('returns null on a clean miss', async () => {
    const { valkey, mock } = makeMock();
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log: makeLog() });
    const result = await cache.get('emb:abc');
    expect(result).toBeNull();
    expect(mock.store.size).toBe(0);
  });

  it('round-trips a number[] vector', async () => {
    const { valkey, mock } = makeMock();
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log: makeLog() });
    const vec: CachedVector = [0.1, 0.2, 0.3];
    await cache.set('emb:abc', vec);
    expect(mock.lastEx).toBe(60);
    const result = await cache.get('emb:abc');
    expect(result).toEqual(vec);
  });

  it('round-trips a base64 string vector', async () => {
    const { valkey } = makeMock();
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log: makeLog() });
    const vec: CachedVector = 'AAECAwQFBgc=';
    await cache.set('emb:abc', vec);
    const result = await cache.get('emb:abc');
    expect(result).toBe(vec);
  });

  it('treats corrupt cached values as a miss + logs warn', async () => {
    const { valkey, mock } = makeMock();
    const log = makeLog();
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log });
    mock.store.set('emb:abc', '{not-valid-json');
    const result = await cache.get('emb:abc');
    expect(result).toBeNull();
    expect(log.calls.length).toBe(1);
  });

  it('propagates Valkey errors from get so the route can fail-open (EMB-H04)', async () => {
    const { valkey, mock } = makeMock();
    mock.getThrows = new Error('ECONNREFUSED');
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log: makeLog() });
    await expect(cache.get('emb:abc')).rejects.toThrow('ECONNREFUSED');
  });

  it('propagates Valkey errors from set so the route can fail-open (EMB-H04)', async () => {
    const { valkey, mock } = makeMock();
    mock.setThrows = new Error('OOM');
    const cache = makeEmbeddingsCache({ valkey, ttlSec: 60, log: makeLog() });
    await expect(cache.set('emb:abc', [0.1])).rejects.toThrow('OOM');
  });
});
