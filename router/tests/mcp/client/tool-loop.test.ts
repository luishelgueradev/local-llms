/**
 * Phase 18 / v0.11.0 — MCPC-04 (dispatch loop, max 10 iterations).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-05 lands the impl.
 *
 * Unit tests for `runMcpToolLoop` — the per-request loop that:
 *   1. Calls the adapter.
 *   2. If response contains external (prefixed) MCP tool_calls, forwards
 *      each to `registry.callTool(alias, toolName, args)` (alias stripped
 *      from `alias__toolName`).
 *   3. Appends `role: "tool"` messages with `content: JSON.stringify(result)`.
 *   4. Recurses up to MCP_TOOL_LOOP_MAX iterations (10 per REQUIREMENTS,
 *      RESOLVED A8 — overrides the older ARCHITECTURE.md=5 doc).
 *
 * Internal MCP-host tools (no `__` prefix) are filtered out by
 * `isExternalMcpToolCall` — the in-process MCP host handles those itself.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string below
 * is the authoritative wording for Plan 18-05's flip.
 */
import { describe, it } from 'vitest';
import type { RunMcpToolLoopOpts } from '../../../src/mcp/client/tool-loop.js';
// Compile-time anchor — keep tsc red until Plan 18-05.
type _UnusedToolLoopOpts = RunMcpToolLoopOpts;

describe('runMcpToolLoop — MCPC-04 dispatch loop', () => {
  it('runtime sentinel: src/mcp/client/tool-loop.js resolves (Wave-0 fails until Plan 18-05)', async () => {
    // Wave-0 missing-module sentinel — tool-loop lives under src/mcp/client/.
    await import('../../../src/mcp/client/tool-loop.js');
  });
  it.todo('MCP_TOOL_LOOP_MAX === 10 (REQUIREMENTS wins over ARCHITECTURE.md=5 — A8 lock)');
  it.todo('no tool calls: adapter called once, returns response unchanged');
  it.todo('one external tool call: adapter called twice (first emit, second after tool result)');
  it.todo('prefix-stripped tool name passed to registry.callTool (alias separated from tool)');
  it.todo('tool result serialized as { role: "tool", tool_call_id, content: JSON.stringify(result) }');
  it.todo('parallel tool calls in one iteration: Promise.all across calls, then ONE follow-up adapter call');
  it.todo('internal MCP host tool-call (no __) is filtered out via isExternalMcpToolCall — NOT proxied');
  it.todo('loop hits cap at 10 iterations → throws McpToolLoopExceededError(10)');
  it.todo('McpToolLoopExceededError.code === "mcp_tool_loop_exceeded"');
  it.todo(
    'upstream tool call error → tool message with { error: "..." } payload + metric status_class:server_error',
  );
  it.todo('abort signal propagates to every adapter call and every registry.callTool');
  it.todo('metric routerMcpToolCallsExternalTotal increments per call with {server_alias, status_class}');
});
