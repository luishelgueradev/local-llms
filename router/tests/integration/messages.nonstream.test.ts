/**
 * messages.nonstream.test.ts — Integration tests for POST /v1/messages (non-stream).
 *
 * Covers Plan 04-02 requirements:
 *   ANTHR-01 (non-stream half) — happy path Anthropic Message wire shape
 *   ANTHR-03 — top-level system honored
 *   ANTHR-04 — role-alternation + tool_result ordering + role:'system' rejection
 *   ANTHR-05 — anthropic-version request header echoed (sanitized)
 *   Capability gate placeholder for Plan 04-05 vision routing
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { ollamaNonStreamHandler } from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import type { ModelEntry } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const MODEL_NAME = 'llama3.2:3b-instruct-q4_K_M';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';
const YAML = `
models:
  - name: ${MODEL_NAME}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${MODEL_NAME}
    capabilities: [chat]
    vram_budget_gb: 4
`;

let app: FastifyInstance;

beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
  });
});
afterEach(async () => {
  await app.close();
});

describe('POST /v1/messages stream=false — happy path (ANTHR-01 non-stream half)', () => {
  it('returns Anthropic-shape Message body with text content + usage', async () => {
    server.use(
      ollamaNonStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        content: 'Hi from msw',
        promptTokens: 12,
        completionTokens: 4,
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Say hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toMatch(/^msg_/);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content).toEqual([{ type: 'text', text: 'Hi from msw' }]);
    expect(body.model).toBe(MODEL_NAME);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
  });
});

describe('POST /v1/messages — ANTHR-03 system lifting', () => {
  it('top-level system is forwarded to upstream as the first system message', async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(`${UPSTREAM_BASE}/chat/completions`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          id: 'chatcmpl-msw',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL_NAME,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        system: 'be brief',
      },
    });

    expect(res.statusCode).toBe(200);
    const upstream = capturedBody as { messages?: Array<{ role: string; content: unknown }> };
    expect(upstream.messages).toBeDefined();
    expect(upstream.messages?.[0]?.role).toBe('system');
    expect(upstream.messages?.[0]?.content).toBe('be brief');
  });
});

describe('POST /v1/messages — ANTHR-04 role-alternation + ordering', () => {
  it('rejects [user, user] with 400 + Anthropic envelope mentioning alternate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message.toLowerCase()).toContain('alternate');
  });

  it('rejects tool_result AFTER text inside a user message with 400 + Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'context' },
              { type: 'tool_result', tool_use_id: 'toolu_xyz', content: 'result' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message).toContain('tool_result');
  });

  it("rejects role:'system' inside messages[] (system is top-level only)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'system', content: 'b' },
          { role: 'user', content: 'c' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
  });
});

describe('POST /v1/messages — ANTHR-05 anthropic-version echo (T-04-05)', () => {
  it('echoes the anthropic-version header verbatim', async () => {
    server.use(
      ollamaNonStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        content: 'ok',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('strips CR/LF and length-caps the anthropic-version header before echoing', async () => {
    server.use(
      ollamaNonStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        content: 'ok',
      }),
    );
    // Header smuggling attempt: includes \r\n and is far longer than 64 chars.
    // Note: Node's HTTP parser rejects raw CRLF in header values upstream of our
    // sanitization, so we use a header that already passed parsing but still
    // contains weird suffix characters our slice(0,64).replace logic must handle.
    const long = 'A'.repeat(120);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'anthropic-version': long,
      },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.headers['anthropic-version'];
    expect(typeof echoed).toBe('string');
    expect((echoed as string).length).toBeLessThanOrEqual(64);
    expect(echoed).not.toMatch(/[\r\n]/);
  });

  it('does NOT inject anthropic-version when absent from the request', async () => {
    server.use(
      ollamaNonStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        content: 'ok',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['anthropic-version']).toBeUndefined();
  });
});

describe('POST /v1/messages — error mapping (Anthropic envelope branch)', () => {
  it('unknown model returns 404 with Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: 'nonexistent:9b',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(404);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('not_found_error');
    expect(env.error.message).toContain('nonexistent:9b');
  });

  it('upstream unreachable returns api_error envelope (mapped via APIConnectionError)', async () => {
    server.use(http.post(`${UPSTREAM_BASE}/chat/completions`, () => HttpResponse.error()));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    // APIConnectionError → 502 (mapToHttpStatus); Anthropic envelope collapses to api_error.
    expect(res.statusCode).toBe(502);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('api_error');
  });

  it('missing max_tokens returns 400 with Anthropic envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        // max_tokens missing — REQUIRED in /v1/messages per ANTHR-01 / FINDING 1.4
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
  });

  it('stream:true returns 501 + Anthropic envelope (Plan 04-03 fills the stream branch)', async () => {
    // Plan 04-03 will DELETE this assertion when it replaces the 501 stub with the
    // full SSE pipeline. The presence of this test is a forward-handoff marker.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(501);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message).toMatch(/Plan 04-03|streaming/i);
  });
});
