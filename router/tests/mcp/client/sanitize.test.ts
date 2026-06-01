/**
 * Phase 18 / v0.11.0 — P2-03 BLOCK (tool poisoning defense).
 * Plan 18-03: real it() — production module landed in src/mcp/client/sanitize.ts.
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
 * Lock convention (Plan 18-01 lock): each `it()` case-name string below
 * is the authoritative wording (carry-over from the original it.todo names).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeExternalTool,
  TOOL_NAME_REGEX,
  DESCRIPTION_MAX_CHARS,
  type SanitizedTool,
} from '../../../src/mcp/client/sanitize.js';
import type { Logger } from 'pino';

// Minimal pino-shaped logger stub with a spy on warn.
function makeLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const log = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { log, warn };
}

function makeRaw(overrides: Partial<{
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}> = {}) {
  return {
    name: 'search_docs',
    description: 'finds docs',
    inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
    ...overrides,
  };
}

describe('sanitizeExternalTool — P2-03 BLOCK tool poisoning defense', () => {
  it('runtime sentinel: src/mcp/client/sanitize.js resolves (Wave-0 fails until Plan 18-03/04)', async () => {
    await import('../../../src/mcp/client/sanitize.js');
  });

  it('TOOL_NAME_REGEX matches /^[a-z0-9_]{1,64}$/', () => {
    expect(TOOL_NAME_REGEX.source).toBe('^[a-z0-9_]{1,64}$');
    expect(TOOL_NAME_REGEX.test('search_docs')).toBe(true);
    expect(TOOL_NAME_REGEX.test('a')).toBe(true);
    expect(TOOL_NAME_REGEX.test('a'.repeat(64))).toBe(true);
    expect(TOOL_NAME_REGEX.test('a'.repeat(65))).toBe(false);
    expect(TOOL_NAME_REGEX.test('')).toBe(false);
    expect(TOOL_NAME_REGEX.test('Search')).toBe(false);
    expect(TOOL_NAME_REGEX.test('search nope')).toBe(false);
  });

  it('valid name "search_docs" passes', () => {
    const { log } = makeLogger();
    const result = sanitizeExternalTool(makeRaw({ name: 'search_docs' }), 'server_a', log);
    expect(result).not.toBeNull();
    expect((result as SanitizedTool).name).toBe('search_docs');
  });

  it('invalid name "search nope" (space) rejected → returns null + warn log with event:mcp_tool_name_rejected', () => {
    const { log, warn } = makeLogger();
    const result = sanitizeExternalTool(makeRaw({ name: 'search nope' }), 'server_a', log);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [logArg] = warn.mock.calls[0]!;
    expect(logArg).toMatchObject({
      alias: 'server_a',
      name: 'search nope',
      event: 'mcp_tool_name_rejected',
    });
  });

  it('invalid name "Search" (uppercase) rejected', () => {
    const { log, warn } = makeLogger();
    const result = sanitizeExternalTool(makeRaw({ name: 'Search' }), 'server_a', log);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('invalid name "" (empty) rejected', () => {
    const { log, warn } = makeLogger();
    const result = sanitizeExternalTool(makeRaw({ name: '' }), 'server_a', log);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('invalid name 65 chars rejected', () => {
    const { log, warn } = makeLogger();
    const name65 = 'a'.repeat(65);
    const result = sanitizeExternalTool(makeRaw({ name: name65 }), 'server_a', log);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('description undefined: defaults to ""', () => {
    const { log } = makeLogger();
    const result = sanitizeExternalTool(
      makeRaw({ name: 'ok', description: undefined }),
      'server_a',
      log,
    );
    expect(result).not.toBeNull();
    expect((result as SanitizedTool).description).toBe('');
  });

  it('description ≤ 512 chars: passed through unchanged', () => {
    const { log, warn } = makeLogger();
    const desc = 'a'.repeat(DESCRIPTION_MAX_CHARS); // exactly 512
    const result = sanitizeExternalTool(
      makeRaw({ name: 'ok', description: desc }),
      'server_a',
      log,
    );
    expect(result).not.toBeNull();
    expect((result as SanitizedTool).description).toBe(desc);
    expect((result as SanitizedTool).warnings).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('description > 512 chars: truncated to 512 + "…[truncated]" suffix + warn event:mcp_tool_description_truncated', () => {
    const { log, warn } = makeLogger();
    const giant = 'b'.repeat(DESCRIPTION_MAX_CHARS + 100);
    const result = sanitizeExternalTool(
      makeRaw({ name: 'ok', description: giant }),
      'server_a',
      log,
    );
    expect(result).not.toBeNull();
    const out = (result as SanitizedTool).description;
    expect(out.endsWith('…[truncated]')).toBe(true);
    // First DESCRIPTION_MAX_CHARS chars preserved.
    expect(out.startsWith('b'.repeat(DESCRIPTION_MAX_CHARS))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [logArg] = warn.mock.calls[0]!;
    expect(logArg).toMatchObject({
      alias: 'server_a',
      name: 'ok',
      event: 'mcp_tool_description_truncated',
      original_len: DESCRIPTION_MAX_CHARS + 100,
    });
  });

  it('warnings array includes "description_truncated" when truncation occurred', () => {
    const { log } = makeLogger();
    const giant = 'c'.repeat(DESCRIPTION_MAX_CHARS + 1);
    const result = sanitizeExternalTool(
      makeRaw({ name: 'ok', description: giant }),
      'server_a',
      log,
    );
    expect(result).not.toBeNull();
    expect((result as SanitizedTool).warnings).toContain('description_truncated');
  });

  it('sanitized tool retains input_schema unchanged (router does not validate inputSchema content)', () => {
    const { log } = makeLogger();
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    };
    const result = sanitizeExternalTool(
      makeRaw({ name: 'ok', inputSchema: schema }),
      'server_a',
      log,
    );
    expect(result).not.toBeNull();
    expect((result as SanitizedTool).input_schema).toBe(schema);
  });
});
