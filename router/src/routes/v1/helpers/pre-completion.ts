/**
 * pre-completion.ts — Phase 18 (v0.11.0 — MCPC-01..06 + RETR-02..06).
 *
 * Shared helper used by /v1/chat/completions, /v1/messages, and /v1/responses
 * to implement the "pre-completion hook chain + MCP external tool injection"
 * block in a single insertion shape (18-PATTERNS line 323 — "the single change
 * shape repeated three times"; mirrors Phase 17 helpers/session-attach.ts).
 *
 * Inserted in each route IMMEDIATELY after the Phase 17 session-attach block,
 * BEFORE the adapter call (chat-completions / responses) or BEFORE the
 * adapter call AFTER anthropicRequestToCanonical (messages). The fenced
 * <retrieved_context> content lands in canonical.system (NOT canonical.messages —
 * CTXP-03 BLOCK invariant carried over from Phase 17).
 *
 * STATELESS + SIDE-EFFECT-FREE wrt to its inputs EXCEPT for:
 *   - reply.header('X-Hook-Error', ...) on fail-open  (Pitfall 17-D analog:
 *     stamp header BEFORE reply.send/reply.sse so it lands in the response).
 *   - (req as { hookLog }).hookLog = hook_log  (stashed for recordOutcome →
 *     request_log.hook_log JSONB column — RETR-04).
 *
 * Decisions resolved (Phase 18):
 *   - #4: MCP tool injection runs on NON-STREAM only (stream path's tool-call
 *     emission stays Phase 16 wire-correct, no loop). The mcpToolLoopEnabled
 *     return field is the gate for the route handler's runMcpToolLoop wrap.
 *   - #7: X-Hook-Error header value format: `<hook_name>:<reason>` literal.
 *     Helper uses `:timeout` (the only reason that fires fail-open today).
 *   - #10: USER-PROVIDED tools have priority — appended FIRST in canonical.tools;
 *     MCP tools appended AFTER. The model resolves the dispatch by name.
 *
 * Non-fatal degradation paths (P2-01 carry-over from registry.ts):
 *   - MCP tools/list throw → warn log + skip THAT alias's tools. Request
 *     proceeds without those tools. Different from fail-closed on hook —
 *     hooks have configurable on_timeout; MCP tools/list is always non-fatal
 *     because the model can still answer without the augmented tools.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Histogram } from 'prom-client';
import type {
  CanonicalRequest,
  CanonicalTool,
} from '../../../translation/canonical.js';
import type { ModelEntry } from '../../../config/registry.js';
import type { McpClientRegistry } from '../../../mcp/client/registry.js';
import type {
  PreCompletionHook,
  HookLogEntry,
} from '../../../hooks/pre-completion.js';
import { runHookChain } from '../../../hooks/pre-completion.js';

// Fastify module augmentation: stash the hook audit on the request so
// recordOutcome (Plan 18-02 migration 0007 → request_log.hook_log JSONB)
// can persist it after the route handler finishes. Single declaration site
// for the field — same pattern as middleware/sessionId.ts:40-49 for sessionId.
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Phase 18 (v0.11.0 — RETR-04): pre-completion hook audit entries —
     * stashed by `runPreCompletionAndInjectMcpTools` so `recordOutcome` can
     * persist them to request_log.hook_log JSONB. SHA256-hashed content
     * only (P5-05) — never the full retrieved text.
     */
    hookLog?: HookLogEntry[];
  }
}

/**
 * The 3 routes that consume this helper. Used as the Map key for
 * `BuildAppOpts.preCompletionHooks` so each route can register a distinct
 * hook chain (or share them via the same Map value).
 */
export type Phase18RouteKey =
  | '/v1/chat/completions'
  | '/v1/messages'
  | '/v1/responses';

/**
 * Minimal narrowed slice of `MetricsRegistry` consumed by `runHookChain`.
 * Mirrors the pattern in chat-completions.ts:140-148 (`metrics?: { jsonValidationTotal }`),
 * keeping test injection cheap: tests pass a hand-rolled histogram without
 * rebuilding the full prom-client registry.
 */
export interface RunPreCompletionMetrics {
  routerHookDurationMs: Histogram<'hook_name' | 'status'>;
}

export interface RunPreCompletionAndInjectMcpToolsOpts {
  /** Map key into `BuildAppOpts.preCompletionHooks`. */
  routeKey: Phase18RouteKey;
  /** Phase 18 (v0.11.0 — RETR-02/03): per-route hook map. Absent → no hooks fire. */
  preCompletionHooks?: Map<string, PreCompletionHook[]>;
  /** Phase 18 (v0.11.0 — MCPC-01): MCP client registry. Absent → no MCP tools injected. */
  mcpClientRegistry?: McpClientRegistry;
  /** Histogram for hook duration observation (runHookChain consumes inside). */
  metrics: RunPreCompletionMetrics;
}

