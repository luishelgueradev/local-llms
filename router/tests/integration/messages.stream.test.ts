/**
 * messages.stream.test.ts — Integration tests for POST /v1/messages (stream:true).
 *
 * Plan 04-03 requirements:
 *   ANTHR-01 stream half — typed-SSE pipeline emits the documented Anthropic events
 *   ANTHR-06 — event order: message_start → content_block_start → content_block_delta+
 *              → content_block_stop → message_delta → message_stop; ping interleaved
 *   ANTHR-07 — usage placement: input_tokens on message_start, cumulative
 *              output_tokens on message_delta
 *   Mid-stream upstream error → SINGLE event: error frame, NO [DONE]
 *   Client abort → no further frames (Pitfall 8)
 *   Heartbeat (Anthropic ping payload) every 15s
 *   Regression gate: /v1/chat/completions stream still terminates with data: [DONE]
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as dns from 'node:dns';
import { APIConnectionError } from 'openai';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { server } from '../setup.js';
import {
  ollamaStreamHandler,
  ollamaNativeChatHandler,
  imageFetchHandler,
} from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/translation/canonical.js';
import { BackendSaturatedError } from '../../src/concurrency/semaphore.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';

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
    // Fake semaphore: grants immediately + idempotent release. These tests don't
    // exercise the rate-limit path; the fake bypasses the real semaphore.
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
});
afterEach(async () => {
  await app.close();
});

/**
 * Minimal SSE parser. Splits on blank-line boundaries; recovers `event:` and `data:`
 * lines. Defensively drops any retry-only directives (no event-name, no data-line).
 *
 * Note: as of the SSE-retry-preamble fix the plugin is registered with
 * `{ retryDelay: false }`, so `retry: 3000\n\n` no longer appears in router output.
 * The filter stays as a no-op safety net — keeps the event-name sequence assertions
 * clean even if some future test fixture re-introduces a retry directive.
 *
 * Mirrors tests/integration/chat-completions.stream.test.ts:51-66 modulo the retry
 * filter (chat-completions asserts on data-presence; this file asserts on event-name
 * order, so any empty-data block must be dropped).
 */
function parseSse(raw: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | undefined;
    let data = '';
    let hasData = false;
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) {
        data = (data ? data + '\n' : '') + line.slice('data:'.length).trim();
        hasData = true;
      }
    }
    // Skip retry-only directives (no event, no data lines).
    if (!hasData && event === undefined) continue;
    events.push(event !== undefined ? { event, data } : { data });
  }
  return events;
}

describe('POST /v1/messages stream=true — happy path (ANTHR-01 stream / ANTHR-06 event order)', () => {
  it('emits message_start → block_start → text_delta(s) → block_stop → message_delta → message_stop in order', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        tokens: ['Hel', 'lo', ' world'],
        promptTokens: 12,
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'say hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.payload);
    // Drop ping events; the remaining sequence must match the documented order.
    const nonPing = events.filter((e) => e.event !== 'ping');
    const names = nonPing.map((e) => e.event);
    expect(names).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // ANTHR-06: every data field's `type` matches its event:.
    for (const ev of nonPing) {
      const obj = JSON.parse(ev.data) as { type: string };
      expect(obj.type).toBe(ev.event);
    }

    // ANTHR-06 negative gate: no [DONE] anywhere.
    for (const ev of events) {
      expect(ev.data).not.toContain('[DONE]');
    }

    // Concatenated text must equal the upstream tokens joined.
    const concatenated = nonPing
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => {
        const obj = JSON.parse(e.data) as { delta: { type: string; text?: string } };
        return obj.delta.text ?? '';
      })
      .join('');
    expect(concatenated).toBe('Hello world');
  });

  it('ANTHR-07: message_start.usage.input_tokens > 0 (from countTokens hint via adapter signature)', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        tokens: ['ok'],
        promptTokens: 5,
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'say something with several tokens to count' }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    const msgStart = events.find((e) => e.event === 'message_start');
    expect(msgStart).toBeTruthy();
    const parsed = JSON.parse(msgStart!.data) as {
      message: { usage: { input_tokens: number; output_tokens: number } };
    };
    expect(parsed.message.usage.input_tokens).toBeGreaterThan(0);
    // ANTHR-07 + Pitfall 3: output_tokens starts at 1 (pre-allocated role token) on message_start.
    expect(parsed.message.usage.output_tokens).toBe(1);
  });

  it('ANTHR-07: message_delta.usage.output_tokens is cumulative total (NOT per-chunk delta)', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        tokens: ['a', 'b', 'c'],
        promptTokens: 7,
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
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    const msgDelta = events.find((e) => e.event === 'message_delta');
    expect(msgDelta).toBeTruthy();
    const parsed = JSON.parse(msgDelta!.data) as {
      delta: { stop_reason: string; stop_sequence: string | null };
      usage: { output_tokens: number };
    };
    // 3 tokens upstream → cumulative output_tokens = 3 (the upstream's completion_tokens).
    expect(parsed.usage.output_tokens).toBe(3);
    expect(parsed.delta.stop_reason).toBe('end_turn');
    expect(parsed.delta.stop_sequence).toBeNull();
  });

  it('ANTHR-06: stream terminator is event: message_stop (NOT data: [DONE])', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        tokens: ['ok'],
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
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    const nonPing = events.filter((e) => e.event !== 'ping');
    expect(nonPing.at(-1)?.event).toBe('message_stop');
    // Negative: payload must NOT contain the OpenAI-style [DONE] terminator.
    expect(res.payload).not.toContain('[DONE]');
  });
});

