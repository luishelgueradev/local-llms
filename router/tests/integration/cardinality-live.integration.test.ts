/**
 * Phase 19 / v0.11.0 — OBSV-02 (Plan 19-05 flips Plan 19-01 Wave-0 scaffold).
 *
 * Live Prometheus cardinality scrape integration test. Boots a minimal
 * buildApp(...) fixture (no Postgres, no Valkey) and scrapes /metrics via
 * app.inject({ method: 'GET', url: '/metrics' }). Asserts:
 *   1. The rendered exposition has zero /_id$/ label violations.
 *   2. The exposition contains at least one labelled series (sanity — confirms
 *      prom-client actually rendered metrics, so the violations===[] check is
 *      not vacuous).
 *
 * Design notes:
 *   - No external services required (no PG_TESTS gate, no Valkey).
 *   - Uses checkCardinalityLive from router/scripts/check-prometheus-cardinality.ts
 *     (D-14 hand-rolled parser, zero new npm deps).
 *   - Builds the same minimal registry/bearerToken/bufferedWriter/metrics fixture
 *     pattern as tests/integration/auth.test.ts (canonical minimal-app pattern).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { checkCardinalityLive } from '../../scripts/check-prometheus-cardinality.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';

/** Bearer token used by the minimal fixture (must be >=8 chars per makeBearerHook). */
const TOKEN = 'local-llms-test-token';

/** Minimal registry YAML — single chat model; no embeddings, no MCP servers. */
const MINIMAL_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

describe('OBSV-02: live /metrics cardinality scrape', () => {
  it('rendered /metrics exposition has zero /_id$/ labels', async () => {
    const registry = makeRegistryStore(loadRegistryFromString(MINIMAL_YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
    });
    try {
      const r = await app.inject({ method: 'GET', url: '/metrics' });
      expect(r.statusCode).toBe(200);
      const violations = checkCardinalityLive(r.body);
      expect(violations).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('exposition contains at least one labelled series (sanity: prom-client actually rendered metrics)', async () => {
    const registry = makeRegistryStore(loadRegistryFromString(MINIMAL_YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
    });
    try {
      const r = await app.inject({ method: 'GET', url: '/metrics' });
      // Confirm /metrics is rendering labelled metrics (not just unlabeled ones),
      // so the violations===[] assertion above is not vacuous.
      expect(r.body).toMatch(/^[a-z0-9_]+\{[^}]+\}/m);
    } finally {
      await app.close();
    }
  });
});
