/**
 * Phase 18 / v0.11.0 — MCPC-03 / P2-02 BLOCK (tool name prefix + dispatch
 * routing). Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-04/05.
 *
 * Integration tests covering the two-server name-collision scenario:
 *   - Server A (alias "server_a") registers a tool named "search".
 *   - Server B (alias "server_b") ALSO registers a tool named "search".
 *   - The router injects them into `canonical.tools[]` as
 *     `server_a__search` and `server_b__search` (alias prefix + `__`
 *     separator).
 *   - The MCP tool-loop strips the prefix via `stripPrefix(name)` and
 *     dispatches to the correct upstream `Client`.
 *
 * P2-02 BLOCK invariant under test: the prefix separator is `__` (double
 * underscore). Single-underscore is too common in real tool names to be
 * the disambiguator. `stripPrefix` splits on the FIRST `__` only — so a
 * tool with `__` in its name (e.g. `dunder_name__sub`) still routes
 * correctly.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-04/05's flip.
 */
import { describe, it } from 'vitest';

describe('MCPC-03 / P2-02: tool name prefix + dispatch routing — two-server collision', () => {
  it.todo('two MSW servers each register tool name "search"; injection produces [server_a__search, server_b__search]');
  it.todo('prefix separator is __ (double underscore); single underscore inside tool names preserved');
  it.todo('calling tool_call with name "server_a__search" routes to server A (verified by MSW request log)');
  it.todo('calling tool_call with name "server_b__search" routes to server B');
  it.todo('stripPrefix("server_a__search") returns { alias: "server_a", toolName: "search" }');
  it.todo('stripPrefix handles tool names containing __ correctly (splits ONLY on first __, not greedy)');
});
