/**
 * ollama-cloud.test.ts — Plan 08-02 (CLOUD-01, CLOUD-02, EMBED-02)
 *
 * Unit tests for OllamaCloudAdapter (router/src/backends/ollama-cloud.ts).
 * Mirrors the shape of ollama-openai.test.ts / vllm-openai.test.ts but pinned
 * to the cloud base URL (https://ollama.com/v1) and the bearer-apiKey path.
 *
 * Coverage:
 *   1. ctor with valid apiKey → constructs; subsequent SDK call carries the
 *      `Authorization: Bearer <key>` header.
 *   2. ctor with empty apiKey → throws at construction time ("empty apiKey")
 *      — the boot-time assertCloudEnvIfConfigured is the primary gate, but the
 *      ctor throw is defense in depth (the factory should not silently accept
 *      a misconfigured adapter).
 *   3. chatCompletionsCanonical happy path — request reaches
 *      https://ollama.com/v1/chat/completions with stream:false; the SDK
 *      response is mapped through openAIChatCompletionToCanonical and the
 *      adapter returns a CanonicalResponse with model/usage/content populated.
 *   4. chatCompletionsCanonicalStream happy path — request reaches the cloud
 *      base with stream:true and stream_options.include_usage:true; the
 *      adapter returns an async iterable that yields at least one canonical
 *      stream event when the upstream emits a single chunk.
 *   5. embeddings happy path — single-string input is forwarded with the
 *      Authorization header; optional opts (encoding_format / dimensions /
 *      user) are spread into the SDK call only when set.
 *   6. probeLiveness — { ok: true } when /v1/models returns non-empty data;
 *      { ok: false, error } on SDK throw (4xx surfaces synchronously).
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { OllamaCloudAdapter } from '../../src/backends/ollama-cloud.js';
import type { CanonicalRequest } from '../../src/translation/canonical.js';

const CLOUD_BASE = 'https://ollama.com/v1';
const TEST_API_KEY = 'oss_test_key_abc123';

function canonicalRequest(model = 'gpt-oss:120b-cloud'): CanonicalRequest {
  return {
    model,
    max_tokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    ],
    stream: false,
  };
}

function floatsToBase64(floats: number[]): string {
  const buf = new ArrayBuffer(floats.length * 4);
  const view = new Float32Array(buf);
  for (let i = 0; i < floats.length; i++) view[i] = floats[i];
  return Buffer.from(buf).toString('base64');
}

describe('OllamaCloudAdapter — constructor', () => {
  it('Test 1: constructs successfully with a non-empty apiKey', () => {
    expect(() => new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY)).not.toThrow();
  });

  it('Test 2: throws with "empty apiKey" message when apiKey is an empty string', () => {
    expect(() => new OllamaCloudAdapter(CLOUD_BASE, '')).toThrow(/empty apiKey/);
  });

  it('Test 2b: also throws when apiKey is whitespace-only', () => {
    expect(() => new OllamaCloudAdapter(CLOUD_BASE, '   ')).toThrow(/empty apiKey/);
  });

  it('Test 2c: SDK constructor still throws if apiKey is undefined (TypeScript guards this; here we verify runtime safety)', () => {
    // Bypassing the TS type for the runtime guard.
    expect(() => new OllamaCloudAdapter(CLOUD_BASE, undefined as unknown as string)).toThrow();
  });
});

describe('OllamaCloudAdapter — chatCompletionsCanonical (non-stream)', () => {
  it('Test 3: forwards canonical → SDK params + bearer header; returns CanonicalResponse', async () => {
    let receivedAuth: string | null = null;
    let receivedBody: { model?: string; stream?: boolean; messages?: unknown[] } | null = null;
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, async ({ request }) => {
        receivedAuth = request.headers.get('authorization');
        receivedBody = (await request.json()) as typeof receivedBody;
        return HttpResponse.json({
          id: 'chatcmpl-cloud-msw',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-oss:120b-cloud',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'pong from cloud' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        });
      }),
    );

    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const res = await adapter.chatCompletionsCanonical(canonicalRequest(), ac.signal);

    expect(receivedAuth).toBe(`Bearer ${TEST_API_KEY}`);
    expect(receivedBody!.model).toBe('gpt-oss:120b-cloud');
    expect(receivedBody!.stream).toBe(false);
    expect(Array.isArray(receivedBody!.messages)).toBe(true);

    expect(res.type).toBe('message');
    expect(res.role).toBe('assistant');
    expect(res.content[0]).toMatchObject({ type: 'text', text: 'pong from cloud' });
    expect(res.usage.input_tokens).toBe(7);
    expect(res.usage.output_tokens).toBe(3);
  });
});

describe('OllamaCloudAdapter — chatCompletionsCanonicalStream', () => {
  it('Test 4: streams with stream:true + include_usage:true; yields at least one canonical event', async () => {
    let receivedBody: { stream?: boolean; stream_options?: { include_usage?: boolean } } | null = null;
    server.use(
      http.post(`${CLOUD_BASE}/chat/completions`, async ({ request }) => {
        receivedBody = (await request.json()) as typeof receivedBody;
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const created = Math.floor(Date.now() / 1000);
            const chunk = {
              id: 'chatcmpl-cloud-stream',
              object: 'chat.completion.chunk',
              created,
              model: 'gpt-oss:120b-cloud',
              choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            const usageChunk = {
              id: 'chatcmpl-cloud-stream',
              object: 'chat.completion.chunk',
              created,
              model: 'gpt-oss:120b-cloud',
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
      }),
    );

    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const iterable = await adapter.chatCompletionsCanonicalStream(
      canonicalRequest(),
      ac.signal,
      { inputTokensHint: 5 },
    );

    expect(receivedBody!.stream).toBe(true);
    expect(receivedBody!.stream_options?.include_usage).toBe(true);

    const events: Array<{ type: string }> = [];
    for await (const ev of iterable) {
      events.push(ev as { type: string });
    }
    // Translator emits at least one event (message_start) before any chunk lands.
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
  });
});

describe('OllamaCloudAdapter — embeddings (EMBED-02)', () => {
  it('Test 5: forwards model/input + bearer auth; spreads optional opts only when set', async () => {
    let receivedAuth: string | null = null;
    let receivedBody: Record<string, unknown> | null = null;
    server.use(
      http.post(`${CLOUD_BASE}/embeddings`, async ({ request }) => {
        receivedAuth = request.headers.get('authorization');
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: floatsToBase64([0.42]) }],
          model: 'embed-cloud-model',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }),
    );

    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const res = await adapter.embeddings('hola', 'embed-cloud-model', ac.signal, {
      encoding_format: 'base64',
    });

    expect(receivedAuth).toBe(`Bearer ${TEST_API_KEY}`);
    expect(receivedBody!.model).toBe('embed-cloud-model');
    expect(receivedBody!.input).toBe('hola');
    expect(receivedBody!.encoding_format).toBe('base64');
    // dimensions + user were NOT passed → MUST NOT appear in the wire body.
    expect(receivedBody!.dimensions).toBeUndefined();
    expect(receivedBody!.user).toBeUndefined();

    expect(res.object).toBe('list');
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.model).toBe('embed-cloud-model');
  });

  it('Test 5b: passes all three optional opts (encoding_format/dimensions/user) when set', async () => {
    let receivedBody: Record<string, unknown> | null = null;
    server.use(
      http.post(`${CLOUD_BASE}/embeddings`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: floatsToBase64([0.1]) }],
          model: 'embed-cloud-model',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }),
    );

    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    await adapter.embeddings('hola', 'embed-cloud-model', ac.signal, {
      encoding_format: 'float',
      dimensions: 512,
      user: 'agent-cloud-1',
    });

    expect(receivedBody!.encoding_format).toBe('float');
    expect(receivedBody!.dimensions).toBe(512);
    expect(receivedBody!.user).toBe('agent-cloud-1');
  });
});

describe('OllamaCloudAdapter — probeLiveness', () => {
  it('Test 6a: { ok: true, latencyMs } when /v1/models returns non-empty data', async () => {
    server.use(
      http.get(`${CLOUD_BASE}/models`, () =>
        HttpResponse.json({
          object: 'list',
          data: [
            { id: 'gpt-oss:120b-cloud', object: 'model', created: 1715517600, owned_by: 'ollama-cloud' },
          ],
        }),
      ),
    );
    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe('number');
    expect(res.error).toBeUndefined();
  });

  it('Test 6b: { ok: false, error: "empty data array" } when /v1/models data is empty', async () => {
    server.use(
      http.get(`${CLOUD_BASE}/models`, () =>
        HttpResponse.json({ object: 'list', data: [] }),
      ),
    );
    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('empty data array');
  });

  it('Test 6c: never throws — 4xx surfaces as { ok: false, error: <string> }', async () => {
    server.use(
      http.get(`${CLOUD_BASE}/models`, () => new HttpResponse('unauthorized', { status: 401 })),
    );
    const adapter = new OllamaCloudAdapter(CLOUD_BASE, TEST_API_KEY);
    const ac = new AbortController();
    const res = await adapter.probeLiveness(ac.signal);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error!.length).toBeGreaterThan(0);
  });
});