describe('POST /v1/messages stream=true — error path (mid-stream upstream failure)', () => {
  it('mid-stream upstream error emits event: error WITHOUT [DONE]', async () => {
    // Upstream emits one delta chunk then errors out (server-side TCP reset analog).
    server.use(
      http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            const chunk = {
              id: 'chatcmpl-msw',
              object: 'chat.completion.chunk',
              created: 0,
              model: MODEL_NAME,
              choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            // Force-close mid-stream — simulates upstream connection reset.
            controller.error(new Error('upstream connection reset'));
          },
        });
        return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
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
        stream: true,
      },
    });
    // SSE has already started — HTTP is 200; the error appears as a typed event.
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeTruthy();
    if (!errorEvent) return;
    const env = JSON.parse(errorEvent.data) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(env.type).toBe('error');
    // APIConnectionError → 'api_error' on the Anthropic taxonomy (FINDING D-F5).
    expect(env.error.type).toBe('api_error');
    // Anthropic does NOT emit [DONE] after error — single frame, stream ends.
    expect(res.payload).not.toContain('[DONE]');
  });
});

describe('POST /v1/messages stream=true — abort propagation (Pitfall 8 + SC3 mocked)', () => {
  it('route passes AbortSignal to adapter.chatCompletionsCanonicalStream (abort chain unit-level)', async () => {
    let capturedSignal: AbortSignal | null = null;
    let chunksYielded = 0;

    class MockAbortAdapter implements BackendAdapter {
      async chatCompletionsCanonical(
        _req: CanonicalRequest,
        _signal: AbortSignal,
      ): Promise<CanonicalResponse> {
        throw new Error('not used in stream test');
      }
      async probeLiveness(
        _signal: AbortSignal,
      ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        return { ok: true, latencyMs: 0 };
      }
      // Plan 07-04: BackendAdapter widened with .embeddings(); not exercised here.
      async embeddings(
        _input: string | string[],
        _model: string,
        _signal: AbortSignal,
      ): Promise<never> {
        throw new Error('not used in stream test');
      }
      // Phase 11 (v0.10.0 — RERANK-02): not exercised here.
      async rerank(): Promise<never> {
        throw new Error('not used in stream test');
      }
      async chatCompletionsCanonicalStream(
        _req: CanonicalRequest,
        signal: AbortSignal,
        _opts?: { inputTokensHint?: number },
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        capturedSignal = signal;
        return (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg_01HXYZTESTABORT00000000000',
              type: 'message',
              role: 'assistant',
              content: [],
              model: MODEL_NAME,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 1 },
            },
          } as CanonicalStreamEvent;
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          };
          for (let i = 0; i < 200; i++) {
            if (signal.aborted) return;
            chunksYielded++;
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: `tok${i}` },
            };
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 20);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
          }
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 200 },
          };
          yield { type: 'message_stop' };
        })();
      }
    }

    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const abortApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => new MockAbortAdapter(),
      semaphores: {
        get: () =>
          ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
    });

    const injectPromise = abortApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'long thing' }],
        stream: true,
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    const chunksBeforeAbort = chunksYielded;
    expect(chunksBeforeAbort).toBeGreaterThan(0);

    const res = await injectPromise;
    await abortApp.close();
    expect(res.statusCode).toBe(200);
    // The signal was wired through opts.
    expect(capturedSignal).not.toBeNull();
  }, 10_000);
});

