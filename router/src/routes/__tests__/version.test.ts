import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { makeFakeBufferedWriter } from '../../../tests/fakes.js';
import { makeMetricsRegistry } from '../../metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../config/registry.js';
import { getBuildInfo } from '../../version.js';

/**
 * Phase 20 (v0.12.0 — OPS-02 / D-08): unit + integration tests for
 * getBuildInfo() and the public GET /version + /healthz extension.
 *
 * Test cases (6 total):
 *   1. getBuildInfo() with BUILD_SHA env set returns the value + git_dirty: false
 *   2. getBuildInfo() with no BUILD_SHA env returns 'unknown' + git_dirty: true
 *   3. node_version always reflects process.version
 *   4. Integration: GET /version returns 200 + expected JSON shape (no bearer needed)
 *   5. Integration: GET /healthz returns 200 + pre-existing fields AND new build fields
 *   6. Backward compat: /healthz still includes status, service, phase, registry_models
 */

const TOKEN = 'local-llms_test_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

describe('getBuildInfo() — unit', () => {
  afterEach(() => {
    delete process.env['BUILD_SHA'];
    delete process.env['BUILD_TIME'];
  });

  it('returns the BUILD_SHA env value + git_dirty: false when set', () => {
    process.env['BUILD_SHA'] = 'abc123def456';
    process.env['BUILD_TIME'] = '2026-06-03T12:00:00Z';
    const info = getBuildInfo();
    expect(info.build_sha).toBe('abc123def456');
    expect(info.build_time).toBe('2026-06-03T12:00:00Z');
    expect(info.git_dirty).toBe(false);
  });

  it("returns 'unknown' + git_dirty: true when BUILD_SHA env is absent", () => {
    delete process.env['BUILD_SHA'];
    delete process.env['BUILD_TIME'];
    const info = getBuildInfo();
    expect(info.build_sha).toBe('unknown');
    expect(info.build_time).toBe('unknown');
    expect(info.git_dirty).toBe(true);
  });

  it('node_version always reflects process.version', () => {
    const info = getBuildInfo();
    expect(info.node_version).toBe(process.version);
  });
});

describe('GET /version + /healthz integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env['BUILD_SHA'] = 'integration-test-sha-deadbeef';
    process.env['BUILD_TIME'] = '2026-06-03T11:00:00Z';
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeMetricsRegistry(),
    });
  });

  afterEach(async () => {
    await app.close();
    delete process.env['BUILD_SHA'];
    delete process.env['BUILD_TIME'];
  });

  it('GET /version returns 200 with expected JSON shape (no bearer needed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.build_sha).toBe('integration-test-sha-deadbeef');
    expect(body.build_time).toBe('2026-06-03T11:00:00Z');
    expect(body.node_version).toBe(process.version);
    expect(body.git_dirty).toBe(false);
    // Exact key set assertion — anti-leak invariant.
    expect(Object.keys(body).sort()).toEqual(['build_sha', 'build_time', 'git_dirty', 'node_version']);
  });

  it('GET /healthz returns 200 with both pre-existing fields AND new build fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Pre-existing fields preserved (additive contract)
    expect(body.status).toBe('ok');
    expect(body.service).toBe('router');
    expect(body.phase).toBe(2);
    expect(body.registry_models).toBe(1);
    // New Phase 20 OPS-02 fields
    expect(body.build_sha).toBe('integration-test-sha-deadbeef');
    expect(body.build_time).toBe('2026-06-03T11:00:00Z');
    expect(body.node_version).toBe(process.version);
    expect(body.git_dirty).toBe(false);
  });

  it('backward compat: /healthz still includes status, service, phase, registry_models (no removed fields)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const body = res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('service');
    expect(body).toHaveProperty('phase');
    expect(body).toHaveProperty('registry_models');
  });
});
