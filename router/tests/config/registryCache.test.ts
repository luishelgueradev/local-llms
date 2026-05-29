/**
 * Plan 08-09 (DATA-06) — registryCache.ts unit tests.
 *
 * Coverage (from 08-09-PLAN.md `<interfaces>` Tests 1-8):
 *   Test 1 (set/get round-trip): set(reg); get() returns a Registry deep-equal
 *     to reg.
 *   Test 2 (get on empty): valkey returns null → cache.get returns null.
 *   Test 3 (get on malformed JSON): valkey returns a non-JSON string →
 *     cache.get returns null (logs warn).
 *   Test 4 (get on schema mismatch): valkey returns JSON that fails
 *     RegistrySchema.parse → cache.get returns null (logs warn).
 *   Test 5 (set TTL): set(reg) calls valkey.set with 'EX', 30 — verify via the
 *     mock recording the EX arg.
 *   Test 6 (Valkey-down on get): mock throws → cache.get returns null without
 *     re-throwing.
 *   Test 7 (Valkey-down on set): mock throws → cache.set does NOT throw (logs
 *     warn).
 *   Test 8 (clear): cache.clear deletes the key.
 *
 * Uses a hand-rolled ValkeyMock (get + set + del — the cache's surface) in
 * the same style as Plans 08-04/08-06 tests.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { makeRegistryCache } from '../../src/config/registryCache.js';
import { loadRegistryFromString, type Registry } from '../../src/config/registry.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

const CACHE_KEY = 'registry:models-yaml:cache:v1';
const TTL_SEC = 300;

const VALID_YAML = `
models:
  - name: small
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: small
    capabilities: [chat]
    vram_budget_gb: 4

  - name: embed
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: embed
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
`;

// ── Hand-rolled Valkey mock (subset of ValkeyClient used by the cache) ──
class ValkeyMock {
  public store = new Map<string, string>();
  public ttls = new Map<string, number>();
  public setCalls: Array<{ key: string; value: string; mode?: string; ttl?: number }> = [];
  public delCalls: string[] = [];
  public getThrows = false;
  public setThrows = false;
  public delThrows = false;
  // Override returned by get() instead of looking up `store` — for the
  // malformed-JSON / schema-mismatch tests where we want to inject a specific
  // raw blob without going through set().
  public getOverride: string | null | undefined = undefined;

  async get(key: string): Promise<string | null> {
    if (this.getThrows) throw new Error('valkey-down: connect ECONNREFUSED');
    if (this.getOverride !== undefined) return this.getOverride;
    return this.store.get(key) ?? null;
  }

  // ioredis SET signature is variadic: SET key value [EX seconds | PX millis | KEEPTTL]
  // The cache uses the EX form: valkey.set(key, value, 'EX', TTL_SEC).
  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    if (this.setThrows) throw new Error('valkey-down: connect ECONNREFUSED');
    this.store.set(key, value);
    if (mode === 'EX' && typeof ttl === 'number') this.ttls.set(key, ttl);
    this.setCalls.push({ key, value, mode, ttl });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    if (this.delThrows) throw new Error('valkey-down: connect ECONNREFUSED');
    this.delCalls.push(key);
    const had = this.store.delete(key);
    return had ? 1 : 0;
  }
}

function makeMockLog(): Logger & { _calls: { warn: unknown[][] } } {
  const calls = { warn: [] as unknown[][] };
  const log = {
    warn: vi.fn((...args: unknown[]) => {
      calls.warn.push(args);
    }),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    _calls: calls,
  } as unknown as Logger & { _calls: { warn: unknown[][] } };
  return log;
}

describe('makeRegistryCache (Plan 08-09 / DATA-06)', () => {
  let valkey: ValkeyMock;
  let log: ReturnType<typeof makeMockLog>;
  let reg: Registry;

  beforeEach(() => {
    valkey = new ValkeyMock();
    log = makeMockLog();
    reg = loadRegistryFromString(VALID_YAML);
  });

  function makeCache() {
    return makeRegistryCache({
      valkey: valkey as unknown as ValkeyClient,
      log,
    });
  }

  // ── Test 1: set/get round-trip ───────────────────────────────────────────
  it('Test 1: set then get round-trips a Registry equal to the input', async () => {
    const cache = makeCache();
    await cache.set(reg);
    const fetched = await cache.get();
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(reg);
  });

  // ── Test 2: get on empty key returns null ───────────────────────────────
  it('Test 2: get returns null when Valkey has no entry for the key', async () => {
    const cache = makeCache();
    const fetched = await cache.get();
    expect(fetched).toBeNull();
  });

  // ── Test 3: malformed JSON in Valkey → null + warn ──────────────────────
  it('Test 3: get returns null (and logs warn) when the cached blob is non-JSON', async () => {
    valkey.getOverride = 'not-valid-json{{{';
    const cache = makeCache();
    const fetched = await cache.get();
    expect(fetched).toBeNull();
    expect(log._calls.warn.length).toBeGreaterThan(0);
    // First warn call should mention "malformed" (substring).
    const firstWarnMsg = JSON.stringify(log._calls.warn[0]);
    expect(firstWarnMsg).toMatch(/malformed/i);
  });

  // ── Test 4: well-formed JSON but failing RegistrySchema → null + warn ───
  it('Test 4: get returns null (and logs warn) when the cached JSON fails RegistrySchema', async () => {
    // Schema requires models[].backend in the LocalBackendEnum + vram_budget_gb
    // → an object lacking the `models` array will be rejected.
    valkey.getOverride = JSON.stringify({ tampered: true });
    const cache = makeCache();
    const fetched = await cache.get();
    expect(fetched).toBeNull();
    expect(log._calls.warn.length).toBeGreaterThan(0);
    const firstWarnMsg = JSON.stringify(log._calls.warn[0]);
    expect(firstWarnMsg).toMatch(/schema/i);
  });

  // ── Test 5: set TTL is 300s via EX mode (gap-closure 08-11 raises from 30→300) ─
  it('Test 5: set writes with EX mode and TTL=300 seconds', async () => {
    const cache = makeCache();
    await cache.set(reg);
    expect(valkey.setCalls.length).toBe(1);
    const call = valkey.setCalls[0]!;
    expect(call.key).toBe(CACHE_KEY);
    expect(call.mode).toBe('EX');
    expect(call.ttl).toBe(TTL_SEC);
    // Stored value is valid JSON that round-trips through the schema.
    expect(() => JSON.parse(call.value)).not.toThrow();
  });

  // ── Test 6: Valkey-down on get → null + warn, no rethrow ───────────────
  it('Test 6: get returns null (and logs warn) when Valkey throws', async () => {
    valkey.getThrows = true;
    const cache = makeCache();
    const fetched = await cache.get();
    expect(fetched).toBeNull();
    expect(log._calls.warn.length).toBeGreaterThan(0);
  });

  // ── Test 7: Valkey-down on set → no throw, warn logged ─────────────────
  it('Test 7: set does NOT throw when Valkey throws (logs warn)', async () => {
    valkey.setThrows = true;
    const cache = makeCache();
    await expect(cache.set(reg)).resolves.toBeUndefined();
    expect(log._calls.warn.length).toBeGreaterThan(0);
  });

  // ── Test 8: clear deletes the cache key ─────────────────────────────────
  it('Test 8: clear calls valkey.del with the cache key', async () => {
    const cache = makeCache();
    await cache.set(reg);
    await cache.clear();
    expect(valkey.delCalls).toContain(CACHE_KEY);
    // Subsequent get returns null.
    const fetched = await cache.get();
    expect(fetched).toBeNull();
  });

  // ── Test 8b: clear is non-fatal when Valkey throws ─────────────────────
  it('Test 8b: clear does NOT throw when Valkey throws (logs warn)', async () => {
    valkey.delThrows = true;
    const cache = makeCache();
    await expect(cache.clear()).resolves.toBeUndefined();
    expect(log._calls.warn.length).toBeGreaterThan(0);
  });
});
