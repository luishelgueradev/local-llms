/**
 * Phase 15 Plan 09 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-01..D-14):
 * MCP tool wrapping POST /v1/rerank.
 *
 * Wave-4 sibling of:
 *   - tools/chat-completion.ts (15-06)
 *   - tools/create-response.ts (15-07)
 *   - tools/create-embedding.ts (15-08)
 *   - tools/list-models.ts     (15-10)
 *
 * D-01 (passthrough): inputSchema = z.toJSONSchema(RerankRequestSchema).
 *   No hand-authored MCP-specific shape; when the route schema evolves the tool
 *   shape evolves with it. RerankRequestSchema is the same Zod object the HTTP
 *   route uses (router/src/routes/v1/rerank.ts).
 *
 * D-03 (dual-shape result): success returns
 *   content:        [{ type: 'text', text: 'reranked N docs vs query, model=M' }]
 *   structuredContent: <full rerank response — model + results[] + usage>
 *   isError:        falsy
 *
 *   The per-doc {index, relevance_score} payload rides entirely in
 *   structuredContent. The text stamp stays a one-line summary.
 *
 * D-04 (error envelope): catch block runs toOpenAIErrorEnvelope and emits
 *   { content: [{type:'text', text: env.error.message}],
 *     structuredContent: { error: env.error.type, code: env.error.code, message },
 *     isError: true }
 *   — same error vocabulary as the HTTP surface. APIUserAbortError (client
 *   disconnect → NO_ENVELOPE) is surfaced as client_disconnect.
 *
 * D-05/D-06 (request_log row): one row per tool call, protocol:'mcp',
 *   route:'/mcp', scoped IDs read from capturedReq (outer /mcp HTTP request).
 *
 * D-07 (metrics): increments router_mcp_tool_calls_total{tool:'rerank',
 *   status_class} once per call AND the shared router_requests_total +
 *   router_request_duration_seconds + router_tokens_total trio (protocol='mcp').
 *
 * D-08 (pino fields): a child logger with {tool_name, mcp_session_id,
 *   mcp_request_id} is built off capturedReq.log for the operator log line —
 *   does NOT reassign req.log (Pitfall-9 grep gate intact).
 *
 * D-14 (abort propagation): extra.signal listened to; inner AbortController
 *   forwarded to adapter.rerank's signal arg.
 *
 * Tokens accounting: rerank only exposes `usage.total_tokens` (Cohere parity —
 * the upstream cross-encoder doesn't split query vs documents). We surface it
 * as `tokens_in` and leave `tokens_out` = 0, matching the existing /v1/rerank
 * HTTP route convention (rerank.ts:230-233).
 */
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';

import { RerankRequestSchema } from '../../../routes/v1/rerank.js';
import { applyPreflight } from '../../../dispatch/preflight.js';
import {
  toOpenAIErrorEnvelope,
  mapToHttpStatus,
  NO_ENVELOPE,
  CapabilityNotSupportedError,
  BreakerOpenError,
} from '../../../errors/envelope.js';
import { computeCostCents } from '../../../cost/computeCostCents.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  truncateAndRedact,
} from '../../../metrics/recordOutcome.js';
import type { McpHostOpts } from '../plugin.js';

/**
 * Description shown in tools/list. Documents the D-03 stamp and where the
 * full score payload lives. Keep concise — MCP clients render this in
 * tool-picker UIs.
 */
const TOOL_DESCRIPTION =
  'Rerank candidate documents against a query. Returns per-document ' +
  'relevance_score in structuredContent.results; content carries a one-line ' +
  'stamp ("reranked N docs vs query, model=M"). Cohere/Jina-compatible.';

/**
 * Default cooldown (seconds) advertised on BreakerOpenError when the helper
 * trips. The HTTP surface stamps Retry-After from the route opts; MCP has no
 * Retry-After equivalent, so we surface the seconds inside the error message
 * via the existing envelope.
 */
const MCP_BREAKER_DEFAULT_COOLDOWN_SEC = 60;

