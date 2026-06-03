/**
 * Phase 20 / CDX-01 (v0.12.0 — D-05 LOCKED / Open Q4 resolved YES) —
 * integration tests for the additive `recommended_for: string[]` field on each
 * /v1/models entry AND the top-level `recommendations` map.
 *
 * Plan 20-03 Task 3 / Part C — 6 integration cases:
 *   1. Operator-declared recommendations map → passthrough
 *   2. Auto-derived when block absent → non-empty map computed from tags
 *   3. Per-entry recommended_for present in response.data[0]
 *   4. Backward-compat fields preserved (id, object, owned_by, capabilities, policy)
 *   5. Schema rejects YAML with recommendation target = nonexistent model
 *   6. Schema rejects YAML with recommendation target = disabled model
 *      (Wave 0 / CAT-01 ↔ Wave 2 / CDX-01 boundary check)
 *
 * Pattern mirrors the Wave 1 health-field integration test:
 *   - real buildApp + makeFakeBufferedWriter + makeFakeMetrics
 *   - fake Valkey (mkFakeValkey) so the backendHealthPlugin doesn't crash
 *   - inertAdapter (never called — these tests only hit /v1/models)
 *   - VRAM hygiene: app.inject only — NO live /v1/chat/* probing
 */
import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type { ValkeyClient } from '../../src/clients/valkey.js';

const TOKEN = 'local-llms_20_03_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

const inertAdapter = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonical: async (): Promise<any> => {
    throw new Error('not used in recommendations tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonicalStream: async (): Promise<any> => {
    throw new Error('not used in recommendations tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  embeddings: async (): Promise<any> => {
    throw new Error('not used in recommendations tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  rerank: async (): Promise<any> => {
    throw new Error('not used in recommendations tests');
  },
  probeLiveness: async (): Promise<{ ok: boolean; latencyMs: number }> => ({
    ok: true,
    latencyMs: 1,
  }),
};

/** Tiny in-memory Valkey fake honoring SET/GET/EX (mirrors Wave 1 fake). */
interface FakeValkey {
  store: Map<string, { value: string; expiresAt?: number }>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function mkFakeValkey(): FakeValkey {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, val: string, _ex: string, ttlSec: number) => {
      store.set(key, { value: val, expiresAt: Date.now() + ttlSec * 1000 });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  };
}

function asValkey(fake: FakeValkey): ValkeyClient {
  return fake as unknown as ValkeyClient;
}

/** Build app with a hand-tailored registry. Stubbed fetch resolves all probes to OK. */
async function buildAppWithRegistry(yamlContent: string): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(yamlContent));
  const valkey = mkFakeValkey();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(new Response('ok', { status: 200 })) as unknown as typeof fetch;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
      valkey: asValkey(valkey),
      // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing
      makeAdapter: (() => inertAdapter) as any,
      env: {
        CIRCUIT_FAILURE_THRESHOLD: 5,
        CIRCUIT_WINDOW_MS: 30_000,
        CIRCUIT_COOLDOWN_MS: 60_000,
        ROUTER_RATE_LIMIT_RPM: 600,
        ROUTER_EMBED_CACHE_TTL_SEC: 86400,
        ROUTER_BACKEND_HEALTH_TTL_SEC: 60,
      },
      cloudApiKey: 'test-cloud-key',
    });
    await app.ready();
    return app;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const YAML_WITH_OPERATOR_REC = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat, tools, json_mode]
    vram_budget_gb: 0
    recommended_for: [chat, chat-tools, chat-json-strict, function-calling]
  - name: big-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat, tools, json_mode]
    vram_budget_gb: 0
    recommended_for: [chat, chat-tools, chat-json-strict, function-calling]
  - name: embed-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 0
    recommended_for: [embeddings]
recommendations:
  chat-local-default: chat-local
  chat-cloud-default: big-cloud
  chat-json-strict-default: chat-local
  embed-default: embed-local
`;

const YAML_WITHOUT_REC_BLOCK = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b
    capabilities: [chat, tools, json_mode]
    vram_budget_gb: 0
  - name: big-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat, tools, json_mode]
    vram_budget_gb: 0
  - name: embed-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 0
`;

const YAML_REC_TARGET_NONEXISTENT = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b
    capabilities: [chat]
    vram_budget_gb: 0
recommendations:
  chat-local-default: nonexistent-model
