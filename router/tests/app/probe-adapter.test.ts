/**
 * Phase 8 Plan 00 — probeAdapterFor disambiguation regression tests.
 *
 * Closes the Phase 8 precondition flagged in 07-REVIEW-FIX.md §CR-02:
 *
 *   probeAdapterFor() must key its adapter cache by `${backend}|${url}` and
 *   resolve the ModelEntry by BOTH (backend, url) — not by URL alone. The
 *   scheduler probe callback must look up the backend from the registry by
 *   URL FIRST before calling probeAdapterFor(backend, url).
 *
 * Test 3: probeAdapterFor disambiguation under two-backends-one-URL fixture
 *   (bypass the schema gate by seeding makeRegistryStore directly — the
 *   schema gate is exercised by tests/config/registry.test.ts; this file
 *   exercises the runtime cache shape).
 *
 * Test 4: scheduler probe callback resolves backend by URL and gracefully
 *   handles an unknown URL by returning { ok: false, error: /no registry
 *   entry for url/ } instead of throwing.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { makeRegistryStore, type Registry } from '../../src/config/registry.js';
import type { LivenessScheduler, MakeLivenessSchedulerOpts } from '../../src/backends/liveness.js';
import type { BackendAdapter, AdapterFactory } from '../../src/backends/adapter.js';

const TOKEN = 'local-llms_probe_t1t2t3t4t5t6t7t8t9t0aabb';

/**
 * Build a registry snapshot that contains two ModelEntries sharing the SAME
 * backend_url but with DISTINCT `backend` values. We seed via makeRegistryStore
 * (not loadRegistryFromString), bypassing the schema gate — the schema gate
 * is tested elsewhere; this fixture exercises runtime behavior given a
 * snapshot that somehow holds two adapters at one URL.
 *
 * Cast `as unknown as Registry` because the test fixture violates the schema
 * invariant on purpose (to prove that the cache shape disambiguates even if
 * a registry were to leak this state past the gate).
 */
function makeSharedUrlRegistry(): ReturnType<typeof makeRegistryStore> {
  const reg = {
    models: [
      {
        name: 'm-backend-a',
        backend: 'backend-a',
        backend_url: 'http://shared:1234/v1',
        backend_model: 'm-backend-a',
        capabilities: ['chat'],
        vram_budget_gb: 4,
      },
      {
        name: 'm-backend-b',
        backend: 'backend-b',
        backend_url: 'http://shared:1234/v1',
        backend_model: 'm-backend-b',
        capabilities: ['chat'],
        vram_budget_gb: 4,
      },
    ],
  } as unknown as Registry;
  return makeRegistryStore(reg);
}

/**
 * Distinct adapter classes per backend so the test can tell them apart by
 * `instanceof` after probeAdapterFor() builds them. Both implement the
 * BackendAdapter shape minimally — only probeLiveness needs to be callable
 * (the scheduler test path is what we care about).
 */
class FakeAdapterA implements BackendAdapter {
  constructor(public readonly baseURL: string) {}
  chatCompletionsCanonical(): never {
    throw new Error('not used');
  }
  chatCompletionsCanonicalStream(): never {
    throw new Error('not used');
  }
  async probeLiveness(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 1 };
  }
  embeddings(): never {
    throw new Error('not used');
  }
}

class FakeAdapterB implements BackendAdapter {
  constructor(public readonly baseURL: string) {}
  chatCompletionsCanonical(): never {
    throw new Error('not used');
  }
  chatCompletionsCanonicalStream(): never {
    throw new Error('not used');
  }
  async probeLiveness(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 2 };
  }
  embeddings(): never {
    throw new Error('not used');
  }
}