describe('POST /v1/messages stream=true — adapter receives inputTokensHint (Issue #6 resolution)', () => {
  it('opts.inputTokensHint is passed to adapter.chatCompletionsCanonicalStream', async () => {
    let capturedOpts: { inputTokensHint?: number } | undefined;

    class HintCapturingAdapter implements BackendAdapter {
      async chatCompletionsCanonical(
        _req: CanonicalRequest,
        _signal: AbortSignal,
      ): Promise<CanonicalResponse> {
        throw new Error('not used');
      }
      async probeLiveness(
        _signal: AbortSignal,
      ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        return { ok: true, latencyMs: 0 };
      }
      // Plan 07-04: BackendAdapter widened with .embeddings(); not exercised here.
      async embeddings(
        _input: string | string[],
        _model: string,
        _signal: AbortSignal,
      ): Promise<never> {
        throw new Error('not used');
      }
      // Phase 11 (v0.10.0 — RERANK-02): not exercised here.
      async rerank(): Promise<never> {
        throw new Error('not used');
      }
      async chatCompletionsCanonicalStream(
        _req: CanonicalRequest,
        _signal: AbortSignal,
        opts?: { inputTokensHint?: number },
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        capturedOpts = opts;
        return (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg_01HXYZTESTHINT0000000000',
              type: 'message',
              role: 'assistant',
              content: [],
              model: MODEL_NAME,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: opts?.inputTokensHint ?? 0, output_tokens: 1 },
            },
          } as CanonicalStreamEvent;
          yield { type: 'message_stop' };
        })();
      }
    }

    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const hintApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => new HintCapturingAdapter(),
      semaphores: {
        get: () =>
          ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
    });

    const res = await hintApp.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'some prompt text that tokenizes to several BPE units' }],
        stream: true,
      },
    });
    await hintApp.close();

    expect(res.statusCode).toBe(200);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.inputTokensHint).toBeGreaterThan(0);
    // The hint surfaces as input_tokens on message_start in the synthetic event.
    const events = parseSse(res.payload);
    const start = events.find((e) => e.event === 'message_start');
    expect(start).toBeTruthy();
    const parsed = JSON.parse(start!.data) as {
      message: { usage: { input_tokens: number } };
    };
    expect(parsed.message.usage.input_tokens).toBe(capturedOpts!.inputTokensHint);
  });
});

// ── Plan 04-05 vision-stream tests ────────────────────────────────────────────
//
// Asserts that vision-stream requests dispatch through Ollama's native /api/chat
// endpoint (VISION-03 / Pitfall 8). A negative handler registered on the OpenAI-
// compat URL `/v1/chat/completions` throws if the dispatch path is wrong.

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

describe('POST /v1/messages stream=true — Plan 04-05 vision (VISION-03)', () => {
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
    metrics: makeFakeMetrics(),
    });
  });
  afterEach(async () => {
    await visionApp.close();
    vi.restoreAllMocks();
  });

  it('VISION-03 base64: vision stream dispatches through native /api/chat (NOT /v1/chat/completions)', async () => {
    let nativeHit = false;
    let openaiCompatHit = false;
    server.use(
      ollamaNativeChatHandler({
        url: 'http://upstream-mock:11434/api/chat',
        model: VISION_MODEL,
        stream: true,
        tokens: ['I ', 'see ', 'a ', 'cat'],
        onRequest: () => {
          nativeHit = true;
        },
      }),
      // Negative handler: if the OpenAI-compat shim is hit with vision content,
      // mark and return error so the integration test fails loudly.
      http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
        openaiCompatHit = true;
        return HttpResponse.json({ error: 'VISION-03 violation' }, { status: 500 });
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
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(nativeHit).toBe(true);
    expect(openaiCompatHit).toBe(false);

    // Events flow through unchanged: message_start → content_block_* → message_stop.
    expect(res.payload).toContain('event: message_start');
    expect(res.payload).toContain('event: content_block_delta');
    expect(res.payload).toContain('event: message_stop');
    expect(res.payload).not.toContain('[DONE]');
  });

  it('VISION-03 URL form: vision stream URL-fetch → native /api/chat with bare base64', async () => {
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
        stream: true,
        tokens: ['ok'],
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
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedNativeBody).not.toBeNull();
    const images = capturedNativeBody!.messages?.[0]?.images;
    expect(images).toBeDefined();
    expect(images![0]).toBeTruthy();
    expect(images![0]).not.toMatch(/^data:/);
    expect(res.payload).toContain('event: message_stop');
  });
});

