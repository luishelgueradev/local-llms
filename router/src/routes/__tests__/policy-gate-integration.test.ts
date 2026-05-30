/**
 * policy-gate-integration.test.ts — Phase 14 (v0.11.0 — POL-01/POL-02/POL-05/P8-02).
 *
 * Behavioral matrix (10 scenarios):
 *   1. POL-01 — allowlist miss on /v1/chat/completions → 403 + model_not_in_allowlist
 *   2. POL-05 — breaker spy: recordFailure called 0 times after policy 403
 *   3. POL-02 — cloud_allowed:false + no outbound cloud call via MSW spy
 *   4. D-04   — absent policies section → allow-all, 200 smoke regression
 *   5. POL-01 cross-route — allowlist miss on /v1/messages → 403 + Anthropic permission_error
 *   6. POL-02 cross-route — cloud_allowed:false on /v1/embeddings → 403
 *   7. POL-02 cross-route — cloud_allowed:false on /v1/rerank → 403
 *   8. POL-02 cross-route — cloud_allowed:false on /v1/responses → 403
 *   9. P8-02 BLOCK (chat-completions) — body policy field IGNORED; registry cloud_allowed:false
 *      still fires 403 even when body contains { policy: { cloud_allowed: true } }
 *  10. P8-02 BLOCK (messages) — same on Anthropic surface
 *
 * Security property for tests 9–10 (P8-02 BLOCK): proves the request body's `policy`
 * field has ZERO effect on the policy gate. Even a caller crafting
 * { policy: { cloud_allowed: true } } cannot bypass registry-level cloud_allowed:false.
 * The gate reads exclusively from opts.registry.get().policies — never from the body.
 * Annotated with CONTEXT.md §"P8-02 BLOCK — no per-request policy override".
 *
 * The route schemas use .passthrough() to forward unknown fields to upstream — this is by
 * design (operators forward custom fields). The security property is NOT "schema rejects
 * policy:{}"; it IS "route handler ignores body.policy, gate reads registry only".
 * This test locks that invariant: if a future change wires body.policy into the gate,
 * this test catches the regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/setup.js';
import { buildApp } from '../../app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../config/registry.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../../../tests/fakes.js';
import type { ModelEntry } from '../../config/registry.js';
import type { BackendAdapter, AdapterFactory } from '../../backends/adapter.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const AUTH_HEADER = `Bearer ${TOKEN}`;

/** Fake BackendAdapter that returns canned responses for all method types */
function makeFakeAdapterInstance(calls?: { called: boolean }): BackendAdapter {
  return {
    async chatCompletionsCanonical() {
      if (calls) calls.called = true;
      return {
        id: 'msg_fake',
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'fake response' }],
        model: 'fake-model',
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
      };
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('not used in policy-gate tests');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings(_input, model) {
      if (calls) calls.called = true;
      return {
        object: 'list' as const,
        data: [{ object: 'embedding' as const, index: 0, embedding: new Array(1024).fill(0) }],
        model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };
    },
    async rerank(_query, _documents, model) {
      if (calls) calls.called = true;
      return {
        model,
        results: [{ index: 0, relevance_score: 0.9 }],
        usage: { total_tokens: 10 },
      };
    },
  };
}

/** AdapterFactory that returns the shared fake adapter */
const makeFakeAdapter = (): AdapterFactory => (_entry: ModelEntry) => makeFakeAdapterInstance();

/** Build a spy breaker for POL-05 assertions */
function makeSpyBreaker(): CircuitBreaker & {
  checkSpy: ReturnType<typeof vi.fn>;
  recordFailureSpy: ReturnType<typeof vi.fn>;
  recordSuccessSpy: ReturnType<typeof vi.fn>;
} {
  const checkSpy = vi.fn().mockResolvedValue({ state: 'closed' as const });
  const recordFailureSpy = vi.fn().mockResolvedValue(undefined);
  const recordSuccessSpy = vi.fn().mockResolvedValue(undefined);
  const resetSpy = vi.fn().mockResolvedValue(undefined);
  return {
    check: checkSpy,
    recordFailure: recordFailureSpy,
    recordSuccess: recordSuccessSpy,
    reset: resetSpy,
    checkSpy,
    recordFailureSpy,
    recordSuccessSpy,
  };
}

// ── Registry YAML builders ────────────────────────────────────────────────────

const CLOUD_MODEL = 'big-cloud';
const LOCAL_ALLOWED_MODEL = 'chat-local';
const CLOUD_BASE = 'https://ollama.com/v1';
const LOCAL_BASE = 'http://ollama:11434/v1';
const EMBED_MODEL = 'embed-cloud';
const RERANK_MODEL = 'rerank-cloud';

