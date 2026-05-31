/**
 * Phase 15 Plan 10 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-10) —
 * MCP tool registration for `list_models`.
 *
 * Wave-4 sibling of:
 *   - tools/chat-completion.ts (15-06)
 *   - tools/create-response.ts (15-07)
 *   - tools/create-embedding.ts (15-08)
 *   - tools/rerank.ts          (15-09)
 *
 * Unlike its four siblings, `list_models` is a READ-ONLY registry projection.
 * It does not:
 *   - Translate to canonical
 *   - Call an adapter / backend
 *   - Push a request_log row (no backend touched → no row to log; D-05 only
 *     applies to backend-touching calls — verified against 15-CONTEXT.md and
 *     the plan's `must_haves.truths[5]`).
 *
 * It STILL:
 *   - Increments the dedicated `routerMcpToolCallsTotal` counter (D-07) for
 *     observability of the MCP surface (operators want to see "how many
 *     list_models calls am I getting?" without correlating against
 *     request_log).
 *   - Observes `requestDurationSeconds` with `backend='none'` /
 *     `model='none'` so the histogram shape stays consistent across MCP tool
 *     calls.
 *
 * D-10 (filter + annotation):
 *   1. Read `policies.default.model_allowlist` from the registry snapshot.
 *   2. If non-empty, only entries whose `name` is in the allowlist appear.
 *   3. Each emitted entry carries `policy: { cloud_allowed }` (defaults to
 *      true when the entry has no policy block) so consumers know
 *      operational constraints up front.
 *
 * T-3-A2 (anti-leak preservation):
 *   The projection lists each public field EXPLICITLY. There is no spread
 *   of `ModelEntry`, so `backend`, `backend_url`, `backend_model`, and
 *   `vram_budget_gb` are structurally impossible to leak. This mirrors the
 *   HTTP route projection in `router/src/routes/v1/models.ts`.
 *
 * Description shown in tools/list:
 *   "Returns the policy-filtered set of models available via the router,
 *    with cloud_allowed annotation per entry. Backend identity is hidden."
 *
 * Plan 15-11 mirrors the same filter + annotation onto the HTTP
 * `/v1/models` + `/v1/models/:id` routes so HTTP and MCP share a single
 * projection lens.
 *
 * Tests: `router/tests/unit/mcp/host/tools/list-models.test.ts` (7 cases).
 */
import { performance } from 'node:perf_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';

import {
  toOpenAIErrorEnvelope,
  NO_ENVELOPE,
} from '../../../errors/envelope.js';
import type { McpHostOpts } from '../plugin.js';

/**
 * MCP tool result envelope shape — content + optional structuredContent +
 * isError. Matches the spec revision 2025-06+ dual-shape contract referenced
 * in 15-CONTEXT D-02. Local mirror of the same shape declared in the other
 * 4 tools — kept private so each tool stays independently evolvable.
 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Description shown in tools/list. Documents the no-input contract +
 * cloud_allowed annotation + T-3-A2 anti-leak. Keep concise — MCP clients
 * render this in tool-picker UIs.
 */
const TOOL_DESCRIPTION =
  'Returns the policy-filtered set of models available via the router, ' +
  'with cloud_allowed annotation per entry. Backend identity is ' +
  'intentionally hidden (T-3-A2). No input parameters in v0.11.0.';

/**
 * Empty raw shape. The MCP SDK 1.29.0 (`server/mcp.js:842-855`) accepts an
 * `inputSchema` that is EITHER:
 *   (a) a Zod schema instance (`_zod` / `_def`-bearing), OR
 *   (b) a "raw shape" — a plain object whose values are Zod schemas.
 * An empty object `{}` is explicitly accepted as a valid raw shape with no
 * fields (the SDK comment: "Empty objects are valid raw shapes (tools with
 * no parameters)"). When the SDK converts `{}` to JSON Schema for the
 * `tools/list` wire surface it yields `{ type: 'object', properties: {},
 * additionalProperties: false }` — exactly the contract this tool wants.
 *
 * v0.11.0 does NOT expose pagination / filter args (MCPS-FUT-02 — deferred).
 */
const EMPTY_INPUT_SHAPE = {} as const;

