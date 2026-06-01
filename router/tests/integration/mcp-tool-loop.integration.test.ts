/**
 * Phase 18 / v0.11.0 — MCPC-04 (MCP tool-call resolution loop).
 * Plan 18-05 Task 1 flip — real it().
 *
 * End-to-end integration tests for the MCP tool-call dispatch loop. The
 * loop is INTERNAL to the non-streaming path only (A4 RESOLVED — Phase 18
 * does NOT cover streaming MCP tool calls; the OpenAI Realtime / Anthropic
 * `messages.stream` surfaces require a follow-up phase). The cap of 10
 * iterations comes from REQUIREMENTS — wins over the older ARCHITECTURE.md
 * value of 5 (A8 lock).
 *
 * Integration boundary under test:
 *   - The MSW MCP fixture (`tests/fixtures/mcp-server.ts`) plays the role of
 *     an upstream MCP server speaking Streamable-HTTP JSON-RPC.
 *   - A REAL `makeMcpClientRegistry` is constructed (no fakes); the registry
 *     issues `tools/call` over MSW.
 *   - A scripted adapter plays the role of the LLM backend, scripted to
 *     emit tool_use blocks for the loop test cases.
 *
 * What is NOT covered here: the buildApp / route wiring (Plan 18-07's
 * concern). The loop's contract — input CanonicalRequest, output
 * CanonicalResponse, parallel-within-iter / sequential-across-iter, 10-iter
 * cap — is fully exercisable from `runMcpToolLoop` directly.
 *
 * Implementation note (Plan 18-05): canonical response is Anthropic-shape,
 * so tool calls surface as `ToolUseBlock` entries in `resp.content[]`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { Counter, Registry as PromRegistry } from 'prom-client';
import type { SetupServer } from 'msw/node';
import {
  setupMcpMswServer,
  MCP_FIXTURE_BASE_URL,
} from '../fixtures/mcp-server.js';
import {
  makeMcpClientRegistry,
  type McpServerConfig,
} from '../../src/mcp/client/registry.js';
import {
  runMcpToolLoop,
  MCP_TOOL_LOOP_MAX,
} from '../../src/mcp/client/tool-loop.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
} from '../../src/translation/canonical.js';
import {
  McpToolLoopExceededError,
  mapToHttpStatus,
} from '../../src/errors/envelope.js';
import { makeFakeMcpClientRegistry } from '../fakes.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeMetric(): {
  routerMcpToolCallsExternalTotal: Counter<'server_alias' | 'status_class'>;
  reg: PromRegistry;
} {
  const reg = new PromRegistry();
  const counter = new Counter({
    name: 'router_mcp_tool_calls_external_total',
    help: 'External MCP tool calls observed by server_alias + status_class',
    labelNames: ['server_alias', 'status_class'] as const,
    registers: [reg],
  });
  return { routerMcpToolCallsExternalTotal: counter, reg };
}

function cfgSearcher(): McpServerConfig {
  return {
    alias: 'searcher',
    url: MCP_FIXTURE_BASE_URL,
    transport: 'streamable-http',
    auth_type: 'none',
    timeout_ms: 5_000,
    tool_filter: ['*'],
  } as McpServerConfig;
}

function makeRequest(): CanonicalRequest {
  return {
    model: 'fake-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'search for foo' }] }],
  };
}

function makeToolUseResponse(name: string, input: Record<string, unknown>, id = 'toolu_1'): CanonicalResponse {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    model: 'fake-model',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function makeTextResponse(text: string): CanonicalResponse {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'fake-model',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

interface ScriptedAdapterHandle {
  adapter: BackendAdapter;
  /** Live counter via getter — do NOT destructure (`const { calls } = ...`). */
  readonly calls: number;
}

function makeScriptedAdapter(queue: CanonicalResponse[]): ScriptedAdapterHandle {
  let count = 0;
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical() {
      const r = queue[count];
      count++;
      if (!r) throw new Error(`scripted adapter ran out at call #${count}`);
      return r;
    },
    chatCompletionsCanonicalStream: async () => {
      throw new Error('stream not used in MCP tool-loop integration');
    },
    embeddings: async () => {
      throw new Error('embeddings not used');
    },
    rerank: async () => {
      throw new Error('rerank not used');
    },
    probeLiveness: async () => ({ ok: true, latencyMs: 1 }),
  };
  return {
    adapter,
    get calls() {
      return count;
    },
  };
}

