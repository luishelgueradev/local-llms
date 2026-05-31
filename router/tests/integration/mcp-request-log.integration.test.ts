/**
 * Phase 15 Plan 15-11 (v0.11.0 — D-05 + D-06) — request_log integration tests.
 *
 * Verifies end-to-end that each MCP tool call writes exactly one row to
 * request_log with:
 *   - `protocol: 'mcp'`, `route: '/mcp'`           (D-05: per tool call, NOT per outer POST /mcp)
 *   - tenant/project/agent/workload IDs threaded from the OUTER /mcp request   (D-06)
 *   - `error_code: 'model_not_found'` + `status_class: 'client_error'`  on RegistryUnknownModelError
 *   - `agent_id: null` when the outer request omits X-Agent-Id            (Pitfall 8)
 *   - Two tool calls in one session yield two rows sharing the same scoped IDs (D-06 across calls)
 *
 * The bufferedWriter is an explicit `vi.fn()` mock so push.mock.calls can be
 * inspected. A fake adapter stubs the upstream so the chat_completion tool
 * succeeds without hitting a real backend.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { BufferedWriter } from '../../src/db/bufferedWriter.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

const TOKEN = 'local-llms_15_11_logrow_t1t2t3t4t5t6t7t8t9t0aabb';

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

function extractFirstJsonRpcFrame(body: string): {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: unknown;
} {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const dataLine = trimmed.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`unexpected MCP response body: ${body.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice(5).trim());
}

/**
 * vi.fn()-backed bufferedWriter so tests can inspect the captured rows.
 * push is a spy; drain + size satisfy the BufferedWriter contract.
 */
function makeSpyBufferedWriter(): BufferedWriter & {
  push: ReturnType<typeof vi.fn>;
} {
  const push = vi.fn();
  return {
    push,
    drain: async () => {},
    get size() {
      return 0;
    },
  };
}

/**
 * Minimal canonical-response shape stubbing the chat_completion tool's
 * adapter dependency. Matches BackendAdapter.chatCompletionsCanonical's
 * return type.
 */
const FAKE_CANONICAL_RESPONSE = {
  id: 'mcp-rqlog-id',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'chat-local',
  content: [{ type: 'text' as const, text: 'ok from MCP' }],
  stop_reason: 'end_turn' as const,
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
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

async function buildAppWithSpy(): Promise<{
  app: FastifyInstance;
  bufferedWriter: ReturnType<typeof makeSpyBufferedWriter>;
}> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const bufferedWriter = makeSpyBufferedWriter();
  const app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter,
    metrics: makeFakeMetrics(),
    // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing
    makeAdapter: (() => fakeAdapter) as any,
  });
  return { app, bufferedWriter };
}

/**
 * Initialize an MCP session through POST /mcp + notifications/initialized.
 * Returns the session id. The outer headers passed here propagate to
 * scopedIdsPreHandler + agentIdPreHandler, and the captured request closes
 * over them for the lifetime of the session.
 */
async function initializeSession(
  app: FastifyInstance,
  headers: Record<string, string>,
): Promise<string> {
  const initRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
      ...headers,
    },
    payload: INITIALIZE_BODY,
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
): Promise<ReturnType<typeof extractFirstJsonRpcFrame>> {
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
  return extractFirstJsonRpcFrame(res.body);
}

/** Filter the captured rows down to the ones from the chat_completion tool. */
function rowsFromChatCompletion(
  spy: ReturnType<typeof makeSpyBufferedWriter>['push'],
): RequestLogInsert[] {
  return spy.mock.calls
    .map((c) => c[0] as RequestLogInsert)
    .filter((r) => r.protocol === 'mcp' && r.route === '/mcp');
}

