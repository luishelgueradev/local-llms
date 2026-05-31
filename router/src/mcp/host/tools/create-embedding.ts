/**
 * Phase 15 Plan 08 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-01..D-14) —
 * `create_embedding` MCP tool handler.
 *
 * Wraps the existing /v1/embeddings adapter surface
 * (`router/src/backends/adapter.ts::embeddings`) and exposes it as an MCP tool
 * over Streamable HTTP. Phase 15's strategic frame: re-expose existing
 * capabilities through `/mcp`, do NOT add new behaviors.
 *
 * Dual-shape result (D-02 + D-03):
 *  - `content[0].text`: a single-line stamp
 *    `"embedded N inputs, dims=D, model=M"`.
 *  - `structuredContent`: the FULL OpenAI embeddings response (`object: 'list'`,
 *    `data: [{ embedding: number[] | string, index, object }]`, `model`,
 *    `usage`). The vector payload (potentially ~3 MB for a 1024×100 batch)
 *    rides ENTIRELY in `structuredContent` — never in `content[].text` per
 *    T-15-08-PAYLOAD.
 *
 * Why two shapes? D-02/D-03 keep cognitive consistency with the other four
 * MCP tools (chat_completion, create_response, rerank, list_models) — every
 * tool returns a small human-readable stamp + a full machine-readable payload.
 * Embedding-vector consumers parse `structuredContent.data[*].embedding`;
 * agents that just want to chain through the result read the stamp.
 *
 * Errors (D-04 / MCPS-04): every thrown error is caught and returned as
 * `{ isError: true, content, structuredContent: { error, code, message } }`
 * via `toOpenAIErrorEnvelope`. JSON-RPC errors are NEVER raised — the
 * structured `isError` envelope is the wire shape per MCP spec rev 2025-06+.
 *
 * Observability (D-05/D-06/D-07): one bufferedWriter row per tool call with
 * `protocol: 'mcp'` + scoped IDs (`tenant_id`, `project_id`, `agent_id`,
 * `workload_class`, `request_id`) closed-over from `capturedReq`. The
 * `router_mcp_tool_calls_total{tool, status_class}` counter increments on
 * both success and error paths. `requestsTotal` / `requestDurationSeconds`
 * receive the same observation under `protocol: 'mcp'` so HTTP dashboards
 * pick up MCP traffic uniformly.
 *
 * Abort propagation (D-14): a fresh AbortController is created per tool call;
 * `extra.signal.addEventListener('abort', …)` wires the MCP transport's
 * cancel signal into `controller.abort()`. The adapter receives
 * `controller.signal` — when the MCP client disconnects, upstream embed
 * computation is cancelled cleanly (mirrors HTTP route pattern).
 *
 * Pino child for per-tool-call log lines (D-08): `toolLog = capturedReq.log
 * .child({ tool_name, mcp_session_id, mcp_request_id })`. Does NOT
 * reassign `req.log` (Pitfall-9 grep gate stays at 1 hit).
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';

import { EmbeddingsRequestSchema } from '../../../routes/v1/embeddings.js';
import { applyPreflight } from '../../../dispatch/preflight.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
  NO_ENVELOPE,
} from '../../../errors/envelope.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  truncateAndRedact,
} from '../../../metrics/recordOutcome.js';
import { computeCostCents } from '../../../cost/computeCostCents.js';
import type { McpHostOpts } from '../plugin.js';

/**
 * Default cooldown when the breaker is sentinel-open from inside an MCP tool
 * call. HTTP routes stamp Retry-After from `opts.breakerCooldownSec`; MCP has
 * no Retry-After surface so the structured error message carries the value.
 * Matches the default used by chat-completion / create-response tool plans.
 */
const MCP_BREAKER_COOLDOWN_SEC = 60;

