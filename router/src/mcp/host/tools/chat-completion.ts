/**
 * Phase 15 (v0.11.0 — Plan 15-06 / MCPS-03 / MCPS-04) — `chat_completion` MCP tool.
 *
 * Wraps the existing OpenAI-compatible chat-completions canonical pipeline
 * (registry.resolve → applyPolicyGate → breaker.check → adapter call) and
 * exposes it as an MCP tool over the Streamable HTTP transport mounted by
 * Plan 15-05's plugin. The tool returns a dual-shape MCP result:
 *
 *   {
 *     content: [{ type: 'text', text: <joined assistant text> }],  // human stamp
 *     structuredContent: <full OpenAI ChatCompletion>,             // machine payload
 *   }
 *
 * On any thrown error the handler catches, runs `toOpenAIErrorEnvelope`, and
 * returns `{ ..., isError: true }` — the MCP wire never sees a JSON-RPC error
 * frame for tool-internal failures (MCPS-04). On client disconnect (the
 * APIUserAbortError → NO_ENVELOPE path) the handler emits a synthetic
 * `client_disconnect` payload — the MCP SDK discards the body after a session
 * close, but the payload is still well-formed for the rare case the abort
 * fired AFTER the handler returned but BEFORE the transport flushed.
 *
 * Decisions reflected in the code (from 15-CONTEXT.md):
 *   - D-01 (full Zod passthrough)       — `inputSchema: ChatCompletionRequestSchema`
 *                                         (Zod object). The SDK internally calls
 *                                         `toJsonSchemaCompat` when publishing
 *                                         `tools/list`; the wire output is
 *                                         equivalent to `z.toJSONSchema(...)`.
 *                                         The exported `JSON_SCHEMA_LOCK`
 *                                         constant captures that JSON Schema
 *                                         at module load — a drift between
 *                                         JSON_SCHEMA_LOCK and a freshly
 *                                         recomputed schema is the P1-03
 *                                         pitfall signal (asserted in tests).
 *   - D-02 / D-03 (dual-shape result)    — `content` carries the joined
 *                                         assistant text; `structuredContent`
 *                                         carries the OpenAI wire shape.
 *   - D-04 (envelope reuse on error)     — `toOpenAIErrorEnvelope(err)` →
 *                                         `{ error, code, message }` stamped
 *                                         into BOTH content + structuredContent.
 *   - D-05 (request_log per tool call)   — one `bufferedWriter.push(row)` with
 *                                         `protocol: 'mcp'` and `route: '/mcp'`.
 *   - D-06 (scoped IDs from outer HTTP)  — closes over `capturedReq` for
 *                                         tenant/project/agent/workload IDs.
 *   - D-07 (mcp tool counter)            — `routerMcpToolCallsTotal.inc({tool,status_class})`
 *                                         on EVERY tool call, plus reuse of
 *                                         `requestsTotal` + `requestDurationSeconds`.
 *   - D-08 (pino flat-key child)         — toolLog = capturedReq.log.child({
 *                                           tool_name, mcp_session_id, mcp_request_id })
 *                                         used for success/error log lines.
 *   - D-12 (silent stream coercion)      — `stream: false` is forced onto the
 *                                         canonical handed to the adapter, even
 *                                         when args.stream === true. The tool
 *                                         description documents this.
 *   - D-14 (abort propagation)           — `extra.signal` is attached to a
 *                                         fresh AbortController whose `.signal`
 *                                         is forwarded to `adapter.chatCompletionsCanonical`.
 *
 * NOT covered here (deferred per CONTEXT):
 *   - D-13 (MCP-level idempotency)       — `idempotency_key: null` on row.
 *   - Streaming via MCP progress notifications (MCPS-FUT).
 *   - Per-tool tenant/agent override (would re-open D-01).
 *
 * Tests: `router/tests/unit/mcp/host/tools/chat-completion.test.ts`.
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';
import { ChatCompletionRequestSchema } from '../../../routes/v1/chat-completions.js';
import { openAIRequestToCanonical } from '../../../translation/openai-in.js';
import { canonicalToOpenAIResponse } from '../../../translation/openai-out.js';
import {
  BreakerOpenError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
} from '../../../errors/envelope.js';
import { applyPreflight } from '../../../dispatch/preflight.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  truncateAndRedact,
} from '../../../metrics/recordOutcome.js';
import { computeCostCents } from '../../../cost/computeCostCents.js';
import type { CanonicalResponse } from '../../../translation/canonical.js';
import type { McpHostOpts } from '../plugin.js';

/**
 * P1-03 drift detection lock. Computed once at module load; the unit test
 * (`Test 1` in chat-completion.test.ts) re-runs `z.toJSONSchema(ChatCompletionRequestSchema)`
 * and asserts deep-equality. Any divergence between the live route schema and
 * this captured snapshot — which would imply the route schema changed without
 * rebuilding the tool module — surfaces as a test failure.
 *
 * The SDK invokes `toJsonSchemaCompat(...)` internally when publishing
 * `tools/list`, producing an equivalent JSON Schema 2020-12 object to what
 * `z.toJSONSchema(ChatCompletionRequestSchema)` yields. Exporting this lock
 * AND passing the Zod schema to `registerTool` therefore satisfies both:
 *   1. The MCP SDK's runtime requirement (`inputSchema must be a Zod schema
 *      or raw shape` — verified at node_modules/@modelcontextprotocol/sdk/.../mcp.js:868).
 *   2. The plan's P1-03 drift gate (`z.toJSONSchema(ChatCompletionRequestSchema)`
 *      appears literally in the file and is asserted by the test matrix).
 */
