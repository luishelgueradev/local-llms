/**
 * chat-completions.llamacpp.test.ts — Integration tests for LlamacppOpenAIAdapter (Plan 03-01)
 *
 * SC1 proof in-process: same POST /v1/chat/completions route handler serves
 * different backends by switching the model field in the request body.
 *
 * Uses loadRegistryFromString with inline YAML — does NOT read router/models.yaml from disk.
 * This makes it work in isolation and independently of the on-disk file state.
 *
 * Shape mirrors chat-completions.stream.test.ts exactly; differences:
 *   - Uses LlamacppOpenAIAdapter (and both adapters via factory for SC1 dispatch proof)
 *   - Uses llamacppStreamHandler / llamacppNonStreamHandler msw stubs
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { server } from '../setup.js';
import { ollamaStreamHandler, llamacppStreamHandler } from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import { LlamacppOpenAIAdapter } from '../../src/backends/llamacpp-openai.js';
import { makeAdapter } from '../../src/backends/factory.js';
import type { ModelEntry } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

const LLAMACPP_MODEL = 'qwen2.5-7b-instruct-q4km';
const LLAMACPP_UPSTREAM_BASE = 'http://llamacpp:8080/v1';

// Single-entry YAML: only the llamacpp model (for adapter-specific tests)
const LLAMACPP_YAML = `
models:
  - name: ${LLAMACPP_MODEL}
    backend: llamacpp
    backend_url: ${LLAMACPP_UPSTREAM_BASE}
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
`;

const OLLAMA_MODEL = 'llama3.2:3b-instruct-q4_K_M';
const OLLAMA_UPSTREAM_BASE = 'http://ollama:11434/v1';

// Two-entry YAML: both models (for SC1 dispatch proof)
const BOTH_MODELS_YAML = `
models:
  - name: ${OLLAMA_MODEL}
    backend: ollama
    backend_url: ${OLLAMA_UPSTREAM_BASE}
    backend_model: ${OLLAMA_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
  - name: ${LLAMACPP_MODEL}
    backend: llamacpp
    backend_url: ${LLAMACPP_UPSTREAM_BASE}
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
`;

let app: FastifyInstance;

beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(LLAMACPP_YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new LlamacppOpenAIAdapter(entry.backend_url),
  });
});
afterEach(async () => {
  await app.close();
});

function parseSse(raw: string): Array<{ event?: string; data: string }> {
  // Minimal SSE parser. Splits on blank-line boundaries.
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

describe('POST /v1/chat/completions via LlamacppOpenAIAdapter (stream=true)', () => {
  it('forwards each upstream chunk verbatim from llama.cpp backend', async () => {
    server.use(llamacppStreamHandler({
      url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
      model: LLAMACPP_MODEL,
      tokens: ['Hel', 'lo', ' world'],
      promptTokens: 5,
    }));

    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LLAMACPP_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
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

  it('synthesizes terminal data: [DONE] for llama.cpp backend', async () => {
    server.use(llamacppStreamHandler({
      url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
      tokens: ['ok'],
    }));
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LLAMACPP_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    const events = parseSse(res.payload);
    const last = events.at(-1);
    expect(last?.data).toBe('[DONE]');
  });

  it('final non-[DONE] chunk has usage.{prompt_tokens,completion_tokens,total_tokens}', async () => {
    server.use(llamacppStreamHandler({
      url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
      tokens: ['a', 'b', 'c'],
      promptTokens: 7,
    }));
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LLAMACPP_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    const events = parseSse(res.payload);
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

/**
 * SC1 proof: switching model field routes to different backend with no other change.
 *
 * This is the in-process proof of SC1 — the live verification is Plan 05's smoke test.
 * Uses factory.makeAdapter (not a hardcoded adapter) to prove the dispatch seam.
 */
describe('SC1 proof: factory.makeAdapter routes to different backend by model name', () => {
  let sc1App: FastifyInstance;

  beforeEach(async () => {
    const registry = makeRegistryStore(loadRegistryFromString(BOTH_MODELS_YAML));
    sc1App = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      // Use the factory — this is the dispatch seam being proven
      makeAdapter,
    });
  });
  afterEach(async () => {
    await sc1App.close();
  });

  it('model: llama3.2 -> routes to ollama upstream (http://ollama:11434/v1)', async () => {
    let ollamaHit = false;
    let llamacppHit = false;

    server.use(
      ollamaStreamHandler({
        url: `${OLLAMA_UPSTREAM_BASE}/chat/completions`,
        model: OLLAMA_MODEL,
        tokens: ['from-ollama'],
      }),
      llamacppStreamHandler({
        url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
        model: LLAMACPP_MODEL,
        tokens: ['from-llamacpp'],
      }),
    );

    const res = await sc1App.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    // The response should contain 'from-ollama' token, proving the ollama upstream was hit
    expect(res.payload).toContain('from-ollama');
    expect(res.payload).not.toContain('from-llamacpp');
  });

  it('model: qwen2.5 -> routes to llamacpp upstream (http://llamacpp:8080/v1)', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${OLLAMA_UPSTREAM_BASE}/chat/completions`,
        model: OLLAMA_MODEL,
        tokens: ['from-ollama'],
      }),
      llamacppStreamHandler({
        url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
        model: LLAMACPP_MODEL,
        tokens: ['from-llamacpp'],
      }),
    );

    const res = await sc1App.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LLAMACPP_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    // The response should contain 'from-llamacpp' token, proving the llamacpp upstream was hit
    expect(res.payload).toContain('from-llamacpp');
    expect(res.payload).not.toContain('from-ollama');
  });

  it('SC1: switching model name routes to different upstream — both succeed', async () => {
    server.use(
      ollamaStreamHandler({
        url: `${OLLAMA_UPSTREAM_BASE}/chat/completions`,
        model: OLLAMA_MODEL,
        tokens: ['ollama-tok'],
      }),
      llamacppStreamHandler({
        url: `${LLAMACPP_UPSTREAM_BASE}/chat/completions`,
        model: LLAMACPP_MODEL,
        tokens: ['llamacpp-tok'],
      }),
    );

    // First request: ollama model
    const res1 = await sc1App.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    // Second request: llamacpp model — same route, just different model name
    const res2 = await sc1App.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: LLAMACPP_MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    // Both succeed with 200
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    // Each response contains tokens from its respective upstream — proving different adapters were invoked
    expect(res1.payload).toContain('ollama-tok');
    expect(res2.payload).toContain('llamacpp-tok');
    expect(res1.payload).not.toContain('llamacpp-tok');
    expect(res2.payload).not.toContain('ollama-tok');
  });
});
