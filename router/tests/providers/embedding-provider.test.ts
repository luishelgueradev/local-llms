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
import { describe, expect, it, expectTypeOf, vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/providers/embedding-provider.js';
import { makeOpenAIEmbeddingProvider } from '../../src/providers/embedding-provider.js';
import {
  CapabilityNotSupportedError,
  EmbeddingsDimsMismatchError,
  RegistryUnknownModelError,
} from '../../src/errors/envelope.js';
import type { ModelEntry, RegistryStore } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
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

  it('EmbeddingProvider.embed signature accepts model, dimensions?, user?, encoding_format?, signal?, entry?', async () => {
    // Phase 19 review fix: interface widened with optional `encoding_format`
    // (EMB-H06: provider honors base64-bypasses-cache), `signal` (SC3:
    // client-disconnect cancels upstream HTTP call), and `entry` (registry
    // torn-snapshot race: route passes the already-resolved ModelEntry from
    // applyPreflight so the provider does NOT re-resolve). All additive +
    // optional, so existing callers continue to compile.
    type EmbedOpts = Parameters<EmbeddingProvider['embed']>[1];
    expectTypeOf<EmbedOpts['model']>().toEqualTypeOf<string>();
    expectTypeOf<EmbedOpts['dimensions']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<EmbedOpts['user']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EmbedOpts['encoding_format']>().toEqualTypeOf<
      'float' | 'base64' | undefined
    >();
    expectTypeOf<EmbedOpts['signal']>().toEqualTypeOf<AbortSignal | undefined>();
    // ModelEntry is registry-typed; assert presence without re-importing schema.
    expectTypeOf<EmbedOpts['entry']>().not.toBeUndefined();
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

// ──────────────────────────────────────────────────────────────────────────
// Phase 19 review-deferred fix (#10): real-factory coverage for
// makeOpenAIEmbeddingProvider. Pre-fix the EMBP-01 suite only exercised the
// fake — dims enforcement, capability gate, registry.resolve, base64 decode,
// and count-mismatch paths were entirely uncovered, so a regression dropping
// the safety check (e.g. removing `vec.length !== entry.dims`) would have
// left every test green. The tests below construct a minimal RegistryStore +
// BackendAdapter pair and assert each guarantee directly against the real
// factory output.
// ──────────────────────────────────────────────────────────────────────────

interface FakeAdapterCall {
  input: string | string[];
  model: string;
  signal: AbortSignal | undefined;
  opts: Parameters<BackendAdapter['embeddings']>[3];
}

function makeProviderHarness(opts: {
  entry: ModelEntry;
  adapter?: Partial<BackendAdapter>;
  log?: Parameters<typeof makeOpenAIEmbeddingProvider>[0]['log'];
}): {
  provider: ReturnType<typeof makeOpenAIEmbeddingProvider>;
  calls: FakeAdapterCall[];
  cacheStore: Map<string, string | number[]>;
  cacheTotal: { hit: number; miss: number; bypass: number };
  dimsTotal: Array<{ model: string; dims: string; value: number }>;
} {
  const { entry } = opts;
  const calls: FakeAdapterCall[] = [];
  const cacheStore = new Map<string, string | number[]>();
  const cacheTotal = { hit: 0, miss: 0, bypass: 0 };
  const dimsTotal: Array<{ model: string; dims: string; value: number }> = [];

  const adapter: BackendAdapter = {
    embeddings: async (input, model, signal, embedOpts) => {
      calls.push({ input, model, signal, opts: embedOpts });
      const arr = Array.isArray(input) ? input : [input];
      return {
        object: 'list',
        data: arr.map((_, i) => ({
          object: 'embedding' as const,
          index: i,
          embedding: Array<number>(entry.dims ?? 4).fill(0.5),
        })),
        model: 'backend-reported-model-id',
        usage: { prompt_tokens: arr.length, total_tokens: arr.length },
      };
    },
    ...opts.adapter,
  } as BackendAdapter;

  const registry: RegistryStore = {
    get: () => ({ models: [entry], createdAt: new Date().toISOString() } as unknown as ReturnType<RegistryStore['get']>),
    getCreatedAtSec: () => Math.floor(Date.now() / 1000),
    resolve: (name: string) => {
      if (name !== entry.name) {
        throw new RegistryUnknownModelError(name, [entry.name]);
      }
      return entry;
    },
    _swap: () => {
      throw new Error('unused in tests');
    },
  };

  // In-memory cache that mirrors EmbeddingsCache shape (get/set returning the
  // value or null). Plays the role of opts.cacheOverride.
  const cacheOverride = {
    get: async (key: string) => (cacheStore.has(key) ? cacheStore.get(key)! : null),
    set: async (key: string, value: number[] | string) => {
      cacheStore.set(key, value);
    },
  };

  const provider = makeOpenAIEmbeddingProvider({
    registry,
    makeAdapter: () => adapter,
    cacheOverride: cacheOverride as Parameters<typeof makeOpenAIEmbeddingProvider>[0]['cacheOverride'],
    metrics: {
      embeddingsCacheTotal: {
        inc: ({ result }) => {
          cacheTotal[result]++;
        },
      },
      embeddingsDimsTotal: {
        inc: (labels, value = 1) => {
          dimsTotal.push({ model: labels.model, dims: labels.dims, value });
        },
      },
    },
    log: (opts.log ?? {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
      }),
    }) as Parameters<typeof makeOpenAIEmbeddingProvider>[0]['log'],
  });

  return { provider, calls, cacheStore, cacheTotal, dimsTotal };
}

function makeEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'embed-test',
    backend: 'ollama',
    backend_url: 'http://localhost:11434',
    backend_model: 'bge-m3',
    capabilities: ['embeddings'],
    vram_budget_gb: 1,
    dims: 4,
    ctx_size: 8192,
    context_strategy: 'sliding-window',
    ...overrides,
  } as ModelEntry;
}