/** Registry with allowlist containing only LOCAL_ALLOWED_MODEL; CLOUD_MODEL is NOT in it */
const YAML_ALLOWLIST_MISS = `
policies:
  default:
    model_allowlist:
      - ${LOCAL_ALLOWED_MODEL}
models:
  - name: ${LOCAL_ALLOWED_MODEL}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: ${LOCAL_ALLOWED_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
    policy:
      cloud_allowed: true
`;

/** Registry with cloud_allowed:false on the cloud entry */
const YAML_CLOUD_NOT_ALLOWED = `
models:
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
    policy:
      cloud_allowed: false
`;

/** Registry with cloud_allowed:false on a cloud embeddings entry */
const YAML_CLOUD_EMBED_NOT_ALLOWED = `
models:
  - name: ${EMBED_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: nomic-embed-cloud
    capabilities: [embeddings]
    dims: 768
    vram_budget_gb: 0
    policy:
      cloud_allowed: false
`;

/** Registry with cloud_allowed:false on a cloud rerank entry */
const YAML_CLOUD_RERANK_NOT_ALLOWED = `
models:
  - name: ${RERANK_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: rerank-cloud
    capabilities: [rerank]
    vram_budget_gb: 0
    policy:
      cloud_allowed: false
`;

/** Registry with NO policies section at all — allow-all default (D-04) */
const YAML_NO_POLICIES = `
models:
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
`;

/** Registry with cloud_allowed:true (permissive — for P8-02 tests) */
const YAML_CLOUD_ALLOWED_PERMISSIVE = `
models:
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
    policy:
      cloud_allowed: true
`;

/** Registry for P8-02 tests: cloud_allowed:false — body policy MUST NOT override */
const YAML_P8_02_CLOUD_NOT_ALLOWED = `
models:
  - name: ${CLOUD_MODEL}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
    policy:
      cloud_allowed: false
`;

// ── App builder helpers ───────────────────────────────────────────────────────

