/**
 * Unit tests for /readyz stale detection logic (Plan 03-03, ROUTE-06).
 * Tests the stale-detection math: age > 2 × INTERVAL_MS (20_000ms) → 'stale'.
 * Uses a fake LivenessScheduler injected into registerReadyz.
 */

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerReadyz } from '../../src/routes/readyz.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type { LivenessScheduler, ProbeResult } from '../../src/backends/liveness.js';

const ONE_URL_YAML = `
models:
  - name: test-model
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2
    capabilities: [chat]
    vram_budget_gb: 4
`;

const TWO_URL_YAML = `
models:
  - name: test-model-1
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2
    capabilities: [chat]
    vram_budget_gb: 4

  - name: test-model-2
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5
    capabilities: [chat]
    vram_budget_gb: 6
`;

function makeFakeScheduler(results: Map<string, ProbeResult | undefined>): LivenessScheduler {
  return {
    get: (url: string) => results.get(url),
    urls: () => Array.from(results.keys()).filter((k) => results.get(k) !== undefined),
    start: () => {},
    stop: () => {},
    refresh: async () => {},
  };
}

describe('/readyz stale detection', () => {
  // -------------------------------------------------------------------------
  // Test 1: lastProbeAt older than 2 × INTERVAL_MS → stale
  // -------------------------------------------------------------------------
  it('1. reports stale when lastProbeAt is older than 2 × INTERVAL_MS (>20s)', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const now = Date.now();
    const staleResult: ProbeResult = {
      status: 'alive',
      lastProbeAt: new Date(now - 25_000).toISOString(), // 25s old > 20s threshold
    };
    const scheduler = makeFakeScheduler(new Map([['http://ollama:11434/v1', staleResult]]));

    registerReadyz(app, registry, scheduler);

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json() as { status: string; backends: Array<{ status: string }> };
    expect(body.backends[0].status).toBe('stale');
    expect(res.statusCode).toBe(503); // stale counts as not-ready
  });

  // -------------------------------------------------------------------------
  // Test 2: lastProbeAt within 2 × INTERVAL_MS → keeps original status
  // -------------------------------------------------------------------------
  it('2. reports alive when lastProbeAt is within 2 × INTERVAL_MS (15s ago)', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const now = Date.now();
    const freshResult: ProbeResult = {
      status: 'alive',
      lastProbeAt: new Date(now - 15_000).toISOString(), // 15s old < 20s threshold
    };
    const scheduler = makeFakeScheduler(new Map([['http://ollama:11434/v1', freshResult]]));

    registerReadyz(app, registry, scheduler);

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json() as { status: string; backends: Array<{ status: string }> };
    expect(body.backends[0].status).toBe('alive');
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Test 3: down + old lastProbeAt → stale (stale takes priority over down)
  // -------------------------------------------------------------------------
  it('3. reports stale when lastProbeAt is >20s old even if status was down', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const now = Date.now();
    const oldDownResult: ProbeResult = {
      status: 'down',
      lastProbeAt: new Date(now - 30_000).toISOString(), // 30s old > 20s threshold
      error: 'ECONNREFUSED',
    };
    const scheduler = makeFakeScheduler(new Map([['http://ollama:11434/v1', oldDownResult]]));

    registerReadyz(app, registry, scheduler);

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json() as { status: string; backends: Array<{ status: string }> };
    expect(body.backends[0].status).toBe('stale');
    expect(res.statusCode).toBe(503);
  });

  // -------------------------------------------------------------------------
  // Test 4: No cache entry → down with error: 'never probed'
  // -------------------------------------------------------------------------
  it('4. reports down with error:"never probed" when cache entry is missing', async () => {
    const app = Fastify({ logger: false });
    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const scheduler = makeFakeScheduler(new Map([['http://ollama:11434/v1', undefined]]));

    registerReadyz(app, registry, scheduler);

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json() as { status: string; backends: Array<{ status: string; error?: string }> };
    expect(body.backends[0].status).toBe('down');
    expect(body.backends[0].error).toBe('never probed');
    expect(res.statusCode).toBe(503);
  });
});
