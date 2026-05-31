/**
 * Phase 15 (v0.11.0 — MCPS-01, MCPS-02, MCPS-05) — Integration tests for the
 * MCP host plugin (router/src/mcp/host/plugin.ts).
 *
 * Coverage:
 *  - Test 1 (MCPS-02): POST /mcp without Authorization → 401 with the existing
 *    BearerAuthError envelope BEFORE any MCP-level handling.
 *  - Test 2 (MCPS-01): POST /mcp with valid bearer + isInitializeRequest body
 *    → 200 + JSON-RPC initialize result, `Mcp-Session-Id` header present.
 *  - Test 3 (MCPS-01): tools/list reusing the session id returns
 *    `{ tools: [] }` — Wave 4 plans will land the 5 tool registrations.
 *  - Test 4 (MCPS-05): on app.close(), every active session is closed and
 *    the `router_mcp_active_sessions` Prometheus gauge reads 0.
 *  - Test 5 (D-15): when MCP_ENABLED=false, POST /mcp returns 404 (the
 *    plugin returned early; no route registered).
 *
 * Note on app.inject + SSE: the SDK's StreamableHTTPServerTransport prefers
 * SSE responses by default. The initialize + tools/list payloads we send
 * here are JSON-RPC requests; the SDK responds either as a single JSON body
 * (when Accept: application/json) or as an SSE stream (when Accept includes
 * text/event-stream). app.inject buffers the entire response, so we accept
 * either — Test 2 parses both shapes (extractInitializeResult below).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

/**
 * MCP initialize JSON-RPC body. Protocol version pinned to the latest
 * spec revision the SDK 1.29.x supports — the SDK negotiates downward if
 * the client uses an older version.
 */
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

/**
 * Both initialize and tools/list need an Accept header that allows BOTH
 * application/json AND text/event-stream — the SDK rejects requests that
 * accept only one or the other.
 */
const ACCEPT_BOTH = 'application/json, text/event-stream';

/**
 * Parses the SDK's response body which may be either a raw JSON-RPC
 * envelope (when the SDK chose JSON mode) or an SSE stream framed as
 * `event: message\ndata: <json>\n\n`. Returns the first message frame.
 */