export function registerListModelsTool(
  server: McpServer,
  deps: McpHostOpts,
  capturedReq: FastifyRequest,
): void {
  // The SDK's `registerTool` is overloaded on the (Zod-shape | AnySchema) arg.
  // For list_models we pass the empty raw shape `{}` (SDK accepts as "no
  // params" — see EMPTY_INPUT_SHAPE comment above). Cast through `unknown`
  // to a permissive signature so the typechecker still verifies the args +
  // return shape of our handler. `.bind(server)` preserves the `this`
  // context the SDK method expects.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    },
    handler: (
      args: unknown,
      extra: {
        signal: AbortSignal;
        sessionId?: string;
        requestId?: string | number | null;
      },
    ) => Promise<McpToolResult>,
  ) => void;

  register(
    'list_models',
    {
      title: 'List available models',
      description: TOOL_DESCRIPTION,
      // D-01 is "passthrough" in the other 4 tools (Zod schema → JSON Schema).
      // For list_models the contract is "no input params" — passing the
      // empty raw shape `{}` is the SDK's canonical "no params" expression.
      // The SDK converts this to `{ type:'object', properties:{},
      // additionalProperties:false }` on the wire (mcp.js:842-855).
      inputSchema: EMPTY_INPUT_SHAPE,
    },
    async (_rawArgs, _extra) => {
      const t0 = performance.now();

      // D-08: per-tool-call child log line. Build off capturedReq.log (the
      // already-scoped pino child created by agentIdPreHandler on the outer
      // /mcp request). DO NOT reassign capturedReq.log — Pitfall-9 grep gate.
      const toolLog = capturedReq.log.child({
        tool_name: 'list_models',
        mcp_session_id: _extra.sessionId,
        mcp_request_id: _extra.requestId ?? null,
      });

      try {
        const reg = deps.registry.get();
        const created = deps.registry.getCreatedAtSec();

        // D-10 filter: empty/unset allowlist = allow-all. Same semantics as
        // policy/gate.ts:36 — single rule across surfaces.
        const allow = reg.policies?.default?.model_allowlist ?? [];
        const entries =
          allow.length === 0
            ? reg.models
            : reg.models.filter((m) => allow.includes(m.name));

        // T-3-A2 anti-leak: explicit field list — NO spread of ModelEntry.
        // backend / backend_url / backend_model / vram_budget_gb stay hidden.
        // D-10 annotation: policy.cloud_allowed defaults to true when the
        // entry has no policy block (Phase 14 default).
        const data = entries.map((m) => ({
          id: m.name,
          object: 'model' as const,
          created,
          owned_by: 'local-llms' as const,
          capabilities: m.capabilities,
          policy: { cloud_allowed: m.policy?.cloud_allowed ?? true },
        }));

        const stamp = `${data.length} models available`;
        const durationMs = performance.now() - t0;

        // D-07: dedicated MCP tool-call counter (5 tools × ~5 classes ≈ 25 series).
        // Read-only path → always 'success' on the happy branch.
        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: 'list_models',
          status_class: 'success',
        });
        // Keep the duration histogram shape consistent with the other 4 tools
        // (protocol='mcp'). backend / model are not meaningful for a registry
        // projection — use 'none' sentinels so PromQL filters can exclude.
        deps.metrics.requestDurationSeconds.observe(
          { protocol: 'mcp', backend: 'none', model: 'none' },
          durationMs / 1000,
        );

        toolLog.info(
          {
            count: data.length,
            allowlist_size: allow.length,
            latency_ms: Math.round(durationMs),
          },
          'mcp list_models tool ok',
        );

        return {
          content: [{ type: 'text' as const, text: stamp }],
          structuredContent: { object: 'list', data },
        };
      } catch (err) {
        // Read-only path — the only realistic failure mode is the registry
        // snapshot being null/undefined (impossible after boot) or a freak
        // exception inside `.map`. We still run the standard envelope path
        // so the wire shape stays consistent with the other tools.
        const caughtErr = err instanceof Error ? err : new Error(String(err));
        const env = toOpenAIErrorEnvelope(caughtErr);
        const errorPayload =
          env === NO_ENVELOPE
            ? {
                error: 'client_disconnect',
                code: 'client_disconnect',
                message: 'client disconnected',
              }
            : {
                error: env.error.type,
                code: env.error.code,
                message: env.error.message,
              };

        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: 'list_models',
          status_class: 'server_error',
        });

        toolLog.error(
          { err: caughtErr, code: errorPayload.code },
          'mcp list_models tool error',
        );

        return {
          content: [{ type: 'text' as const, text: errorPayload.message }],
          structuredContent: errorPayload,
          isError: true,
        };
      }
    },
  );
}
