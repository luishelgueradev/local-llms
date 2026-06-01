/**
 * Phase 18 (v0.11.0 — MCPC-03 / P2-02 BLOCK — tool-name collision prevention)
 *
 * Double-underscore separator chosen for:
 *   - JSON Schema name safety (no escaping issues)
 *   - Regex safety
 *   - Unambiguous stripPrefix (split on FIRST __ only)
 *
 * Alternatives rejected:
 *   - `/` (slash): collides with MCP method names
 *   - `.` (dot): collides with OpenAPI function-name conventions
 *   - `:` (colon): collides with URL-style schemes
 */

export const PREFIX_SEPARATOR = '__';

/**
 * Prefix a tool name with its server alias for injection into canonical.tools[].
 *
 * @example prefixToolName('server_a', 'search') === 'server_a__search'
 */
export function prefixToolName(alias: string, toolName: string): string {
  return `${alias}${PREFIX_SEPARATOR}${toolName}`;
}

/**
 * Strip the alias prefix from a tool name for dispatch to the correct MCP server.
 *
 * IMPORTANT: splits on the FIRST occurrence of `__` only — tool names may
 * themselves contain `__` (e.g. `read__file` from an alias `notion`):
 *   stripPrefix('notion__read__file') === { alias: 'notion', toolName: 'read__file' }
 *
 * @returns null if the name has no prefix separator (treat as non-external).
 */
export function stripPrefix(prefixed: string): { alias: string; toolName: string } | null {
  const idx = prefixed.indexOf(PREFIX_SEPARATOR);
  if (idx < 0) return null;
  return {
    alias: prefixed.slice(0, idx),
    toolName: prefixed.slice(idx + PREFIX_SEPARATOR.length),
  };
}

/**
 * Check if a tool-call function name is an external MCP tool (has alias prefix
 * matching one of the enabled aliases).
 */
export function isExternalMcpToolCall(
  functionName: string,
  enabledAliases: readonly string[],
): boolean {
  const stripped = stripPrefix(functionName);
  if (!stripped) return false;
  return enabledAliases.includes(stripped.alias);
}