/**
 * MCP tool result envelope shape — content + optional structuredContent + isError.
 * Matches the spec revision 2025-06+ dual-shape contract referenced in CONTEXT D-02.
 * (Local mirror of the same shape declared in `create-response.ts` — kept private
 * so each tool stays independently evolvable.)
 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function registerCreateEmbeddingTool(
  server: McpServer,
  deps: McpHostOpts,
  capturedReq: FastifyRequest,
): void {
  // The SDK's `registerTool` is overloaded on the (Zod-shape | AnySchema) arg —
  // passing a plain JSON-Schema object (the `z.toJSONSchema` output) is
  // semantically what the spec asks for (the wire surface for `tools/list`
  // expects a JSON-Schema document) but is outside the SDK's parameter type
  // taxonomy. Cast through `unknown` to a permissive signature so the
  // typechecker still verifies the args + return shape of our handler.
  // `.bind(server)` preserves the `this` context the SDK method expects.
  // Plans 15-07 / 15-09 use the same shape.
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
    'create_embedding',
    {
      title: 'OpenAI-compatible embeddings',
      description:
        'OpenAI-compatible embeddings. Returns the full vector payload in ' +
        'structuredContent; the text content carries a one-line stamp ' +
        '("embedded N inputs, dims=D, model=M"). No MCP streaming.',
      // D-01 (P1-03 mitigation): the tool's input shape IS the route's Zod
      // schema, converted to JSON Schema 2020-12 at registration time. Any
      // future evolution of EmbeddingsRequestSchema propagates here for free.
      inputSchema: z.toJSONSchema(EmbeddingsRequestSchema) as Record<string, unknown>,
    },
    async (rawArgs, extra) => {
      // Per-tool-call structured log lineage (D-08). Detached child — does NOT
      // reassign capturedReq.log (Pitfall-9 grep gate enforced at 1 site).
      const toolLog = capturedReq.log.child({
        tool_name: 'create_embedding',
        mcp_session_id: extra.sessionId,
        mcp_request_id: extra.requestId ?? null,
      });

      // The SDK's ToolCallback signature passes `args` as the parsed
      // JSON-Schema shape; we trust the schema (D-01) and parse defensively
      // through EmbeddingsRequestSchema so downstream code receives the
      // strict TypeScript shape (and so any odd JSON-RPC client that bypasses
      // the schema validator still fails closed at this boundary).
      const args = EmbeddingsRequestSchema.parse(rawArgs);

      const t0 = performance.now();
      // D-14 abort propagation: bridge MCP transport cancel → adapter signal.
      const controller = new AbortController();
      extra.signal.addEventListener('abort', () => controller.abort());

      let backend = 'unknown';
      let model = 'unknown';
      let entryRef: Awaited<ReturnType<typeof applyPreflight>>['entry'] | undefined;
      let resp: Awaited<ReturnType<NonNullable<ReturnType<typeof deps.makeAdapter>['embeddings']>>> | undefined;
      let caughtErr: Error | undefined;

      try {
        // D-09 shared preflight: resolve → applyPolicyGate → breaker.check.
        // Throws RegistryUnknownModelError / AllowlistViolationError /
        // CloudNotAllowedError on policy violations (which never touch the
        // breaker counter — POL-05 invariant preserved by helper).
        const { entry, breakerState } = await applyPreflight(args.model, {
          registry: deps.registry,
          breaker: deps.breaker,
        });
        entryRef = entry;
        backend = entry.backend;
        model = entry.name;

        // Sentinel-open: HTTP routes stamp Retry-After before throwing; MCP
        // surfaces the cooldown via the error envelope message only (no
        // header context in JSON-RPC results).
        if (breakerState === 'open') {
          throw new BreakerOpenError(entry.backend, MCP_BREAKER_COOLDOWN_SEC);
        }

        // Defense-in-depth capability gate (D-09 stays per-tool). The HTTP
        // route's gate is at routes/v1/embeddings.ts:240 — the same check
        // here ensures a chat-only model used via MCP returns the canonical
        // model_capability_mismatch error.
        if (!entry.capabilities.includes('embeddings')) {
          throw new CapabilityNotSupportedError(entry.name, 'embeddings');
        }

        // Normalize input shape: route schema accepts string | string[].
        // The adapter accepts either, but the route normalizes for cache
        // bookkeeping (Phase 12 EMB-H01). MCP does not run the cache —
        // following the simpler path used by the adapter's typing.
        const adapterInput: string | string[] = Array.isArray(args.input)
          ? args.input
          : args.input;

        const adapter = deps.makeAdapter(entry);
        resp = await adapter.embeddings(
          adapterInput,
          entry.backend_model,
          controller.signal,
          {
            // Forward the optional OpenAI EmbeddingCreateParams that the
            // schema validates (07-REVIEW CR-01 parity with HTTP route).
            encoding_format: args.encoding_format,
            dimensions: args.dimensions,
            user: args.user,
          },
        );
        // Fire-and-forget breaker success signal — same pattern as HTTP route.
        void deps.breaker.recordSuccess(entry.backend);

        // D-03 stamp build. `dims` reads the first embedding's length when
        // the adapter returned vectors as `number[]`. When the wire shape is
        // `string` (base64), the dims label falls back to 0 — the stamp
        // remains a single line and downstream consumers read dims from the
        // structuredContent payload directly when they need precision.
        const n = resp.data.length;
        const firstEmbedding = resp.data[0]?.embedding;
        const dims = Array.isArray(firstEmbedding) ? firstEmbedding.length : 0;
        const stamp = `embedded ${n} inputs, dims=${dims}, model=${resp.model}`;

        return {
          content: [{ type: 'text' as const, text: stamp }],
          structuredContent: resp as unknown as Record<string, unknown>,
        };
      } catch (err) {
        caughtErr = err instanceof Error ? err : new Error(String(err));
        // Fire-and-forget breaker failure signal (skip the breaker's own
        // BreakerOpenError to avoid recursive trip — mirrors HTTP route).
        if (entryRef && !(caughtErr instanceof BreakerOpenError)) {
          void deps.breaker.recordFailure(entryRef.backend, caughtErr);
        }

        // D-04: reuse OpenAI envelope mapper. NO_ENVELOPE (client-disconnect)
        // surfaces as the dedicated `client_disconnect` payload — distinct
        // from upstream errors so MCP consumers can filter on it.
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

        return {
          content: [{ type: 'text' as const, text: errorPayload.message }],
          structuredContent: errorPayload as unknown as Record<string, unknown>,
          isError: true,
        };
      } finally {
        // D-05/D-06/D-07: one request_log row + metric observations per call.
        const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : 200;
        const statusClass = deriveStatusClass(httpStatus, controller.signal.aborted);
        const durationMs = performance.now() - t0;
        const tokensIn = caughtErr ? undefined : resp?.usage.prompt_tokens ?? 0;
        // Embeddings have no output token concept; emit 0 (consistent with the
        // HTTP route at routes/v1/embeddings.ts:506) on success and undefined
        // on error so dashboards' SUM(tokens_out) treats this row honestly.
        const tokensOut = caughtErr ? undefined : 0;
        const costCents =
          !caughtErr && entryRef
            ? computeCostCents({ entry: entryRef, tokensIn, tokensOut }) ?? undefined
            : undefined;

        // D-07: shared HTTP/MCP histograms + counter on the {protocol, backend,
        // model} label triple, plus the dedicated MCP tool-call counter.
        deps.metrics.requestsTotal.inc({
          protocol: 'mcp',
          backend,
          model,
          status_class: statusClass,
        });
        deps.metrics.requestDurationSeconds.observe(
          { protocol: 'mcp', backend, model },
          durationMs / 1000,
        );
        if (typeof tokensIn === 'number' && tokensIn > 0) {
          deps.metrics.tokensTotal.inc(
            { protocol: 'mcp', backend, model, direction: 'input' },
            tokensIn,
          );
        }
        // tokens_out=0 → do NOT increment the counter (matches HTTP route's
        // recordOutcome pattern at metrics/recordOutcome.ts:257-259).
        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: 'create_embedding',
          status_class: statusClass,
        });

        // D-05/D-06: bufferedWriter row. protocol='mcp' is a new wire value
        // accepted by the TEXT NOT NULL column (no CHECK constraint — verified
        // 2026-05-31 against the request_log migration set). Scoped IDs
        // inherit from the outer /mcp HTTP request via capturedReq closure.
        deps.bufferedWriter.push({
          ts: new Date(),
          protocol: 'mcp',
          route: '/mcp',
          backend,
          model,
          status_class: statusClass,
          http_status: httpStatus,
          tokens_in: tokensIn ?? null,
          tokens_out: tokensOut ?? null,
          ttft_ms: null,
          latency_ms: Math.round(durationMs),
          error_code: caughtErr ? mapErrorToCode(caughtErr) : null,
          error_message: caughtErr
            ? truncateAndRedact(caughtErr.message)
            : null,
          agent_id: capturedReq.agentId ?? null,
          tenant_id: capturedReq.tenantId ?? null,
          project_id: capturedReq.projectId ?? null,
          workload_class: capturedReq.workloadClass ?? null,
          request_id: capturedReq.id,
          upstream_message_id: null,
          idempotency_key: null,
          cost_cents: costCents ?? null,
        });

        // Structured operator signal. Stays at info level — same as the
        // existing HTTP route observability volume.
        toolLog.info(
          {
            backend,
            model,
            status_class: statusClass,
            http_status: httpStatus,
            tokens_in: tokensIn,
            latency_ms: Math.round(durationMs),
            error_code: caughtErr ? mapErrorToCode(caughtErr) : undefined,
          },
          'mcp create_embedding tool call complete',
        );
      }
    },
  );
}
