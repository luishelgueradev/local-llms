/**
 * Phase 18 / v0.11.0 — RETR-06 / P5-04 (hook + MCP tool coexistence).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-07 lands the impl.
 *
 * Integration tests exercising the cross-feature contract: a request
 * referencing BOTH `pre_completion_hooks: [retriever]` AND
 * `mcp_servers_enabled: [searcher]` must:
 *
 *   - Fire the hook once (pre-completion only — NOT inside the MCP tool loop).
 *   - Surface the retrieved fence in `canonical.system`.
 *   - Surface the prefixed MCP tools in `canonical.tools[]`.
 *   - Dispatch the model tool call `searcher__search` through the MCP loop
 *     — NOT through the hook (the hook is data-retrieval; the MCP loop is
 *     function-call execution).
 *
 * Wire-level effect: `request_log.hook_log` has ONE entry (the hook), and
 * `router_mcp_tool_calls_external_total` increments once (the MCP call).
 *
 * The shared fixture pattern follows the three-route adapter-spy idiom
 * established in `tests/routes/session-attach.integration.test.ts` (PATTERNS
 * lines 797-808) — same `buildApp({ adapterFactory })` style with the
 * additional `preCompletionHooks` + `mcpRegistry` build opts.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-07's flip.
 */
import { describe, it } from 'vitest';
import type {
  makeFakeRetrieverProvider,
  makeFakeMcpClientRegistry,
} from '../fakes.js';
// Compile-time anchors — keep tsc red until Plan 18-01 Task 3 extends fakes.ts.
type _UnusedRetrieverFake = typeof makeFakeRetrieverProvider;
type _UnusedMcpFake = typeof makeFakeMcpClientRegistry;

describe('RETR-06 / P5-04: hook + MCP tool coexistence', () => {
  it.todo('request with BOTH pre_completion_hooks: [retriever] + mcp_servers_enabled: [searcher]: both fire');
  it.todo('hook fires ONCE (pre-completion); hook_log has 1 entry');
  it.todo('canonical.tools[] has the prefixed MCP tools AFTER hook ran');
  it.todo('canonical.system has the retrieved_context fence injected from the hook');
  it.todo('model tool-call for "searcher__search" routes through MCP loop (NOT through hook)');
  it.todo(
    'two distinct request_log entries: one for hook (hook_log set), MCP tool-call counted in router_mcp_tool_calls_external_total',
  );
});
