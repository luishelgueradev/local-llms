/**
 * Phase 15 Plan 12 (v0.11.0 — 15-CONTEXT D-15) — MCP disabled-mode
 * integration tests.
 *
 * Verifies the operator escape hatch: when `MCP_ENABLED=false` is passed
 * into buildApp's env override, the MCP plugin returns early WITHOUT
 * registering the `/mcp` route. Requests to `/mcp` then 404 via Fastify's
 * default not-found handler. The rest of the app (especially /v1/*
 * routes) continues to function — the early-return must NOT break
 * existing wiring.
 *
 * Test matrix:
 *
 *   Test 1 (disabled mode → 404): POST /mcp with a valid initialize body
 *   returns 404. The bearer is present, so this proves the route itself
 *   is gone, not a bearer rejection.
 *
 *   Test 2 (plugin skipped): app.hasRoute({ method:'POST', url:'/mcp' })
 *   returns false. Same for GET /mcp and DELETE /mcp.
 *
 *   Test 3 (no regression on /v1/*): POST /v1/chat/completions with a
 *   stub adapter still returns 200 under MCP_ENABLED=false. Proves the
 *   plugin's early-return path leaves the rest of buildApp intact.
 *
 *   Test 4 (enabled mode still works): a second app built with
 *   MCP_ENABLED=true serves POST /mcp normally (status 200 +
 *   Mcp-Session-Id header). Confirms the early-return is conditional,
 *   not unconditional.
 *
 * Unit-level coverage of the early-return branch lives in
 * `tests/unit/mcp/host/plugin.test.ts` (Test 6.2). This file proves the
 * SAME behavior through the full buildApp wiring + Fastify route table.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry, type MetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';

const TOKEN = 'local-llms_mcp_t1t2t3t4t5t6t7t8t9t0aabbccddee';

const YAML = `
models:
  - name: llama3.2:3b
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b
    capabilities: [chat]
    vram_budget_gb: 4
`;

const INITIALIZE_BODY = {
  jsonrpc: '2.0' as const,
  id: 0,
  method: 'initialize' as const,
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' },
  },
};

const ACCEPT_BOTH = 'application/json, text/event-stream';

async function buildAppWithMcp(opts: {
  mcpEnabled: boolean;
  metrics?: MetricsRegistry;
  makeAdapter?: unknown;
}): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: opts.metrics ?? makeMetricsRegistry(),
    env: { MCP_ENABLED: opts.mcpEnabled } as never,
    // biome-ignore lint/suspicious/noExplicitAny: optional makeAdapter passthrough
    makeAdapter: (opts.makeAdapter ?? undefined) as any,
  });
}

describe('Phase 15 Plan 12 — MCP disabled-mode integration (D-15)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('Test 1 (disabled mode → 404): POST /mcp with valid bearer + initialize body returns 404', async () => {
    app = await buildAppWithMcp({ mcpEnabled: false });

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });

    expect(res.statusCode).toBe(404);
  });

  it('Test 2 (plugin skipped): app.hasRoute is false for POST/GET/DELETE /mcp under MCP_ENABLED=false', async () => {
    app = await buildAppWithMcp({ mcpEnabled: false });

    expect(app.hasRoute({ method: 'POST', url: '/mcp' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/mcp' })).toBe(false);
    expect(app.hasRoute({ method: 'DELETE', url: '/mcp' })).toBe(false);
  });

  it('Test 3 (no regression on /v1/*): POST /v1/chat/completions still works under MCP_ENABLED=false', async () => {
    // Stub the adapter so the test does not need a real Ollama upstream.
    // Mirrors the pattern from mcp-host.integration.test.ts Test 7.
    const fakeAdapter = {
      // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
      chatCompletionsCanonical: async (_canonical: unknown, _signal: AbortSignal): Promise<any> => ({
        id: 'mcp-disabled-test',
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'llama3.2:3b',
        content: [{ type: 'text' as const, text: 'mcp disabled but http works' }],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
      chatCompletionsCanonicalStream: async (): Promise<any> => {
        throw new Error('stream branch not used');
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
      embeddings: async (): Promise<any> => {
        throw new Error('embeddings not used');
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
      rerank: async (): Promise<any> => {
        throw new Error('rerank not used');
      },
      probeLiveness: async (): Promise<{ ok: boolean; latencyMs: number }> => ({
        ok: true,
        latencyMs: 1,
      }),
    };

    app = await buildAppWithMcp({
      mcpEnabled: false,
      makeAdapter: () => fakeAdapter,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: {
        model: 'llama3.2:3b',
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      choices: Array<{ message: { role: string; content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }>();
    expect(body.choices[0]!.message.role).toBe('assistant');
    expect(body.choices[0]!.message.content).toBe('mcp disabled but http works');
    expect(body.usage.prompt_tokens).toBe(3);
    expect(body.usage.completion_tokens).toBe(5);
  });

  it('Test 4 (enabled mode still works): MCP_ENABLED=true serves /mcp normally', async () => {
    app = await buildAppWithMcp({ mcpEnabled: true });

    expect(app.hasRoute({ method: 'POST', url: '/mcp' })).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });

    expect(res.statusCode).toBe(200);
    const sid = res.headers['mcp-session-id'];
    expect(typeof sid).toBe('string');
    expect((sid as string).length).toBeGreaterThan(0);
  });
});
