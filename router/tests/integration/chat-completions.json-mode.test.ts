/**
 * Phase 10 (v0.10.0 — JSON-01..06) integration tests for `response_format` on
 * POST /v1/chat/completions: capability gate + first-pass success + retry-with-repair
 * + final failure + metric `router_json_validation_total{result}`.
 *
 * Uses a controllable FakeAdapter (not msw) so we can exactly orchestrate the
 * sequence of canonical responses across the repair retry.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type {
  BackendAdapter,
} from '../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/translation/canonical.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const JSON_MODEL = 'json-capable-test';
const PLAIN_MODEL = 'plain-chat-test';

const YAML = `
models:
  - name: ${JSON_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: irrelevant
    capabilities: [chat, json_mode]
    vram_budget_gb: 4
  - name: ${PLAIN_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: irrelevant
    capabilities: [chat]
    vram_budget_gb: 4
`;

/**
 * FakeAdapter that returns pre-seeded canonical responses for each successive
 * chatCompletionsCanonical call. Lets the test plant "first call: bad JSON, second
 * call: good JSON" without an HTTP layer.
 */
function makeFakeAdapter(responseTexts: string[]): BackendAdapter & { calls: number } {
  let i = 0;
  const self = {
    calls: 0,
    async chatCompletionsCanonical(
      _req: CanonicalRequest,
      _signal: AbortSignal,
    ): Promise<CanonicalResponse> {
      const text = responseTexts[Math.min(i, responseTexts.length - 1)] ?? '';
      i += 1;
      self.calls = i;
      return {
        id: `msg_${i}`,
        type: 'message' as const,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text }],
        model: 'irrelevant',
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
    async chatCompletionsCanonicalStream(): Promise<AsyncIterable<CanonicalStreamEvent>> {
      throw new Error('stream branch not used in JSON-mode tests');
    },
    async probeLiveness(): Promise<{ ok: boolean; latencyMs: number }> {
      return { ok: true, latencyMs: 1 };
    },
    async embeddings(): Promise<never> {
      throw new Error('embeddings not used');
    },
  };
  return self;
}

let app: FastifyInstance;
let metrics: ReturnType<typeof makeMetricsRegistry>;
let fakeAdapter: ReturnType<typeof makeFakeAdapter>;

async function setup(responseTexts: string[]): Promise<void> {
  fakeAdapter = makeFakeAdapter(responseTexts);
  metrics = makeMetricsRegistry();
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: () => fakeAdapter,
    semaphores: {
      get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
  });
}

afterEach(async () => {
  await app.close();
});

async function getJsonValidationCounter(result: 'ok' | 'retry' | 'failed'): Promise<number> {
  const all = await metrics.jsonValidationTotal.get();
  const found = all.values.find((v) => v.labels.result === result);
  return found ? Number(found.value) : 0;
}

describe('Phase 10: POST /v1/chat/completions response_format gate + repair loop', () => {
  describe('JSON-05 capability gate', () => {
    it('rejects response_format with 400 + model_capability_mismatch when model lacks json_mode (before adapter call)', async () => {
      await setup(['{"x":1}']); // adapter would happily return valid JSON, but the gate fires first

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: PLAIN_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('model_capability_mismatch');
      expect(fakeAdapter.calls).toBe(0); // adapter never invoked
    });

    it('allows the request when model declares json_mode', async () => {
      await setup(['{"ok": true}']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('type=text bypasses the gate entirely (no json_mode required)', async () => {
      await setup(['hello plain text']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: PLAIN_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'text' },
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('JSON-01 happy path (first response valid)', () => {
    it('returns the response unchanged + records metric result=ok + adapter called once', async () => {
      await setup(['{"foo": "bar"}']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'give me json' }],
          response_format: { type: 'json_object' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content).toBe('{"foo": "bar"}');
      expect(fakeAdapter.calls).toBe(1);
      expect(await getJsonValidationCounter('ok')).toBe(1);
      expect(await getJsonValidationCounter('retry')).toBe(0);
      expect(await getJsonValidationCounter('failed')).toBe(0);
    });
  });

  describe('JSON-03 retry-with-repair (first response bad, retry succeeds)', () => {
    it('returns the repaired body + metric result=retry + adapter called twice', async () => {
      // First response: invalid JSON. Second: valid JSON.
      await setup(['this is not json at all', '{"after": "repair"}']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'give me json' }],
          response_format: { type: 'json_object' },
        },
      });
      expect(res.statusCode).toBe(200);
      const content = res.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content;
      expect(content).toBe('{"after": "repair"}');
      expect(fakeAdapter.calls).toBe(2);
      expect(await getJsonValidationCounter('ok')).toBe(0);
      expect(await getJsonValidationCounter('retry')).toBe(1);
      expect(await getJsonValidationCounter('failed')).toBe(0);
    });
  });

  describe('JSON-04 both attempts fail → 400 invalid_structured_output', () => {
    it('returns 400 + envelope code=invalid_structured_output + metric result=failed', async () => {
      // Both responses invalid.
      await setup(['nope', 'still nope']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'give me json' }],
          response_format: { type: 'json_object' },
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; type: string; message: string; param: string } }>();
      expect(body.error.code).toBe('invalid_structured_output');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.param).toBe('response_format');
      expect(body.error.message).toMatch(/Details:/);
      expect(fakeAdapter.calls).toBe(2);
      expect(await getJsonValidationCounter('failed')).toBe(1);
    });
  });

  describe('JSON-02 json_schema validation', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
      additionalProperties: false,
    };

    it('accepts valid schema-conforming response', async () => {
      await setup(['{"name":"Luis","age":35}']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'give me a person' }],
          response_format: { type: 'json_schema', json_schema: { name: 'Person', schema } },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(await getJsonValidationCounter('ok')).toBe(1);
    });

    it('retries on schema-mismatched first response and accepts the repaired one', async () => {
      await setup(['{"name":"Luis"}', '{"name":"Luis","age":35}']);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'person please' }],
          response_format: { type: 'json_schema', json_schema: { name: 'Person', schema } },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(fakeAdapter.calls).toBe(2);
      expect(await getJsonValidationCounter('retry')).toBe(1);
    });
  });

  describe('JSON-06 metric registered + queryable on /metrics', () => {
    it('exposes router_json_validation_total on the /metrics endpoint', async () => {
      await setup(['{"ok": true}']);
      // Trigger one ok so the counter has a value to expose.
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: JSON_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        },
      });
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/router_json_validation_total\{result="ok"\}\s+1/);
    });
  });
});
