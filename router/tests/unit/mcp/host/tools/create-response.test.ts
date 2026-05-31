/**
 * Phase 15 (v0.11.0 — MCPS-03, MCPS-04 / 15-07-PLAN.md) — Unit-test matrix for
 * `registerCreateResponseTool`.
 *
 * Mirrors the 15-06 chat-completion test matrix exactly. Differences:
 *  - Tool name: `create_response`
 *  - Schema: `ResponsesRequestSchema` from routes/v1/responses.ts
 *  - Success-path text stamp (D-03): assistant text joined from canonical
 *    `output[].content[*].text` where `type === 'output_text'`. Because the
 *    Phase-13 /v1/responses route translates the canonical CanonicalResponse
 *    into a custom Responses-API wire shape internally, the MCP tool handler
 *    mirrors the same translation and emits the join over its own
 *    `output[i].content[j].text` entries.
 *  - structuredContent: the FULL /v1/responses-API body (Phase-13 canonicalToResponses shape)
 *
 * Covers (one it() per design decision):
 *  1. D-01  inputSchema = z.toJSONSchema(ResponsesRequestSchema)
 *  2. D-02/D-03 dual-shape success result
 *  3. D-04  policy violation → isError:true envelope
 *  4. D-12  stream:true coerced silently to false in canonical
 *  5. D-14  extra.signal propagates to adapter signal
 *  6. D-05/D-06 one bufferedWriter row pushed per call with protocol='mcp' + scoped IDs
 *  7. D-07  router_mcp_tool_calls_total counter increments per call
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';
import { ResponsesRequestSchema } from '../../../../../src/routes/v1/responses.js';
import type { CanonicalRequest, CanonicalResponse } from '../../../../../src/translation/canonical.js';
import {
  AllowlistViolationError,
  RegistryUnknownModelError,
} from '../../../../../src/errors/envelope.js';
import { registerCreateResponseTool, JSON_SCHEMA_LOCK } from '../../../../../src/mcp/host/tools/create-response.js';
import type { McpHostOpts } from '../../../../../src/mcp/host/plugin.js';

// ── shared fixtures ────────────────────────────────────────────────────────────

const ENTRY = {
  name: 'chat-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'llama3.2:3b',
  capabilities: ['chat'] as const,
  vram_budget_gb: 4,
};

function makeFakeCanonicalResponse(text = 'hello'): CanonicalResponse {
  return {
    id: 'msg_01HDEMOTOOLRESP',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: ENTRY.backend_model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

function makeFakes() {
  const fakeAdapter = {
    chatCompletionsCanonical: vi.fn<
      (canonical: CanonicalRequest, signal: AbortSignal) => Promise<CanonicalResponse>
    >().mockResolvedValue(makeFakeCanonicalResponse()),
    chatCompletionsCanonicalStream: vi.fn().mockRejectedValue(new Error('not used')),
    embeddings: vi.fn().mockRejectedValue(new Error('not used')),
    rerank: vi.fn().mockRejectedValue(new Error('not used')),
    probeLiveness: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };

  const fakeRegistry = {
    get: vi.fn().mockReturnValue({ models: [ENTRY], policies: undefined }),
    getCreatedAtSec: vi.fn().mockReturnValue(0),
    resolve: vi.fn().mockReturnValue(ENTRY),
    _swap: vi.fn(),
  };

  const fakeBreaker = {
    check: vi.fn().mockResolvedValue({ state: 'closed' as const }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    onStateChange: vi.fn(),
    snapshot: vi.fn(),
  };

  const fakeBufferedWriter = {
    push: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
    get size(): number {
      return 0;
    },
  };

  const fakeMetrics = {
    routerMcpToolCallsTotal: { inc: vi.fn() },
    routerMcpActiveSessions: { set: vi.fn() },
    requestsTotal: { inc: vi.fn() },
    requestDurationSeconds: { observe: vi.fn() },
    ttftSeconds: { observe: vi.fn() },
    tokensTotal: { inc: vi.fn() },
    logBufferDroppedTotal: { inc: vi.fn() },
    jsonValidationTotal: { inc: vi.fn() },
    embeddingsCacheTotal: { inc: vi.fn() },
    embeddingsBatchSize: { observe: vi.fn() },
    embeddingsDimsTotal: { inc: vi.fn() },
    register: { metrics: vi.fn().mockResolvedValue('') },
  };

  const childLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const baseLog: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue(childLog),
  };

  const fakeReq = {
    id: 'req-test-123',
    agentId: 'agent-x',
    tenantId: 'acme',
    projectId: 'agents',
    workloadClass: 'dev',
    log: baseLog,
  } as unknown as FastifyRequest;

  // The fake `metrics` deliberately omits the heavy prom-client Registry
  // surface — the tool handler never reads it. Cast through unknown so the
  // tsc --noEmit gate stays clean while we keep tests focused on observable
  // behavior (vi.fn() spies on individual metric handles).
  const deps = {
    registry: fakeRegistry,
    makeAdapter: vi.fn().mockReturnValue(fakeAdapter),
    bufferedWriter: fakeBufferedWriter,
    metrics: fakeMetrics,
    breaker: fakeBreaker,
    env: {
      MCP_ENABLED: true as const,
      MCP_SESSION_TTL_SEC: 3600,
      MCP_GC_INTERVAL_MS: 1_800_000,
    },
  } as unknown as McpHostOpts;

  return { deps, fakeReq, fakeAdapter, fakeRegistry, fakeBreaker, fakeBufferedWriter, fakeMetrics, childLog };
}

// Capture the (name, definition, handler) tuple from a registerTool call.
function makeFakeServer(): { server: McpServer; calls: { name: string; def: { description?: string; inputSchema: unknown; title?: string }; handler: (args: unknown, extra: { signal: AbortSignal; sessionId?: string; requestId?: string | number }) => Promise<unknown> }[] } {
  const calls: { name: string; def: { description?: string; inputSchema: unknown; title?: string }; handler: (args: unknown, extra: { signal: AbortSignal; sessionId?: string; requestId?: string | number }) => Promise<unknown> }[] = [];
  const server = {
    registerTool: vi.fn((name: string, def: { description?: string; inputSchema: unknown; title?: string }, handler: (args: unknown, extra: { signal: AbortSignal; sessionId?: string; requestId?: string | number }) => Promise<unknown>) => {
      calls.push({ name, def, handler });
    }),
  } as unknown as McpServer;
  return { server, calls };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('Phase 15 — registerCreateResponseTool', () => {
  it('Test 1 (D-01): inputSchema is the route Zod schema; JSON_SCHEMA_LOCK == z.toJSONSchema(ResponsesRequestSchema)', () => {
    const { deps, fakeReq } = makeFakes();
    const { server, calls } = makeFakeServer();

    registerCreateResponseTool(server, deps, fakeReq);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('create_response');
    // The SDK requires a Zod schema (not a JSON Schema object) — see
    // node_modules/@modelcontextprotocol/sdk/.../server/mcp.js:868
    // ("inputSchema must be a Zod schema or raw shape"). The tool registers
    // ResponsesRequestSchema directly; SDK serialization runs
    // toJsonSchemaCompat() internally when emitting tools/list.
    expect(calls[0]?.def.inputSchema).toBe(ResponsesRequestSchema);
    // P1-03 drift gate: JSON_SCHEMA_LOCK MUST deep-equal a freshly recomputed
    // z.toJSONSchema(ResponsesRequestSchema). Schema drift between HTTP +
    // MCP is impossible by construction — both flow from the single Zod
    // source schema.
    expect(JSON_SCHEMA_LOCK).toStrictEqual(z.toJSONSchema(ResponsesRequestSchema));
    // Description MUST document the no-MCP-streaming policy (D-12).
    expect(calls[0]?.def.description ?? '').toMatch(/stream/i);
  });

  it('Test 2 (D-02 / D-03): success path returns dual-shape result with assistant text + full /v1/responses-shape body', async () => {
    const { deps, fakeReq, fakeAdapter } = makeFakes();
    const { server, calls } = makeFakeServer();
    fakeAdapter.chatCompletionsCanonical.mockResolvedValueOnce(makeFakeCanonicalResponse('hi there!'));

    registerCreateResponseTool(server, deps, fakeReq);
    const handler = calls[0]!.handler;
    const controller = new AbortController();
    const result = (await handler(
      { model: 'chat-local', input: 'say hi' },
      { signal: controller.signal, sessionId: 'sess-1', requestId: 42 },
    )) as {
      content: Array<{ type: 'text'; text: string }>;
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'hi there!' }]);

    // structuredContent: full /v1/responses-shape body. Walk the same path the
    // production handler emits — output[0].content[0].text === joined text.
    const sc = result.structuredContent;
    expect(sc.object).toBe('response');
    expect(sc.status).toBe('completed');
    expect(sc.model).toBe('chat-local');
    const output = sc.output as Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output[0]?.type).toBe('message');
    expect(output[0]?.role).toBe('assistant');
    expect(output[0]?.content[0]?.type).toBe('output_text');
    expect(output[0]?.content[0]?.text).toBe('hi there!');
    // output_text shortcut (the SDK exposes this directly).
    expect(sc.output_text).toBe('hi there!');
    // usage echoes the canonical token counts.
    const usage = sc.usage as { input_tokens: number; output_tokens: number; total_tokens: number };
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(7);
    expect(usage.total_tokens).toBe(12);
  });

  it('Test 3 (D-04): policy violation → isError:true with structured envelope', async () => {
    const { deps, fakeReq, fakeRegistry } = makeFakes();
    const { server, calls } = makeFakeServer();
    // Cause applyPreflight to throw AllowlistViolationError.
    fakeRegistry.get.mockReturnValueOnce({
      models: [ENTRY],
      policies: { default: { model_allowlist: ['some-other-model'] } },
    });
    // resolve still returns the entry; applyPolicyGate then rejects it.
    fakeRegistry.resolve.mockReturnValueOnce(ENTRY);

    registerCreateResponseTool(server, deps, fakeReq);
    const handler = calls[0]!.handler;
    const controller = new AbortController();
    const result = (await handler(
      { model: 'chat-local', input: 'hi' },
      { signal: controller.signal, sessionId: 'sess-1', requestId: 1 },
    )) as {
      content: Array<{ type: 'text'; text: string }>;
      structuredContent: { error?: string; code?: string; message?: string };
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('model_not_in_allowlist');
    // type from envelope is 'policy_violation' (envelope.ts:512).
    expect(result.structuredContent.error).toBe('policy_violation');
    expect(typeof result.structuredContent.message).toBe('string');
    expect(result.content[0]?.type).toBe('text');
  });

  it('Test 4 (D-12): stream:true is silently coerced to false in canonical', async () => {
    const { deps, fakeReq, fakeAdapter } = makeFakes();
    const { server, calls } = makeFakeServer();

    registerCreateResponseTool(server, deps, fakeReq);
    const handler = calls[0]!.handler;
    const controller = new AbortController();
    await handler(
      { model: 'chat-local', input: 'hi', stream: true },
      { signal: controller.signal, sessionId: 'sess-1' },
    );

    expect(fakeAdapter.chatCompletionsCanonical).toHaveBeenCalledTimes(1);
    const canonicalArg = fakeAdapter.chatCompletionsCanonical.mock.calls[0]![0] as CanonicalRequest;
    expect(canonicalArg.stream).toBe(false);
  });

  it('Test 5 (D-14): extra.signal aborts → adapter sees aborted signal', async () => {
    const { deps, fakeReq, fakeAdapter } = makeFakes();
    const { server, calls } = makeFakeServer();

    // Adapter blocks until its own signal aborts.
    fakeAdapter.chatCompletionsCanonical.mockImplementationOnce(
      (_canonical: CanonicalRequest, signal: AbortSignal) =>
        new Promise<CanonicalResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('adapter aborted'));
          });
        }),
    );

    registerCreateResponseTool(server, deps, fakeReq);
    const handler = calls[0]!.handler;
    const transportController = new AbortController();
    const resultPromise = handler(
      { model: 'chat-local', input: 'hi' },
      { signal: transportController.signal, sessionId: 'sess-1' },
    );
    // Abort after a microtask so the adapter call has registered the listener.
    setTimeout(() => transportController.abort(), 5);

    const result = (await resultPromise) as { isError?: boolean };
    expect(result.isError).toBe(true);
    // Adapter saw an aborted signal.
    const adapterSignal = fakeAdapter.chatCompletionsCanonical.mock.calls[0]![1] as AbortSignal;
    expect(adapterSignal.aborted).toBe(true);
  });

  it('Test 6 (D-05 / D-06): one bufferedWriter row pushed per tool call with protocol="mcp" + scoped IDs from capturedReq', async () => {
    const { deps, fakeReq, fakeBufferedWriter } = makeFakes();
    const { server, calls } = makeFakeServer();

    registerCreateResponseTool(server, deps, fakeReq);
    const handler = calls[0]!.handler;
    const controller = new AbortController();
    await handler(
      { model: 'chat-local', input: 'hi' },
      { signal: controller.signal, sessionId: 'sess-1' },
    );

    expect(fakeBufferedWriter.push).toHaveBeenCalledTimes(1);
    const row = fakeBufferedWriter.push.mock.calls[0]![0] as {
      protocol: string;
      route: string;
      backend: string;
      model: string;
      tenant_id: string | null;
      project_id: string | null;
      agent_id: string | null;
      workload_class: string | null;
      request_id: string;
      status_class: string;
      tokens_in: number | null;
      tokens_out: number | null;
    };
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.backend).toBe('ollama');
    expect(row.model).toBe('chat-local');
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.agent_id).toBe('agent-x');
    expect(row.workload_class).toBe('dev');
    expect(row.request_id).toBe('req-test-123');
    expect(row.status_class).toBe('success');
    expect(row.tokens_in).toBe(5);
    expect(row.tokens_out).toBe(7);
  });

  it('Test 7 (D-07): router_mcp_tool_calls_total{tool:"create_response", status_class} increments per call (success + error)', async () => {
    // 7a — success path.
    {
      const { deps, fakeReq, fakeMetrics } = makeFakes();
      const { server, calls } = makeFakeServer();
      registerCreateResponseTool(server, deps, fakeReq);
      const handler = calls[0]!.handler;
      const controller = new AbortController();
      await handler(
        { model: 'chat-local', input: 'hi' },
        { signal: controller.signal, sessionId: 's' },
      );
      expect(fakeMetrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledWith({
        tool: 'create_response',
        status_class: 'success',
      });
    }

    // 7b — error path (registry unknown model).
    {
      const { deps, fakeReq, fakeRegistry, fakeMetrics } = makeFakes();
      const { server, calls } = makeFakeServer();
      fakeRegistry.resolve.mockImplementationOnce(() => {
        throw new RegistryUnknownModelError('missing', ['chat-local']);
      });
      registerCreateResponseTool(server, deps, fakeReq);
      const handler = calls[0]!.handler;
      const controller = new AbortController();
      const result = (await handler(
        { model: 'missing', input: 'hi' },
        { signal: controller.signal, sessionId: 's' },
      )) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(fakeMetrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledWith({
        tool: 'create_response',
        status_class: 'client_error',
      });
    }
  });
});

// Reference imports for type-only assertion above — silence "unused" lint by re-export.
export type _AllowlistViolationError = AllowlistViolationError;
