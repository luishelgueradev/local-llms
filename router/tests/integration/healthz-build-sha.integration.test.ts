import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';

/**
 * Phase 20 (v0.12.0 — OPS-02 / D-08): integration tests for /healthz BUILD_SHA
 * + /version public exposure. Cases:
 *
 *   1. Default sentinel — no BUILD_SHA env → /healthz + /version both report
 *      build_sha: 'unknown' + git_dirty: true.
 *   2. Stubbed env — BUILD_SHA='deadbeef' → /healthz + /version both report
 *      build_sha: 'deadbeef' + git_dirty: false (SHAs match between endpoints).
 *   3. /version is public — GET /version with NO Authorization header → 200.
 *   4. /healthz is public — existing contract preserved (GET /healthz with no
 *      Authorization → 200).
 */

const TOKEN = 'local-llms_healthz_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

async function makeApp(): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeMetricsRegistry(),
  });
}

describe('Phase 20 OPS-02 — /healthz BUILD_SHA + /version integration', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
    delete process.env['BUILD_SHA'];
    delete process.env['BUILD_TIME'];
  });

  it('Default sentinel — no BUILD_SHA env: /healthz + /version both report unknown + git_dirty: true', async () => {
    delete process.env['BUILD_SHA'];
    delete process.env['BUILD_TIME'];
    app = await makeApp();

    const healthzRes = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthzRes.statusCode).toBe(200);
    const healthz = healthzRes.json();
    expect(healthz.build_sha).toBe('unknown');
    expect(healthz.git_dirty).toBe(true);
    expect(healthz.build_time).toBe('unknown');

    const versionRes = await app.inject({ method: 'GET', url: '/version' });
    expect(versionRes.statusCode).toBe(200);
    const version = versionRes.json();
    expect(version.build_sha).toBe('unknown');
    expect(version.git_dirty).toBe(true);
    expect(version.build_time).toBe('unknown');
  });

  it('Stubbed env BUILD_SHA=deadbeef: /healthz + /version both report SHA matching, git_dirty: false', async () => {
    process.env['BUILD_SHA'] = 'deadbeef';
    process.env['BUILD_TIME'] = '2026-06-03T11:30:00Z';
    app = await makeApp();

    const healthzRes = await app.inject({ method: 'GET', url: '/healthz' });
    const versionRes = await app.inject({ method: 'GET', url: '/version' });

    expect(healthzRes.statusCode).toBe(200);
    expect(versionRes.statusCode).toBe(200);

    const healthz = healthzRes.json();
    const version = versionRes.json();

    expect(healthz.build_sha).toBe('deadbeef');
    expect(version.build_sha).toBe('deadbeef');
    // CRITICAL: SHAs MUST match between endpoints (single source of truth).
    expect(healthz.build_sha).toBe(version.build_sha);
    expect(healthz.build_time).toBe(version.build_time);
    expect(healthz.git_dirty).toBe(false);
    expect(version.git_dirty).toBe(false);
  });

  it('/version is public — GET /version with NO Authorization header returns 200 (not 401)', async () => {
    app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    // Sanity: NOT a 401 envelope
    const body = res.json();
    expect(body).toHaveProperty('build_sha');
    expect(body).toHaveProperty('build_time');
    expect(body).toHaveProperty('node_version');
    expect(body).toHaveProperty('git_dirty');
  });

  it('/healthz is public — existing contract preserved (no Authorization → 200)', async () => {
    app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Existing fields preserved (backward-compat invariant)
    expect(body.status).toBe('ok');
    expect(body.service).toBe('router');
    expect(body.phase).toBe(2);
    expect(body.registry_models).toBe(1);
    // New OPS-02 fields present
    expect(body).toHaveProperty('build_sha');
    expect(body).toHaveProperty('git_dirty');
  });
});
