/**
 * Phase 18 / v0.11.0 — MCPC-04 (MCP tool-call resolution loop).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-05 lands the impl.
 *
 * End-to-end integration tests for the MCP tool-call dispatch loop. The
 * loop is INTERNAL to the non-streaming path only (A4 RESOLVED — Phase 18
 * does NOT cover streaming MCP tool calls; the OpenAI Realtime / Anthropic
 * `messages.stream` surfaces require a follow-up phase). The cap of 10
 * iterations comes from REQUIREMENTS — wins over the older ARCHITECTURE.md
 * value of 5 (A8 lock).
 *
 * Wire-level shape under test:
 *   - Adapter emits `tool_calls: [{ id, function: { name: 'server_a__search', arguments: '{"q":"foo"}' } }]`.
 *   - Router strips prefix, calls `mcpRegistry.callTool('server_a', 'search', { q: 'foo' })`.
 *   - Tool result appended as `{ role: 'tool', tool_call_id, content: JSON.stringify(result) }`.
 *   - Adapter re-called with the updated messages array.
 *   - Loop terminates when adapter returns a response without `tool_calls`.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-05's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-04: MCP tool-call resolution loop (max 10 iterations)', () => {
  it.todo('happy path: model emits 1 tool call → router proxies → result added as tool message → second model call returns final text');
  it.todo('zero tool calls: adapter called once; no MCP traffic');
  it.todo('loop iterates up to 10 times; 11th iteration throws McpToolLoopExceededError');
  it.todo('McpToolLoopExceededError mapped to 502 via envelope.mapToHttpStatus');
  it.todo('error_envelope code: "mcp_tool_loop_exceeded"; maxIter: 10 captured on error class');
  it.todo('streaming path: MCP tool loop is NOT invoked (A4 RESOLVED — non-stream only in Phase 18)');
  it.todo('user-provided tools coexist: canonical.tools = [...userTools, ...mcpTools] (RESOLVED #10 append-not-replace)');
});
