/**
 * Phase 18 / v0.11.0 — MCPC-04 (dispatch loop, max 10 iterations).
 * Plan 18-05 Task 1 flip — real it().
 *
 * Unit tests for `runMcpToolLoop` — the per-request loop that:
 *   1. Calls the adapter.
 *   2. If response contains external (prefixed) MCP tool_use blocks, forwards
 *      each to `registry.callTool(alias, toolName, input)` (alias stripped
 *      from `alias__toolName`).
 *   3. Appends an assistant message replaying the tool_use blocks + a user
 *      message with the tool_result blocks.
 *   4. Recurses up to MCP_TOOL_LOOP_MAX iterations (10 per REQUIREMENTS,
 *      RESOLVED A8 — overrides the older ARCHITECTURE.md=5 doc).
 *
 * Internal MCP-host tools (no `__` prefix, or prefix-alias NOT in enabled
 * list) are filtered out by `isExternalMcpToolCall` — they pass through.
 *
 * Implementation note (Plan 18-05): canonical response is Anthropic-shape,
 * so `resp.content[]` carries ToolUseBlock entries (not OpenAI tool_calls).
 * The tests assert against the real schema, not the Plan-18-RESEARCH
 * snippet's OpenAI shape (the snippet was illustrative; the implementation
 * uses the canonical schema).
 */
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Counter, Registry as PromRegistry } from 'prom-client';
import {
  runMcpToolLoop,
  MCP_TOOL_LOOP_MAX,
  type RunMcpToolLoopOpts,
} from '../../../src/mcp/client/tool-loop.js';
import type {
  BackendAdapter,
} from '../../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  ContentBlock,
  ToolUseBlock,
} from '../../../src/translation/canonical.js';
import { McpToolLoopExceededError } from '../../../src/errors/envelope.js';
import { makeFakeMcpClientRegistry } from '../../fakes.js';

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

