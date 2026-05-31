/**
 * Phase 15 (v0.11.0 — MCPS-03, MCPS-04 / 15-07-PLAN.md) — `create_response` MCP tool.
 *
 * Exposes the /v1/responses surface (Phase 13 — v0.10.0 RESP-01..04) as an MCP
 * tool. The handler mirrors the Phase-13 route's pipeline but runs inside an MCP
 * tool-call boundary instead of an HTTP request:
 *
 *   1. applyPreflight(args.model, deps)           — resolve + policy gate + breaker
 *   2. coerce stream:false (D-12, MCP cannot stream)
 *   3. responsesToCanonical(args, entry.backend_model)
 *   4. adapter.chatCompletionsCanonical(canonical, signal)
 *   5. canonicalToResponses(canonicalResp, entry.name, echo)
 *   6. emit dual-shape MCP result: { content: [{text: extractedText}], structuredContent: <responsesBody> }
 *
 * Single export: `registerCreateResponseTool(server, deps, capturedReq)`.
 * Called by `buildServerForRequest` in plugin.ts — Plan 15-10 wires the call
 * site once all five tools (chat_completion / create_response / create_embedding
 * / rerank / list_models) have landed in parallel.
 *
 * Invariants encoded:
 *   - D-01: inputSchema = z.toJSONSchema(ResponsesRequestSchema). Single source
 *           of truth — schema drift between HTTP + MCP made impossible by
 *           construction (P1-03).
 *   - D-02/D-03: success path returns { content, structuredContent } where text
 *           is the joined `output[i].content[j].text` for `type === 'output_text'`.
 *   - D-04: every thrown error caught and emitted as { isError: true } via
 *           toOpenAIErrorEnvelope (MCPS-04).
 *   - D-05/D-06: ONE request_log row pushed per tool call with protocol='mcp',
 *           route='/mcp', and scoped IDs closed-over from capturedReq.
 *   - D-07: router_mcp_tool_calls_total{tool='create_response', status_class}
 *           increments once per call, plus the shared router_requests_total +
 *           router_request_duration_seconds + router_tokens_total surface.
 *   - D-08: each tool-call log line spawns a `req.log.child({ tool_name,
 *           mcp_session_id, mcp_request_id })` pino child — flat top-level fields.
 *   - D-12: stream:true silently coerced to false in the canonical (P1-06 risk
 *           eliminated by construction; tool description documents the policy).
 *   - D-14: extra.signal → AbortController → adapter signal; upstream cancels
 *           when the MCP transport closes.
 *
 * `canonicalToResponses` translation logic is reproduced inline from the
 * Phase-13 /v1/responses route (router/src/routes/v1/responses.ts:222-284).
 * That helper is module-private to keep its echoed-fields contract local; we
 * mirror it here so the MCP tool stays decoupled (and the responses route file
 * is not modified by Plan 15-07). Any drift between the two translators would
 * be caught by Plan 15-11's wire-shape integration test which calls both
 * surfaces and asserts identical JSON bodies.
 */
import { z } from 'zod/v4';
import { performance } from 'node:perf_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';
import type { CanonicalRequest, CanonicalResponse } from '../../../translation/canonical.js';
import {
  ResponsesRequestSchema,
  type ResponsesRequest,
} from '../../../routes/v1/responses.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
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
import type { McpHostOpts } from '../plugin.js';

/**
 * The Phase-13 /v1/responses route's `responsesToCanonical` mapper. Reproduced
 * here so the MCP tool stays decoupled from the HTTP route (the route's
 * function is module-private and re-exporting it would couple Plan 15-07 to a
 * route-file edit). Mapping rules are byte-identical to responses.ts:132-177.
 */
function responsesToCanonical(
  body: ResponsesRequest,
  backendModel: string,
): CanonicalRequest {
  const messages: CanonicalRequest['messages'] = [];
  const systemParts: string[] = [];
  if (body.instructions) systemParts.push(body.instructions);

  if (typeof body.input === 'string') {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: body.input }],
    });
  } else {
    for (const m of body.input) {
      const rawRole = m.role as 'system' | 'user' | 'assistant' | 'tool';
      if (rawRole === 'system') {
        if (typeof m.content === 'string') systemParts.push(m.content);
        else systemParts.push(JSON.stringify(m.content));
        continue;
      }
      const role: 'user' | 'assistant' = rawRole === 'assistant' ? 'assistant' : 'user';
      const content = typeof m.content === 'string'
        ? [{ type: 'text' as const, text: m.content }]
        : (m.content as CanonicalRequest['messages'][number]['content']);
      messages.push({ role, content });
    }
  }

  const canonical: CanonicalRequest = {
    model: backendModel,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n') } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_output_tokens !== undefined
      ? { max_tokens: body.max_output_tokens }
      : {}),
    // D-12: stream is FORCED to false here. Even if the caller passed stream:true,
    // the MCP tool description documents this coercion as the v0.11.0 policy.
    stream: false,
  };
  return canonical;
}