function baseBuildOpts(yaml: string, extra?: { breaker?: CircuitBreaker }): Parameters<typeof buildApp>[0] {
  const registry = makeRegistryStore(loadRegistryFromString(yaml));
  const base: Parameters<typeof buildApp>[0] = {
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: makeFakeAdapter(),
    semaphores: {
      get: () =>
        ({
          acquire: async () => () => {},
          stats: () => ({ inFlight: 0, queued: 0 }),
        }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  };
  if (extra?.breaker) {
    return { ...base, breaker: extra.breaker };
  }
  return base;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('policy-gate integration — all 5 routes (Phase 14 / POL-01/02/05/P8-02)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  // ─── Test 1: POL-01 — allowlist miss on /v1/chat/completions ───────────────

  it('1. (POL-01) allowlist miss → 403 + model_not_in_allowlist on OpenAI surface', async () => {
    app = await buildApp(baseBuildOpts(YAML_ALLOWLIST_MISS));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('model_not_in_allowlist');
    expect(body.error.type).toBe('policy_violation');
    expect(body.error.message).toContain(CLOUD_MODEL);
  });

  // ─── Test 2: POL-05 — breaker spy records 0 failures ──────────────────────

  it('2. (POL-05) policy 403 does NOT increment breaker.check or recordFailure', async () => {
    const spyBreaker = makeSpyBreaker();
    app = await buildApp(baseBuildOpts(YAML_ALLOWLIST_MISS, { breaker: spyBreaker as CircuitBreaker }));

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // Policy gate fires BEFORE breaker.check — neither should be called.
    expect(spyBreaker.recordFailureSpy).toHaveBeenCalledTimes(0);
    expect(spyBreaker.checkSpy).toHaveBeenCalledTimes(0);
  });

  // ─── Test 3: POL-02 — no outbound cloud call on cloud_allowed:false ────────

  it('3. (POL-02) cloud_allowed:false → 403 + cloud_not_allowed + zero outbound cloud calls', async () => {
    const cloudCalls: Request[] = [];
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, ({ request }) => {
        cloudCalls.push(request);
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    app = await buildApp(baseBuildOpts(YAML_CLOUD_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('cloud_not_allowed');
    expect(body.error.type).toBe('policy_violation');
    // Zero cloud requests — the gate fires before any adapter call
    expect(cloudCalls.length).toBe(0);
  });

  // ─── Test 4: D-04 — absent policies → allow-all (regression guard) ─────────

  it('4. (D-04) absent policies section → allow-all, cloud request succeeds (200)', async () => {
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, () => {
        return HttpResponse.json({
          id: 'chatcmpl-cloud',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: CLOUD_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }),
    );

    // No policies section — allow-all default
    app = await buildApp(baseBuildOpts(YAML_NO_POLICIES));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // allow-all default → existing behavior preserved
    expect(res.statusCode).toBe(200);
  });

  // ─── Test 5: POL-01 cross-route — Anthropic surface ───────────────────────

  it('5. (POL-01 cross-route) allowlist miss → 403 + Anthropic permission_error on /v1/messages', async () => {
    app = await buildApp(baseBuildOpts(YAML_ALLOWLIST_MISS));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('permission_error');
    expect(body.error.message).toContain(CLOUD_MODEL);
  });

  // ─── Test 6: POL-02 cross-route — /v1/embeddings ─────────────────────────

  it('6. (POL-02 cross-route) cloud_allowed:false on /v1/embeddings → 403 + cloud_not_allowed', async () => {
    app = await buildApp(baseBuildOpts(YAML_CLOUD_EMBED_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: EMBED_MODEL,
        input: 'test embedding input',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('cloud_not_allowed');
    expect(body.error.type).toBe('policy_violation');
  });

  // ─── Test 7: POL-02 cross-route — /v1/rerank ─────────────────────────────

  it('7. (POL-02 cross-route) cloud_allowed:false on /v1/rerank → 403 + cloud_not_allowed', async () => {
    app = await buildApp(baseBuildOpts(YAML_CLOUD_RERANK_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/rerank',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: RERANK_MODEL,
        query: 'test query',
        documents: ['doc one', 'doc two'],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('cloud_not_allowed');
    expect(body.error.type).toBe('policy_violation');
  });

  // ─── Test 8: POL-02 cross-route — /v1/responses ──────────────────────────

  it('8. (POL-02 cross-route) cloud_allowed:false on /v1/responses → 403 + cloud_not_allowed', async () => {
    app = await buildApp(baseBuildOpts(YAML_CLOUD_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        input: 'test input',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('cloud_not_allowed');
    expect(body.error.type).toBe('policy_violation');
  });

  // ─── Test 9: P8-02 BLOCK (chat-completions) ──────────────────────────────
  //
  // Security property: even when the caller sends `policy: { cloud_allowed: true }`
  // in the request body, the policy gate IGNORES the body field and reads ONLY from
  // the registry snapshot (opts.registry.get().policies). cloud_allowed:false in the
  // registry MUST still produce a 403.
  //
  // Context: CONTEXT.md §"P8-02 BLOCK — no per-request policy override".
  // If a future change accidentally wires body.policy into applyPolicyGate(), this
  // test would return 200 instead of 403 — the regression becomes immediately visible.

  it('9. (P8-02 BLOCK) body policy:{cloud_allowed:true} does NOT override registry cloud_allowed:false — chat-completions surface', async () => {
    const cloudCalls: Request[] = [];
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, ({ request }) => {
        cloudCalls.push(request);
        return HttpResponse.json({}, { status: 200 });
      }),
    );

    // Registry says cloud_allowed: false — this is authoritative
    app = await buildApp(baseBuildOpts(YAML_P8_02_CLOUD_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        // Attacker-shaped body: attempt to override policy via request body.
        // This MUST be ignored — the gate reads only from registry.
        policy: { cloud_allowed: true },
      },
    });

    // Registry overrides body — still 403.
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe('cloud_not_allowed');
    expect(body.error.type).toBe('policy_violation');
    // No outbound cloud request — proves gate fired before adapter.
    expect(cloudCalls.length).toBe(0);
  });

  // ─── Test 10: P8-02 BLOCK (messages / Anthropic surface) ─────────────────
  //
  // Same invariant on the Anthropic wire surface. The body field `policy` passes
  // through .passthrough() on AnthropicMessagesRouteBodySchema, but applyPolicyGate
  // reads ONLY from opts.registry.get().policies. The 403 Anthropic permission_error
  // proves the body field has no effect on gate behavior.

  it('10. (P8-02 BLOCK) body policy:{cloud_allowed:true} does NOT override registry cloud_allowed:false — Anthropic /v1/messages surface', async () => {
    const cloudCalls: Request[] = [];
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, ({ request }) => {
        cloudCalls.push(request);
        return HttpResponse.json({}, { status: 200 });
      }),
    );

    // Registry says cloud_allowed: false — body's policy field must not override this.
    app = await buildApp(baseBuildOpts(YAML_P8_02_CLOUD_NOT_ALLOWED));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: AUTH_HEADER, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        // Attacker-shaped body: policy override attempt.
        // applyPolicyGate must ignore this — reads registry only.
        policy: { cloud_allowed: true },
      },
    });

    // Anthropic permission_error — body.policy had zero effect on gate outcome.
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('permission_error');
    // No outbound cloud request — proves gate fired before adapter.
    expect(cloudCalls.length).toBe(0);
  });
});
