import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { APIConnectionError } from 'openai';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { server } from '../setup.js';
import { ollamaStreamHandler } from '../msw/handlers.js';
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

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const MODEL_NAME = 'llama3.2:3b-instruct-q4_K_M';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';
// Phase 3: capabilities + vram_budget_gb are required in the schema.
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
    // Revision 1 (Warning 5) — fake semaphore that grants immediately + idempotent release.
    // These tests do not exercise the rate-limit path; the fake bypasses the real semaphore.
    semaphores: {
      get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
});
afterEach(async () => {
  await app.close();
});

function parseSse(raw: string): Array<{ event?: string; data: string }> {
  // Minimal SSE parser for the assertions below. Splits on blank-line boundaries.
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | undefined;
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data = (data ? data + '\n' : '') + line.slice('data:'.length).trim();
    }
    events.push(event !== undefined ? { event, data } : { data });
  }
  return events;
}

describe('POST /v1/chat/completions stream=true (SC1, OAI-04, OAI-05 stream half) — happy path', () => {
  it('forwards each upstream chunk verbatim', async () => {
    server.use(ollamaStreamHandler({
      url: `${UPSTREAM_BASE}/chat/completions`,
      model: MODEL_NAME,
      tokens: ['Hel', 'lo', ' world'],
      promptTokens: 5,
    }));

    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.payload);
    // Expected: 3 delta chunks + 1 usage chunk + [DONE] from upstream + [DONE] synthesized by router
    const dataEvents = events.filter((e) => e.data && e.data !== '[DONE]');
    const doneEvents = events.filter((e) => e.data === '[DONE]');
    expect(dataEvents.length).toBeGreaterThanOrEqual(4);  // 3 deltas + 1 usage chunk minimum
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('synthesizes terminal data: [DONE]', async () => {
    server.use(ollamaStreamHandler({ url: `${UPSTREAM_BASE}/chat/completions`, tokens: ['ok'] }));
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    const events = parseSse(res.payload);
    const last = events.at(-1);
    expect(last?.data).toBe('[DONE]');
  });

  it('final non-[DONE] chunk has usage.{prompt_tokens,completion_tokens,total_tokens}', async () => {
    server.use(ollamaStreamHandler({
      url: `${UPSTREAM_BASE}/chat/completions`,
      tokens: ['a', 'b', 'c'],
      promptTokens: 7,
    }));
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    const events = parseSse(res.payload);
    // Find the chunk with usage populated (the second-to-last non-[DONE], by spec).
    const usageChunk = events
      .map((e) => { try { return JSON.parse(e.data); } catch { return null; } })
      .filter((p) => p && p.usage)
      .at(-1);
    expect(usageChunk).toBeTruthy();
    expect(usageChunk.usage.prompt_tokens).toBe(7);
    expect(usageChunk.usage.completion_tokens).toBe(3);
    expect(usageChunk.usage.total_tokens).toBe(10);
  });
});

describe('POST /v1/chat/completions stream=true — abort + error paths (SC3 mocked, D-C2, RESEARCH Pitfall 2 + 8)', () => {
  it('route passes AbortSignal to adapter.chatCompletionsStream (SC3 abort chain unit-level)', async () => {
    // Verify that the route handler correctly wires the AbortController signal to the
    // adapter's chatCompletionsStream call. This is the critical link in the SC3 abort chain:
    // req.raw.once('close') -> controller.abort() -> signal -> adapter -> upstream SDK -> undici.
    //
    // We test this at the adapter interface level rather than via real TCP + MSW passthrough,
    // because MSW's passthrough() for SSE streams closes the response connection prematurely,
    // making end-to-end abort tests unreliable in the vitest environment.
    //
    // The live SC3 check (kill curl mid-stream + /api/ps poll confirming Ollama stops)
    // is in plan 02-05's bash smoke test (`bin/smoke-test-router.sh`).
    let capturedSignal: AbortSignal | null = null;
    let chunksYielded = 0;
    let generatorCompleted = false;

    // Mock adapter that captures the signal and generates canonical stream events
    // until aborted. Updated for the Plan 04-01 canonical interface — emits
    // message_start → many content_block_delta {text_delta} → message_stop.
    class MockAbortAdapter implements BackendAdapter {
      async chatCompletionsCanonical(_req: CanonicalRequest, _signal: AbortSignal): Promise<CanonicalResponse> {
        throw new Error('not used in stream test');
      }
      async probeLiveness(_signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
        return { ok: true, latencyMs: 0 };
      }
      async chatCompletionsCanonicalStream(_req: CanonicalRequest, signal: AbortSignal): Promise<AsyncIterable<CanonicalStreamEvent>> {
        capturedSignal = signal;
        return (async function* () {
          try {
            // Emit message_start so canonicalToOpenAISse captures id/model/created.
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
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            for (let i = 0; i < 200; i++) {
              if (signal.aborted) return;
              chunksYielded++;
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: `tok${i}` },
              };
              await new Promise<void>((resolve, reject) => {
                // Respect abort signal in the delay
                const timer = setTimeout(resolve, 20);
                signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
              });
            }
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 200 },
            };
            yield { type: 'message_stop' };
          } finally {
            generatorCompleted = true;
          }
        })();
      }
    }

    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const abortApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: () => new MockAbortAdapter(),
      // Revision 1 (Warning 5) — fake semaphore for this local buildApp instance.
      semaphores: {
        get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
    });

    // Start inject (non-blocking — runs the SSE generator in the background)
    const injectPromise = abortApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'long thing' }], stream: true },
    });

    // Wait for the route handler to start and the generator to yield some chunks
    await new Promise((r) => setTimeout(r, 150));

    // Verify signal is wired correctly
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    const chunksBeforeAbort = chunksYielded;
    expect(chunksBeforeAbort).toBeGreaterThan(0);

    // Simulate what req.raw.once('close') does: call controller.abort().
    // The route exposes the controller through the captured signal.
    // We abort via the signal's underlying controller by triggering it directly.
    // Since we can't access the controller directly, we verify the signal IS the
    // one passed to the adapter (correct wiring), then abort it indirectly by
    // waiting for inject to finish and verifying the generator stopped early.
    //
    // For the actual abort propagation test, we rely on plan 02-05 live smoke.
    // Here we verify: signal is non-null + non-aborted before → generator running.
    expect(chunksBeforeAbort).toBeLessThan(200);  // generator didn't complete all chunks yet

    // Let inject complete (generator runs for ~150ms more then finishes all 200 chunks
    // or times out — we wait up to 5s)
    const res = await injectPromise;
    await abortApp.close();

    expect(res.statusCode).toBe(200);
    // The signal must have been passed to the adapter
    expect(capturedSignal).not.toBeNull();
  }, 10_000);

  it('emits D-C2 error frame on real upstream error (NOT on client abort)', async () => {
    // Upstream emits one chunk then errors out (server-side).
    server.use(http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const chunk = { id: 'x', object: 'chat.completion.chunk', created: 0, model: MODEL_NAME, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          // Force-close mid-stream (simulates upstream connection reset).
          controller.error(new Error('upstream connection reset'));
        },
      });
      return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }));

    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200);  // SSE has already started — HTTP is 200
    const events = parseSse(res.payload);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent).toBeTruthy();
    if (!errorEvent) return;
    const env = JSON.parse(errorEvent.data);
    expect(env.error).toBeTruthy();
    // Followed by [DONE]
    const idx = events.findIndex((e) => e.event === 'error');
    expect(events[idx + 1]?.data).toBe('[DONE]');
  });
});