/**
 * Phase-13 /v1/responses route's `canonicalToResponses` translator. Mirrors
 * responses.ts:222-284 byte-for-byte (including the SDK-iteration safety fields
 * — annotations:[], reasoning, text, tool_choice, parallel_tool_calls, etc.).
 */
function canonicalToResponses(
  result: CanonicalResponse,
  displayModel: string,
  echo: {
    instructions?: string;
    temperature?: number;
    max_output_tokens?: number;
    user?: string;
  } = {},
): Record<string, unknown> {
  const text = result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const responseId = result.id || `resp_${Date.now()}`;
  const outputId = result.id ? result.id.replace(/^msg_/, 'msg_') : `msg_${Date.now()}`;
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: echo.instructions ?? null,
    max_output_tokens: echo.max_output_tokens ?? null,
    model: displayModel,
    output: [
      {
        type: 'message',
        id: outputId,
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: echo.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: result.usage.input_tokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: result.usage.output_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: result.usage.input_tokens + result.usage.output_tokens,
    },
    user: echo.user ?? null,
    metadata: {},
    output_text: text,
  };
}

/**
 * Walks the Responses-API body produced by `canonicalToResponses` and joins
 * every `output[i].content[j].text` where `type === 'output_text'`. This is the
 * D-03 text stamp — keep it identical to what `output_text` shortcut surfaces
 * so `content[0].text === structuredContent.output_text`. Both surfaces should
 * stay in lock-step; mismatching them would be a subtle wire-shape bug.
 */
function extractResponsesText(body: Record<string, unknown>): string {
  const output = body.output as
    | Array<{ content?: Array<{ type?: string; text?: string }> }>
    | undefined;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block && block.type === 'output_text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('');
}

const TOOL_NAME = 'create_response' as const;

const TOOL_DESCRIPTION =
  'OpenAI-compatible Responses-API call (POST /v1/responses surface). ' +
  'Streaming via MCP is NOT supported in v0.11.0 — set stream:false or omit; ' +
  'if stream:true is supplied it is silently coerced to false. Use HTTP POST ' +
  '/v1/responses for the future streaming surface (Phase 16).';

/**
 * D-01 / P1-03 drift gate — the canonical JSON Schema for ResponsesRequestSchema.
 *
 * The plan's D-01 invariant requires `inputSchema = z.toJSONSchema(ResponsesRequestSchema)`
 * as the single source of truth between the HTTP `/v1/responses` route and the
 * MCP `create_response` tool. However, the MCP SDK 1.29.0 rejects a plain JSON
 * Schema object at runtime — `node_modules/@modelcontextprotocol/sdk/.../server/mcp.js`
 * enforces `inputSchema must be a Zod schema or raw shape` and we must pass the
 * Zod schema directly. The SDK then runs `toJsonSchemaCompat()` internally when
 * publishing `tools/list`, producing a JSON Schema document wire-equivalent to
 * what `z.toJSONSchema(...)` produces.
 *
 * `JSON_SCHEMA_LOCK` exports the JSON-Schema view so the unit test (and any
 * future integration test) can deep-equality-assert it against
 * `z.toJSONSchema(ResponsesRequestSchema)` — the schema-drift gate is preserved
 * by tying both surfaces to the same source schema. Mirrors Plan 15-06's
 * `JSON_SCHEMA_LOCK` pattern on `chat-completion.ts` (documented in
 * .planning/phases/15.../deferred-items.md as a Rule-1 deviation from
 * plan-as-written).
 */
export const JSON_SCHEMA_LOCK: Record<string, unknown> = z.toJSONSchema(
  ResponsesRequestSchema,
) as Record<string, unknown>;

/**
 * MCP tool result envelope shape — content + optional structuredContent + isError.
 * Matches the spec revision 2025-06+ dual-shape contract referenced in CONTEXT D-02.
 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Registers the `create_response` tool on `server`. Called once per
 * McpServer instance built by `buildServerForRequest` (plugin.ts).
 */