describe('Phase 15 Plan 15-11 — MCP request_log row population (D-05 + D-06)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('Test 1 (D-05): chat_completion tool/call writes exactly one row with protocol=mcp + route=/mcp + model + tokens', async () => {
    const built = await buildAppWithSpy();
    app = built.app;
    const bufferedWriter = built.bufferedWriter;

    const sid = await initializeSession(app, {
      'x-tenant-id': 'acme',
      'x-project-id': 'agents',
      'x-agent-id': 'a1',
      'x-workload-class': 'dev',
    });

    const frame = await callChatCompletion(app, sid, 1, 'chat-local');
    expect(frame.result).toBeDefined();

    const rows = rowsFromChatCompletion(bufferedWriter.push);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.model).toBe('chat-local');
    expect(row.tokens_in).toBe(5);
    expect(row.tokens_out).toBe(3);
    expect(typeof row.latency_ms).toBe('number');
    expect(row.latency_ms!).toBeGreaterThanOrEqual(0);
    expect(row.status_class).toBe('success');
    expect(row.http_status).toBe(200);
    // D-13: MCP-level idempotency is HTTP-only.
    expect(row.idempotency_key).toBeNull();
    // Non-stream by construction (D-12).
    expect(row.ttft_ms).toBeNull();
  });

  it('Test 2 (D-06): scoped IDs from outer POST /mcp propagate to the tool-call row', async () => {
    const built = await buildAppWithSpy();
    app = built.app;
    const bufferedWriter = built.bufferedWriter;

    const sid = await initializeSession(app, {
      'x-tenant-id': 'acme',
      'x-project-id': 'agents',
      'x-agent-id': 'a1',
      'x-workload-class': 'dev',
    });
    await callChatCompletion(app, sid, 1, 'chat-local');

    const row = rowsFromChatCompletion(bufferedWriter.push)[0]!;
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.agent_id).toBe('a1');
    expect(row.workload_class).toBe('dev');
  });

  it('Test 3 (error path): unknown model writes one row with status_class=client_error + error_code=model_not_found', async () => {
    const built = await buildAppWithSpy();
    app = built.app;
    const bufferedWriter = built.bufferedWriter;

    const sid = await initializeSession(app, {
      'x-tenant-id': 'acme',
      'x-project-id': 'agents',
      'x-agent-id': 'a1',
      'x-workload-class': 'dev',
    });

    // Unknown model → preflight throws RegistryUnknownModelError → tool
    // emits isError:true MCP frame; finally-block still pushes a row.
    const frame = await callChatCompletion(app, sid, 2, 'unknown-model');
    // The MCP tool catch block stamps isError:true, NOT a JSON-RPC error.
    const r = frame.result as { isError?: boolean };
    expect(r.isError).toBe(true);

    const rows = rowsFromChatCompletion(bufferedWriter.push);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.protocol).toBe('mcp');
    expect(row.status_class).toBe('client_error');
    // mapErrorToCode maps RegistryUnknownModelError → 'unknown_model'
    // (request_log internal taxonomy; the OpenAI envelope shows 'model_not_found'
    //  to clients — single source: recordOutcome.ts:167).
    expect(row.error_code).toBe('unknown_model');
    expect(row.error_message).toBeTruthy();
    // Pre-resolve failure: tokens are null, http_status is 404.
    expect(row.tokens_in).toBeNull();
    expect(row.tokens_out).toBeNull();
    expect(row.http_status).toBe(404);
    // Scoped IDs still propagate on error (D-06).
    expect(row.tenant_id).toBe('acme');
    expect(row.agent_id).toBe('a1');
  });

  it('Test 4 (D-05 + D-06): two consecutive chat_completion tool calls write two rows sharing the same scoped IDs', async () => {
    const built = await buildAppWithSpy();
    app = built.app;
    const bufferedWriter = built.bufferedWriter;

    const sid = await initializeSession(app, {
      'x-tenant-id': 'acme',
      'x-project-id': 'agents',
      'x-agent-id': 'a1',
      'x-workload-class': 'dev',
    });
    await callChatCompletion(app, sid, 1, 'chat-local');
    await callChatCompletion(app, sid, 2, 'chat-local');

    const rows = rowsFromChatCompletion(bufferedWriter.push);
    expect(rows).toHaveLength(2);

    // Both rows share the SAME scoped identity (D-06 — all N tool calls in
    // a session close over the SAME outer POST /mcp request).
    expect(rows[0]!.tenant_id).toBe(rows[1]!.tenant_id);
    expect(rows[0]!.project_id).toBe(rows[1]!.project_id);
    expect(rows[0]!.agent_id).toBe(rows[1]!.agent_id);
    expect(rows[0]!.workload_class).toBe(rows[1]!.workload_class);
    expect(rows[0]!.tenant_id).toBe('acme');
    expect(rows[0]!.agent_id).toBe('a1');

    // Both rows are successes from the same model.
    expect(rows[0]!.status_class).toBe('success');
    expect(rows[1]!.status_class).toBe('success');
    expect(rows[0]!.model).toBe('chat-local');
    expect(rows[1]!.model).toBe('chat-local');
  });

  it('Test 5 (Pitfall 8): when X-Agent-Id is absent on the outer request, the row has agent_id=null', async () => {
    const built = await buildAppWithSpy();
    app = built.app;
    const bufferedWriter = built.bufferedWriter;

    // Other scoped headers present; X-Agent-Id deliberately omitted.
    const sid = await initializeSession(app, {
      'x-tenant-id': 'acme',
      'x-project-id': 'agents',
      'x-workload-class': 'dev',
    });
    await callChatCompletion(app, sid, 1, 'chat-local');

    const row = rowsFromChatCompletion(bufferedWriter.push)[0]!;
    expect(row.agent_id).toBeNull();
    // Other scoped IDs still populated.
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.workload_class).toBe('dev');
  });
});