describe('regression gate — /v1/chat/completions stream still uses OpenAI terminator', () => {
  it('OpenAI surface still emits data: [DONE] (Plan 04-03 must not regress Phase 2/3)', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${UPSTREAM_BASE}/chat/completions`,
        model: MODEL_NAME,
        tokens: ['ok'],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // OpenAI terminator is preserved — proves Plan 04-03 didn't accidentally drop it.
    expect(res.payload).toContain('[DONE]');
    // OpenAI surface never emits the Anthropic typed terminator.
    expect(res.payload).not.toContain('event: message_stop');
  });
});

describe('CR-02 — stream pre-stream error records exactly one row (05-VERIFICATION.md gaps[1])', () => {
  // Symmetric to chat-completions.stream.test.ts — anthropic surface variant.
  // Adapter throws SYNCHRONOUSLY so the route's inner pre-stream catch
  // (messages.ts ~238) fires BEFORE the SSE headers ship. The fake
  // bufferedWriter captures the row safeRecord pushes; the assertions then
  // confirm exactly one row + correct status_class / error_code / redacted
  // error_message.
  function makeRejectingAdapter(err: Error): BackendAdapter {
    return {
      async chatCompletionsCanonical(
        _req: CanonicalRequest,
        _signal: AbortSignal,
      ): Promise<CanonicalResponse> {
        throw new Error('not used in stream test');
      },
      async probeLiveness(
        _signal: AbortSignal,
      ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        return { ok: true, latencyMs: 0 };
      },
      // Plan 07-04: BackendAdapter widened with .embeddings(); not exercised here.
      async embeddings(
        _input: string | string[],
        _model: string,
        _signal: AbortSignal,
      ): Promise<never> {
        throw new Error('not used in stream test');
      },
      // Phase 11 (v0.10.0 — RERANK-02): not exercised here.
      async rerank(): Promise<never> {
        throw new Error('not used');
      },
      async chatCompletionsCanonicalStream(
        _req: CanonicalRequest,
        _signal: AbortSignal,
        _opts?: { inputTokensHint?: number },
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        throw err;
      },
    };
  }

  async function buildAppWithFakeAdapter(err: Error): Promise<{
    app: FastifyInstance;
    pushed: RequestLogInsert[];
  }> {
    const pushed: RequestLogInsert[] = [];
    const fakeBuffered = {
      push: (row: RequestLogInsert) => pushed.push(row),
      drain: async () => {},
      get size() {
        return 0;
      },
    };
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const a = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => makeRejectingAdapter(err),
      semaphores: {
        get: () =>
          ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: fakeBuffered,
      metrics: makeMetricsRegistry(),
    });
    return { app: a, pushed };
  }

  it('CR-02-A: BackendSaturatedError → 429 wire envelope + 1 client_error row with backend_saturated', async () => {
    const seededErr = new BackendSaturatedError('ollama', 30_000);
    const { app: localApp, pushed } = await buildAppWithFakeAdapter(seededErr);
    try {
      const res = await localApp.inject({
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

      // Wire side: 429 with Anthropic envelope (rate_limit_error).
      expect(res.statusCode).toBe(429);
      const body = res.json() as { type?: string; error?: { type?: string } };
      expect(body.type).toBe('error');
      expect(body.error?.type).toBe('rate_limit_error');

      // Buffered side: EXACTLY ONE row.
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe('client_error');
      expect(pushed[0].error_code).toBe('backend_saturated');
      expect(pushed[0].http_status).toBe(429);
      expect(pushed[0].protocol).toBe('anthropic');
      expect(pushed[0].error_message).not.toBeNull();
    } finally {
      await localApp.close();
    }
  });

  it('CR-02-B: APIConnectionError → 502 wire envelope + 1 server_error row with redacted error_message (D-D3)', async () => {
    const seededErr = new APIConnectionError({
      message: 'connect ECONNREFUSED — Bearer abc123def456 expired',
      cause: new Error('ECONNREFUSED'),
    } as never);
    const { app: localApp, pushed } = await buildAppWithFakeAdapter(seededErr);
    try {
      const res = await localApp.inject({
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

      // Wire side: 502 with Anthropic envelope (api_error per anthropic taxonomy).
      expect(res.statusCode).toBe(502);
      const body = res.json() as { type?: string; error?: { type?: string } };
      expect(body.type).toBe('error');
      expect(body.error?.type).toBe('api_error');

      // Buffered side: EXACTLY ONE row.
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe('server_error');
      expect(pushed[0].error_code).toBe('upstream_timeout');
      expect(pushed[0].http_status).toBe(502);
      expect(pushed[0].protocol).toBe('anthropic');
      expect(pushed[0].error_message).not.toBeNull();
      expect(pushed[0].error_message).not.toContain('Bearer ');
    } finally {
      await localApp.close();
    }
  });
});

describe('CR-03 — mid-stream upstream error records server_error (05-VERIFICATION.md gaps[2])', () => {
  // Symmetric to chat-completions.stream.test.ts CR-03 test — anthropic surface variant.
  // The fake adapter yields ONE message_start event AND THEN throws an
  // APIConnectionError. Additional assertion vs the OpenAI version:
  // pushed[0].upstream_message_id === 'msg_01ARZH' (the literal seeded by the
  // fake generator's message_start event) — proves the upstreamMessageId
  // passthrough survives the mid-stream error / sseCleanup error-override.
  function makeMidStreamFailingAdapter(seededErr: Error): BackendAdapter {
    return {
      async chatCompletionsCanonical(
        _req: CanonicalRequest,
        _signal: AbortSignal,
      ): Promise<CanonicalResponse> {
        throw new Error('not used in stream test');
      },
      async probeLiveness(
        _signal: AbortSignal,
      ): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        return { ok: true, latencyMs: 0 };
      },
      // Plan 07-04: BackendAdapter widened with .embeddings(); not exercised here.
      async embeddings(
        _input: string | string[],
        _model: string,
        _signal: AbortSignal,
      ): Promise<never> {
        throw new Error('not used in stream test');
      },
      // Phase 11 (v0.10.0 — RERANK-02): not exercised here.
      async rerank(): Promise<never> {
        throw new Error('not used');
      },
      async chatCompletionsCanonicalStream(
        _req: CanonicalRequest,
        _signal: AbortSignal,
        _opts?: { inputTokensHint?: number },
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        return (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg_01ARZH',
              type: 'message',
              role: 'assistant',
              content: [],
              model: MODEL_NAME,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          } as CanonicalStreamEvent;
          throw seededErr;
        })();
      },
    };
  }

  it('CR-03: mid-stream APIConnectionError after message_start ships → wire 200, server_error + redacted error_message + preserved upstreamMessageId', async () => {
    const seededErr = new APIConnectionError({
      message: 'upstream socket closed — Bearer abc123def456 expired',
      cause: new Error('ECONNRESET'),
    } as never);
    const pushed: RequestLogInsert[] = [];
    const fakeBuffered = {
      push: (row: RequestLogInsert) => pushed.push(row),
      drain: async () => {},
      get size() {
        return 0;
      },
    };
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const localApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => makeMidStreamFailingAdapter(seededErr),
      semaphores: {
        get: () =>
          ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: fakeBuffered,
      metrics: makeMetricsRegistry(),
    });

    try {
      const res = await localApp.inject({
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

      // Wire side: HTTP 200 (SSE headers already flushed before the throw).
      expect(res.statusCode).toBe(200);
      // At least one SSE data: frame shipped (message_start + translator's
      // emitted Anthropic error frame).
      expect(res.payload).toContain('data:');

      // Buffered side: EXACTLY ONE row with the upstream error reflected.
      expect(pushed.length).toBe(1);
      // CR-03 regression gate: NOT 'success'.
      expect(pushed[0].status_class).toBe('server_error');
      // APIConnectionError → 'upstream_timeout' per mapErrorToCode.
      expect(['upstream_timeout', 'upstream_5xx', 'internal_error']).toContain(
        pushed[0].error_code,
      );
      expect(pushed[0].http_status).toBe(502);
      expect(pushed[0].protocol).toBe('anthropic');
      expect(pushed[0].error_message).not.toBeNull();
      // D-D3 redaction gate — the seeded 'Bearer abc123def456' must be stripped.
      expect(pushed[0].error_message).not.toContain('Bearer ');
      // Anthropic-specific: upstream_message_id must survive the mid-stream
      // error / sseCleanup error-override (the override does NOT drop it).
      expect(pushed[0].upstream_message_id).toBe('msg_01ARZH');
    } finally {
      await localApp.close();
    }
  });
});