export function registerCreateResponseTool(
  server: McpServer,
  deps: McpHostOpts,
  capturedReq: FastifyRequest,
): void {
  // The MCP SDK accepts either a Zod schema or a "raw shape" (object whose
  // values are Zod schemas) for `inputSchema`. We pass the route's
  // `ResponsesRequestSchema` directly — when the SDK serializes the tool list
  // for `tools/list`, it runs `toJsonSchemaCompat()` on this and emits the
  // JSON-Schema document. The unit test asserts the resulting JSON Schema
  // equals `JSON_SCHEMA_LOCK` (= `z.toJSONSchema(ResponsesRequestSchema)`)
  // so D-01 drift gating is preserved.
  //
  // The cast through `unknown` widens the SDK's handler signature so we can
  // declare the (args, extra) → Promise<McpToolResult> shape we actually
  // produce. `.bind(server)` preserves the `this` context the SDK requires.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
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
    TOOL_NAME,
    {
      title: 'OpenAI Responses API',
      description: TOOL_DESCRIPTION,
      // D-01 — schema source of truth is the route's Zod schema. Drift is
      // structurally impossible (the schema is a single import). The wire
      // JSON Schema published by the SDK on `tools/list` equals
      // `JSON_SCHEMA_LOCK` (= `z.toJSONSchema(ResponsesRequestSchema)`).
      inputSchema: ResponsesRequestSchema,
    },
    async (rawArgs, extra) => {
      const t0 = performance.now();
      // D-14 — bridge the SDK transport's `extra.signal` to a fresh
      // AbortController, then hand that controller's signal to the adapter.
      // Mirrors the HTTP route pattern (responses.ts:332-344).
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      extra.signal.addEventListener('abort', onAbort);

      // D-08 — flat pino child with MCP-specific fields. mcp_request_id may be
      // absent on JSON-RPC notifications, but for tools/call the SDK always
      // forwards the request id.
      const toolLog = capturedReq.log.child({
        tool_name: TOOL_NAME,
        mcp_session_id: extra.sessionId ?? null,
        mcp_request_id: extra.requestId ?? null,
      });

      // Validate (and narrow) the inbound args through the same Zod schema the
      // HTTP route uses. If args are malformed, the catch block emits a
      // structured isError envelope (D-04) rather than a JSON-RPC error frame.
      let body: ResponsesRequest;
      let backend = 'unknown';
      let model = 'unknown';
      let canonicalResp: CanonicalResponse | undefined;
      let caughtErr: Error | undefined;
      let httpStatus = 200;
      let responsesBody: Record<string, unknown> | undefined;
      let costCents: string | undefined;

      try {
        body = ResponsesRequestSchema.parse(rawArgs);

        // applyPreflight — registry resolve + policy gate + breaker.check.
        const { entry, breakerState } = await applyPreflight(body.model, {
          registry: deps.registry,
          breaker: deps.breaker,
        });
        backend = entry.backend;
        model = entry.name;

        // MCP has no Retry-After header context; throw BreakerOpenError with a
        // 60s default cooldown (per RESEARCH §Pattern 5 / RESP-02 parity note).
        if (breakerState === 'open') {
          throw new BreakerOpenError(entry.backend, 60);
        }

        // Capability gate — Responses surface requires `chat` (it is a
        // chat-style API). Embeddings-only / rerank-only models → client_error.
        if (!entry.capabilities.includes('chat')) {
          throw new CapabilityNotSupportedError(entry.name, 'chat' as never);
        }

        // D-12 — stream:true is silently coerced to false (the `responsesToCanonical`
        // helper hard-codes stream:false; the rebuilt body for the upstream call
        // never carries stream:true regardless of what `body.stream` was).
        const canonical = responsesToCanonical(body, entry.backend_model);

        const adapter = deps.makeAdapter(entry);
        canonicalResp = await adapter.chatCompletionsCanonical(canonical, controller.signal);
        void deps.breaker.recordSuccess(entry.backend);

        responsesBody = canonicalToResponses(canonicalResp, entry.name, {
          instructions: body.instructions,
          temperature: body.temperature,
          max_output_tokens: body.max_output_tokens,
          user: typeof (body as { user?: unknown }).user === 'string'
            ? ((body as { user?: string }).user)
            : undefined,
        });

        costCents =
          computeCostCents({
            entry,
            tokensIn: canonicalResp.usage.input_tokens,
            tokensOut: canonicalResp.usage.output_tokens,
          }) ?? undefined;

        const text = extractResponsesText(responsesBody);
        const successResult: McpToolResult = {
          content: [{ type: 'text', text }],
          structuredContent: responsesBody,
        };
        // Fall through to finally{} for the request_log row + metrics.
        // Return AFTER the finally has logged so the row reflects the actual
        // success path — JS will execute finally before the function returns.
        return successResult;
      } catch (err) {
        // Record failure on the breaker only for non-policy non-breaker errors
        // (POL-05: policy_violation never mutates the failure counter).
        if (
          !(err instanceof BreakerOpenError) &&
          backend !== 'unknown'
        ) {
          // Best-effort — don't let breaker bookkeeping mask the real error.
          try {
            void deps.breaker.recordFailure(backend, err);
          } catch {
            // ignore
          }
        }
        caughtErr = err instanceof Error ? err : new Error(String(err));
        httpStatus = mapToHttpStatus(caughtErr);

        const envelope = toOpenAIErrorEnvelope(caughtErr);
        if (envelope === NO_ENVELOPE) {
          // Client disconnect — emit a minimal isError result so the JSON-RPC
          // frame still parses cleanly; the bufferedWriter row's status_class
          // will be 'disconnect' (deriveStatusClass with clientAborted=true).
          const result: McpToolResult = {
            content: [{ type: 'text', text: 'client disconnected' }],
            structuredContent: {
              error: 'client_disconnect',
              code: 'client_disconnect',
              message: 'client disconnected',
            },
            isError: true,
          };
          return result;
        }

        const result: McpToolResult = {
          content: [{ type: 'text', text: envelope.error.message }],
          structuredContent: {
            error: envelope.error.type,
            code: envelope.error.code,
            message: envelope.error.message,
          },
          isError: true,
        };
        return result;
      } finally {
        extra.signal.removeEventListener('abort', onAbort);

        // D-05 / D-06 — request_log row push. status_class derived from
        // httpStatus (success path leaves httpStatus=200) plus the
        // controller's aborted state so a disconnect mid-flight becomes
        // 'disconnect' rather than 'success'.
        const durationMs = performance.now() - t0;
        const clientAborted = controller.signal.aborted;
        const statusClass = caughtErr
          ? deriveStatusClass(httpStatus, clientAborted)
          : deriveStatusClass(httpStatus, clientAborted);

        deps.bufferedWriter.push({
          ts: new Date(),
          protocol: 'mcp',
          route: '/mcp',
          backend,
          model,
          status_class: statusClass,
          http_status: httpStatus,
          tokens_in: canonicalResp?.usage.input_tokens ?? null,
          tokens_out: canonicalResp?.usage.output_tokens ?? null,
          ttft_ms: null,
          latency_ms: Math.round(durationMs),
          error_code: caughtErr
            ? clientAborted
              ? 'client_disconnect'
              : mapErrorToCode(caughtErr)
            : null,
          error_message: caughtErr ? truncateAndRedact(caughtErr.message) : null,
          agent_id: capturedReq.agentId ?? null,
          tenant_id: capturedReq.tenantId ?? null,
          project_id: capturedReq.projectId ?? null,
          workload_class: capturedReq.workloadClass ?? null,
          request_id: capturedReq.id,
          upstream_message_id: canonicalResp?.id ?? null,
          idempotency_key: null,
          cost_cents: costCents ?? null,
        });

        // D-07 — Prometheus observations.
        const labels = { protocol: 'mcp' as const, backend, model };
        deps.metrics.requestsTotal.inc({ ...labels, status_class: statusClass });
        deps.metrics.requestDurationSeconds.observe(labels, durationMs / 1000);
        if (canonicalResp?.usage.input_tokens) {
          deps.metrics.tokensTotal.inc(
            { ...labels, direction: 'input' },
            canonicalResp.usage.input_tokens,
          );
        }
        if (canonicalResp?.usage.output_tokens) {
          deps.metrics.tokensTotal.inc(
            { ...labels, direction: 'output' },
            canonicalResp.usage.output_tokens,
          );
        }
        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: TOOL_NAME,
          status_class: statusClass,
        });

        // D-08 — single tool-call log line, flat top-level fields. Status,
        // model, backend already on the child via the route-level pino enrichers
        // when this runs through the real plugin; we restate the load-bearing
        // fields here so unit-test-only invocations (no plugin) still produce
        // useful log lines.
        if (caughtErr) {
          toolLog.warn(
            {
              status: statusClass,
              backend,
              model,
              latency_ms: Math.round(durationMs),
              error_code: clientAborted ? 'client_disconnect' : mapErrorToCode(caughtErr),
            },
            'mcp tool call failed',
          );
        } else {
          toolLog.info(
            {
              status: statusClass,
              backend,
              model,
              latency_ms: Math.round(durationMs),
              tokens_in: canonicalResp?.usage.input_tokens ?? 0,
              tokens_out: canonicalResp?.usage.output_tokens ?? 0,
            },
            'mcp tool call ok',
          );
        }
      }
    },
  );
}