export const JSON_SCHEMA_LOCK = z.toJSONSchema(ChatCompletionRequestSchema);

/**
 * Joins all `type: 'text'` content blocks from a canonical response into a
 * single human-readable string. Tool-use blocks are ignored — the dual-shape
 * `structuredContent` carries the full tool_calls payload for agents that need
 * it. Used to populate the MCP `content[0].text` stamp (D-03).
 */
function extractAssistantText(response: CanonicalResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Default cooldown (seconds) advertised in BreakerOpenError when applyPreflight
 * reports `breakerState === 'open'`. HTTP routes derive this from
 * `env.CIRCUIT_COOLDOWN_MS`; MCP tool handlers do not have a Retry-After
 * header to set (the MCP error envelope alone carries the hint), so we use
 * the same 60-second default the HTTP routes resolve to in zero-config
 * deployments.
 */
const MCP_BREAKER_COOLDOWN_SEC = 60;

/**
 * Register the `chat_completion` MCP tool on `server`.
 *
 * The tool's handler:
 *   1. Runs the shared preflight (`applyPreflight`) so registry resolution
 *      + policy gate + breaker check are byte-identical to the HTTP route.
 *   2. Coerces `stream: false` (D-12) before translating to canonical.
 *   3. Calls `deps.makeAdapter(entry).chatCompletionsCanonical(canonical, signal)`.
 *   4. Returns the dual-shape MCP result on success, or `isError:true` on any
 *      thrown failure.
 *   5. In a `finally` block, pushes one `request_log` row + increments
 *      observability metrics (D-05 / D-07).
 *
 * `capturedReq` is the originating Fastify request from the MCP session's
 * initialize call. Tool handlers close over it to read scoped IDs (D-06)
 * for every tool call on this session.
 */
export function registerChatCompletionTool(
  server: McpServer,
  deps: McpHostOpts,
  capturedReq: FastifyRequest,
): void {
  server.registerTool(
    'chat_completion',
    {
      title: 'OpenAI-compatible chat completion',
      description:
        'OpenAI-compatible chat completion. ' +
        'Streaming via MCP is NOT supported in v0.11.0 — set stream:false or omit. ' +
        'If stream:true is passed it is silently coerced to false and the full response ' +
        'returns in structuredContent. Use HTTP POST /v1/chat/completions directly for SSE.',
      // D-01 passthrough: the Zod schema IS the input contract — the SDK
      // converts to JSON Schema for tools/list emission. The drift gate lives
      // in JSON_SCHEMA_LOCK above; the literal call site is preserved in
      // module-load scope so the codebase grep `z.toJSONSchema(ChatCompletionRequestSchema)`
      // returns 1 hit (P1-03 mitigation).
      inputSchema: ChatCompletionRequestSchema,
    },
    async (args, extra) => {
      const t0 = performance.now();

      // D-14 abort propagation: fresh AbortController whose .signal is handed
      // to the adapter. extra.signal is the MCP transport's signal (fires on
      // client disconnect, DELETE /mcp, or SIGTERM transport teardown). When
      // it aborts, the controller aborts, which propagates to the openai SDK
      // via undici and tears down the upstream TCP connection.
      const controller = new AbortController();
      const onExtraAbort = (): void => controller.abort();
      extra.signal.addEventListener('abort', onExtraAbort);

      // D-08 flat-key pino child. The MCP SDK exposes `sessionId` and
      // `requestId` on `extra`; the JSON-RPC `id` of the tool/call surfaces
      // as `extra.requestId` (the SDK uses the same field for HTTP request
      // id and JSON-RPC request id semantics here). NEVER assign back to
      // capturedReq.log — that would trip the Pitfall-9 grep gate.
      const toolLog = capturedReq.log.child({
        tool_name: 'chat_completion',
        mcp_session_id: extra.sessionId ?? null,
        mcp_request_id:
          extra.requestId !== undefined
            ? String(extra.requestId)
            : ((extra._meta?.progressToken ?? null) as string | null),
      });

      // Captured across try/catch/finally for the request_log row + metric
      // observation. `backend` + `model` default to 'unknown' when the
      // preflight itself throws (before entry is resolved).
      let backend = 'unknown';
      let model = 'unknown';
      let canonicalResp: CanonicalResponse | undefined;
      let caughtErr: Error | undefined;
      // `resolvedEntry` is captured so the finally block can call
      // `computeCostCents` without re-resolving from the registry.
      let resolvedEntry: Awaited<ReturnType<typeof applyPreflight>>['entry'] | undefined;

      try {
        // Shared preflight pipeline: registry.resolve → applyPolicyGate →
        // breaker.check. Throws RegistryUnknownModelError /
        // AllowlistViolationError / CloudNotAllowedError verbatim;
        // breaker state is returned (Option A sentinel — D-09 RESEARCH).
        const preflight = await applyPreflight(args.model, {
          registry: deps.registry,
          breaker: deps.breaker,
        });
        resolvedEntry = preflight.entry;
        backend = preflight.entry.backend;
        model = preflight.entry.name;

        if (preflight.breakerState === 'open') {
          // HTTP routes stamp Retry-After on the reply BEFORE throwing.
          // MCP has no equivalent header surface — the structured envelope
          // alone carries the back-off hint via BreakerOpenError.message.
          throw new BreakerOpenError(preflight.entry.backend, MCP_BREAKER_COOLDOWN_SEC);
        }

        // D-12 silent stream coercion. The canonical handed to the adapter
        // is ALWAYS non-stream regardless of args.stream. The `model` field
        // is remapped to entry.backend_model so the adapter calls the
        // upstream with the backend-side model id (parity with the HTTP
        // route at chat-completions.ts:215).
        const canonical = openAIRequestToCanonical({
          ...args,
          model: preflight.entry.backend_model,
          stream: false,
        });

        const adapter = deps.makeAdapter(preflight.entry);
        canonicalResp = await adapter.chatCompletionsCanonical(canonical, controller.signal);

        // D-02 / D-03 dual-shape result. `displayModel` passes the registry
        // name on the wire — matches HTTP route output at chat-completions.ts:851.
        const openAiResp = canonicalToOpenAIResponse(canonicalResp, {
          displayModel: preflight.entry.name,
        });
        const assistantText = extractAssistantText(canonicalResp);

        toolLog.info(
          {
            backend,
            model,
            tokens_in: canonicalResp.usage.input_tokens,
            tokens_out: canonicalResp.usage.output_tokens,
            latency_ms: Math.round(performance.now() - t0),
          },
          'mcp chat_completion tool ok',
        );

        return {
          content: [{ type: 'text' as const, text: assistantText }],
          // structuredContent is typed as `Record<string, unknown>` by the SDK
          // (CallToolResult schema — `z.ZodRecord<string, unknown>`). The
          // OpenAI ChatCompletion shape is a specific object literal type
          // WITHOUT an index signature; the cast through unknown bridges that
          // gap without losing field-name guarantees at the call site.
          structuredContent: openAiResp as unknown as Record<string, unknown>,
        };
      } catch (err) {
        caughtErr = err instanceof Error ? err : new Error(String(err));

        // D-04: reuse the existing OpenAI envelope mapping. The envelope's
        // {type, code, message} is then stamped into BOTH content[0].text
        // (human stamp) and structuredContent (machine payload).
        const env = toOpenAIErrorEnvelope(caughtErr);
        const isClientDisconnect = env === NO_ENVELOPE;
        const errorPayload = isClientDisconnect
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

        toolLog.error(
          { err: caughtErr, backend, model, code: errorPayload.code },
          'mcp chat_completion tool error',
        );

        return {
          content: [{ type: 'text' as const, text: errorPayload.message }],
          structuredContent: errorPayload,
          isError: true,
        };
      } finally {
        // Remove the extra.signal listener so we do not retain a closure
        // reference to the controller after the handler returns. Without
        // this, long-lived sessions accumulate listeners on `extra.signal`
        // even though each tool call has its own controller — minor leak
        // but cheap to fix.
        extra.signal.removeEventListener('abort', onExtraAbort);

        const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : 200;
        const statusClass = deriveStatusClass(httpStatus, controller.signal.aborted);
        const durationMs = performance.now() - t0;
        const tokensIn = canonicalResp?.usage.input_tokens;
        const tokensOut = canonicalResp?.usage.output_tokens;
        // Cost: skip when the model has no pricing OR we never resolved an
        // entry (preflight threw before assignment). `computeCostCents`
        // returns null for entries without `pricing`.
        const costCentsStr =
          !caughtErr && resolvedEntry && canonicalResp
            ? computeCostCents({
                entry: resolvedEntry,
                tokensIn: tokensIn,
                tokensOut: tokensOut,
              }) ?? undefined
            : undefined;

        // D-07 metric observations. Labels match the existing HTTP route
        // surface (protocol/backend/model/status_class) so dashboards can
        // group across protocols. The dedicated mcp counter
        // (routerMcpToolCallsTotal) gives the per-tool breakdown.
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
        if (typeof tokensOut === 'number' && tokensOut > 0) {
          deps.metrics.tokensTotal.inc(
            { protocol: 'mcp', backend, model, direction: 'output' },
            tokensOut,
          );
        }
        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: 'chat_completion',
          status_class: statusClass,
        });

        // D-05 / D-06: one request_log row per tool call, protocol='mcp',
        // route='/mcp', scoped IDs from capturedReq (the outer HTTP
        // initialize request). The shape mirrors the OutcomeContext field
        // map at recordOutcome.ts:262-296 — we use the schema's snake_case
        // field names directly because we push to bufferedWriter rather
        // than going through recordRequestOutcome (which expects the
        // OutcomeContext camelCase shape).
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
          ttft_ms: null, // non-stream by construction (D-12)
          latency_ms: Math.round(durationMs),
          error_code: caughtErr ? mapErrorToCode(caughtErr) : null,
          error_message: caughtErr ? truncateAndRedact(caughtErr.message) : null,
          agent_id: capturedReq.agentId ?? null,
          tenant_id: capturedReq.tenantId ?? null,
          project_id: capturedReq.projectId ?? null,
          workload_class: capturedReq.workloadClass ?? null,
          request_id: capturedReq.id,
          upstream_message_id: canonicalResp?.id ?? null,
          idempotency_key: null, // D-13: MCP-level idempotency is HTTP-only
          cost_cents: costCentsStr ?? null,
        });
      }
    },
  );
}
