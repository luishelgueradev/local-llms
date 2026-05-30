/**
 * scopedIds-request-log.test.ts — Phase 14 (v0.11.0 — POL-04).
 *
 * Integration test proving the full scoped-ID round-trip:
 *   X-Tenant-ID / X-Project-ID / X-Workload-Class request headers
 *   → scopedIdsPreHandler stamps req.tenantId / req.projectId / req.workloadClass
 *   → route's safeRecord closure passes them into OutcomeContext
 *   → row builder stamps tenant_id / project_id / workload_class on RequestLogInsert
 *   → bufferedWriter.push receives the row (spy captures it)
 *
 * POL-04 success criterion 3: "A caller sending X-Tenant-ID: acme and
 * X-Project-ID: agents sees both values appear in the Postgres request_log row
 * for that request (verified by integration test querying the DB row)."
 *
 * Uses a bufferedWriter spy (NOT a real Postgres connection) — the spy captures
 * the pushed row at the exact moment the route's safeRecord closure fires.
 * This mirrors the existing recordOutcome.test.ts:149-151 bufferedWriter spy pattern.
 *
 * 6 behavioral cases:
 *   1. Happy path — all 3 headers populated → row reflects them
 *   2. No headers → all three columns NULL
 *   3. Invalid X-Workload-Class (space) → silent-NULL (status 200)
 *   4. Invalid X-Tenant-ID (slash) → 400 + row recorded with NULL scoped IDs (DETERMINISTIC)
 *   5. Cross-route /v1/messages → same tenant/project columns in row
 *   6. Cross-route /v1/embeddings → same fan-out works on embeddings surface
 *
 * Pitfall-9 invariant: this test does NOT create any req.log = assignment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../config/registry.js';
import { makeMetricsRegistry } from '../../metrics/registry.js';
import type { RequestLogInsert } from '../../db/schema/index.js';
import type { ModelEntry } from '../../config/registry.js';
import type { BackendAdapter, AdapterFactory } from '../../backends/adapter.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const AUTH_HEADER = `Bearer ${TOKEN}`;
const CHAT_MODEL = 'chat-local';
const EMBED_MODEL = 'embed-local';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';

const YAML = `
models:
  - name: ${CHAT_MODEL}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${CHAT_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${EMBED_MODEL}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
`;

// ── Fake adapter ──────────────────────────────────────────────────────────────

/**
 * A fake BackendAdapter that returns canned canonical responses without making
 * real HTTP calls. Avoids MSW handler registration so the test is self-contained.
 */
function makeFakeAdapter(): AdapterFactory {
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical() {
      return {
        id: 'msg_fake',
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'fake response' }],
        model: CHAT_MODEL,
        usage: { input_tokens: 5, output_tokens: 3 },
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
      };
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('not exercised in scoped-ID tests');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings(_input, model) {
      const items = Array.isArray(_input) ? _input : [_input];
      return {
        object: 'list' as const,
        data: items.map((_, i) => ({
          object: 'embedding' as const,
          index: i,
          embedding: new Array(1024).fill(0.1),
        })),
        model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };
    },
    async rerank(_query, _documents, model) {
      return { model, results: [], usage: { total_tokens: 0 } };
    },
  };
  return (_entry: ModelEntry) => adapter;
}

// ── buildApp helper ───────────────────────────────────────────────────────────

function buildAppWithSpy(pushedRows: RequestLogInsert[]): Promise<FastifyInstance> {
  const bufferedWriter = {
    push: (row: RequestLogInsert) => pushedRows.push(row),
    drain: async () => {},
    get size() {
      return 0;
    },
  };
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const metrics = makeMetricsRegistry();

  return buildApp({
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
    bufferedWriter,
    metrics,
  });
}

// ── Chat-completion helpers ───────────────────────────────────────────────────

