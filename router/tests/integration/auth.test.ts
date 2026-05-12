import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
`;

let app: FastifyInstance;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'router-auth-it-'));
  writeFileSync(join(tmpDir, 'models.yaml'), YAML);
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({ registry, bearerToken: TOKEN, loggerOpts: false as never });
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

  it('Any /v1/* request returns NOT 401 with correct bearer (404 expected because the route is not wired in plan 02-02; plan 02-03 wires it)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // After plan 02-03 + 02-04 land, this becomes 200/400/502 etc.
    // For plan 02-02, the route does not exist yet — auth passes, then Fastify 404s.
    expect(res.statusCode).not.toBe(401);
    expect([404, 405]).toContain(res.statusCode);
  });
});
