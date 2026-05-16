/**
 * vllm-openai.test.ts — Unit tests for VLLMOpenAIAdapter (Plan 07-03)
 *
 * Mirrors the llamacpp adapter coverage: probeLiveness ok/empty/error paths
 * via MSW, plus a chatCompletionsCanonical happy-path that confirms the
 * upstream URL is built from the constructor's baseURL.
 *
 * vLLM exposes the same OpenAI-compat surface as llama.cpp-server (POST
 * /v1/chat/completions + GET /v1/models); the adapter is functionally the
 * llamacpp adapter modulo the apiKey label, so the tests follow the same
 * shape.
 */
import { describe, expect, it } from 'vitest';
import { server } from '../setup.js';
import { vllmModelsListHandler, vllmNonStreamHandler } from '../msw/handlers.js';
import { http, HttpResponse } from 'msw';
import { VLLMOpenAIAdapter } from '../../src/backends/vllm-openai.js';
import type { CanonicalRequest } from '../../src/translation/canonical.js';

const VLLM_BASE = 'http://vllm:8000/v1';

function makeAdapter(): VLLMOpenAIAdapter {
  return new VLLMOpenAIAdapter(VLLM_BASE);
}

function canonicalRequest(model = 'Qwen/Qwen2.5-7B-Instruct-AWQ'): CanonicalRequest {
  return {
    model,
    max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    stream: false,
  };
}

describe('VLLMOpenAIAdapter — probeLiveness', () => {
  it('returns { ok: true, latencyMs } when /v1/models has non-empty data', async () => {
    server.use(vllmModelsListHandler({ url: `${VLLM_BASE}/models` }));
    const adapter = makeAdapter();
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.error).toBeUndefined();
  });

  it('returns { ok: false, error: "empty data array" } when /v1/models data is empty', async () => {
    server.use(vllmModelsListHandler({ url: `${VLLM_BASE}/models`, modelIds: [] }));
    const adapter = makeAdapter();
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('empty data array');
    expect(typeof res.latencyMs).toBe('number');
  });

  it('returns { ok: false, error: <message> } when /v1/models returns 4xx (non-retried)', async () => {
    // Use 400 not 500 — the OpenAI SDK retries 5xx by default which would push
    // this test past vitest's 5s default timeout. 400 surfaces immediately as
    // BadRequestError and exercises the same catch branch (ok=false + error
    // string), which is the contract we care about for probeLiveness.
    server.use(
      http.get(`${VLLM_BASE}/models`, () => new HttpResponse('bad request', { status: 400 })),
    );
    const adapter = makeAdapter();
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error!.length).toBeGreaterThan(0);
  });

  it('never throws — connection-refused style failures surface via { ok: false, error }', async () => {
    // Point at a base URL we don't register any MSW handler for; msw rejects
    // unhandled requests, which surfaces as a thrown error inside the OpenAI
    // SDK. probeLiveness MUST catch it.
    const unreachable = new VLLMOpenAIAdapter('http://unreachable-vllm:9999/v1');
    server.use(
      http.get('http://unreachable-vllm:9999/v1/models', () => HttpResponse.error()),
    );
    const ac = new AbortController();
    const res = await unreachable.probeLiveness(ac.signal);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});

describe('VLLMOpenAIAdapter — chatCompletionsCanonical (non-stream)', () => {
  it('translates canonical → openai params, calls upstream /v1/chat/completions, returns CanonicalResponse', async () => {
    let hit = false;
    server.use(
      http.post(`${VLLM_BASE}/chat/completions`, async ({ request }) => {
        hit = true;
        const body = (await request.json()) as { model?: string; messages?: unknown[] };
        // Adapter forwards the canonical model verbatim — vLLM resolves it against
        // its --served-model-name registration.
        expect(body.model).toBe('Qwen/Qwen2.5-7B-Instruct-AWQ');
        expect(Array.isArray(body.messages)).toBe(true);
        return HttpResponse.json({
          id: 'chatcmpl-msw-vllm',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }),
    );

    const adapter = makeAdapter();
    const ac = new AbortController();
    const res = await adapter.chatCompletionsCanonical(canonicalRequest(), ac.signal);

    expect(hit).toBe(true);
    expect(res.type).toBe('message');
    expect(res.role).toBe('assistant');
    expect(res.content[0]).toMatchObject({ type: 'text', text: 'pong' });
    expect(res.usage.input_tokens).toBe(5);
    expect(res.usage.output_tokens).toBe(1);
  });

  it('uses vllmNonStreamHandler defaults — verifies baseURL routing', async () => {
    server.use(vllmNonStreamHandler({ url: `${VLLM_BASE}/chat/completions` }));
    const adapter = makeAdapter();
    const ac = new AbortController();
    const res = await adapter.chatCompletionsCanonical(canonicalRequest(), ac.signal);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });
});