const CHAT_PAYLOAD = {
  model: CHAT_MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

const MESSAGES_PAYLOAD = {
  model: CHAT_MODEL,
  max_tokens: 100,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

const EMBED_PAYLOAD = {
  model: EMBED_MODEL,
  input: 'hello world',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('scopedIds → request_log round-trip (Phase 14 / POL-04)', () => {
  let app: FastifyInstance;
  let pushed: RequestLogInsert[];

  beforeEach(async () => {
    pushed = [];
    app = await buildAppWithSpy(pushed);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ─── Test 1: Happy path — all 3 headers populated ─────────────────────────

  it('1. (POL-04) happy path — X-Tenant-ID/Project-ID/Workload-Class populate row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        'x-tenant-id': 'acme',
        'x-project-id': 'agents',
        'x-workload-class': 'SENSITIVE', // should be lowercased per D-11
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    // POL-04 success criterion 3 — the pushed row must reflect the caller's headers.
    expect(pushed[0]?.tenant_id).toBe('acme');
    expect(pushed[0]?.project_id).toBe('agents');
    // D-11: workload_class is lowercase-normalized by scopedIdsPreHandler.
    expect(pushed[0]?.workload_class).toBe('sensitive');
    // Sanity: other columns still populated correctly.
    expect(pushed[0]?.status_class).toBe('success');
    expect(pushed[0]?.http_status).toBe(200);
  });

  // ─── Test 2: No headers → all three columns NULL ──────────────────────────

  it('2. (POL-04) no scoped-ID headers → all three columns null in row (D-13/D-17)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        // No X-Tenant-ID, X-Project-ID, X-Workload-Class
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.tenant_id).toBeNull();
    expect(pushed[0]?.project_id).toBeNull();
    expect(pushed[0]?.workload_class).toBeNull();
  });

  // ─── Test 3: Invalid X-Workload-Class → silent-NULL (status 200) ──────────

  it('3. (D-12) invalid X-Workload-Class (space) → silent-NULL + status 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        'x-workload-class': 'in valid', // contains space — violates WC_RE
      },
      payload: CHAT_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    // D-12: invalid workload-class silently NULLed — must NOT cause a 400.
    expect(pushed[0]?.workload_class).toBeNull();
    // Valid tenant/project absent → also null.
    expect(pushed[0]?.tenant_id).toBeNull();
    expect(pushed[0]?.project_id).toBeNull();
  });

  // ─── Test 4: Invalid X-Tenant-ID → 400 + row recorded with NULL scoped IDs ──

  it('4. (D-16 DETERMINISTIC) invalid X-Tenant-ID → 400 + row recorded with null scoped IDs via setErrorHandler', async () => {
    // DETERMINISM RATIONALE (plan Test 4):
    // scopedIdsPreHandler throws InvalidScopedIdError BEFORE stamping req.tenantId.
    // app.ts setErrorHandler fires for /v1/chat/completions with status=400 (not 401),
    // so the isRecordedRoute && !req.__recorded branch fires recordOutcome().
    // At that moment: req.tenantId/projectId/workloadClass are ALL undefined (never stamped).
    // Row builder: ctx.tenantId ?? null → null. Same for project_id and workload_class.
    // If this test fails, either:
    //   - setErrorHandler was modified to skip recordOutcome for 400 errors (D-D4 regression), OR
    //   - scopedIdsPreHandler now stamps req.tenantId before throwing (logic change), OR
    //   - Plan 07 task 1 wiring changed (regression in app.ts setErrorHandler patching).
    // DO NOT loosen this assertion — flag the divergence instead.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        'x-tenant-id': '../../etc', // contains '/' — violates ID_RE
      },
      payload: CHAT_PAYLOAD,
    });

    // scopedIdsPreHandler throws InvalidScopedIdError → 400.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_scoped_id');

    // setErrorHandler MUST have recorded exactly ONE row (D-D4 coverage for /v1/chat/completions).
    expect(pushed).toHaveLength(1);
    // All scoped IDs are null because scopedIdsPreHandler threw before stamping them.
    expect(pushed[0]!.tenant_id).toBeNull();
    expect(pushed[0]!.project_id).toBeNull();
    expect(pushed[0]!.workload_class).toBeNull();
    // agent_id is also null (agentIdPreHandler never ran — scopedIds threw first).
    expect(pushed[0]!.agent_id).toBeNull();
    // Row must use error_code from mapErrorToCode(InvalidScopedIdError) = 'invalid_request'.
    expect(pushed[0]!.error_code).toBe('invalid_request');
    expect(pushed[0]!.http_status).toBe(400);
    expect(pushed[0]!.status_class).toBe('client_error');
  });

  // ─── Test 5: Cross-route /v1/messages (Task 2 fan-out on Anthropic surface) ─

  it('5. (POL-04 cross-route) /v1/messages records tenant/project/workload_class in row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-tenant-id': 'globex',
        'x-project-id': 'cortex',
        'x-workload-class': 'BATCH',
      },
      payload: MESSAGES_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.tenant_id).toBe('globex');
    expect(pushed[0]?.project_id).toBe('cortex');
    // D-11: lowercased.
    expect(pushed[0]?.workload_class).toBe('batch');
    // Protocol should be anthropic on this surface.
    expect(pushed[0]?.protocol).toBe('anthropic');
  });

  // ─── Test 6: Cross-route /v1/embeddings (Task 2 fan-out on embeddings surface) ─

  it('6. (POL-04 cross-route) /v1/embeddings records tenant/project/workload_class in row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: AUTH_HEADER,
        'content-type': 'application/json',
        'x-tenant-id': 'acme',
        'x-project-id': 'search',
        'x-workload-class': 'analytics',
      },
      payload: EMBED_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.tenant_id).toBe('acme');
    expect(pushed[0]?.project_id).toBe('search');
    expect(pushed[0]?.workload_class).toBe('analytics');
    expect(pushed[0]?.route).toBe('/v1/embeddings');
  });
});