describe('makeOpenAIEmbeddingProvider — real factory coverage (review-deferred #10)', () => {
  it('throws RegistryUnknownModelError when the model is not in the registry', async () => {
    const { provider } = makeProviderHarness({ entry: makeEntry() });
    await expect(provider.embed(['x'], { model: 'unknown-model' })).rejects.toThrow(
      RegistryUnknownModelError,
    );
  });

  it('throws CapabilityNotSupportedError when entry lacks the embeddings capability', async () => {
    const entry = makeEntry({ capabilities: ['chat'] });
    const { provider } = makeProviderHarness({ entry });
    await expect(provider.embed(['x'], { model: 'embed-test' })).rejects.toThrow(
      CapabilityNotSupportedError,
    );
  });

  it('throws EmbeddingsDimsMismatchError when upstream vector length != entry.dims', async () => {
    const entry = makeEntry({ dims: 1024 }); // declare 1024
    const adapter: Partial<BackendAdapter> = {
      embeddings: async () => ({
        object: 'list' as const,
        // upstream returns 4-dim — mismatch
        data: [{ object: 'embedding' as const, index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
        model: 'bge-m3',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    };
    const { provider } = makeProviderHarness({ entry, adapter });
    await expect(provider.embed(['x'], { model: 'embed-test' })).rejects.toThrow(
      EmbeddingsDimsMismatchError,
    );
  });

  it('throws count-mismatch when upstream returns fewer vectors than missed inputs', async () => {
    const entry = makeEntry({ dims: 4 });
    const adapter: Partial<BackendAdapter> = {
      embeddings: async () => ({
        object: 'list' as const,
        // only one vector for two inputs
        data: [
          { object: 'embedding' as const, index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
        ],
        model: 'bge-m3',
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    };
    const { provider } = makeProviderHarness({ entry, adapter });
    await expect(
      provider.embed(['a', 'b'], { model: 'embed-test' }),
    ).rejects.toThrow(/count mismatch/);
  });

  it('preserves upstream model id in the wire response (review fix #6 lock-in)', async () => {
    const entry = makeEntry({ dims: 4 });
    const { provider } = makeProviderHarness({ entry });
    const r = await provider.embed(['a'], { model: 'embed-test' });
    // The harness adapter reports 'backend-reported-model-id'; provider must
    // surface that string (NOT entry.name='embed-test').
    expect(r.model).toBe('backend-reported-model-id');
  });

  it('emits exactly one embeddings_dims_total inc per request, with value=inputs.length (review fix #8 lock-in)', async () => {
    const entry = makeEntry({ dims: 4 });
    const { provider, dimsTotal } = makeProviderHarness({ entry });
    await provider.embed(['a', 'b', 'c'], { model: 'embed-test' });
    expect(dimsTotal).toHaveLength(1);
    expect(dimsTotal[0]).toEqual({ model: 'embed-test', dims: '4', value: 3 });
  });

  it('decodes base64 upstream response into number[] (Float32Array LE)', async () => {
    const entry = makeEntry({ dims: 4 });
    // Encode [1.0, 2.0, 3.0, 4.0] as little-endian float32 base64 — same
    // wire format Ollama / sentence-transformer adapters return.
    const buf = Buffer.alloc(16);
    buf.writeFloatLE(1.0, 0);
    buf.writeFloatLE(2.0, 4);
    buf.writeFloatLE(3.0, 8);
    buf.writeFloatLE(4.0, 12);
    const base64 = buf.toString('base64');
    const adapter: Partial<BackendAdapter> = {
      embeddings: async () => ({
        object: 'list' as const,
        data: [{ object: 'embedding' as const, index: 0, embedding: base64 }],
        model: 'bge-m3',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    };
    const { provider } = makeProviderHarness({ entry, adapter });
    const r = await provider.embed(['x'], { model: 'embed-test' });
    expect(r.embeddings[0]).toEqual([1.0, 2.0, 3.0, 4.0]);
  });

  it('rejects (does NOT silently truncate) when base64 payload byteLength is not a multiple of 4 (review fix #11 lock-in)', async () => {
    const entry = makeEntry({ dims: 4 });
    // 17 bytes — one stray trailing byte. Pre-fix silently truncated; post-fix
    // throws so the corrupted payload cannot poison the cache.
    const corruptBuf = Buffer.alloc(17);
    corruptBuf.writeFloatLE(1.0, 0);
    corruptBuf.writeFloatLE(2.0, 4);
    corruptBuf.writeFloatLE(3.0, 8);
    corruptBuf.writeFloatLE(4.0, 12);
    const base64 = corruptBuf.toString('base64');
    const adapter: Partial<BackendAdapter> = {
      embeddings: async () => ({
        object: 'list' as const,
        data: [{ object: 'embedding' as const, index: 0, embedding: base64 }],
        model: 'bge-m3',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    };
    const { provider } = makeProviderHarness({ entry, adapter });
    await expect(provider.embed(['x'], { model: 'embed-test' })).rejects.toThrow(
      /not a multiple of 4/,
    );
  });

  it('cache: miss → upstream → set; second identical request → hit (no upstream call) (review fix lock-in)', async () => {
    const entry = makeEntry({ dims: 4 });
    const { provider, calls, cacheTotal, cacheStore } = makeProviderHarness({ entry });

    await provider.embed(['hello'], { model: 'embed-test' });
    expect(calls).toHaveLength(1);
    expect(cacheTotal).toEqual({ hit: 0, miss: 1, bypass: 0 });
    expect(cacheStore.size).toBe(1);

    await provider.embed(['hello'], { model: 'embed-test' });
    // Upstream MUST NOT be hit a second time.
    expect(calls).toHaveLength(1);
    expect(cacheTotal).toEqual({ hit: 1, miss: 1, bypass: 0 });
  });

  it('encoding_format=base64 skips cache get/set AND emits bypass per input (review fix #3/#5 lock-in — EMB-H06)', async () => {
    const entry = makeEntry({ dims: 4 });
    const { provider, cacheStore, cacheTotal } = makeProviderHarness({ entry });

    await provider.embed(['a', 'b'], {
      model: 'embed-test',
      encoding_format: 'base64',
    });
    // Provider must not pollute the float cache with base64 traffic.
    expect(cacheStore.size).toBe(0);
    // Bypass emitted per input.
    expect(cacheTotal).toEqual({ hit: 0, miss: 0, bypass: 2 });
  });

  it('skips registry.resolve when callOpts.entry is supplied (review fix #9 lock-in — torn-snapshot guard)', async () => {
    // Build a registry whose resolve() throws to PROVE the provider doesn't call it.
    const sentinelEntry = makeEntry();
    let resolveCalled = 0;
    const exploder: RegistryStore = {
      get: () => ({ models: [sentinelEntry] } as unknown as ReturnType<RegistryStore['get']>),
      getCreatedAtSec: () => 0,
      resolve: () => {
        resolveCalled++;
        throw new Error('registry.resolve must not be called when entry is supplied');
      },
      _swap: () => {
        throw new Error('unused');
      },
    };
    const adapter = {
      embeddings: async () => ({
        object: 'list' as const,
        data: [
          {
            object: 'embedding' as const,
            index: 0,
            embedding: Array<number>(4).fill(0.5),
          },
        ],
        model: 'bge-m3',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    } as unknown as BackendAdapter;
    const provider = makeOpenAIEmbeddingProvider({
      registry: exploder,
      makeAdapter: () => adapter,
      metrics: {
        embeddingsCacheTotal: { inc: vi.fn() },
        embeddingsDimsTotal: { inc: vi.fn() },
      },
      log: ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: () => ({
          warn: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          debug: vi.fn(),
          trace: vi.fn(),
          fatal: vi.fn(),
        }),
      } as unknown) as Parameters<typeof makeOpenAIEmbeddingProvider>[0]['log'],
    });

    await provider.embed(['x'], { model: 'embed-test', entry: sentinelEntry });
    expect(resolveCalled).toBe(0);
  });

  it('forwards callOpts.signal to adapter.embeddings (review fix #1 lock-in — SC3 propagation)', async () => {
    const entry = makeEntry({ dims: 4 });
    const { provider, calls } = makeProviderHarness({ entry });
    const controller = new AbortController();
    await provider.embed(['x'], { model: 'embed-test', signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
