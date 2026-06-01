/**
 * Phase 18 (v0.11.0 — MCPC-01..06): mcp/client/ barrel.
 *
 * Single import surface for the MCP client subsystem. Production wiring
 * (Plan 18-07's composition root) imports the registry factory + types
 * from here; route helpers (Plan 18-05's tool-loop, Plan 18-06's hook
 * runner) import the prefix/sanitize utilities from here.
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

// Plan 18-04: registry factory + types + outbound auth/transport factory.
export {
  makeMcpClientRegistry,
  type McpClientRegistry,
  type McpServerConfig,
  type MakeMcpClientRegistryOpts,
} from './registry.js';

export {
  buildClient,
  buildOutboundHeaders,
} from './transport.js';

// Plan 18-05: tool-call dispatch loop (MCPC-04 — 10-iter cap, parallel within iter).
export {
  runMcpToolLoop,
  MCP_TOOL_LOOP_MAX,
  type RunMcpToolLoopOpts,
} from './tool-loop.js';
