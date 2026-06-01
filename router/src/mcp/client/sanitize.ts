/**
 * Phase 18 (v0.11.0 — P2-03 BLOCK — tool poisoning defense)
 *
 * Validates external MCP tool ingestion: name regex + description truncate.
 * Rejected tools NEVER land in the canonical.tools[] array. The 60s Valkey
 * cache (Plan 18-04) stores ONLY sanitized tools — a malicious description
 * cannot land in canonical even on cache hit.
 */

import type { Logger } from 'pino';

/** MCP tool name regex — RFC-of-record per P2-03 BLOCK. */
export const TOOL_NAME_REGEX = /^[a-z0-9_]{1,64}$/;

/** Description hard cap. */
export const DESCRIPTION_MAX_CHARS = 512;

export interface SanitizedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Human-readable warnings; written to pino warn log. */
  warnings: string[];
}

/**
 * Sanitize an external MCP tool descriptor before injection.
 *
 * @param raw   The raw tool from `Client.listTools()` (name + description? + inputSchema).
 * @param alias The MCP server alias (for log context — NOT mixed into the tool name yet; prefix happens in prefix.ts).
 * @param log   pino logger child for `event:` field convention.
 * @returns     SanitizedTool, or `null` if the tool is rejected (with warn log).
 */
export function sanitizeExternalTool(
  raw: { name: string; description?: string; inputSchema: Record<string, unknown> },
  alias: string,
  log: Logger,
): SanitizedTool | null {
  // 1. Name regex — defense against tool-name-based prompt injection.
  if (!TOOL_NAME_REGEX.test(raw.name)) {
    log.warn(
      { alias, name: raw.name, event: 'mcp_tool_name_rejected' },
      `external MCP tool rejected: name '${raw.name}' does not match /^[a-z0-9_]{1,64}$/`,
    );
    return null;
  }

  // 2. Description truncate (defense against description-based prompt injection).
  let description = raw.description ?? '';
  const warnings: string[] = [];
  if (description.length > DESCRIPTION_MAX_CHARS) {
    log.warn(
      {
        alias,
        name: raw.name,
        original_len: description.length,
        event: 'mcp_tool_description_truncated',
      },
      `external MCP tool description truncated from ${description.length} to ${DESCRIPTION_MAX_CHARS} chars`,
    );
    description = description.slice(0, DESCRIPTION_MAX_CHARS) + '…[truncated]';
    warnings.push('description_truncated');
  }

  // 3. Input schema is opaque to the router — the SDK already validates it as JSON
  //    Schema 2020-12 at parse time. We pass through unchanged. A future P2-FUT could
  //    add schema-shape validation here; v0.11.0 ships the regex + truncate gates only.

  return { name: raw.name, description, input_schema: raw.inputSchema, warnings };
}