describe('MCPC-04: MCP tool-call resolution loop (max 10 iterations)', () => {
  let msw: SetupServer | undefined;

  beforeEach(() => {
    msw = setupMcpMswServer({
      tools: [
        {
          name: 'search',
          description: 'Search docs',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
      callResult: { hits: [{ id: 1, title: 'Foo Doc' }] },
    });
    msw.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    msw?.close();
    msw = undefined;
  });

  it('happy path: model emits 1 tool call → router proxies → result added as tool message → second model call returns final text', async () => {
    const registry = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      logger: silentLogger(),
    });
    const m = makeMetric();
    const handle = makeScriptedAdapter([
      makeToolUseResponse('searcher__search', { q: 'foo' }),
      makeTextResponse('Found Foo Doc.'),
    ]);

    const result = await runMcpToolLoop({
      initial: makeRequest(),
      adapter: handle.adapter,
      signal: new AbortController().signal,
      registry,
      enabledAliases: ['searcher'],
      log: silentLogger(),
      metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
    });

    expect(handle.calls).toBe(2);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Found Foo Doc.' });
    // Metric incremented for the successful tool call.
    const text = await m.reg.metrics();
    expect(text).toMatch(
      /router_mcp_tool_calls_external_total\{server_alias="searcher",status_class="success"\}\s+1/,
    );
    await registry.disposeAll();
  });

  it('zero tool calls: adapter called once; no MCP traffic', async () => {
    const registry = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      logger: silentLogger(),
    });
    const m = makeMetric();
    const handle = makeScriptedAdapter([makeTextResponse('no tools needed')]);

    const result = await runMcpToolLoop({
      initial: makeRequest(),
      adapter: handle.adapter,
      signal: new AbortController().signal,
      registry,
      enabledAliases: ['searcher'],
      log: silentLogger(),
      metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
    });

    expect(handle.calls).toBe(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'no tools needed' });
    // Metric NOT touched (no calls made).
    const text = await m.reg.metrics();
    expect(text).not.toMatch(/router_mcp_tool_calls_external_total\{[^}]+\}\s+[1-9]/);
    await registry.disposeAll();
  });

  it('loop iterates up to 10 times; 11th iteration throws McpToolLoopExceededError', async () => {
    // Use the FAKE registry here — driving the real MSW server 10 times is
    // unnecessarily slow when the assertion is purely about the cap. The
    // adapter's `tool_use` response on every call drives the loop.
    const registry = makeFakeMcpClientRegistry();
    const m = makeMetric();
    const queue: CanonicalResponse[] = [];
    for (let i = 0; i < 11; i++) {
      queue.push(makeToolUseResponse('searcher__search', { n: i }, `toolu_${i}`));
    }
    const handle = makeScriptedAdapter(queue);

    await expect(
      runMcpToolLoop({
        initial: makeRequest(),
        adapter: handle.adapter,
        signal: new AbortController().signal,
        registry,
        enabledAliases: ['searcher'],
        log: silentLogger(),
        metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
      }),
    ).rejects.toBeInstanceOf(McpToolLoopExceededError);

    // 1 initial adapter call + 10 iterations of "tool again" = 11 total.
    expect(handle.calls).toBe(11);
    // 10 tool calls dispatched (one per iteration before cap fires).
    const text = await m.reg.metrics();
    expect(text).toMatch(
      /router_mcp_tool_calls_external_total\{server_alias="searcher",status_class="success"\}\s+10/,
    );
  });

  it('McpToolLoopExceededError mapped to 502 via envelope.mapToHttpStatus', () => {
    const err = new McpToolLoopExceededError(MCP_TOOL_LOOP_MAX);
    expect(mapToHttpStatus(err)).toBe(502);
  });

  it('error_envelope code: "mcp_tool_loop_exceeded"; maxIter: 10 captured on error class', async () => {
    const registry = makeFakeMcpClientRegistry();
    const m = makeMetric();
    const queue: CanonicalResponse[] = [];
    for (let i = 0; i < 11; i++) {
      queue.push(makeToolUseResponse('searcher__search', { n: i }, `toolu_${i}`));
    }
    const handle2 = makeScriptedAdapter(queue);

    try {
      await runMcpToolLoop({
        initial: makeRequest(),
        adapter: handle2.adapter,
        signal: new AbortController().signal,
        registry,
        enabledAliases: ['searcher'],
        log: silentLogger(),
        metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolLoopExceededError);
      const e = err as McpToolLoopExceededError;
      expect(e.code).toBe('mcp_tool_loop_exceeded');
      expect(e.maxIter).toBe(10);
    }
  });

  it('streaming path: MCP tool loop is NOT invoked (A4 RESOLVED — non-stream only in Phase 18)', async () => {
    // Plan 18-05 exports `runMcpToolLoop` for the NON-STREAM path only. The
    // stream path (Plan 18-07's wiring) will NOT invoke this function. We
    // assert structurally: the function's signature accepts `BackendAdapter`
    // and returns `Promise<CanonicalResponse>` — there is NO stream-event
    // iteration surface. Plan 18-07's responsibility is to route stream
    // requests AROUND this helper.
    //
    // This test enshrines the contract: any code path that produces a stream
    // (CanonicalStreamEvent iterable) must NOT pass through runMcpToolLoop.
    // We verify by asserting that the adapter's STREAM method is NEVER
    // invoked by the loop, even when the request opts in to streaming.
    const registry = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      logger: silentLogger(),
    });
    const m = makeMetric();
    let streamCalled = false;
    const adapter: BackendAdapter = {
      async chatCompletionsCanonical() {
        return makeTextResponse('ok');
      },
      async chatCompletionsCanonicalStream() {
        streamCalled = true;
        throw new Error('stream should not be invoked');
      },
      embeddings: async () => {
        throw new Error('embeddings not used');
      },
      rerank: async () => {
        throw new Error('rerank not used');
      },
      probeLiveness: async () => ({ ok: true, latencyMs: 1 }),
    };

    // Even when the request has `stream: true`, runMcpToolLoop uses the
    // non-stream method. Plan 18-07 will gate the stream path AHEAD of
    // calling runMcpToolLoop.
    const initial: CanonicalRequest = { ...makeRequest(), stream: true };
    await runMcpToolLoop({
      initial,
      adapter,
      signal: new AbortController().signal,
      registry,
      enabledAliases: ['searcher'],
      log: silentLogger(),
      metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
    });

    expect(streamCalled).toBe(false);
    await registry.disposeAll();
  });

  it('user-provided tools coexist: canonical.tools = [...userTools, ...mcpTools] (RESOLVED #10 append-not-replace)', async () => {
    // The loop preserves any pre-existing canonical.tools[] passed by the
    // caller — Plan 18-07 will inject MCP tools at REQUEST ingestion (not
    // inside the loop). The loop's job is just to dispatch on tool_use
    // blocks regardless of who registered them in canonical.tools. We verify
    // here that the loop does NOT mutate `canonical.tools[]` across
    // iterations — only `canonical.messages[]` grows.
    const registry = makeMcpClientRegistry({
      servers: new Map([['searcher', cfgSearcher()]]),
      logger: silentLogger(),
    });
    const m = makeMetric();
    let firstReqToolsLen = -1;
    let secondReqToolsLen = -1;
    let invocation = 0;
    const userTool = { name: 'user_tool', input_schema: { type: 'object' as const } };
    const mcpTool = {
      name: 'searcher__search',
      input_schema: { type: 'object' as const },
    };

    const adapter: BackendAdapter = {
      async chatCompletionsCanonical(canonical) {
        if (invocation === 0) {
          firstReqToolsLen = canonical.tools?.length ?? 0;
          invocation++;
          return makeToolUseResponse('searcher__search', { q: 'foo' });
        }
        secondReqToolsLen = canonical.tools?.length ?? 0;
        return makeTextResponse('done');
      },
      chatCompletionsCanonicalStream: async () => {
        throw new Error('stream not used');
      },
      embeddings: async () => {
        throw new Error('embeddings not used');
      },
      rerank: async () => {
        throw new Error('rerank not used');
      },
      probeLiveness: async () => ({ ok: true, latencyMs: 1 }),
    };

    const initial: CanonicalRequest = {
      ...makeRequest(),
      tools: [userTool, mcpTool],
    };

    await runMcpToolLoop({
      initial,
      adapter,
      signal: new AbortController().signal,
      registry,
      enabledAliases: ['searcher'],
      log: silentLogger(),
      metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
    });

    // Both invocations saw the same 2-tool canonical.tools[] — loop did
    // NOT add, remove, or reorder them.
    expect(firstReqToolsLen).toBe(2);
    expect(secondReqToolsLen).toBe(2);
    await registry.disposeAll();
  });
});
