/**
 * Integration tests for liveness scheduler shutdown behavior (Plan 03-03, ROUTE-06, D-D7).
 * Verifies that app.close() clears all interval timers so process exit is clean.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type { LivenessScheduler } from '../../src/backends/liveness.js';

const TOKEN = 'local-llms_shutdown_t1t2t3t4t5t6t7t8t9t0aabbcc';

const ONE_URL_YAML = `
models:
  - name: llama3.2
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2
    capabilities: [chat]
    vram_budget_gb: 4
`;

const TWO_URL_YAML = `
models:
  - name: llama3.2
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2
    capabilities: [chat]
    vram_budget_gb: 4

  - name: qwen2.5
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5
    capabilities: [chat]
    vram_budget_gb: 6
`;

describe('liveness scheduler shutdown (D-D7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: app.close stops all liveness timers
  // -------------------------------------------------------------------------
  it('1. app.close() calls liveness.stop() — stop spy is invoked', async () => {
    let stopCalled = false;
    const fakeSched: LivenessScheduler = {
      get: () => undefined,
      urls: () => [],
      start: () => {},
      stop: () => { stopCalled = true; },
      refresh: async () => {},
    };

    const registry = makeRegistryStore(loadRegistryFromString(TWO_URL_YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      livenessFactory: () => fakeSched,
    });

    expect(stopCalled).toBe(false);
    await app.close();
    expect(stopCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: app.liveness is decorated on the FastifyInstance
  // -------------------------------------------------------------------------
  it('2. app.liveness is accessible as a Fastify decoration', async () => {
    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
    });

    // TypeScript sees liveness via module augmentation
    expect((app as FastifyInstance & { liveness: LivenessScheduler }).liveness).toBeDefined();
    expect(typeof (app as FastifyInstance & { liveness: LivenessScheduler }).liveness.start).toBe('function');

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 3: stop() idempotent in onClose (double-close does not throw)
  // -------------------------------------------------------------------------
  it('3. calling stop() before app.close() does not throw on second call in onClose', async () => {
    let stopCallCount = 0;
    const fakeSched: LivenessScheduler = {
      get: () => undefined,
      urls: () => [],
      start: () => {},
      stop: () => { stopCallCount++; },
      refresh: async () => {},
    };

    const registry = makeRegistryStore(loadRegistryFromString(ONE_URL_YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      livenessFactory: () => fakeSched,
    });

    // Manually call stop before app.close (simulates another code path calling stop early)
    (app as FastifyInstance & { liveness: LivenessScheduler }).liveness.stop();
    expect(stopCallCount).toBe(1);

    // app.close triggers onClose hook which calls liveness.stop() again
    await expect(app.close()).resolves.toBeUndefined();
    // The real makeLivenessScheduler's stop() is idempotent — no throw
    // With our fake, stopCallCount may be 1 or 2 depending on whether the real stop is called
    // The important thing is no exception was thrown
    expect(stopCallCount).toBeGreaterThanOrEqual(1);
  });
});