const makeFakeAdapterByBackend: AdapterFactory = (entry) => {
  // Compare-as-string: the fixture deliberately uses non-enum backend strings
  // (cast via `as unknown as Registry` in makeSharedUrlRegistry) to exercise
  // cache disambiguation. Without the widening cast, the comparison narrows
  // to `never` (TS2367).
  const backend = entry.backend as string;
  if (backend === 'backend-a') return new FakeAdapterA(entry.backend_url);
  if (backend === 'backend-b') return new FakeAdapterB(entry.backend_url);
  throw new Error(`unexpected backend "${backend}" in test fixture`);
};

/**
 * Capture the scheduler opts that buildApp passes into livenessFactory so the
 * test can drive the `probe(url, signal)` callback directly — bypassing the
 * real scheduler's timer plumbing.
 */
function makeCapturingLivenessFactory(): {
  factory: (opts: MakeLivenessSchedulerOpts) => LivenessScheduler;
  getProbe: () => MakeLivenessSchedulerOpts['probe'];
} {
  let captured: MakeLivenessSchedulerOpts | null = null;
  const factory = (opts: MakeLivenessSchedulerOpts): LivenessScheduler => {
    captured = opts;
    return {
      get: () => undefined,
      urls: () => [],
      start: () => {},
      stop: () => {},
      refresh: async () => {},
    };
  };
  return {
    factory,
    getProbe: () => {
      if (!captured) throw new Error('livenessFactory not invoked yet');
      return captured.probe;
    },
  };
}

describe('probeAdapterFor — Phase 8 (backend, url) disambiguation (07-REVIEW-FIX §CR-02)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('Test 3: scheduler probe callback returns DIFFERENT adapter classes for the same URL under distinct backends', async () => {
    const registry = makeSharedUrlRegistry();
    const { factory, getProbe } = makeCapturingLivenessFactory();

    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: makeFakeAdapterByBackend,
      livenessFactory: factory,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
    });

    const probe = getProbe();
    // The scheduler's probe callback resolves the backend by URL. With the
    // shared-URL registry, BOTH entries match by URL — the callback will
    // pick the FIRST match each call. To prove the cache is keyed by
    // `${backend}|${url}` (not just url), we need to bypass the URL→backend
    // resolution in the callback and drive probeAdapterFor's two backends
    // explicitly. Since probeAdapterFor is not exported, we exercise it
    // indirectly: swap the order in the registry models array between
    // calls so the URL-find returns a different backend each time.
    const reg = registry.get();
    const originalModels = reg.models;

    // Call 1: backend-a is first (already so) → probe returns FakeAdapterA's result
    const ac = new AbortController();
    const r1 = await probe!('http://shared:1234/v1', ac.signal);
    expect(r1.ok).toBe(true);
    expect(r1.latencyMs).toBe(1); // FakeAdapterA returns latencyMs: 1

    // Call 2: swap so backend-b is first → URL-find returns backend-b entry,
    //         probeAdapterFor builds + caches a SECOND adapter under key
    //         `backend-b|http://shared:1234/v1`, NOT reusing the
    //         `backend-a|http://shared:1234/v1` entry.
    registry._swap({
      ...reg,
      models: [originalModels[1]!, originalModels[0]!],
    } as Registry);
    const r2 = await probe!('http://shared:1234/v1', ac.signal);
    expect(r2.ok).toBe(true);
    expect(r2.latencyMs).toBe(2); // FakeAdapterB returns latencyMs: 2

    // If probeAdapterFor were keyed by url alone, r2 would still return
    // FakeAdapterA's latencyMs (1) because the cache would hit on the
    // url-only key. The latencyMs flip (1 → 2) is the runtime proof that
    // the cache is keyed by `${backend}|${url}`.
  });

  it('Test 4: scheduler probe callback returns synthetic down for an unknown URL (no throw)', async () => {
    const registry = makeSharedUrlRegistry();
    const { factory, getProbe } = makeCapturingLivenessFactory();

    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: makeFakeAdapterByBackend,
      livenessFactory: factory,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
    });

    const probe = getProbe();
    const ac = new AbortController();
    const r = await probe!('http://nonexistent:9999/v1', ac.signal);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error!).toMatch(/no registry entry for url/);
  });
});