export interface RunPreCompletionAndInjectMcpToolsResult {
  /**
   * Possibly-mutated canonical: `system` field appended with fenced retrieved
   * content by runHookChain (when any hook fired and produced content);
   * `tools[]` appended with prefixed MCP tools (when mcpToolLoopEnabled holds).
   * Messages are NEVER touched (CTXP-03 BLOCK).
   */
  canonical: CanonicalRequest;
  /** Hook audit entries — also stashed on `req.hookLog` for recordOutcome. */
  hook_log: HookLogEntry[];
  /**
   * True when ALL three conditions hold:
   *   - entry.mcp_servers_enabled has at least one alias AND
   *   - opts.mcpClientRegistry was supplied AND
   *   - canonical.stream is falsy (Phase 18 RESOLVED #4 — non-stream only) AND
   *   - at least one tool was successfully fetched from the enabled aliases.
   *
   * The route handler MUST wrap its non-stream adapter call in `runMcpToolLoop()`
   * when this returns true; otherwise call the adapter directly.
   */
  mcpToolLoopEnabled: boolean;
}

/**
 * Run the pre-completion hook chain, then inject external MCP tools into
 * canonical.tools when applicable. See file header for invariants.
 *
 * @param req         FastifyRequest — passed to runHookChain so each hook's
 *                    buildRequest() can read request-scoped state. Also the
 *                    target of the hookLog stash for recordOutcome.
 * @param reply       FastifyReply — used to stamp `X-Hook-Error` on fail-open.
 *                    The header MUST be set BEFORE reply.send/reply.sse (see
 *                    project memory project_fastify_onsend_timing.md).
 * @param canonical   The post-ContextProvider, pre-adapter canonical request.
 *                    Helper does NOT mutate the input; returns a possibly
 *                    new canonical via spread.
 * @param entry       The resolved registry entry — read for
 *                    `mcp_servers_enabled` (Plan 18-02 schema widening).
 * @param opts        See `RunPreCompletionAndInjectMcpToolsOpts`.
 * @returns           `{ canonical, hook_log, mcpToolLoopEnabled }`.
 *                    Throws `HookTimeoutError` ONLY when a hook with
 *                    `on_timeout: 'fail-closed'` times out (runHookChain
 *                    decides; helper just propagates).
 */
export async function runPreCompletionAndInjectMcpTools(
  req: FastifyRequest,
  reply: FastifyReply,
  canonical: CanonicalRequest,
  entry: ModelEntry,
  opts: RunPreCompletionAndInjectMcpToolsOpts,
): Promise<RunPreCompletionAndInjectMcpToolsResult> {
  // ── 1. Pre-completion hook chain (RETR-02 — fires AFTER ContextProvider, BEFORE adapter) ──
  const hooks = opts.preCompletionHooks?.get(opts.routeKey) ?? [];
  const {
    canonical: canonicalAfterHooks,
    hook_log,
    fail_open_signaled,
    fail_open_hook_name,
  } = await runHookChain(req, canonical, hooks, opts.metrics);

  if (fail_open_signaled && fail_open_hook_name) {
    // Pitfall 17-D analog: stamp X-Hook-Error BEFORE reply.send/reply.sse.
    // Fastify v5 onSend fires sync inside reply.send; setting headers AFTER
    // is a no-op. RESOLVED #7 format: `<hook_name>:<reason>`. Only fail-open
    // reaches here (fail-closed throws inside runHookChain), so the reason
    // is structurally `timeout` for v0.11.0.
    void reply.header('X-Hook-Error', `${fail_open_hook_name}:timeout`);
  }

  // ── 2. MCP external tool injection (MCPC-03 — alias-prefixed) ──
  // mcp_servers_enabled is declared on ModelEntry (Plan 18-02). When the entry
  // does not enable any MCP server, OR the registry isn't wired, OR the request
  // is streaming, skip injection entirely. RESOLVED #4: stream path keeps
  // Phase 16 wire-correct behavior — no tool loop.
  let finalCanonical = canonicalAfterHooks;
  let mcpToolLoopEnabled = false;
  const enabledAliases = entry.mcp_servers_enabled ?? [];

  if (
    enabledAliases.length > 0 &&
    opts.mcpClientRegistry &&
    !finalCanonical.stream
  ) {
    const injectedTools: CanonicalTool[] = [];
    for (const alias of enabledAliases) {
      try {
        const tools = await opts.mcpClientRegistry.getOrFetchTools(alias);
        injectedTools.push(...tools);
      } catch (err) {
        // P2-01 carry-over: external MCP server unreachable at request time
        // → warn log + skip THIS alias. The request continues without those
        // tools — the model can still answer (degradation, not failure).
        req.log.warn(
          { alias, err: String(err), event: 'mcp_tools_fetch_failed' },
          `MCP tools/list failed for alias "${alias}" — proceeding without its tools`,
        );
      }
    }
    if (injectedTools.length > 0) {
      // RESOLVED #10: USER tools first (priority), MCP tools appended after.
      finalCanonical = {
        ...finalCanonical,
        tools: [...(finalCanonical.tools ?? []), ...injectedTools],
      };
      mcpToolLoopEnabled = true;
    }
  }

  // ── 3. Stash hook_log on req for recordOutcome → request_log.hook_log JSONB ──
  req.hookLog = hook_log;

  return {
    canonical: finalCanonical,
    hook_log,
    mcpToolLoopEnabled,
  };
}