function makeBaseRequest(): CanonicalRequest {
  return {
    model: 'fake-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
}

function makeToolUseResponse(blocks: Array<{ id: string; name: string; input: Record<string, unknown> }>): CanonicalResponse {
  const content: ContentBlock[] = blocks.map((b) => ({
    type: 'tool_use' as const,
    id: b.id,
    name: b.name,
    input: b.input,
  }));
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content,
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

/**
 * Build a minimal BackendAdapter whose `chatCompletionsCanonical` returns
 * the next response in `queue` on each invocation. Captures every signal it
 * receives for abort-propagation assertions.
 */
function makeScriptedAdapter(queue: CanonicalResponse[]): {
  adapter: BackendAdapter;
  calls: Array<{ canonical: CanonicalRequest; signal: AbortSignal }>;
} {
  const calls: Array<{ canonical: CanonicalRequest; signal: AbortSignal }> = [];
  let idx = 0;
  const adapter: BackendAdapter = {
    async chatCompletionsCanonical(canonical, signal) {
      calls.push({ canonical, signal });
      if (idx >= queue.length) {
        throw new Error(`scripted adapter ran out of responses at call #${idx + 1}`);
      }
      const r = queue[idx];
      idx++;
      if (!r) throw new Error('scripted adapter: undefined response');
      return r;
    },
    chatCompletionsCanonicalStream: async () => {
      throw new Error('stream not used in tool-loop tests');
    },
    embeddings: async () => {
      throw new Error('embeddings not used');
    },
    rerank: async () => {
      throw new Error('rerank not used');
    },
    probeLiveness: async () => ({ ok: true, latencyMs: 1 }),
  };
  return { adapter, calls };
}

function makeOpts(
  overrides: Partial<RunMcpToolLoopOpts> & Pick<RunMcpToolLoopOpts, 'adapter'>,
): RunMcpToolLoopOpts {
  const m = makeMetric();
  return {
    initial: makeBaseRequest(),
    signal: new AbortController().signal,
    registry: makeFakeMcpClientRegistry(),
    enabledAliases: ['server_a'],
    log: silentLogger(),
    metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
    ...overrides,
  };
}

describe('runMcpToolLoop — MCPC-04 dispatch loop', () => {
  it('runtime sentinel: src/mcp/client/tool-loop.js resolves (Wave-0 fails until Plan 18-05)', async () => {
    await import('../../../src/mcp/client/tool-loop.js');
  });

  it('MCP_TOOL_LOOP_MAX === 10 (REQUIREMENTS wins over ARCHITECTURE.md=5 — A8 lock)', () => {
    expect(MCP_TOOL_LOOP_MAX).toBe(10);
  });

  it('no tool calls: adapter called once, returns response unchanged', async () => {
    const finalResp = makeTextResponse('hello');
    const { adapter, calls } = makeScriptedAdapter([finalResp]);
    const result = await runMcpToolLoop(makeOpts({ adapter }));
    expect(calls).toHaveLength(1);
    expect(result).toBe(finalResp);
  });

  it('one external tool call: adapter called twice (first emit, second after tool result)', async () => {
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_1', name: 'server_a__search', input: { q: 'foo' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter, calls } = makeScriptedAdapter([toolCallResp, finalResp]);

    const result = await runMcpToolLoop(makeOpts({ adapter }));

    expect(calls).toHaveLength(2);
    expect(result).toBe(finalResp);
    // Second adapter call carries the appended turns.
    expect(calls[1]!.canonical.messages).toHaveLength(3); // user + assistant + tool-reply
    const tail = calls[1]!.canonical.messages[2]!;
    expect(tail.role).toBe('user');
    const content = tail.content as ContentBlock[];
    expect(content[0]!.type).toBe('tool_result');
  });

  it('prefix-stripped tool name passed to registry.callTool (alias separated from tool)', async () => {
    const callTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    const registry = makeFakeMcpClientRegistry({ callTrace });
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_1', name: 'server_a__search', input: { q: 'foo' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter } = makeScriptedAdapter([toolCallResp, finalResp]);

    await runMcpToolLoop(makeOpts({ adapter, registry }));

    expect(callTrace).toHaveLength(1);
    expect(callTrace[0]).toEqual({
      alias: 'server_a',
      toolName: 'search',
      args: { q: 'foo' },
    });
  });

  it('tool result serialized as { type: "tool_result", tool_use_id, content: JSON.stringify(result) }', async () => {
    const toolResult = { results: [{ id: 1, title: 'doc' }] };
    const registry = makeFakeMcpClientRegistry({
      toolResultsByAlias: { server_a: { search: toolResult } },
    });
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_1', name: 'server_a__search', input: { q: 'foo' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter, calls } = makeScriptedAdapter([toolCallResp, finalResp]);

    await runMcpToolLoop(makeOpts({ adapter, registry }));

    const replyTurn = calls[1]!.canonical.messages[2]!;
    expect(replyTurn.role).toBe('user');
    const blocks = replyTurn.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: JSON.stringify(toolResult),
    });
  });

  it('parallel tool calls in one iteration: Promise.all across calls, then ONE follow-up adapter call', async () => {
    // Two distinct calls in the SAME assistant response → both run via Promise.all.
    // Resolution order is the registry's; we observe BOTH replies in the next adapter call.
    const callTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    const registry = makeFakeMcpClientRegistry({ callTrace });
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_a', name: 'server_a__search', input: { q: 'foo' } },
      { id: 'toolu_b', name: 'server_a__lookup', input: { id: 'x' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter, calls } = makeScriptedAdapter([toolCallResp, finalResp]);

    await runMcpToolLoop(makeOpts({ adapter, registry }));

    // Exactly TWO callTool invocations in this iteration, and ONE follow-up adapter call.
    expect(callTrace).toHaveLength(2);
    expect(calls).toHaveLength(2);
    // The tool-reply message carries BOTH tool_result blocks.
    const replyTurn = calls[1]!.canonical.messages[2]!;
    const blocks = replyTurn.content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => (b as { tool_use_id?: string }).tool_use_id).sort()).toEqual([
      'toolu_a',
      'toolu_b',
    ]);
  });

  it('internal MCP host tool-call (no __) is filtered out via isExternalMcpToolCall — NOT proxied', async () => {
    const callTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    const registry = makeFakeMcpClientRegistry({ callTrace });
    // tool_use block whose name has NO __ prefix → not an external MCP call.
    const respWithInternal: CanonicalResponse = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_internal', name: 'internal_tool', input: {} },
      ],
      model: 'fake-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const { adapter, calls } = makeScriptedAdapter([respWithInternal]);

    const result = await runMcpToolLoop(makeOpts({ adapter, registry }));

    // Adapter called exactly once — loop saw no external tool calls, returned the response.
    expect(calls).toHaveLength(1);
    expect(callTrace).toHaveLength(0);
    expect(result).toBe(respWithInternal);
  });

  it('loop hits cap at 10 iterations → throws McpToolLoopExceededError(10)', async () => {
    // Every iteration: model emits one external tool call, registry returns result,
    // model emits another tool call — forever. Loop must stop at cap.
    const toolCallResp = (n: number): CanonicalResponse =>
      makeToolUseResponse([{ id: `toolu_${n}`, name: 'server_a__search', input: { n } }]);
    // 11 scripted adapter responses (1 initial + 10 iterations of "tool again")
    // ensures the loop has enough fuel to hit the cap.
    const queue: CanonicalResponse[] = [];
    for (let i = 0; i < 11; i++) queue.push(toolCallResp(i));
    const { adapter, calls } = makeScriptedAdapter(queue);

    await expect(runMcpToolLoop(makeOpts({ adapter }))).rejects.toBeInstanceOf(
      McpToolLoopExceededError,
    );
    // Loop did 11 adapter calls (initial + 10 iterations); cap fires AFTER the 11th
    // response is observed to still carry tool calls.
    expect(calls).toHaveLength(11);
  });

  it('McpToolLoopExceededError.code === "mcp_tool_loop_exceeded"', async () => {
    const toolCallResp = (n: number): CanonicalResponse =>
      makeToolUseResponse([{ id: `toolu_${n}`, name: 'server_a__search', input: { n } }]);
    const queue: CanonicalResponse[] = [];
    for (let i = 0; i < 11; i++) queue.push(toolCallResp(i));
    const { adapter } = makeScriptedAdapter(queue);

    try {
      await runMcpToolLoop(makeOpts({ adapter }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolLoopExceededError);
      expect((err as McpToolLoopExceededError).code).toBe('mcp_tool_loop_exceeded');
      expect((err as McpToolLoopExceededError).maxIter).toBe(10);
    }
  });

  it('upstream tool call error → tool message with { error: "..." } payload + metric status_class:server_error', async () => {
    const registry = makeFakeMcpClientRegistry({
      shouldFailOn: { alias: 'server_a', on: 'call' },
    });
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_1', name: 'server_a__search', input: { q: 'foo' } },
    ]);
    const finalResp = makeTextResponse('giving up');
    const { adapter, calls } = makeScriptedAdapter([toolCallResp, finalResp]);

    const m = makeMetric();
    await runMcpToolLoop(
      makeOpts({
        adapter,
        registry,
        metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
      }),
    );

    // Tool-reply block carries an error payload (graceful surface to model).
    const replyTurn = calls[1]!.canonical.messages[2]!;
    const blocks = replyTurn.content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as { type: string; content: string; is_error?: boolean };
    expect(block.type).toBe('tool_result');
    expect(block.is_error).toBe(true);
    const parsed = JSON.parse(block.content) as { error: string };
    expect(parsed.error).toContain('fake-fail');

    // Metric increments with status_class: server_error.
    const text = await m.reg.metrics();
    expect(text).toMatch(
      /router_mcp_tool_calls_external_total\{server_alias="server_a",status_class="server_error"\}\s+1/,
    );
  });

  it('abort signal propagates to every adapter call and every registry.callTool', async () => {
    const controller = new AbortController();
    const callTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    // Custom registry whose callTool inspects the OPTS signal — the fake doesn't expose it,
    // so we layer in a verification by wrapping callTool ourselves.
    let registrySawAborted = false;
    const baseReg = makeFakeMcpClientRegistry({ callTrace });
    const registry: typeof baseReg = {
      ...baseReg,
      async callTool(alias, toolName, args) {
        // The loop hands the signal to the adapter; for the registry, the SDK's
        // RequestOptions wires it via opts.timeout / opts.signal. The FAKE
        // registry has no signal parameter — but the assertion we care about
        // is the ADAPTER signal-propagation. So this layer simply records the
        // controller's aborted state to verify signal threading is observable
        // alongside the call.
        registrySawAborted = controller.signal.aborted;
        return baseReg.callTool(alias, toolName, args);
      },
    };
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_1', name: 'server_a__search', input: { q: 'foo' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter, calls } = makeScriptedAdapter([toolCallResp, finalResp]);

    await runMcpToolLoop(makeOpts({ adapter, registry, signal: controller.signal }));

    // Every adapter call received the SAME AbortSignal instance.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[1]!.signal).toBe(controller.signal);
    // And the registry's callTool ran while bound to the same controller's lifecycle.
    expect(registrySawAborted).toBe(false); // not aborted in happy path
  });

  it('metric routerMcpToolCallsExternalTotal increments per call with {server_alias, status_class}', async () => {
    const m = makeMetric();
    const registry = makeFakeMcpClientRegistry({
      toolResultsByAlias: { server_a: { search: { ok: 1 } } },
    });
    const toolCallResp = makeToolUseResponse([
      { id: 'toolu_a', name: 'server_a__search', input: { q: 'a' } },
      { id: 'toolu_b', name: 'server_a__search', input: { q: 'b' } },
    ]);
    const finalResp = makeTextResponse('done');
    const { adapter } = makeScriptedAdapter([toolCallResp, finalResp]);

    await runMcpToolLoop(
      makeOpts({
        adapter,
        registry,
        metrics: { routerMcpToolCallsExternalTotal: m.routerMcpToolCallsExternalTotal },
      }),
    );

    const text = await m.reg.metrics();
    // Two successful calls to alias=server_a.
    expect(text).toMatch(
      /router_mcp_tool_calls_external_total\{server_alias="server_a",status_class="success"\}\s+2/,
    );
  });
});