`;

const YAML_REC_TARGET_DISABLED = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b
    capabilities: [chat]
    vram_budget_gb: 0
  - name: disabled-target
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: dead-model
    capabilities: [chat]
    vram_budget_gb: 0
    disabled: true
recommendations:
  chat-local-default: disabled-target
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('/v1/models recommendations + recommended_for (Phase 20 / CDX-01 / D-05)', () => {
  it('1. operator-declared recommendations map → passthrough on response', async () => {
    const app = await buildAppWithRegistry(YAML_WITH_OPERATOR_REC);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      object: string;
      data: unknown[];
      recommendations: Record<string, string>;
    };
    expect(body.object).toBe('list');
    expect(body.recommendations).toBeDefined();
    // Exact passthrough — every operator-declared key/value lands on the wire.
    expect(body.recommendations['chat-local-default']).toBe('chat-local');
    expect(body.recommendations['chat-cloud-default']).toBe('big-cloud');
    expect(body.recommendations['chat-json-strict-default']).toBe('chat-local');
    expect(body.recommendations['embed-default']).toBe('embed-local');
    // Key set is exactly what the operator declared (no auto-derivation pollution).
    expect(Object.keys(body.recommendations).sort()).toEqual(
      ['chat-cloud-default', 'chat-json-strict-default', 'chat-local-default', 'embed-default'].sort(),
    );

    await app.close();
  });

  it('2. auto-derive when block absent → non-empty map computed from tags + profile rules', async () => {
    const app = await buildAppWithRegistry(YAML_WITHOUT_REC_BLOCK);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: unknown[];
      recommendations: Record<string, string>;
    };
    expect(body.recommendations).toBeDefined();
    // Auto-derived keys reflect the (tag, profile) rule: each enabled entry
    // contributes `<tag>-default` (local profile, backend !== 'ollama-cloud')
    // OR `<tag>-cloud-default` (cloud profile, backend === 'ollama-cloud')
    // for each `recommended_for` tag the entry covers. The local-profile chat
    // default is the first matching local entry (chat-local — non-cloud
    // backend); the cloud-profile chat default is the first matching cloud
    // entry (big-cloud — ollama-cloud backend).
    expect(body.recommendations['chat-default']).toBe('chat-local');
    expect(body.recommendations['chat-cloud-default']).toBe('big-cloud');
    expect(body.recommendations['chat-tools-default']).toBe('chat-local');
    expect(body.recommendations['chat-tools-cloud-default']).toBe('big-cloud');
    expect(body.recommendations['chat-json-strict-default']).toBe('chat-local');
    expect(body.recommendations['chat-json-strict-cloud-default']).toBe('big-cloud');
    expect(body.recommendations['function-calling-default']).toBe('chat-local');
    // `embed-local` has capabilities=[embeddings] → auto-derive key is
    // `embeddings-default` (the tag name verbatim, not the short alias
    // operators sometimes prefer). When operators want `embed-default` they
    // declare it explicitly in the operator-configurable block (Test 1).
    expect(body.recommendations['embeddings-default']).toBe('embed-local');
    // No vision/rerank entries in this fixture — those keys should NOT appear.
    expect(body.recommendations['vision-default']).toBeUndefined();
    expect(body.recommendations['rerank-default']).toBeUndefined();
    // Non-zero key count proves the auto-derivation actually ran.
    expect(Object.keys(body.recommendations).length).toBeGreaterThanOrEqual(6);

    await app.close();
  });

  it('3. per-entry recommended_for present in response.data — taxonomy-valid values', async () => {
    const app = await buildAppWithRegistry(YAML_WITH_OPERATOR_REC);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Array<{ id: string; recommended_for: string[] }>;
    };
    expect(body.data.length).toBeGreaterThan(0);

    const allowedTags = new Set([
      'chat',
      'chat-tools',
      'chat-json-strict',
      'embeddings',
      'rerank',
      'vision',
      'function-calling',
    ]);
    for (const entry of body.data) {
      expect(Array.isArray(entry.recommended_for)).toBe(true);
      for (const tag of entry.recommended_for) {
        expect(allowedTags.has(tag)).toBe(true);
      }
    }

    // Spot-check chat-local — operator-declared tags should be exactly what
    // landed on the wire.
    const chatLocal = body.data.find((m) => m.id === 'chat-local');
    expect(chatLocal).toBeDefined();
    expect(new Set(chatLocal!.recommended_for)).toEqual(
      new Set(['chat', 'chat-tools', 'chat-json-strict', 'function-calling']),
    );

    // Spot-check embed-local — operator-declared single tag preserved.
    const embedLocal = body.data.find((m) => m.id === 'embed-local');
    expect(embedLocal).toBeDefined();
    expect(embedLocal!.recommended_for).toEqual(['embeddings']);

    await app.close();
  });

  it('4. backward-compat fields preserved (id, object, owned_by, capabilities, policy) — additive contract', async () => {
    const app = await buildAppWithRegistry(YAML_WITH_OPERATOR_REC);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        capabilities: string[];
        policy: { cloud_allowed: boolean };
        recommended_for: string[];
      }>;
    };
    const first = body.data[0]!;
    // Pre-Phase-20 contract: these fields MUST still be present.
    expect(first.id).toBeDefined();
    expect(first.object).toBe('model');
    expect(first.owned_by).toBe('local-llms');
    expect(Array.isArray(first.capabilities)).toBe(true);
    expect(first.capabilities.length).toBeGreaterThan(0);
    expect(first.policy).toBeDefined();
    expect(typeof first.policy.cloud_allowed).toBe('boolean');
    // Phase 20 additive fields ALSO present alongside.
    expect(first.recommended_for).toBeDefined();
    // T-3-A2 anti-leak still holds — backend / backend_url / backend_model
    // must NOT appear in the projection.
    expect((first as unknown as Record<string, unknown>).backend).toBeUndefined();
    expect((first as unknown as Record<string, unknown>).backend_url).toBeUndefined();
    expect((first as unknown as Record<string, unknown>).backend_model).toBeUndefined();
    expect((first as unknown as Record<string, unknown>).vram_budget_gb).toBeUndefined();

    await app.close();
  });

  it('5. schema rejects YAML with recommendation target = nonexistent model (boot-time superRefine)', () => {
    expect(() => loadRegistryFromString(YAML_REC_TARGET_NONEXISTENT)).toThrow(/recommendations|nonexistent-model/);
  });

  it('6. schema rejects YAML with recommendation target = disabled model (Wave 0 ↔ Wave 2 boundary)', () => {
    // Per RegistrySchema.superRefine, recommendation targets must be ENABLED
    // (not just present). A disabled entry as a target would surface a
    // recommendation that consumers couldn't actually use.
    expect(() => loadRegistryFromString(YAML_REC_TARGET_DISABLED)).toThrow(/recommendations|disabled-target/);
  });
});
