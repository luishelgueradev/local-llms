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

const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
  // Real OllamaOpenAIAdapter pointed at the msw upstream — exercises the SDK code path end-to-end.
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
  });
});
afterEach(async () => {
  await app.close();
});

describe('POST /v1/chat/completions stream=false (SC2, OAI-01 non-stream half, OAI-05 non-stream half)', () => {
  it('returns full ChatCompletion with usage.{prompt_tokens,completion_tokens,total_tokens}', async () => {
    server.use(ollamaNonStreamHandler({
      url: `${UPSTREAM_BASE}/chat/completions`,
      model: MODEL_NAME,
      content: 'Hi from msw',
      promptTokens: 12,
      completionTokens: 4,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'Say hi' }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toBe('Hi from msw');
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    expect(body.model).toBe(MODEL_NAME);
  });

  it('returns 404 with OpenAI envelope when model is not in registry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'nonexistent:9b', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    const env = res.json();
    expect(env.error.type).toBe('not_found_error');
    expect(env.error.code).toBe('model_not_found');
    expect(env.error.message).toContain('nonexistent:9b');
  });

  it('returns 502 with OpenAI envelope when upstream is unreachable (APIConnectionError)', async () => {
    // No msw handler registered for this URL -> msw returns 'unhandled request' -> openai SDK throws APIConnectionError
    server.use(http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
      return HttpResponse.error();  // Simulates network-level failure
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(502);
    const env = res.json();
    expect(env.error.type).toBe('upstream_error');
  });

  it('returns 400 with OpenAI envelope when body is missing required fields (zod validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },  // missing model
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
  });

});

// ── Plan 04-05 vision on the OpenAI surface (VISION-02) ─────────────────────

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

describe('POST /v1/chat/completions — Plan 04-05 vision capability gate + URL form', () => {
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

  it('VISION-02: image_url on non-vision model returns 400 + OpenAI envelope', async () => {
    let upstreamHit = false;
    server.use(
      http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
        upstreamHit = true;
        return HttpResponse.json({});
      }),
    );
    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: MODEL_NAME, // non-vision
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1_BASE64}` } },
              { type: 'text', text: '?' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('model_capability_mismatch');
    expect(env.error.param).toBe('model');
    expect(upstreamHit).toBe(false);
  });

  it('VISION-01 URL form on OpenAI surface: image_url with https URL → fetched + forwarded to /api/chat', async () => {
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
        content: 'a cat',
        evalCount: 2,
        onRequest: (body) => {
          capturedNativeBody = body as never;
        },
      }),
    );

    const res = await visionApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: {
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
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
    expect(images![0]).not.toMatch(/^data:/);
    const body = res.json();
    expect(body.choices[0].message.content).toBe('a cat');
  });
});

// Live Ollama smoke probe — opt-in via LIVE_OLLAMA=1.
// The full bash smoke test lands in plan 02-05; this is just a vitest convenience.
describe('LIVE Ollama smoke (opt-in)', () => {
  it.skipIf(process.env.LIVE_OLLAMA !== '1')('non-stream against real Ollama returns usage', async () => {
    const url = process.env.LIVE_ROUTER_URL ?? 'http://127.0.0.1:3000';
    const tok = process.env.ROUTER_BEARER_TOKEN ?? '';
    if (!tok) throw new Error('LIVE smoke needs ROUTER_BEARER_TOKEN in env');
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b-instruct-q4_K_M',
        messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    expect(body.choices?.[0]?.message?.content).toBeTruthy();
    expect(body.usage?.total_tokens).toBeGreaterThan(0);
  }, 30_000);
});