/**
 * MCP tool result envelope shape — content + optional structuredContent + isError.
 * Matches the spec revision 2025-06+ dual-shape contract referenced in CONTEXT
 * D-02. Local mirror of the same shape declared in `create-embedding.ts` and
 * `create-response.ts` — kept private so each tool stays independently
 * evolvable.
 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function registerRerankTool(
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
  // Plans 15-07 / 15-08 use the same shape.
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
    'rerank',
    {
      title: 'Rerank documents against a query',
      description: TOOL_DESCRIPTION,
      // D-01: passthrough — every option HTTP callers have is available to MCP
      // callers. The JSON Schema is the runtime value the MCP wire expects;
      // the SDK's internal extractor reads it as a Record<string, unknown>.
      inputSchema: z.toJSONSchema(RerankRequestSchema) as Record<string, unknown>,
    },
    async (
      rawArgs: unknown,
      extra: { signal: AbortSignal; sessionId?: string; requestId?: string | number | null },
    ) => {
      const t0 = performance.now();

      // D-14: MCP transport signal → fresh AbortController → adapter signal.
      // The inner controller is what we hand to the adapter; aborting `extra.signal`
      // (client disconnect, session close, SIGTERM) cascades through.
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      extra.signal.addEventListener('abort', onAbort);

      // D-08: per-tool-call child log line. Build off capturedReq.log (the
      // already-scoped pino child created by agentIdPreHandler on the outer
      // /mcp request). DO NOT reassign capturedReq.log — Pitfall-9 grep gate.
      const toolLog = capturedReq.log.child({
        tool_name: 'rerank',
        mcp_session_id: extra.sessionId,
        mcp_request_id: extra.requestId ?? null,
      });

      // The SDK's ToolCallback signature passes `args` as the parsed
      // JSON-Schema shape; we trust the schema (D-01) and parse defensively
      // through RerankRequestSchema so downstream code receives the strict
      // TypeScript shape (and so any odd JSON-RPC client that bypasses the
      // schema validator still fails closed at this boundary).
      const body = RerankRequestSchema.parse(rawArgs);

      let backend = 'unknown';
      let model = body.model;
      let caughtErr: Error | undefined;
      let result:
        | {
            model: string;
            results: Array<{ index: number; relevance_score: number; document?: { text: string } }>;
            usage: { total_tokens: number };
          }
        | undefined;

      try {
        // D-09: applyPreflight = resolve + policy gate + breaker.check.
        const { entry, breakerState } = await applyPreflight(body.model, {
          registry: deps.registry,
          breaker: deps.breaker,
        });
        backend = entry.backend;
        model = entry.name;

        // Sentinel branch: MCP has no Retry-After to stamp; surface the breaker
        // state as a structured BreakerOpenError so the centralized envelope
        // mapping returns api_error / backend_circuit_open uniformly.
        if (breakerState === 'open') {
          throw new BreakerOpenError(entry.backend, MCP_BREAKER_DEFAULT_COOLDOWN_SEC);
        }

        // Capability gate — defense in depth (registry-level gate catches
        // misconfig upstream; this catches a hot-reload race or a tool call
        // against a model that lost the capability between resolve and dispatch).
        if (!entry.capabilities.includes('rerank')) {
          throw new CapabilityNotSupportedError(entry.name, 'rerank');
        }

        const adapter = deps.makeAdapter(entry);
        result = await adapter.rerank(
          body.query,
          body.documents,
          entry.backend_model,
          controller.signal,
          {
            ...(body.top_n !== undefined ? { top_n: body.top_n } : {}),
            return_documents: body.return_documents ?? false,
          },
        );

        // Wire-shape parity with the HTTP route: surface registry name as
        // `model` (RERANK-04 — clients see the registered alias, not the
        // backend_model id), enforce top_n post-filter, sort by score desc.
        const sorted = [...result.results].sort(
          (a, b) => b.relevance_score - a.relevance_score,
        );
        const capped = body.top_n !== undefined ? sorted.slice(0, body.top_n) : sorted;
        const wireBody = {
          model: entry.name,
          results: capped,
          usage: result.usage,
        };

        void deps.breaker.recordSuccess(entry.backend);

        // D-03 stamp: short summary; full score payload rides in
        // structuredContent. `body.documents.length` is the inbound size —
        // not the (possibly capped) output length — so the stamp tells the
        // operator how many docs were scored, matching the embedding tool's
        // "N inputs" convention.
        const stamp = `reranked ${body.documents.length} docs vs query, model=${entry.name}`;

        return {
          content: [{ type: 'text' as const, text: stamp }],
          structuredContent: wireBody,
        };
      } catch (err) {
        caughtErr = err instanceof Error ? err : new Error(String(err));
        // Failed call → record on the breaker (BreakerOpenError already
        // short-circuited above, so we skip it to avoid double-counting).
        if (!(caughtErr instanceof BreakerOpenError)) {
          void deps.breaker.recordFailure(backend, caughtErr);
        }

        // D-04: reuse existing envelope mapping. APIUserAbortError → NO_ENVELOPE
        // (client gone). Translate to a uniform client_disconnect shape so MCP
        // clients always receive isError + a parseable structuredContent.
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
          structuredContent: errorPayload,
          isError: true,
        };
      } finally {
        extra.signal.removeEventListener('abort', onAbort);

        // D-05/D-06/D-07: emit the metric + request_log row in lockstep.
        const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : 200;
        const statusClass = deriveStatusClass(httpStatus, controller.signal.aborted);
        const durationMs = performance.now() - t0;

        // Rerank tokens: only total_tokens (no input/output split). Surface as
        // tokens_in / 0 to keep request_log SUM aggregations clean — same
        // convention as routes/v1/rerank.ts:230-233.
        const tokensIn = caughtErr ? undefined : result?.usage.total_tokens ?? 0;
        const tokensOut = caughtErr ? undefined : 0;

        // Cost: only meaningful when the entry has pricing declared (cloud
        // rerankers, when/if Ollama Cloud adds the capability). Local
        // rerankers → null → no cost column populated. Resolve the entry by
        // model name; safe inside the finally because resolve() never throws
        // for a model we've already seen succeed. On the error branch the
        // resolution may itself throw — guard.
        let costCents: string | undefined;
        if (!caughtErr) {
          try {
            const entry = deps.registry.resolve(model);
            costCents = computeCostCents({ entry, tokensIn, tokensOut }) ?? undefined;
          } catch {
            // Defensive — registry hot-reload between resolve and finally is rare
            // but possible. Leave costCents undefined → NULL column.
          }
        }

        const labels = { protocol: 'mcp' as const, backend, model };
        deps.metrics.requestsTotal.inc({ ...labels, status_class: statusClass });
        deps.metrics.requestDurationSeconds.observe(labels, durationMs / 1000);
        if (tokensIn !== undefined && tokensIn > 0) {
          deps.metrics.tokensTotal.inc({ ...labels, direction: 'input' }, tokensIn);
        }
        // D-07: dedicated MCP tool-call counter (5 tools × ~5 classes ≈ 25 series).
        deps.metrics.routerMcpToolCallsTotal.inc({
          tool: 'rerank',
          status_class: statusClass,
        });

        // D-05/D-06: one request_log row per MCP tool call.
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
          ttft_ms: null, // non-stream tool — no TTFT.
          latency_ms: Math.round(durationMs),
          error_code: caughtErr ? mapErrorToCode(caughtErr) : null,
          error_message: caughtErr ? truncateAndRedact(caughtErr.message) : null,
          agent_id: capturedReq.agentId ?? null,
          tenant_id: capturedReq.tenantId ?? null,
          project_id: capturedReq.projectId ?? null,
          workload_class: capturedReq.workloadClass ?? null,
          request_id: capturedReq.id,
          upstream_message_id: null, // rerank has no upstream message id.
          idempotency_key: null, // D-13: MCP-level idempotency is HTTP-only.
          cost_cents: costCents ?? null,
        });

        // D-08: structured log line for the operator. Status_class + http_status
        // + duration cover the triage triple; tokens hint at capacity.
        if (caughtErr) {
          toolLog.warn(
            {
              backend,
              model,
              status: statusClass,
              http_status: httpStatus,
              latency_ms: Math.round(durationMs),
              error_code: mapErrorToCode(caughtErr),
            },
            'mcp tool rerank failed',
          );
        } else {
          toolLog.info(
            {
              backend,
              model,
              status: statusClass,
              latency_ms: Math.round(durationMs),
              tokens_in: tokensIn ?? 0,
            },
            'mcp tool rerank ok',
          );
        }
      }
    },
  );
}
