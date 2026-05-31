/**
 * responses.test.ts — Phase 13 (v0.10.0 — RESP-01..04 + COST-01..04) integration
 * coverage for POST /v1/responses.
 *
 * Behavioral matrix:
 *   1. Happy path (string input): 200, body shape matches Responses API, usage
 *      reported, request_log row written.
 *   2. Happy path (array input + instructions): instructions fold into the
 *      canonical system field; assistant content returned in output[0].
 *   3. Capability gate: embeddings-only model → 400 / model_capability_mismatch.
 *   4. Stream:true rejection: clear 400 envelope pointing at /v1/chat/completions.
 *   5. Cost tracking: cloud-priced model → X-Cost-Cents header AND non-null
 *      cost_cents in request_log; local model (no pricing) → no header AND
 *      NULL cost_cents column.
 *   6. Bearer auth: missing token → 401; no request_log row (D-D4).
 *   7. Unknown model → 404.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const LOCAL_CHAT = 'qwen2.5-local';
const CLOUD_CHAT = 'gpt-oss-cloud';
const EMBED_ONLY = 'bge-m3-test';
const LOCAL_BASE = 'http://upstream-mock:11434/v1';
const CLOUD_BASE = 'https://ollama.com/v1';
const VLLM_BASE = 'http://upstream-mock-2:8000/v1';

// Cloud entry has pricing → X-Cost-Cents emitted + cost_cents non-null.
// Local entry omits pricing → no header + NULL column.
const YAML = `
models:
  - name: ${LOCAL_CHAT}
    backend: ollama
    backend_url: ${LOCAL_BASE}
    backend_model: qwen2.5:7b
    capabilities: [chat]
    vram_budget_gb: 6
  - name: ${CLOUD_CHAT}
    backend: ollama-cloud
    backend_url: ${CLOUD_BASE}
    backend_model: gpt-oss-cloud
    capabilities: [chat, tools]
    pricing:
      input_per_1m: 0.10
      output_per_1m: 0.30
    vram_budget_gb: 0
  - name: ${EMBED_ONLY}
    backend: vllm-embed
    backend_url: ${VLLM_BASE}
    backend_model: BAAI/bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
`;

interface FakeCall {
  systemPrompt: string | undefined;
  messages: Array<{ role: string; content: unknown }>;
  model: string;
}

function makeFakeAdapter(): { adapter: BackendAdapter; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical(canonical) {
      calls.push({
        systemPrompt: canonical.system,
        messages: canonical.messages,
        model: canonical.model,
      });
      return {
        id: 'msg_01TESTRESPID',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from fake' }],
        model: canonical.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 6 },
      };
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('stream not used in responses suite');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 0 };
    },
    async embeddings(input, model) {
      const items = Array.isArray(input) ? input : [input];
      return {
        object: 'list',
        data: items.map((_, i) => ({
          object: 'embedding' as const,
          index: i,
          embedding: new Array(1024).fill(0.42),
        })),
        model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };
    },
    async rerank(_q, _d, model) {
      return { model, results: [], usage: { total_tokens: 0 } };
    },
  };
  return { adapter, calls };
}

let app: FastifyInstance;
let pushed: RequestLogInsert[];
let fakeCalls: FakeCall[];

beforeEach(async () => {
  pushed = [];
  fakeCalls = [];

  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const fakeBuffered = {
    push: (row: RequestLogInsert) => pushed.push(row),
    drain: async () => {},
    get size() {
      return 0;
    },
  };
  const metrics = makeMetricsRegistry();
  const { adapter, calls } = makeFakeAdapter();
  fakeCalls = calls;

  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (_entry: ModelEntry) => adapter,
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: fakeBuffered,
    metrics,
  });
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/responses — happy paths (RESP-01)', () => {
  it('string input → 200 + Responses-shape body + recordOutcome row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LOCAL_CHAT, input: 'hola' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('response');
    expect(body.model).toBe(LOCAL_CHAT);
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].role).toBe('assistant');
    expect(body.output[0].content[0].type).toBe('output_text');
    expect(body.output[0].content[0].text).toBe('hello from fake');
    // SDK-compat hardening (post-bug-fix): content blocks MUST carry annotations:[]
    // because openai-node iterates `content[].annotations.map(...)` on parse.
    expect(body.output[0].content[0].annotations).toEqual([]);
    // Required-or-nullable fields the SDK deserializer expects on every response.
    expect(body.status).toBe('completed');
    expect(typeof body.created_at).toBe('number');
    expect(body.error).toBeNull();
    expect(body.incomplete_details).toBeNull();
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    // Flat-text shortcut the SDK exposes as response.output_text; LangChain reads it.
    expect(body.output_text).toBe('hello from fake');
    // Usage: assert the three core counts; the *_tokens_details sub-objects are
    // present for SDK projection compatibility but their internals (cached_tokens,
    // reasoning_tokens) are 0 in this fake-adapter path.
    expect(body.usage.input_tokens).toBe(12);
    expect(body.usage.output_tokens).toBe(6);
    expect(body.usage.total_tokens).toBe(18);
    expect(body.usage.input_tokens_details).toBeDefined();
    expect(body.usage.output_tokens_details).toBeDefined();

    // Adapter received a canonical with backend_model + a single user message.
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0].model).toBe('qwen2.5:7b');
    expect(fakeCalls[0].messages).toHaveLength(1);
    expect(fakeCalls[0].messages[0].role).toBe('user');

    // request_log row recorded.
    expect(pushed).toHaveLength(1);
    expect(pushed[0].route).toBe('/v1/responses');
    expect(pushed[0].protocol).toBe('openai');
    expect(pushed[0].backend).toBe('ollama');
    expect(pushed[0].model).toBe(LOCAL_CHAT);
    expect(pushed[0].http_status).toBe(200);
    expect(pushed[0].tokens_in).toBe(12);
    expect(pushed[0].tokens_out).toBe(6);
  });

  it('SDK-compat regression: emulates openai-node response parser .map() calls (n8n bug-2026-05-29)', async () => {
    // Original bug: n8n with `responsesApiEnabled: true` raised
    // "Cannot read properties of undefined (reading 'map')" because the openai-node
    // SDK iterates `content[].annotations.map(...)` and `tools.map(...)` during
    // response parsing. This test runs the exact same `.map()` calls the SDK does
    // against our wire body — if any are undefined we crash here too, catching the
    // regression at the integration boundary instead of in production.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LOCAL_CHAT, input: 'hola' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      output: Array<{ content: Array<{ annotations: unknown[] }> }>;
      tools: unknown[];
      output_text: string;
    };
    // The exact .map() calls the openai-node SDK does:
    expect(() => body.output.map((o) => o.content.map((c) => c.annotations.map((_a) => _a)))).not.toThrow();
    expect(() => body.tools.map((t) => t)).not.toThrow();
    // Flat-text shortcut is populated (LangChain reads this off the wire).
    expect(body.output_text).toBe('hello from fake');
  });

  it('array input + instructions → instructions fold into system; messages preserved', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: LOCAL_CHAT,
        input: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
        instructions: 'You are concise.',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0].systemPrompt).toBe('You are concise.');
    expect(fakeCalls[0].messages).toHaveLength(3);
    expect(fakeCalls[0].messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('stamps X-Model-Backend header on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LOCAL_CHAT, input: 'hola' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-model-backend']).toBe('ollama');
  });
});

describe('POST /v1/responses — capability gate (RESP-04)', () => {
  it('embeddings-only model → 400 model_capability_mismatch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: EMBED_ONLY, input: 'hola' },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('model_capability_mismatch');
    expect(fakeCalls).toHaveLength(0);

    // request_log records the error row.
    expect(pushed).toHaveLength(1);
    expect(pushed[0].status_class).toBe('client_error');
    expect(pushed[0].error_code).toBe('model_capability_mismatch');
    expect(pushed[0].cost_cents).toBeNull();
  });
});

// Phase 16 (v0.11.0 — RESS-01): the previous /v1/responses stream:true → 400
// rejection (responses_stream_unsupported) was removed when streaming shipped.
// Real-streaming integration tests live in router/tests/routes/responses-stream.test.ts.

describe('POST /v1/responses — cost tracking (COST-01/02)', () => {
  it('cloud-priced model → X-Cost-Cents header + non-null cost_cents column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: CLOUD_CHAT, input: 'hola' },
    });
    expect(res.statusCode).toBe(200);
    // 12 input × 0.10 + 6 output × 0.30 = 1.2 + 1.8 = 3.0 → 3 / 10_000 = 0.0003 cents.
    expect(res.headers['x-cost-cents']).toBe('0.0003');
    expect(pushed[0].cost_cents).toBe('0.0003');
  });

  it('local model with no pricing → no X-Cost-Cents header + NULL cost_cents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LOCAL_CHAT, input: 'hola' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cost-cents']).toBeUndefined();
    expect(pushed[0].cost_cents).toBeNull();
  });
});

describe('POST /v1/responses — bearer auth + registry lookup', () => {
  it('missing bearer → 401, no request_log row (D-D4)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      payload: { model: LOCAL_CHAT, input: 'hola' },
    });
    expect(res.statusCode).toBe(401);
    expect(pushed).toHaveLength(0);
  });

  it('unknown model → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'definitely-not-a-model', input: 'hola' },
    });
    expect(res.statusCode).toBe(404);
    const env = res.json();
    expect(env.error.code).toBe('model_not_found');
  });
});

describe('POST /v1/responses — cost on chat-completions parity (COST-02 cross-route)', () => {
  it('/v1/chat/completions cloud-priced also emits X-Cost-Cents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: CLOUD_CHAT,
        messages: [{ role: 'user', content: 'hola' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cost-cents']).toBe('0.0003');
  });
});
