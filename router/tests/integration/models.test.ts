import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import type { ModelEntry } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

const TWO_ENTRY_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4

  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
`;

const ONE_ENTRY_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

const DIFFERENT_YAML = `
models:
  - name: new-model-after-swap
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: new-model-after-swap
    capabilities: [chat, tools]
    vram_budget_gb: 4
`;

function makeApp(yaml: string): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(yaml));
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    // makeAdapter is required by buildApp for chat-completions but not used by /v1/models
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    bufferedWriter: makeFakeBufferedWriter(),
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  app = await makeApp(TWO_ENTRY_YAML);
});
afterEach(async () => {
  await app.close();
});

describe('GET /v1/models — D-C1 shape, auth, no-leak, liveness-decoupled, D-C3 stability', () => {
  // Case 1: Full shape (D-C1)
  it('returns 200 + full D-C1 shape with capabilities for two entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      object: string;
      data: Array<{
        id: string;
        object: string;
        created: number;
        owned_by: string;
        capabilities: string[];
      }>;
    }>();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    // First entry
    const first = body.data[0]!;
    expect(Object.keys(first).sort()).toEqual(['capabilities', 'created', 'id', 'object', 'owned_by'].sort());
    expect(first.id).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(first.object).toBe('model');
    expect(first.owned_by).toBe('local-llms');
    expect(first.capabilities).toEqual(['chat']);
    expect(typeof first.created).toBe('number');
    expect(first.created).toBeGreaterThan(1_700_000_000); // sanity: after year 2023
    // Second entry
    const second = body.data[1]!;
    expect(second.id).toBe('qwen2.5-7b-instruct-q4km');
    expect(second.capabilities).toEqual(['chat', 'tools']);
  });

  // Case 2: Auth — no bearer
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('unauthorized');
  });

  // Case 3: Auth — wrong bearer
  it('returns 401 when wrong bearer is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong-token-here' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Case 4: No backend_url leak (T-3-A2)
  it('does NOT leak backend_url, backend, or backend_model in any entry (T-3-A2)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.json<{ data: object[] }>();
    for (const entry of body.data) {
      expect(entry).not.toHaveProperty('backend_url');
      expect(entry).not.toHaveProperty('backend');
      expect(entry).not.toHaveProperty('backend_model');
    }
  });

  // Case 5: Lists all regardless of liveness (D-C4)
  it('lists all registry models regardless of backend liveness (D-C4)', async () => {
    // No liveness probe wired — endpoint must still return all entries
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(2);
  });

  // Case 6: Reflects hot-reload
  it('reflects registry after _swap (hot-reload simulation)', async () => {
    const oneEntryApp = await makeApp(ONE_ENTRY_YAML);
    const registry = makeRegistryStore(loadRegistryFromString(ONE_ENTRY_YAML));
    const hotApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
      bufferedWriter: makeFakeBufferedWriter(),
    });

    try {
      const res1 = await hotApp.inject({
        method: 'GET', url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res1.json<{ data: unknown[] }>().data).toHaveLength(1);

      // Simulate successful hot-reload
      registry._swap(loadRegistryFromString(TWO_ENTRY_YAML));

      const res2 = await hotApp.inject({
        method: 'GET', url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res2.json<{ data: unknown[] }>().data).toHaveLength(2);
    } finally {
      await hotApp.close();
      await oneEntryApp.close();
    }
  });

  // Case 7: D-C3 — created is stable across snapshot (revision 1, Blocker 4)
  it('created is stable across two requests on the same snapshot (D-C3 stability)', async () => {
    const res1 = await app.inject({
      method: 'GET', url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body1 = res1.json<{ data: Array<{ created: number }> }>();
    const created1 = body1.data[0]!.created;
    // All entries in the same response share the same created value
    for (const entry of body1.data) {
      expect(entry.created).toBe(created1);
    }

    // Wait > 1 second to advance wall clock
    await new Promise((r) => setTimeout(r, 1100));

    // Second request — no _swap — created MUST be identical
    const res2 = await app.inject({
      method: 'GET', url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body2 = res2.json<{ data: Array<{ created: number }> }>();
    const created2 = body2.data[0]!.created;
    // D-C3: within one snapshot, created MUST be stable. created1 === created2 (strict identity).
    expect(created1 === created2).toBe(true); // created1 === created2 — snapshot timestamp unchanged
    for (const entry of body2.data) {
      expect(entry.created).toBe(created2);
    }
  }, 10_000);

  // Case 8: D-C3 — created advances on hot-reload (revision 1, Blocker 4)
  it('created advances after registry._swap (D-C3 advance on hot-reload)', async () => {
    const registry = makeRegistryStore(loadRegistryFromString(ONE_ENTRY_YAML));
    const stableApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
      bufferedWriter: makeFakeBufferedWriter(),
    });

    try {
      const res1 = await stableApp.inject({
        method: 'GET', url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const created1 = res1.json<{ data: Array<{ created: number }> }>().data[0]!.created;

      // Advance wall clock by ≥ 1 second
      await new Promise((r) => setTimeout(r, 1100));

      // Simulate successful hot-reload
      registry._swap(loadRegistryFromString(DIFFERENT_YAML));

      const res2 = await stableApp.inject({
        method: 'GET', url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const created2 = res2.json<{ data: Array<{ created: number }> }>().data[0]!.created;

      expect(created2).toBeGreaterThan(created1); // strictly greater after _swap
    } finally {
      await stableApp.close();
    }
  }, 10_000);
});