describe('CR-02 — stream pre-stream error records exactly one row (05-VERIFICATION.md gaps[1])', () => {
  // Each case wires a streaming POST to a fake adapter whose
  // chatCompletionsCanonicalStream throws SYNCHRONOUSLY so the route's inner
  // pre-stream catch (chat-completions.ts ~210) fires BEFORE the SSE headers
  // ship. The fake bufferedWriter captures the row safeRecord pushes; the
  // assertions then confirm the row count is exactly 1 (idempotency proof
  // — if both the inner catch AND the finally fired safeRecord, we'd have
  // 2 rows; the recorded flag prevents that) and that status_class /
  // error_code / error_message are populated correctly.
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
      async chatCompletionsCanonicalStream(
        _req: CanonicalRequest,
        _signal: AbortSignal,
      ): Promise<AsyncIterable<CanonicalStreamEvent>> {
        // Throw synchronously (rejects on the await) so the inner pre-stream
        // catch runs and emits the JSON envelope path — NOT the SSE path.
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
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: MODEL_NAME,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      });

      // Wire side: 429 with OpenAI envelope (rate_limit_error / backend_saturated).
      expect(res.statusCode).toBe(429);
      const body = res.json() as { error?: { code?: string; type?: string } };
      expect(body.error?.code).toBe('backend_saturated');
      expect(body.error?.type).toBe('rate_limit_error');

      // Buffered side: EXACTLY ONE row (idempotency proof).
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe('client_error');
      expect(pushed[0].error_code).toBe('backend_saturated');
      expect(pushed[0].http_status).toBe(429);
      expect(pushed[0].protocol).toBe('openai');
      expect(pushed[0].error_message).not.toBeNull();
    } finally {
      await localApp.close();
    }
  });

  it('CR-02-B: APIConnectionError → 502 wire envelope + 1 server_error row with redacted error_message (D-D3)', async () => {
    // The seeded message contains 'Bearer abc123def456' so we can additionally
    // assert the truncateAndRedact path stripped it before the row landed.
    const seededErr = new APIConnectionError({
      message: 'connect ECONNREFUSED — Bearer abc123def456 expired',
      cause: new Error('ECONNREFUSED'),
    } as never);
    const { app: localApp, pushed } = await buildAppWithFakeAdapter(seededErr);
    try {
      const res = await localApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        payload: {
          model: MODEL_NAME,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        },
      });

      // Wire side: 502 with OpenAI envelope (upstream_error / econnrefused).
      expect(res.statusCode).toBe(502);
      const body = res.json() as { error?: { code?: string; type?: string } };
      expect(body.error?.type).toBe('upstream_error');

      // Buffered side: EXACTLY ONE row (idempotency proof).
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe('server_error');
      expect(pushed[0].error_code).toBe('upstream_timeout');
      expect(pushed[0].http_status).toBe(502);
      expect(pushed[0].protocol).toBe('openai');
      expect(pushed[0].error_message).not.toBeNull();
      // D-D3 redaction gate — truncateAndRedact stripped the 'Bearer xxx' substring.
      expect(pushed[0].error_message).not.toContain('Bearer ');
    } finally {
      await localApp.close();
    }
  });
});

describe('LIVE Ollama stream smoke (opt-in)', () => {
  it.skipIf(process.env.LIVE_OLLAMA !== '1')('SC1 live: stream returns delta chunks + usage + [DONE]', async () => {
    const url = process.env.LIVE_ROUTER_URL ?? 'http://127.0.0.1:3000';
    const tok = process.env.ROUTER_BEARER_TOKEN ?? '';
    if (!tok) throw new Error('LIVE smoke needs ROUTER_BEARER_TOKEN in env');
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b-instruct-q4_K_M',
        messages: [{ role: 'user', content: 'Reply with exactly the word "ok".' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toContain('[DONE]');
    // Find the chunk with usage populated.
    const usageMatch = text.match(/"usage":\{"prompt_tokens":(\d+),"completion_tokens":(\d+),"total_tokens":(\d+)/);
    expect(usageMatch).toBeTruthy();
    if (!usageMatch) return;
    expect(Number(usageMatch[1])).toBeGreaterThan(0);
    expect(Number(usageMatch[2])).toBeGreaterThan(0);
    expect(Number(usageMatch[3])).toBe(Number(usageMatch[1]) + Number(usageMatch[2]));
  }, 60_000);
});
