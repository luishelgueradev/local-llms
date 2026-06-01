/**
 * Phase 18 / v0.11.0 — P2-03 BLOCK (tool poisoning defense).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-03/18-04 lands the impl.
 *
 * Unit tests for `sanitizeExternalTool` — the defense layer that screens
 * every `Tool` returned by an upstream MCP server before it lands in
 * `canonical.tools[]`. The MCP spec deliberately leaves `Tool.name` /
 * `Tool.description` un-validated, so a hostile server can return:
 *   - names containing prompt-injection payloads (whitespace, unicode,
 *     null-bytes, > 64 chars) — `TOOL_NAME_REGEX = /^[a-z0-9_]{1,64}$/`.
 *   - descriptions > 512 chars used as a smuggled system-prompt — the
 *     sanitizer truncates to 512 chars + appends `…[truncated]`.
 *
 * Coverage matches the per-case enumeration in RESEARCH §"Phase Requirements
 * → Test Map" (P2-03 row). The sanitizer returns `null` for hard-rejected
 * tools so the registry can skip them in `getOrFetchTools`.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string below
 * is the authoritative wording for Plan 18-03/04's flip.
 */
import { describe, it } from 'vitest';
import type { SanitizedTool } from '../../../src/mcp/client/sanitize.js';
// Compile-time anchor — keep tsc red until Plan 18-03/04.
type _UnusedSanitizedTool = SanitizedTool;

describe('sanitizeExternalTool — P2-03 BLOCK tool poisoning defense', () => {
  it('runtime sentinel: src/mcp/client/sanitize.js resolves (Wave-0 fails until Plan 18-03/04)', async () => {
    // Wave-0 missing-module sentinel — sanitizer lives under src/mcp/client/.
    await import('../../../src/mcp/client/sanitize.js');
  });
  it.todo('TOOL_NAME_REGEX matches /^[a-z0-9_]{1,64}$/');
  it.todo('valid name "search_docs" passes');
  it.todo(
    'invalid name "search nope" (space) rejected → returns null + warn log with event:mcp_tool_name_rejected',
  );
  it.todo('invalid name "Search" (uppercase) rejected');
  it.todo('invalid name "" (empty) rejected');
  it.todo('invalid name 65 chars rejected');
  it.todo('description undefined: defaults to ""');
  it.todo('description ≤ 512 chars: passed through unchanged');
  it.todo(
    'description > 512 chars: truncated to 512 + "…[truncated]" suffix + warn event:mcp_tool_description_truncated',
  );
  it.todo('warnings array includes "description_truncated" when truncation occurred');
  it.todo('sanitized tool retains input_schema unchanged (router does not validate inputSchema content)');
});
