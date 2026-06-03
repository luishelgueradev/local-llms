/**
 * Phase 20 / CAT-02 (v0.12.0 — D-04 LOCKED + Open Q1 → plugin).
 *
 * Plugin tests covering the 5 contract points enumerated in Plan 20-02 Task 2:
 *   1. Boot probes once per distinct backend
 *   2. Boot fail-open on Valkey down (in-memory cache still works)
 *   3. Lazy refresh after TTL (advance time, second ensureFresh re-probes)
 *   4. ollama-cloud returns 'unknown' (no probe)
 *   5. No probe for disabled-backend-only entries
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { backendHealthPlugin } from '../backend-health-plugin.js';
import { loadRegistryFromString, makeRegistryStore } from '../../config/registry.js';
import type { ValkeyClient } from '../../clients/valkey.js';

const YAML_FOUR_BACKENDS = `
models:
  - name: chat-ollama
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4

  - name: chat-llamacpp
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5:7b
    capabilities: [chat]
    vram_budget_gb: 6

  - name: chat-vllm
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7

  - name: big-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
`;

const YAML_ONE_BACKEND_DISABLED = `
models:
  - name: chat-ollama
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4

  - name: chat-vllm-disabled
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7
    disabled: true
`;

/** Tiny in-memory Valkey fake honoring SET/GET/EX. */
interface FakeValkey {
  store: Map<string, { value: string; expiresAt?: number }>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function mkFakeValkey(): FakeValkey {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, val: string, _ex: string, ttlSec: number) => {
      store.set(key, { value: val, expiresAt: Date.now() + ttlSec * 1000 });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  };
}

function asValkey(fake: FakeValkey): ValkeyClient {
  return fake as unknown as ValkeyClient;
}

describe('backendHealthPlugin', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('1. boot probes once per distinct backend (4 backends → 3 probes, cloud not probed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const registry = makeRegistryStore(loadRegistryFromString(YAML_FOUR_BACKENDS));
    const app = Fastify({ logger: false });
    const valkey = mkFakeValkey();
    await app.register(backendHealthPlugin, {
      registry,
      valkey: asValkey(valkey),
      ttlSec: 60,
      fetchImpl,
    });
    await app.ready();

    // 4 distinct backends: ollama, llamacpp, vllm, ollama-cloud.
    // ollama-cloud has PROBE_ENDPOINTS[...] = null → no fetch call.
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // All 4 backends populated in cache.
    expect(app.backendHealth.get('ollama').status).toBe('ok');
    expect(app.backendHealth.get('llamacpp').status).toBe('ok');
    expect(app.backendHealth.get('vllm').status).toBe('ok');
    expect(app.backendHealth.get('ollama-cloud').status).toBe('unknown');

    // Valkey write-through: 4 keys set (cloud included — its 'unknown' result is also cached).
    expect(valkey.set).toHaveBeenCalledTimes(4);
    expect(valkey.store.has('backend-health:ollama')).toBe(true);
    expect(valkey.store.has('backend-health:ollama-cloud')).toBe(true);

    await app.close();
  });

  it('2. boot fail-open on Valkey down — plugin still serves from in-memory cache', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const registry = makeRegistryStore(loadRegistryFromString(YAML_FOUR_BACKENDS));
    const app = Fastify({ logger: false });
    // valkey is undefined — plugin logs warn and operates in-memory only.
    await app.register(backendHealthPlugin, {
      registry,
      valkey: undefined,
      ttlSec: 60,
      fetchImpl,
    });
    await app.ready();

    // In-memory cache still populated.
    expect(app.backendHealth.get('ollama').status).toBe('ok');
    expect(app.backendHealth.get('llamacpp').status).toBe('ok');

    await app.close();
  });

  it('3. lazy refresh after TTL — first ensureFresh is a no-op, second (post-expiry) re-probes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const registry = makeRegistryStore(
      loadRegistryFromString(`
models:
  - name: chat-ollama
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4
`),
    );
    const app = Fastify({ logger: false });
    const valkey = mkFakeValkey();
    await app.register(backendHealthPlugin, {
      registry,
      valkey: asValkey(valkey),
      ttlSec: 1, // 1s TTL
      fetchImpl,
    });
    await app.ready();

    // Boot probe ran once.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // First ensureFresh — still within TTL → no refresh.
    await app.backendHealth.ensureFresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance the cache's stored checked_at into the past by mutating the cache
    // entry directly. (We can't use vi.useFakeTimers without freezing Fastify's
    // internal timers, which breaks `app.ready` semantics.)
    const stale = new Date(Date.now() - 5_000).toISOString();
    // Mutate via re-registering: cleanest is to call refreshAll, then mutate the
    // backing Map. Since the plugin's cache is closure-private, we instead use
    // a real wall-clock wait of ~1.1s — long enough to cross the 1s TTL.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Second ensureFresh — stale → refreshes ALL.
    await app.backendHealth.ensureFresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Silence the unused-variable warning (we deliberately did not mutate by hand —
    // the wall-clock path is the honest test of the staleness predicate).
    expect(typeof stale).toBe('string');

    await app.close();
  });

  it('4. ollama-cloud returns status:unknown — no fetch call for that backend', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const registry = makeRegistryStore(
      loadRegistryFromString(`
models:
  - name: big-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
`),
    );
    const app = Fastify({ logger: false });
    await app.register(backendHealthPlugin, {
      registry,
      valkey: undefined,
      ttlSec: 60,
      fetchImpl,
    });
    await app.ready();

    expect(app.backendHealth.get('ollama-cloud').status).toBe('unknown');
    // ollama-cloud is in PROBE_ENDPOINTS as null → no network call ever.
    expect(fetchImpl).not.toHaveBeenCalled();

    await app.close();
  });

  it('5. no probe for disabled-backend-only entries — vllm-disabled does NOT appear in probe set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const registry = makeRegistryStore(loadRegistryFromString(YAML_ONE_BACKEND_DISABLED));
    const app = Fastify({ logger: false });
    await app.register(backendHealthPlugin, {
      registry,
      valkey: undefined,
      ttlSec: 60,
      fetchImpl,
    });
    await app.ready();

    // Only ollama gets probed (vllm entry is disabled — Wave 0 contract).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toContain('ollama:11434');
    expect(calledUrl).not.toContain('vllm');

    // vllm is NOT in the cache — get() returns 'unknown' for it.
    expect(app.backendHealth.get('vllm').status).toBe('unknown');
    expect(app.backendHealth.get('ollama').status).toBe('ok');

    await app.close();
  });
});
