/**
 * Phase 18 (v0.11.0 — MCPC-01..06): mcp/client/ barrel.
 *
 * Re-exports the public utilities. Plans 18-04 + 18-05 add registry +
 * tool-loop exports.
 */

export {
  sanitizeExternalTool,
  TOOL_NAME_REGEX,
  DESCRIPTION_MAX_CHARS,
  type SanitizedTool,
} from './sanitize.js';

export {
  prefixToolName,
  stripPrefix,
  isExternalMcpToolCall,
  PREFIX_SEPARATOR,
} from './prefix.js';

// Plan 18-04 adds: makeMcpClientRegistry + type McpClientRegistry + type McpServerConfig
// Plan 18-05 adds: runMcpToolLoop + MCP_TOOL_LOOP_MAX + type RunMcpToolLoopOpts
