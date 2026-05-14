import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
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

// Capture pino lines emitted during the test.
const collectedLogLines: string[] = [];
const writeStream = {
  write: (chunk: string) => {
    collectedLogLines.push(chunk);
    return true;
  },
};

let app: FastifyInstance;

beforeEach(async () => {
  collectedLogLines.length = 0;
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    // Use stream-based logger so we can capture log lines for assertions.
    loggerOpts: { level: 'info', stream: writeStream as never } as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    semaphores: {
      get: () =>
        ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeMetricsRegistry(),
  });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('agentIdPreHandler (ROUTE-09, D-D5)', () => {
  it('1. absent X-Agent-Id — request succeeds; req.agentId undefined', async () => {
    // /healthz is unauth; absent header just falls through.
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    // No log line should carry agent_id when header is absent.
    const lines = collectedLogLines.join('');
    expect(lines).not.toContain('"agent_id":"');
  });

  it('2. valid X-Agent-Id "claude-code:luis" — pino child log line carries agent_id', async () => {
    // Send a body-shape-invalid request so it 400s without needing upstream; pino still
    // logs from the centralized error handler via req.log.warn(...).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-agent-id': 'claude-code:luis',
      },
      payload: { messages: [{ role: 'user', content: 'hi' }] }, // missing model -> 400
    });
    expect(res.statusCode).toBe(400);
    const lines = collectedLogLines.join('');
    expect(lines).toContain('"agent_id":"claude-code:luis"');
  });

  it('3a. regex violation (space character) on /v1/chat/completions returns 400 + OpenAI invalid_request envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-agent-id': 'has spaces', // space disallowed by regex
      },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('invalid_agent_id');
  });

  it('3b. regex violation on /v1/messages returns 400 + Anthropic invalid_request envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-agent-id': 'has spaces',
      },
      payload: {
        model: MODEL_NAME,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
  });

  it('4. duplicate header (array) — first value wins per RFC 9110', async () => {
    // Fastify normalizes duplicates as arrays. Send via headers as array.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        // Array form via inject — first value should win, validates against regex
        'x-agent-id': ['first-value', 'second value with space'] as never,
      },
      payload: { messages: [{ role: 'user', content: 'hi' }] }, // -> 400 from zod (missing model)
    });
    // Zod validation 400 means agent-id preHandler PASSED (it accepted first value).
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.code).not.toBe('invalid_agent_id'); // first value was valid
  });

  it('5. 129-char input violates max length and returns 400', async () => {
    const tooLong = 'a'.repeat(129);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-agent-id': tooLong,
      },
      payload: { model: MODEL_NAME, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.code).toBe('invalid_agent_id');
  });
});
