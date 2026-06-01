/**
 * Phase 18 (v0.11.0 — MCPC-04)
 *
 * runMcpToolLoop: drive the model→external-MCP-tool→model loop with a hard
 * 10-iteration cap. Per-request, sequential between iterations; tool calls
 * within one iteration run in parallel (Promise.all).
 *
 * SCOPE (RESOLVED Open Question #4): NON-STREAM paths only for Phase 18.
 * The stream path keeps Phase 16 behavior unchanged (the model emits tool
 * call events but the router does NOT loop on them — RESS-FUT).
 *
 * Protocol-agnostic: NO imports from router/src/routes/ or router/src/mcp/host/.
 * Mirrors the `dispatch/preflight.ts` helper-isolation invariant.
 *
 * Canonical schema note (Plan 18-05 implementation detail — supersedes the
 * Plan-18-05 / 18-RESEARCH interface snippet which used the OpenAI wire
 * shape `tool_calls[].function.name`): the canonical response is
 * Anthropic-shape — tool calls surface as `ToolUseBlock` entries inside
 * `resp.content[]`, with `block.name` (already-decoded function name) and
 * `block.input` (already-parsed args object). The dispatch loop reads those
 * directly, no JSON.parse on arguments. Tool results are appended as a
 * single `role:'user'` message whose content is an array of `tool_result`
 * blocks — that is the round-trip shape OpenAI-in / Anthropic-in both
 * accept (see src/translation/openai-in.ts lines 348-356 for the analogous
 * collapse rule on the inbound side).
 */

import type { CanonicalRequest, CanonicalResponse, ContentBlock, ToolUseBlock, ToolResultBlock, CanonicalMessage } from '../../translation/canonical.js';
import type { BackendAdapter } from '../../backends/adapter.js';
import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import type { McpClientRegistry } from './registry.js';
import { stripPrefix, isExternalMcpToolCall } from './prefix.js';
import { McpToolLoopExceededError } from '../../errors/envelope.js';

/** MCPC-04 hard cap. REQUIREMENTS.md + ROADMAP.md say 10 (A8 lock). */
export const MCP_TOOL_LOOP_MAX = 10;

export interface RunMcpToolLoopOpts {
  initial: CanonicalRequest;
  adapter: BackendAdapter;
  signal: AbortSignal;
  registry: McpClientRegistry;
  enabledAliases: readonly string[];
  log: Logger;
  metrics: {
    routerMcpToolCallsExternalTotal: Counter<'server_alias' | 'status_class'>;
  };
}

/**
 * Drive the model→external-tool→model loop until:
 *   - Model returns no external tool calls → resolve with final response.
 *   - Iteration count reaches MCP_TOOL_LOOP_MAX (10) → throw McpToolLoopExceededError.
 *   - Abort signal fires → propagate (adapter / registry will throw).
 *
 * Internal tool-calls whose names lack the `{alias}__` prefix (or whose
 * alias is not in `enabledAliases`) are IGNORED by this loop — they pass
 * through unchanged so the caller / route can surface them per the existing
 * tool-call contract.
 */
export async function runMcpToolLoop(opts: RunMcpToolLoopOpts): Promise<CanonicalResponse> {
  let canonical = opts.initial;
  let iter = 0;

  // First adapter call — issued unconditionally.
  let resp = await opts.adapter.chatCompletionsCanonical(canonical, opts.signal);

  // Helper: locate tool_use blocks whose function name resolves to an
  // enabled external MCP alias. Internal / un-prefixed tool_use blocks are
  // out of scope here (the host / existing adapter loop handles those).
  const externalToolUses = (r: CanonicalResponse): ToolUseBlock[] =>
    r.content.filter(
      (b): b is ToolUseBlock =>
        b.type === 'tool_use' && isExternalMcpToolCall(b.name, opts.enabledAliases),
    );

  while (externalToolUses(resp).length > 0 && iter < MCP_TOOL_LOOP_MAX) {
    iter++;
    const externalCalls = externalToolUses(resp);

    // Parallel dispatch within ONE iteration (per RESEARCH "Key invariants"
    // line 527 — sequential ACROSS iterations, parallel WITHIN one).
    const toolResultBlocks: ToolResultBlock[] = await Promise.all(
      externalCalls.map(async (block) => {
        const stripped = stripPrefix(block.name);
        // isExternalMcpToolCall already verified the prefix exists + alias
        // matches an enabled entry — assertion is structural, not validation.
        if (!stripped) {
          throw new Error(
            `runMcpToolLoop invariant: isExternalMcpToolCall passed but stripPrefix returned null for "${block.name}"`,
          );
        }
        const { alias, toolName } = stripped;
        try {
          // block.input is already a parsed object (canonical schema enforces
          // record<string, unknown> — see CanonicalRequestSchema line 72).
          // No JSON.parse needed — that conversion happened at the inbound
          // translator (openai-in.ts toolCallsToToolUseBlocks).
          const result = await opts.registry.callTool(alias, toolName, block.input);
          opts.metrics.routerMcpToolCallsExternalTotal.inc({
            server_alias: alias,
            status_class: 'success',
          });
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          // Surface tool failure to the model as a tool_result with an
          // error payload + is_error:true. The model can choose to retry,
          // adapt, or give up. This is graceful-recovery (RESEARCH §Pattern
          // 4 lines 508-512).
          opts.metrics.routerMcpToolCallsExternalTotal.inc({
            server_alias: alias,
            status_class: 'server_error',
          });
          opts.log.warn(
            { alias, tool: toolName, err: String(err), event: 'mcp_tool_call_failed' },
            `external MCP tool call ${alias}__${toolName} failed`,
          );
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify({ error: String(err) }),
            is_error: true,
          };
        }
      }),
    );

    // Build the assistant turn that emitted the tool calls + a single user
    // turn carrying every tool_result block (Anthropic's wire shape — see
    // translation/openai-in.ts lines 348-356 for the collapse rule).
    const assistantTurn: CanonicalMessage = {
      role: 'assistant',
      content: resp.content as ContentBlock[],
    };
    const toolReplyTurn: CanonicalMessage = {
      role: 'user',
      content: toolResultBlocks,
    };

    canonical = {
      ...canonical,
      messages: [...canonical.messages, assistantTurn, toolReplyTurn],
    };

    // Next adapter call — abort signal threads through per BackendAdapter contract.
    resp = await opts.adapter.chatCompletionsCanonical(canonical, opts.signal);
  }

  // Cap firing: the loop body ran MCP_TOOL_LOOP_MAX times AND the resulting
  // response STILL has external tool calls pending — we refuse to take an
  // 11th iteration. Throw the structured error (502 via envelope mapper).
  if (iter >= MCP_TOOL_LOOP_MAX && externalToolUses(resp).length > 0) {
    opts.log.warn(
      { iter, event: 'mcp_tool_loop_exceeded' },
      `MCP tool-call loop hit cap of ${MCP_TOOL_LOOP_MAX} iterations`,
    );
    throw new McpToolLoopExceededError(MCP_TOOL_LOOP_MAX);
  }

  return resp;
}
