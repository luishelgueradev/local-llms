import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
// Phase 3: capabilities + vram_budget_gb are required in the schema.
const YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

let app: FastifyInstance;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'router-auth-it-'));
  writeFileSync(join(tmpDir, 'models.yaml'), YAML);
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
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bearer auth + skip-list (SC4 auth half, ROUTE-03, ROUTE-04)', () => {
  it('GET /healthz returns 200 with NO Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('router');
    expect(body.phase).toBe(2);
    expect(body.registry_models).toBe(1);
  });

  it('GET /healthz returns 200 even with a wrong token (skip-list does not validate)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/healthz',
      headers: { authorization: 'Bearer totally-wrong' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('Any /v1/* request returns 401 with NO Authorization header', async () => {
    // The actual chat-completions route lands in plan 02-03; for now we
    // just need ANY /v1/* path. Fastify will return 404 from the router
    // ONLY if auth passes — auth runs in preHandler, before route matching.
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('Any /v1/* request returns 401 with malformed Authorization', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: TOKEN }, // missing 'Bearer ' prefix
    });
    expect(res.statusCode).toBe(401);
  });

  it('Any /v1/* request returns 401 with wrong bearer', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /metrics unauth returns 200 + text/plain content-type (D-C5 skip-list)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // Body should contain at least one custom metric HELP line.
    expect(res.body).toContain('router_requests_total');
  });

  it('Any /v1/* request returns NOT 401 with correct bearer (route now wired in plan 02-03)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // After plan 02-03, the route exists. Auth passes (correct token),
    // then zod validation rejects the missing body -> 400.
    expect(res.statusCode).not.toBe(401);
    expect([400, 404, 405]).toContain(res.statusCode);
  });

  // RFC 7235 §2.1 — the auth-scheme token is case-insensitive. Regression gate
  // for the WR-02 / TD-01 fix in bearer.ts (only the 7-byte scheme prefix is
  // lower-cased; credential bytes stay untouched so timingSafeEqual sees them
  // verbatim).
  it.each([
    'bearer',  // all lowercase
    'BEARER',  // all uppercase
    'BeArEr',  // mixed case
  ])('Any /v1/* request accepts %s scheme (RFC 7235 case-insensitive)', async (scheme) => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `${scheme} ${TOKEN}` },
    });
    expect(res.statusCode).not.toBe(401);
    expect([400, 404, 405]).toContain(res.statusCode);
  });
});
