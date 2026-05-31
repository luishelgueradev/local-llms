/**
 * responses.ts — Phase 13 (v0.10.0 — RESP-01..04) — POST /v1/responses.
 *
 * Wire surface: OpenAI Responses API (minimal, non-streaming). Closes the gap
 * exposed by the n8n "Message a Model" node + other modern OpenAI SDK clients
 * that have migrated to the Responses surface — until this lands, those clients
 * 404 against the router.
 *
 * Shape (input):
 *   {
 *     model:              string,
 *     input:              string | OpenAI-message[],
 *     instructions?:      string,
 *     temperature?:       number,
 *     max_output_tokens?: number,
 *     stream?:            boolean // false → JSON wire body (this file's legacy path);
 *                                  // true  → Responses-API SSE stream (Phase 16 / RESS-01..05)
 *   }
 *
 * Shape (output):
 *   {
 *     id:     string,                  // re-exposed from upstream completion id
 *     object: "response",
 *     model:  string,                  // registry alias (parity with chat-completions)
 *     output: [
 *       {
 *         type:    "message",
 *         role:    "assistant",
 *         content: [{ type: "output_text", text }]
 *       }
 *     ],
 *     usage:  {
 *       input_tokens:  number,
 *       output_tokens: number,
 *       total_tokens:  number
 *     }
 *   }
 *
 * Implementation strategy (RESP-02): translate Responses → canonical, hand to
 * adapter.chatCompletionsCanonical (the same plumbing chat-completions uses),
 * then translate canonical → Responses wire shape. No duplication of the
 * 800-LOC chat-completions pipeline.
 *
 * Shares end-to-end with /v1/chat/completions (RESP-03):
 *   - bearer auth (onRequest hook), agent-id, rate-limit
 *   - capability gate (RESP-04 — chat-only requirement)
 *   - per-backend circuit breaker, semaphore, Idempotency-Key multiplexer
 *   - X-Model-Backend + X-Cost-Cents response headers (onSend hook)
 *   - request_log row + Prometheus metrics
 *
 * Phase 16 (v0.11.0 — RESS-01..05): streaming branch wired in. `stream: true`
 * now emits Responses-API SSE via `canonicalToResponsesSse` — a different
 * protocol vocabulary from chat-completions (P3-01 BLOCK; the translator never
 * imports from openai-out.ts). The non-stream branch below is preserved
 * byte-identical (P9-02 BLOCK). The streaming branch is a near-verbatim copy
 * of chat-completions.ts:506-779 with two substitutions: translator
 * (canonicalToOpenAISse → canonicalToResponsesSse) and route string.
 *
 * X-Cost-Cents header is NOT emitted on the streaming branch — SSE headers
 * seal before tokens are known. Cost still lands in request_log.cost_cents
 * (same as chat-completions stream). Mirrors orchestrator inline resolution #1.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startHeartbeat } from '../../sse/heartbeat.js';
import { canonicalToResponsesSse } from '../../translation/responses-stream.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
} from '../../errors/envelope.js';
import { applyPreflight } from '../../dispatch/preflight.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import type { IdempotencyMultiplexer } from '../../resilience/idempotency.js';
import { extractIdempotencyKey } from '../../middleware/idempotencyKey.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  type OutcomeContext,
  type RecordRequestOutcome,
} from '../../metrics/recordOutcome.js';
import { computeCostCents } from '../../cost/computeCostCents.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../translation/canonical.js';

// ── Body schema ────────────────────────────────────────────────────────────────
//
// `input` is either a string (treated as a single user message) or an array of
// OpenAI-shape chat messages (passed through). `.passthrough()` on messages
// keeps forward-compat with new content-block types the upstream SDK adds.
//
// `stream` accepts ANY boolean at schema level — we reject `true` post-parse
// with a friendly message rather than a generic zod "must be false" error.
const ResponsesMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.unknown())]),
  })
  .passthrough();

export const ResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string().min(1), z.array(ResponsesMessageSchema).min(1)]),
    instructions: z.string().optional(),
    temperature: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export interface RegisterResponsesOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };
  recordOutcome: RecordRequestOutcome;
  breaker: CircuitBreaker;
  breakerCooldownSec: number;
  idempotency?: IdempotencyMultiplexer;
}

/**
 * Translate a Responses-API request body into the canonical request used by
 * the shared adapter pipeline.
 *
 * Mapping rules (mirroring how openai-in.ts handles /v1/chat/completions):
 *   - `instructions` → joined into the canonical's top-level `system` string
 *     (canonical only allows user|assistant roles in `messages`; system is a
 *     dedicated top-level field per Anthropic semantics).
 *   - Array input: `system` messages also fold into the top-level `system`.
 *     `user`/`assistant` messages map directly with content normalized to a
 *     text block when supplied as a string. `tool` role messages are
 *     downgraded to `user` for v0.10.0 — full tool-calling on Responses API
 *     is in the v0.11+ backlog.
 *   - String input: single user message with a plain text block.
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
      // System role contributes to the top-level `system` string; the canonical
      // messages array forbids 'system'.
      if (rawRole === 'system') {
        if (typeof m.content === 'string') systemParts.push(m.content);
        else systemParts.push(JSON.stringify(m.content));
        continue;
      }
      // Tool role is not first-class in the canonical messages enum; downgrade
      // to a user message with the content stringified. v0.10.0 ships Responses
      // as text-only; tool support comes when the upstream contract stabilizes.
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
    // `max_output_tokens` is the Responses API's name for max_tokens — same semantic.
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_output_tokens !== undefined
      ? { max_tokens: body.max_output_tokens }
      : {}),
  };
  return canonical;
}

/**
 * Translate the canonical assistant response into the Responses-API wire shape.
 * Text-only output (no tool calls) for v0.10.0; tool support is in scope for a
 * later iteration when the Responses-API tool-calling contract stabilizes
 * across SDK versions.
 *
 * Wire-shape fields included beyond the minimal {id, object, output, usage}
 * advertised in the Phase 13 spec — these are the openai-node SDK's
 * required-or-nullable fields that the SDK's response parser ITERATES (e.g.
 * `content[].annotations.map(...)` blows up with "Cannot read properties of
 * undefined (reading 'map')" when `annotations` is missing):
 *
 *   - content[].annotations: []     — SDK maps over this to extract citations;
 *                                     `[]` is the spec value for "no citations"
 *   - output_text                   — flat-string shortcut the SDK exposes as
 *                                     `response.output_text`; some consumers
 *                                     (LangChain `lmChatOpenAi` with
 *                                     `responsesApiEnabled: true`) read this
 *                                     directly off the wire instead of
 *                                     recomputing from content blocks
 *   - status                        — "completed" | "in_progress" | "failed"
 *   - created_at                    — unix seconds; SDK expects a number
 *   - error: null                   — required field; null when no error
 *   - incomplete_details: null      — required field; null when complete
 *   - tools: []                     — SDK iterates this for function-call
 *                                     translation; `[]` means "no tools"
 *   - tool_choice: "auto"           — required field; "auto" is the default
 *   - parallel_tool_calls: true     — required boolean
 *   - reasoning, text, truncation, instructions, max_output_tokens,
 *     metadata, previous_response_id, temperature, top_p, user — all
 *     required-or-nullable per the spec; some SDKs deserialize the response
 *     into a strict class and choke on missing fields
 *   - output[].id, output[].status  — per-output-item identifier and lifecycle;
 *     SDK uses these to correlate streaming events but they're also expected
 *     in the non-stream shape
 *   - usage.{input,output}_tokens_details — the SDK projects these into
 *     `response.usage.input_tokens_details.cached_tokens` etc.; missing
 *     fields cause property-access errors in `output_tokens_details.reasoning_tokens`
 *
 * Echoing fields from the inbound request (model, instructions, temperature,
 * max_output_tokens, etc.) is part of the spec — the response is the "current
 * state of the response object" and callers may inspect echoed knobs.
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

export function registerResponsesRoute(
  app: FastifyInstance,
  opts: RegisterResponsesOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/responses',
    { schema: { body: ResponsesRequestSchema } },
    async (req, reply) => {
      const body = req.body;

      // Phase 16 (v0.11.0 — RESS-01): the previous v0.10.0 stream:true → 400
      // rejection block was removed when streaming shipped. The stream:true
      // path now lives below as a near-verbatim copy of chat-completions.ts's
      // streaming branch with the translator swap (canonicalToOpenAISse →
      // canonicalToResponsesSse) and the route-string swap. Non-stream wire
      // shape is preserved byte-identical (P9-02 BLOCK).

      // Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): consolidated preflight.
      // applyPreflight runs resolve → applyPolicyGate → breaker.check in one
      // helper, shared with MCP tool handlers (Wave 4). breakerState='open' is
      // RETURNED so the HTTP caller stamps Retry-After before BreakerOpenError.
      const { entry, breakerState } = await applyPreflight(body.model, {
        registry: opts.registry,
        breaker: opts.breaker,
      });
      req.resolvedBackend = entry.backend;
      // Plan 08-04 (CLOUD-03) — sentinel-open branch.
      if (breakerState === 'open') {
        void reply.header('Retry-After', String(opts.breakerCooldownSec));
        throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
      }

      const adapter: BackendAdapter = opts.makeAdapter(entry);
      const canonical = responsesToCanonical(body, entry.backend_model);

      // ── Phase 16 (RESS-05): unified AbortController + onClose wiring.
      // CRITICAL: req.raw.socket.once NOT req.raw.once — see chat-completions.ts:251-265
      // comment block for the full empirical justification (req.raw.once fires on body
      // parse, not TCP close). The stopHeartbeat closure variable is wired through so
      // the listener also clears the heartbeat when client disconnects mid-stream.
      const controller = new AbortController();
      let stopHeartbeat: (() => void) | null = null;
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
        stopHeartbeat?.();
      };
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'stream: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      let recorded = false;
      const safeRecord = (ctx: OutcomeContext): void => {
        if (recorded) return;
        recorded = true;
        req.__recorded = true;
        opts.recordOutcome(ctx);
      };

      let caughtErr: Error | undefined;
      let canonicalResult: CanonicalResponse | undefined;

      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyRole: 'leader' | 'follower' | undefined;
      let followerUpstreamMessageId: string | undefined;

      // ────────────────────────────────────────────────────────────────────────
      // Phase 16 (v0.11.0 — RESS-01..05): STREAMING BRANCH.
      //
      // Reachable ONLY after applyPreflight succeeds (resolve → policy gate →
      // breaker check). Mirrors chat-completions.ts:506-779 with two
      // substitutions: translator (canonicalToOpenAISse → canonicalToResponsesSse)
      // and route string ('/v1/chat/completions' → '/v1/responses').
      //
      // X-Cost-Cents header is NOT emitted on this branch — SSE headers seal
      // before tokens are known. Cost lands in request_log.cost_cents only.
      // req.computedCostCents is NOT stamped on this branch (would no-op anyway
      // since onSend runs synchronously inside reply.send() which never fires
      // for streaming — but documenting the contract for clarity).
      // ────────────────────────────────────────────────────────────────────────
      if (body.stream === true) {
        // Capability gate — chat surface (same check as non-stream branch).
        // Fires BEFORE the adapter call; this branch has its own envelope path,
        // intentional duplication to keep each branch self-contained.
        if (!entry.capabilities.includes('chat')) {
          req.raw.socket?.off('close', onClose);
          throw new CapabilityNotSupportedError(entry.name, 'chat' as never);
        }

        let capturedUpstreamMessageId: string | undefined;

        // ── Idempotency-Key handling (mirrors chat-completions.ts:349-497) ──
        if (idempotencyKey && opts.idempotency) {
          const acq = await opts.idempotency.acquire(idempotencyKey, req.id);
          idempotencyRole = acq.role;
          if (acq.role === 'follower') {
            // ── STREAM FOLLOWER ──────────────────────────────────────────
            // Pipe the multiplexer's iterator through the SAME translator the
            // leader uses; wire output is byte-identical because both run the
            // same canonicalToResponsesSse with the same displayModel + echo.
            const followerHeartbeat = startHeartbeat(reply.raw);
            stopHeartbeat = (): void => followerHeartbeat.stop();
            const muxIter = opts.idempotency.awaitStreamResult(idempotencyKey, req.id);
            let muxTerminal: 'done' | 'error' | 'aborted' | undefined;
            const followerEvents: AsyncIterable<CanonicalStreamEvent> = {
              async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
                for await (const item of muxIter) {
                  if (item.terminal !== undefined) {
                    muxTerminal = item.terminal;
                    return;
                  }
                  if (item.event !== undefined) {
                    if ((item.event as CanonicalStreamEvent).type === 'message_start') {
                      capturedUpstreamMessageId = (
                        item.event as Extract<CanonicalStreamEvent, { type: 'message_start' }>
                      ).message.id;
                    }
                    yield item.event as CanonicalStreamEvent;
                  }
                }
              },
            };
            const followerSseCleanup = (final?: {
              tokensIn: number;
              tokensOut: number;
              error?: Error;
            }): void => {
              followerHeartbeat.stop();
              req.raw.socket?.off('close', onClose);
              // Followers never acquired the semaphore — no safeRelease call.
              const aborted = muxTerminal === 'aborted' || controller.signal.aborted;
              const hasErr = final?.error !== undefined;
              const errStatus = hasErr
                ? mapToHttpStatus(final!.error)
                : reply.statusCode;
              const statusClass = aborted
                ? 'disconnect'
                : hasErr
                  ? deriveStatusClass(errStatus, false)
                  : deriveStatusClass(reply.statusCode, false);
              const errorCode = aborted
                ? 'client_disconnect'
                : hasErr
                  ? mapErrorToCode(final!.error)
                  : undefined;
              const costCents = hasErr
                ? undefined
                : computeCostCents({
                    entry,
                    tokensIn: final?.tokensIn,
                    tokensOut: final?.tokensOut,
                  }) ?? undefined;
              safeRecord({
                protocol: 'openai',
                route: req.url.split('?')[0] ?? req.url,
                backend: entry.backend,
                model: entry.name,
                statusClass,
                httpStatus: errStatus,
                durationMs: performance.now() - (req._t0 ?? performance.now()),
                ttftMs: followerHeartbeat.msSinceStart,
                tokensIn: final?.tokensIn,
                tokensOut: final?.tokensOut,
                errorCode,
                errorMessage: hasErr ? final!.error!.message : undefined,
                agentId: req.agentId,
                tenantId: req.tenantId,
                projectId: req.projectId,
                workloadClass: req.workloadClass,
                requestId: req.id,
                upstreamMessageId: capturedUpstreamMessageId,
                idempotencyKey,
                costCents,
                timestamp: new Date(),
              });
            };
            try {
              await reply.sse(
                canonicalToResponsesSse(followerEvents, {
                  signal: controller.signal,
                  onCleanup: followerSseCleanup,
                  displayModel: entry.name,
                  echo: {
                    instructions: body.instructions,
                    temperature: body.temperature,
                    max_output_tokens: body.max_output_tokens,
                    tools: (body as { tools?: unknown[] }).tools,
                    tool_choice: (body as { tool_choice?: unknown }).tool_choice,
                  },
                }),
              );
            } finally {
              followerHeartbeat.stop();
            }
            if (controller.signal.aborted) {
              req.log.info(
                {
                  url: req.url,
                  bytesEmitted: followerHeartbeat.bytesSinceStart,
                  msSinceStart: followerHeartbeat.msSinceStart,
                },
                'stream: client disconnected (follower)',
              );
            }
            return;
          }
          // Leader role: fall through and execute the adapter call.
        }

        // ── Leader path ────────────────────────────────────────────────
        // Semaphore acquire (cancellable on client-disconnect via controller.signal).
        const semaphore = opts.semaphores.get(entry.backend);
        try {
          release = await semaphore.acquire(controller.signal);
          released = false;
        } catch (err) {
          // BackendSaturatedError → centralized error handler stamps Retry-After + 429.
          req.raw.socket?.off('close', onClose);
          if (err instanceof BackendSaturatedError) {
            void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
          }
          throw err;
        }

        // Pre-stream upstream call. If the adapter throws BEFORE the first
        // canonical event yields, headers are still mutable — JSON envelope.
        let upstream: AsyncIterable<CanonicalStreamEvent>;
        try {
          upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
        } catch (err) {
          void opts.breaker.recordFailure(entry.backend, err);
          if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
            void opts.idempotency
              .finalizeStream(idempotencyKey, 'error')
              .catch((finalizeErr: unknown) => {
                req.log.warn(
                  { err: finalizeErr, idempotencyKey },
                  'idempotency: finalizeStream(error) failed (leader pre-stream catch)',
                );
              });
          }
          req.raw.socket?.off('close', onClose);
          safeRelease();
          const env = toOpenAIErrorEnvelope(err);
          const status = mapToHttpStatus(err);
          const errInst = err instanceof Error ? err : new Error(String(err));
          if (env === NO_ENVELOPE) {
            safeRecord({
              protocol: 'openai',
              route: req.url.split('?')[0] ?? req.url,
              backend: entry.backend,
              model: entry.name,
              statusClass: 'disconnect',
              httpStatus: status,
              durationMs: performance.now() - (req._t0 ?? performance.now()),
              errorCode: 'client_disconnect',
              errorMessage: errInst.message,
              agentId: req.agentId,
              tenantId: req.tenantId,
              projectId: req.projectId,
              workloadClass: req.workloadClass,
              requestId: req.id,
              idempotencyKey,
              timestamp: new Date(),
            });
            return;
          }
          safeRecord({
            protocol: 'openai',
            route: req.url.split('?')[0] ?? req.url,
            backend: entry.backend,
            model: entry.name,
            statusClass: deriveStatusClass(status, false),
            httpStatus: status,
            durationMs: performance.now() - (req._t0 ?? performance.now()),
            errorCode: mapErrorToCode(err),
            errorMessage: errInst.message,
            agentId: req.agentId,
            tenantId: req.tenantId,
            projectId: req.projectId,
            workloadClass: req.workloadClass,
            requestId: req.id,
            idempotencyKey,
            timestamp: new Date(),
          });
          return reply.code(status).send(env);
        }

        // Leader idempotency mux wrap — each canonical event is fire-and-forget
        // RPUSHed + PUBLISHed before being yielded to the SSE translator.
        const upstreamWithMux: AsyncIterable<CanonicalStreamEvent> =
          idempotencyKey && idempotencyRole === 'leader' && opts.idempotency
            ? {
                async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
                  for await (const ev of upstream) {
                    if (ev.type === 'message_start') {
                      capturedUpstreamMessageId = ev.message.id;
                    }
                    void opts.idempotency!.publishStreamEvent(idempotencyKey, ev);
                    yield ev;
                  }
                },
              }
            : {
                async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
                  for await (const ev of upstream) {
                    if (ev.type === 'message_start') {
                      capturedUpstreamMessageId = ev.message.id;
                    }
                    yield ev;
                  }
                },
              };

        const heartbeat = startHeartbeat(reply.raw);
        stopHeartbeat = () => heartbeat.stop();

        const sseCleanup = (final?: {
          tokensIn: number;
          tokensOut: number;
          error?: Error;
        }): void => {
          heartbeat.stop();
          req.raw.socket?.off('close', onClose);
          safeRelease();
          if (final?.error !== undefined) {
            void opts.breaker.recordFailure(entry.backend, final.error);
          } else {
            void opts.breaker.recordSuccess(entry.backend);
          }
          if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
            const terminal: 'done' | 'error' | 'aborted' =
              final?.error !== undefined
                ? 'error'
                : controller.signal.aborted
                  ? 'aborted'
                  : 'done';
            void opts.idempotency
              .finalizeStream(idempotencyKey, terminal, capturedUpstreamMessageId)
              .catch((finalizeErr: unknown) => {
                req.log.warn(
                  { err: finalizeErr, idempotencyKey, terminal },
                  'idempotency: finalizeStream failed (leader stream end)',
                );
              });
          }
          const hasUpstreamError = final?.error !== undefined;
          const errStatus = hasUpstreamError
            ? mapToHttpStatus(final!.error)
            : reply.statusCode;
          const statusClass = hasUpstreamError
            ? deriveStatusClass(errStatus, false)
            : deriveStatusClass(reply.statusCode, controller.signal.aborted);
          const errorCode = hasUpstreamError
            ? mapErrorToCode(final!.error)
            : controller.signal.aborted
              ? 'client_disconnect'
              : undefined;
          const errorMessage = hasUpstreamError ? final!.error!.message : undefined;
          // Phase 16 (RESS-05): cost on the streaming path lands in
          // request_log.cost_cents only — the X-Cost-Cents HEADER cannot be
          // sent on streamed responses (SSE headers sealed before first chunk).
          const costCents = hasUpstreamError
            ? undefined
            : computeCostCents({
                entry,
                tokensIn: final?.tokensIn,
                tokensOut: final?.tokensOut,
              }) ?? undefined;
          safeRecord({
            protocol: 'openai',
            route: req.url.split('?')[0] ?? req.url,
            backend: entry.backend,
            model: entry.name,
            statusClass,
            httpStatus: errStatus,
            durationMs: performance.now() - (req._t0 ?? performance.now()),
            ttftMs: heartbeat.msSinceStart,
            tokensIn: final?.tokensIn,
            tokensOut: final?.tokensOut,
            errorCode,
            errorMessage,
            agentId: req.agentId,
            tenantId: req.tenantId,
            projectId: req.projectId,
            workloadClass: req.workloadClass,
            requestId: req.id,
            upstreamMessageId: capturedUpstreamMessageId,
            idempotencyKey,
            costCents,
            timestamp: new Date(),
          });
        };

        try {
          await reply.sse(
            canonicalToResponsesSse(upstreamWithMux, {
              signal: controller.signal,
              onCleanup: sseCleanup,
              displayModel: entry.name,
              echo: {
                instructions: body.instructions,
                temperature: body.temperature,
                max_output_tokens: body.max_output_tokens,
                tools: (body as { tools?: unknown[] }).tools,
                tool_choice: (body as { tool_choice?: unknown }).tool_choice,
              },
            }),
          );
        } finally {
          heartbeat.stop();
        }

        if (controller.signal.aborted) {
          req.log.info(
            {
              url: req.url,
              bytesEmitted: heartbeat.bytesSinceStart,
              msSinceStart: heartbeat.msSinceStart,
            },
            'stream: client disconnected (leader)',
          );
        }
        return;
      }

      try {
        // RESP-04 — capability gate. Responses requires chat (it's a chat
        // surface in OpenAI's modern API). Embeddings-only / rerank-only models
        // → 400 with the standard model_capability_mismatch envelope.
        if (!entry.capabilities.includes('chat')) {
          throw new CapabilityNotSupportedError(entry.name, 'chat' as never);
        }

        // Plan 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): the policy gate and
        // breaker check were consolidated into applyPreflight() at the top of
        // the handler (before this try block). The sentinel-open branch and
        // Retry-After stamp moved alongside it.

        if (idempotencyKey && opts.idempotency) {
          const acq = await opts.idempotency.acquire(idempotencyKey, req.id);
          idempotencyRole = acq.role;
          if (acq.role === 'follower') {
            const { body: cachedBody, upstreamMessageId } =
              await opts.idempotency.awaitNonStreamResult(idempotencyKey, req.id);
            followerUpstreamMessageId = upstreamMessageId;
            // Reconstruct canonicalResult from the cached Responses body so the
            // outer finally records real tokens + cost (parity with chat-completions
            // follower handling). The cached body has the Responses shape with
            // input_tokens/output_tokens already at top-level usage.
            const cb = cachedBody as {
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (cb.usage) {
              canonicalResult = {
                id: '',
                type: 'message',
                role: 'assistant',
                content: [],
                model: entry.backend_model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: cb.usage.input_tokens ?? 0,
                  output_tokens: cb.usage.output_tokens ?? 0,
                },
              };
              // Stamp X-Cost-Cents for the follower too (same reasoning as the
              // leader path — Fastify fires onSend synchronously inside .send()).
              const followerCost =
                computeCostCents({
                  entry,
                  tokensIn: canonicalResult.usage.input_tokens,
                  tokensOut: canonicalResult.usage.output_tokens,
                }) ?? undefined;
              if (followerCost !== undefined) {
                req.computedCostCents = followerCost;
              }
            }
            req.raw.socket?.off('close', onClose);
            return reply.send(cachedBody);
          }
        }

        const semaphore = opts.semaphores.get(entry.backend);
        release = await semaphore.acquire(controller.signal);
        released = false;

        canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
        void opts.breaker.recordSuccess(entry.backend);
        req.raw.socket?.off('close', onClose);

        // Phase 13 (v0.10.0 — COST-02): stamp req.computedCostCents BEFORE
        // reply.send(). Fastify v5's reply.send() triggers the onSend hook
        // chain SYNCHRONOUSLY (preSerialization → onSend → flush) inside the
        // .send() call — by the time the route's outer finally runs, headers
        // are already sealed. The finally block still records cost to the
        // request_log row; this is the header path.
        const earlyCost =
          computeCostCents({
            entry,
            tokensIn: canonicalResult.usage.input_tokens,
            tokensOut: canonicalResult.usage.output_tokens,
          }) ?? undefined;
        if (earlyCost !== undefined) {
          req.computedCostCents = earlyCost;
        }

        const wireBody = canonicalToResponses(canonicalResult, entry.name, {
          instructions: body.instructions,
          temperature: body.temperature,
          max_output_tokens: body.max_output_tokens,
          user: typeof (body as { user?: unknown }).user === 'string'
            ? ((body as { user?: string }).user)
            : undefined,
        });

        if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
          try {
            await opts.idempotency.publishNonStream(
              idempotencyKey,
              wireBody,
              canonicalResult.id,
            );
          } catch (err) {
            req.log.warn(
              { err, idempotencyKey },
              'idempotency: publishNonStream failed (leader response still returned)',
            );
          }
        }
        return reply.send(wireBody);
      } catch (err) {
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        if (!(err instanceof BreakerOpenError)) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        safeRelease();
        const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : reply.statusCode;
        const tokensIn = caughtErr ? undefined : canonicalResult?.usage.input_tokens;
        const tokensOut = caughtErr ? undefined : canonicalResult?.usage.output_tokens;
        const costCents = caughtErr
          ? undefined
          : computeCostCents({ entry, tokensIn, tokensOut }) ?? undefined;
        if (costCents !== undefined) {
          req.computedCostCents = costCents;
        }
        safeRecord({
          protocol: 'openai',
          route: req.url.split('?')[0] ?? req.url,
          backend: entry.backend,
          model: entry.name,
          statusClass: caughtErr
            ? deriveStatusClass(httpStatus, false)
            : deriveStatusClass(reply.statusCode, false),
          httpStatus,
          durationMs: performance.now() - (req._t0 ?? performance.now()),
          tokensIn,
          tokensOut,
          errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
          errorMessage: caughtErr?.message,
          agentId: req.agentId,
          tenantId: req.tenantId,
          projectId: req.projectId,
          workloadClass: req.workloadClass,
          requestId: req.id,
          upstreamMessageId: followerUpstreamMessageId ?? canonicalResult?.id,
          idempotencyKey,
          costCents,
          timestamp: new Date(),
        });
      }
    },
  );
}
