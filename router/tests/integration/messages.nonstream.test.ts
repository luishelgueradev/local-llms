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
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as dns from 'node:dns';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import {
  ollamaNonStreamHandler,
  ollamaNativeChatHandler,
  imageFetchHandler,
} from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import type { ModelEntry } from '../../src/config/registry.js';

// Tiny 1x1 transparent PNG (shared with count-tokens / translator tests).
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
    bufferedWriter: makeFakeBufferedWriter(),
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

  // WR-06: the sanitizer must strip the full set of HTTP-disallowed bytes (NUL,
  // VT, FF, ESC, DEL, high-bit 0x80-0xFF) — not just CR/LF — before echoing.
  // RFC 7230 §3.2.6 limits header field-vchar to visible US-ASCII + HTAB.
  it('strips non-printable control bytes from anthropic-version before echoing', async () => {
    server.use(
      ollamaNonStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        content: 'ok',
      }),
    );
    // Header with NUL, VT, FF, ESC, DEL, and a high-bit byte interleaved.
    const probe = `2023-\x00\v\f\x1b\x7f\xff06-01`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'anthropic-version': probe,
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
    // All control / high-bit bytes removed; visible ASCII preserved.
    expect(echoed).toBe('2023-06-01');
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

  // Plan 04-02 had a 12th case here asserting `stream:true returns 501 + Anthropic
  // envelope` — Plan 04-03 deleted it because the 501 placeholder was replaced with
  // the full streaming pipeline. End-to-end stream coverage now lives in
  // tests/integration/messages.stream.test.ts.
});

// ── Plan 04-05 vision tests ──────────────────────────────────────────────────
//
// Uses a SECOND app instance with a YAML that declares BOTH a text-only model AND
// a vision-capable model so capability-gate + happy-path coverage can coexist.
// The vision model dispatches through Ollama's native /api/chat (VISION-03).

const VISION_MODEL = 'llama3.2-vision:11b-instruct-q4_K_M';
const YAML_VISION = `
models:
  - name: ${MODEL_NAME}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${MODEL_NAME}
    capabilities: [chat]
    vram_budget_gb: 4

  - name: ${VISION_MODEL}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${VISION_MODEL}
    capabilities: [chat, vision]
    vram_budget_gb: 8
`;

describe('POST /v1/messages — Plan 04-05 vision (VISION-01..03)', () => {
  let visionApp: FastifyInstance;

  beforeEach(async () => {
    const registry = makeRegistryStore(loadRegistryFromString(YAML_VISION));
    visionApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
      semaphores: {
        get: () =>
          ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
    });
  });
  afterEach(async () => {
    await visionApp.close();
    vi.restoreAllMocks();
  });

  it('VISION-02: image content + non-vision model returns 400 + Anthropic envelope BEFORE adapter call', async () => {
    // Negative: register a handler that throws if hit. The capability gate must
    // fire before any upstream call so this handler is never invoked.
    let upstreamHit = false;
    server.use(
      http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
        upstreamHit = true;
        return HttpResponse.json({});
      }),
      http.post('http://upstream-mock:11434/api/chat', () => {
        upstreamHit = true;
        return HttpResponse.json({});
      }),
    );
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME, // non-vision
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 },
              },
              { type: 'text', text: 'what is this?' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message.toLowerCase()).toContain('vision');
    expect(upstreamHit).toBe(false);
  });

  it('VISION-01 base64: vision happy path via mocked /api/chat returns assistant content + usage', async () => {
    server.use(
      ollamaNativeChatHandler({
        url: 'http://upstream-mock:11434/api/chat',
        model: VISION_MODEL,
        content: 'I see a cat in the image',
        promptEvalCount: 20,
        evalCount: 8,
      }),
    );

    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_1x1_BASE64 },
              },
              { type: 'text', text: 'what is in this image?' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toEqual([{ type: 'text', text: 'I see a cat in the image' }]);
    expect(body.usage).toEqual({ input_tokens: 20, output_tokens: 8 });
    expect(body.model).toBe(VISION_MODEL);
  });

  it('VISION-01 URL form: fetches via MSW + forwards bare base64 to /api/chat', async () => {
    const imageUrl = 'https://example.com/cat.png';
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);

    let capturedNativeBody: { messages?: Array<{ images?: string[] }> } | null = null;
    server.use(
      imageFetchHandler({ url: imageUrl, contentType: 'image/png' }),
      ollamaNativeChatHandler({
        url: 'http://upstream-mock:11434/api/chat',
        model: VISION_MODEL,
        content: 'I see a cat',
        evalCount: 6,
        onRequest: (body) => {
          capturedNativeBody = body as never;
        },
      }),
    );

    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: imageUrl } },
              { type: 'text', text: '?' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedNativeBody).not.toBeNull();
    const images = capturedNativeBody!.messages?.[0]?.images;
    expect(images).toBeDefined();
    expect(images![0]).toBeTruthy();
    // Must be bare base64 — no data: prefix.
    expect(images![0]).not.toMatch(/^data:/);
    expect(images![0]!.length).toBeGreaterThan(0);
  });

  it('VISION-01 URL: http:// scheme rejected with 400 invalid_image_url', async () => {
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'http://example.com/x.png' } }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message.toLowerCase()).toMatch(/https/);
  });

  it('VISION-01 URL: private IP resolution rejected with 400', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '10.0.0.1', family: 4 },
    ] as never);
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://internal.example.com/x.png' } },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.message.toLowerCase()).toMatch(/private|loopback|ssrf/);
  });

  it('VISION-01 URL: non-image Content-Type rejected with 400', async () => {
    const imageUrl = 'https://example.com/not-an-image';
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    server.use(imageFetchHandler({ url: imageUrl, contentType: 'text/html' }));
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: imageUrl } }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.message.toLowerCase()).toMatch(/content-type|text\/html/);
  });

  it('VISION-01 URL: oversized body rejected with 400 image_too_large', async () => {
    const imageUrl = 'https://example.com/big.png';
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    // 11 MB stream — exceeds the 10 MB cap quickly.
    server.use(
      http.get(imageUrl, () => {
        const chunkSize = 256 * 1024;
        const totalChunks = 44; // ~11 MB
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < totalChunks; i++) {
              controller.enqueue(new Uint8Array(chunkSize));
            }
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }),
    );
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: imageUrl } }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.message.toLowerCase()).toMatch(/10mb|too large|exceeded/);
  });
});
