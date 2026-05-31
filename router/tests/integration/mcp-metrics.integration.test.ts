/**
 * Phase 15 Plan 15-11 (v0.11.0 — D-07) — MCP metrics integration tests.
 *
 * Verifies the MCP-specific Prometheus series are visible at /metrics:
 *   - `router_mcp_active_sessions` gauge tracks the session count live
 *     (Tests 1, 2, 5)
 *   - `router_mcp_tool_calls_total{tool, status_class}` counter increments
 *     per tool call (Tests 3, 4)
 *
 * Also re-runs POL-06 invariant against live /metrics output (Test 6) — no
 * label name ending in `_id` may appear.
 *
 * /metrics is in PUBLIC_PATHS (auth/bearer.ts:25) so requests need no bearer.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import {
  makeMetricsRegistry,
  type MetricsRegistry,
} from '../../src/metrics/registry.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';

const TOKEN = 'local-llms_15_11_metrics_t1t2t3t4t5t6t7t8t9t0aabb';

const YAML = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.1:8b
    capabilities: [chat]
    vram_budget_gb: 5
`;

const ACCEPT_BOTH = 'application/json, text/event-stream';

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

const FAKE_CANONICAL_RESPONSE = {
  id: 'mcp-metrics-id',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'chat-local',
  content: [{ type: 'text' as const, text: 'metrics ok' }],
  stop_reason: 'end_turn' as const,
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
};

const fakeAdapter = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonical: async (): Promise<any> => FAKE_CANONICAL_RESPONSE,
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonicalStream: async (): Promise<any> => {
    throw new Error('stream not used');
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

async function buildAppForMetrics(metrics: MetricsRegistry): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
    // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing
    makeAdapter: (() => fakeAdapter) as any,
  });
}

/** Fetch /metrics text body — no bearer (PUBLIC_PATHS). */
async function getMetricsText(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  expect(res.statusCode).toBe(200);
  return res.body;
}

async function initializeSession(app: FastifyInstance, jsonRpcId = 0): Promise<string> {
  const initRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
    },
    payload: { ...INITIALIZE_BODY, id: jsonRpcId },
  });
  expect(initRes.statusCode).toBe(200);
  const sid = initRes.headers['mcp-session-id'] as string;
  expect(sid).toBeTruthy();

  const ackRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
      'mcp-session-id': sid,
    },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  expect([200, 202]).toContain(ackRes.statusCode);

  return sid;
}

async function callChatCompletion(
  app: FastifyInstance,
  sid: string,
  jsonRpcId: number,
  model: string,
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
      'mcp-session-id': sid,
    },
    payload: {
      jsonrpc: '2.0',
      id: jsonRpcId,
      method: 'tools/call',
      params: {
        name: 'chat_completion',
        arguments: {
          model,
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
    },
  });
  expect(res.statusCode).toBe(200);
}

describe('Phase 15 Plan 15-11 — MCP /metrics integration (D-07)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('Test 1 (gauge present at zero): freshly-built app emits router_mcp_active_sessions 0', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    const text = await getMetricsText(app);
    // The metric MUST be present in the output even before any sessions exist.
    expect(text).toMatch(/^# TYPE router_mcp_active_sessions gauge$/m);
    expect(text).toMatch(/^router_mcp_active_sessions 0$/m);
  });

  it('Test 2 (gauge increments on initialize): one session → router_mcp_active_sessions 1', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    await initializeSession(app);

    const text = await getMetricsText(app);
    expect(text).toMatch(/^router_mcp_active_sessions 1$/m);
  });

  it('Test 3 (counter present after success): router_mcp_tool_calls_total{tool="chat_completion",status_class="success"} ≥ 1', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    const sid = await initializeSession(app);
    await callChatCompletion(app, sid, 1, 'chat-local');

    const text = await getMetricsText(app);
    // prom-client emits labels in a deterministic order based on declaration
    // order: `labelNames: ['tool', 'status_class']` → `tool` first, then
    // `status_class`. The series MUST exist with value ≥ 1.
    const match = text.match(
      /^router_mcp_tool_calls_total\{tool="chat_completion",status_class="success"\}\s+(\d+(?:\.\d+)?)$/m,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('Test 4 (counter increments on error): unknown-model tool call → status_class="client_error" series appears', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    const sid = await initializeSession(app);
    await callChatCompletion(app, sid, 2, 'unknown-model');

    const text = await getMetricsText(app);
    const match = text.match(
      /^router_mcp_tool_calls_total\{tool="chat_completion",status_class="client_error"\}\s+(\d+(?:\.\d+)?)$/m,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('Test 5 (gauge decrements on app.close()): post-shutdown registry dump shows router_mcp_active_sessions 0', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    // Open a session.
    await initializeSession(app);

    // Gauge reads 1 BEFORE close.
    const beforeText = await metrics.register.metrics();
    expect(beforeText).toMatch(/^router_mcp_active_sessions 1$/m);

    // Triggers the MCP plugin's onClose hook (shutdownSessions + gauge.set(0)).
    await app.close();
    app = undefined;

    // /metrics requires a live Fastify instance, but the metrics registry
    // is still accessible. shutdownSessions sets the gauge to 0 explicitly.
    const afterText = await metrics.register.metrics();
    expect(afterText).toMatch(/^router_mcp_active_sessions 0$/m);
  });

  it('Test 6 (POL-06 invariant): /metrics output contains no label name ending in "_id"', async () => {
    const metrics = makeMetricsRegistry();
    app = await buildAppForMetrics(metrics);

    // Drive both the gauge and the counter so the MCP series are present.
    const sid = await initializeSession(app);
    await callChatCompletion(app, sid, 1, 'chat-local');

    const text = await getMetricsText(app);

    // Scan every series line for a label name ending in '_id'. Series lines
    // have the form: name{label="value",label2="value2"} <number>.
    // A label like {request_id="abc"} would match /([A-Za-z_]+_id)="/.
    // The MCP active-sessions gauge intentionally exposes NO labels at all
    // (T-15-04-INFO disposition — accept session-id non-leakage by surface).
    const offending: string[] = [];
    for (const line of text.split('\n')) {
      // Skip HELP/TYPE comments and empty lines.
      if (line.startsWith('#') || line.length === 0) continue;
      // Pull every label name from the line.
      const labelNameRe = /([A-Za-z_][A-Za-z0-9_]*)=/g;
      for (const m of line.matchAll(labelNameRe)) {
        const name = m[1]!;
        if (name.endsWith('_id')) {
          offending.push(`${line}  (label '${name}')`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