function extractFirstJsonRpcFrame(body: string): { jsonrpc: string; id: number | string | null; result?: unknown; error?: unknown } {
  const trimmed = body.trim();
  // Plain JSON-RPC body — when the SDK returns enableJsonResponse mode.
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  // SSE frame — look for the first `data: ...\n\n` block.
  const dataLine = trimmed.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`unexpected MCP response body: ${body.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice(5).trim());
}

async function buildMcpApp(overrides?: {
  mcpEnabled?: boolean;
  metrics?: MetricsRegistry;
}): Promise<{ app: FastifyInstance; metrics: MetricsRegistry }> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const metrics = overrides?.metrics ?? makeMetricsRegistry();
  const app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
    env: overrides?.mcpEnabled !== undefined
      ? ({ MCP_ENABLED: overrides.mcpEnabled } as never)
      : undefined,
  });
  return { app, metrics };
}

describe('Phase 15 MCP host plugin — integration', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('Test 1 (MCPS-02): POST /mcp with NO Authorization → 401 + unauthorized envelope (BEFORE MCP-level handling)', async () => {
    const built = await buildMcpApp();
    app = built.app;

    const res = await app.inject({ method: 'POST', url: '/mcp' });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
  });

  it('Test 2 (MCPS-01): POST /mcp with bearer + initialize body → 200 + Mcp-Session-Id header + initialize result', async () => {
    const built = await buildMcpApp();
    app = built.app;

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
    // SDK stamps the session id on the response. Header is lower-cased by Fastify.
    const sid = res.headers['mcp-session-id'];
    expect(typeof sid).toBe('string');
    expect((sid as string).length).toBeGreaterThan(0);

    const frame = extractFirstJsonRpcFrame(res.body);
    expect(frame.jsonrpc).toBe('2.0');
    expect(frame.id).toBe(0);
    expect(frame.result).toBeDefined();
    // The server identifies itself per buildServerForRequest.
    const result = frame.result as { serverInfo: { name: string; version: string }; capabilities: { tools?: unknown } };
    expect(result.serverInfo.name).toBe('local-llms-router');
    expect(result.serverInfo.version).toBe('0.11.0');
    expect(result.capabilities.tools).toBeDefined(); // tools capability advertised, even if list is empty
  });

  it('Test 3 (MCPS-01 / MCPS-03 / MCPS-04): tools/list returns the 5-tool golden set [chat_completion, create_embedding, create_response, list_models, rerank]', async () => {
    const built = await buildMcpApp();
    app = built.app;

    // 1) Open a session via initialize.
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });
    expect(initRes.statusCode).toBe(200);
    const sid = initRes.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();

    // 2) Send the SDK-mandated `notifications/initialized` to complete the handshake.
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
    // The session-reuse path completes without an error response (notification → 202 or 200).
    expect([200, 202]).toContain(ackRes.statusCode);

    // 3) tools/list — Plan 15-10 wires all 5 tools in buildServerForRequest
    //    (P1-05 hard-coded allowlist). The set is locked: any drift here
    //    would mean either a new tool was added without a plan, or one was
    //    silently dropped. Sort-stable assertion below.
    const listRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
        'mcp-session-id': sid,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(listRes.statusCode).toBe(200);
    const frame = extractFirstJsonRpcFrame(listRes.body);
    expect(frame.jsonrpc).toBe('2.0');
    expect(frame.id).toBe(1);
    expect(frame.result).toBeDefined();
    const result = frame.result as { tools: Array<{ name: string }> };
    expect(Array.isArray(result.tools)).toBe(true);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'chat_completion',
      'create_embedding',
      'create_response',
      'list_models',
      'rerank',
    ]);
  });

  it('Test 6 (MCPS-03 / D-10 / T-3-A2): tools/call list_models returns the policy-projected set with no backend leak', async () => {
    const built = await buildMcpApp();
    app = built.app;

    // 1) Initialize.
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });
    expect(initRes.statusCode).toBe(200);
    const sid = initRes.headers['mcp-session-id'] as string;
    expect(sid).toBeTruthy();

    // 2) Acknowledge the handshake.
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

    // 3) tools/call list_models — no args (v0.11.0 contract).
    const callRes = await app.inject({
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
        id: 2,
        method: 'tools/call',
        params: { name: 'list_models', arguments: {} },
      },
    });
    expect(callRes.statusCode).toBe(200);
    const frame = extractFirstJsonRpcFrame(callRes.body);
    expect(frame.jsonrpc).toBe('2.0');
    expect(frame.id).toBe(2);
    expect(frame.result).toBeDefined();

    const r = frame.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        object: string;
        data: Array<Record<string, unknown>>;
      };
      isError?: boolean;
    };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.type).toBe('text');
    expect(r.content[0]!.text).toMatch(/^\d+ models available$/);
    expect(r.structuredContent.object).toBe('list');
    expect(Array.isArray(r.structuredContent.data)).toBe(true);
    expect(r.structuredContent.data.length).toBeGreaterThan(0);

    // T-3-A2 anti-leak: every entry MUST NOT include backend / backend_url
    // / backend_model / vram_budget_gb fields. Whether the YAML fixture has
    // them present in the registry or not, the projection must hide them.
    for (const entry of r.structuredContent.data) {
      expect(entry.backend).toBeUndefined();
      expect(entry.backend_url).toBeUndefined();
      expect(entry.backend_model).toBeUndefined();
      expect(entry.vram_budget_gb).toBeUndefined();
      // D-10 annotation: every projected entry has policy.cloud_allowed.
      expect(entry.policy).toBeDefined();
      const pol = entry.policy as { cloud_allowed: boolean };
      expect(typeof pol.cloud_allowed).toBe('boolean');
    }
  });

  it('Test 7 (MCPS-01 #3 — assistant text round-trip): tools/call chat_completion returns assistant text via the MCP wire end-to-end', async () => {
    // This test uses an opts.makeAdapter override to stub the upstream adapter,
    // exercising the full Plan 15-06 chat_completion handler over the MCP wire:
    // registerTool → tools/call → applyPreflight → adapter.chatCompletionsCanonical
    // → canonicalToOpenAIResponse → dual-shape MCP return. It is the canonical
    // success-criterion #3 gate for MCPS-01 ("assistant text round-trip").
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const metrics = makeMetricsRegistry();

    // Minimal fake adapter — mirrors the shape of router/src/backends/adapter.ts
    // BackendAdapter; the chat_completion tool only calls chatCompletionsCanonical
    // and the liveness scheduler calls probeLiveness. Other adapter methods throw
    // since this test never exercises them.
    const fakeAdapter = {
      // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
      chatCompletionsCanonical: async (_canonical: unknown, _signal: AbortSignal): Promise<any> => ({
        id: 'mcp-test-id',
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'llama3.2:3b',
        content: [{ type: 'text' as const, text: 'hello from MCP' }],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 3 },
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

    const localApp = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      bufferedWriter: makeFakeBufferedWriter(),
      metrics,
      // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing
      makeAdapter: (() => fakeAdapter) as any,
    });
    app = localApp;

    // 1) Initialize.
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });
    expect(initRes.statusCode).toBe(200);
    const sid = initRes.headers['mcp-session-id'] as string;

    // 2) Acknowledge.
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

    // 3) tools/call chat_completion with a single user message.
    const callRes = await app.inject({
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
        id: 7,
        method: 'tools/call',
        params: {
          name: 'chat_completion',
          arguments: {
            model: 'llama3.2:3b',
            messages: [{ role: 'user', content: 'hi' }],
          },
        },
      },
    });
    expect(callRes.statusCode).toBe(200);
    const frame = extractFirstJsonRpcFrame(callRes.body);
    expect(frame.jsonrpc).toBe('2.0');
    expect(frame.id).toBe(7);
    expect(frame.result).toBeDefined();

    const r = frame.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        choices: Array<{ message: { role: string; content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      isError?: boolean;
    };
    expect(r.isError).toBeFalsy();
    // D-03 stamp: joined assistant text block content lives in content[0].text.
    expect(r.content[0]!.type).toBe('text');
    expect(r.content[0]!.text).toBe('hello from MCP');
    // structuredContent carries the full OpenAI ChatCompletion shape.
    expect(r.structuredContent.choices[0]!.message.role).toBe('assistant');
    expect(r.structuredContent.choices[0]!.message.content).toBe('hello from MCP');
    expect(r.structuredContent.usage.prompt_tokens).toBe(4);
    expect(r.structuredContent.usage.completion_tokens).toBe(3);
  });

  it('Test 4 (MCPS-05): app.close() shuts down active sessions; router_mcp_active_sessions gauge → 0', async () => {
    const metrics = makeMetricsRegistry();
    const built = await buildMcpApp({ metrics });
    app = built.app;

    // Open a session.
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: ACCEPT_BOTH,
      },
      payload: INITIALIZE_BODY,
    });
    expect(initRes.statusCode).toBe(200);

    // Active sessions gauge should be 1 BEFORE close.
    const beforeText = await metrics.register.metrics();
    expect(beforeText).toMatch(/^router_mcp_active_sessions\s+1$/m);

    // Trigger the onClose chain — both the main onClose body and the MCP
    // plugin's onClose (shutdownSessions + gauge.set(0)) must run.
    await app.close();
    app = undefined;

    const afterText = await metrics.register.metrics();
    expect(afterText).toMatch(/^router_mcp_active_sessions\s+0$/m);
  });

  it('Test 5 (D-15): MCP_ENABLED=false → /mcp returns 404 (plugin route never registered)', async () => {
    const built = await buildMcpApp({ mcpEnabled: false });
    app = built.app;

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
});
