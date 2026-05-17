/**
 * messages.ts — POST /v1/messages route.
 *
 * Wire surface: Anthropic Messages API. Body validated by anthropic-in.ts'
 * AnthropicMessagesRequestSchema (carrying the role-alternation + tool_result
 * ordering superRefines). Translation through canonical → adapter.canonical{,Stream} →
 * canonicalToAnthropicResponse|Sse. The route's AbortController + onClose +
 * safeRelease + semaphore + heartbeat + sseCleanup plumbing mirrors
 * chat-completions.ts byte-for-byte; only the translator pipeline differs.
 *
 * Plan 04-02 shipped the non-stream branch + a not-implemented stub for streaming.
 * Plan 04-03 (THIS edit) replaces that stub with the full SSE pipeline:
 *   countTokens(canonical)  → inputTokensHint
 *   adapter.chatCompletionsCanonicalStream(canonical, signal, { inputTokensHint })
 *   reply.sse(canonicalToAnthropicSse(upstream, { signal, onCleanup }))
 *   startAnthropicHeartbeat(reply.raw)   ← typed `event: ping` frame every 15s
 *
 * Issue #6 resolution: the route does NOT intercept the canonical event stream to
 * back-patch input_tokens. The hint is computed ONCE here and passed to the adapter
 * via the new opts arg; the adapter→translator pipeline owns event emission.
 *
 * D-E5 / T-04-05: anthropic-version request header is echoed verbatim on the
 * response, length-capped to 64 chars with CR/LF stripped (header injection mitigation).
 *
 * D-C2: capability gating — if the body has image blocks and the registry entry's
 * capabilities array lacks 'vision', the route throws CapabilityNotSupportedError
 * BEFORE acquiring a semaphore slot or calling the adapter. Maps to 400 + Anthropic
 * envelope on the wire.
 *
 * D-F3: every request flows through canonical (no single-hop OpenAI↔Anthropic anywhere).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startAnthropicHeartbeat } from '../../sse/heartbeat.js';
import { anthropicRequestToCanonical } from '../../translation/anthropic-in.js';
import {
  canonicalToAnthropicResponse,
  canonicalToAnthropicSse,
} from '../../translation/anthropic-out.js';
import { countTokens } from '../../translation/count-tokens.js';
import type { CanonicalResponse, CanonicalStreamEvent } from '../../translation/canonical.js';
import {
  ANTHROPIC_NO_ENVELOPE,
  BreakerOpenError,
  CapabilityNotSupportedError,
  CloudMaxTokensExceededError,
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
} from '../../errors/envelope.js';
import { CLOUD_MAX_TOKENS_CAP } from '../../config/constants.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  type OutcomeContext,
  type RecordRequestOutcome,
} from '../../metrics/recordOutcome.js';

/**
 * Permissive body schema. The translator's AnthropicMessagesRequestSchema is the
 * full one (with superRefines + tool block validation); this is the route-level
 * gate so Fastify's type-provider can accept the body before our zod parse runs.
 * Strict refinement happens inside anthropicRequestToCanonical.
 */
export const AnthropicMessagesRouteBodySchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(z.unknown()).min(1),
    system: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).max(5).optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

export interface RegisterMessagesRouteOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };
  /**
   * Plan 05-02 (D-C6) — same helper used by chat-completions.ts. Records
   * metrics + enqueues request_log row via per-request safeRecord closure.
   */
  recordOutcome: RecordRequestOutcome;
  /**
   * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — per-backend circuit breaker. See
   * RegisterChatCompletionsOpts.breaker for the full semantics; this route
   * follows the same gate-then-record-around-adapter pattern.
   */
  breaker: CircuitBreaker;
  /** Plan 08-04 — Retry-After header value when the breaker is open. */
  breakerCooldownSec: number;
}

/**
 * Sanitize the anthropic-version header before echoing it back to the client.
 * - Cap to 64 chars (defense in depth)
 * - Keep ONLY visible US-ASCII plus tab (RFC 7230 §3.2.6 field-vchar + HTAB) —
 *   strips CR/LF (header injection — T-04-05) plus other control bytes (NUL,
 *   vertical tab, form feed, ESC, DEL, high-bit 0x80–0xFF). The CRLF strip is
 *   the only injection-significant filter; the broader cutoff is defense in
 *   depth against log-injection vectors and intermediary edge-case behavior
 *   (WR-06).
 * - First value if Fastify gave us an array
 */
function sanitizeAnthropicVersion(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' || first.length === 0) return null;
  // \x20-\x7E = printable ASCII (space through tilde). \t = HTAB. Everything
  // else (including CR/LF and high-bit bytes) is stripped.
  // IN-03: treat empty string post-sanitization the same as absent — a header
  // consisting only of non-printable bytes within 64 chars would otherwise
  // produce an empty `anthropic-version: ` response header, which some strict
  // HTTP clients or intermediaries may reject.
  const stripped = first.slice(0, 64).replace(/[^\x20-\x7E\t]/g, '');
  return stripped === '' ? null : stripped;
}

/**
 * Detect any image content blocks anywhere in canonical.messages. Used by the
 * capability gate (D-C2): if true AND the registry entry lacks `vision`, throw
 * CapabilityNotSupportedError before calling the adapter.
 */
function canonicalHasImage(canonical: ReturnType<typeof anthropicRequestToCanonical>): boolean {
  for (const msg of canonical.messages) {
    for (const block of msg.content) {
      if (block.type === 'image') return true;
    }
  }
  return false;
}

export function registerMessagesRoute(
  app: FastifyInstance,
  opts: RegisterMessagesRouteOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/messages',
    { schema: { body: AnthropicMessagesRouteBodySchema } },
    async (req, reply) => {
      const body = req.body as {
        model: string;
        max_tokens: number;
        messages: unknown[];
        stream?: boolean;
        system?: string;
        [k: string]: unknown;
      };

      // Echo anthropic-version verbatim (ANTHR-05). Sanitized for length + CRLF.
      // Done early so even error envelopes carry the header.
      const echoed = sanitizeAnthropicVersion(req.headers['anthropic-version']);
      if (echoed !== null) {
        void reply.header('anthropic-version', echoed);
      }

      // Resolve model → entry → adapter. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + Anthropic envelope.
      const entry = opts.registry.resolve(body.model);
      req.resolvedBackend = entry.backend;       // Plan 08-03 (ROUTE-10) — stamp for onSend hook

      // Plan 08-05 (CLOUD-04 / D-C1, D-C2): cloud-served models hard-cap
      // max_tokens at CLOUD_MAX_TOKENS_CAP. Same guard as chat-completions.ts;
      // the Anthropic Messages request body's `max_tokens` is REQUIRED
      // (zod-validated as positive int at the route schema), so the typeof
      // check is defensive — schema already guarantees it. Throws
      // CloudMaxTokensExceededError → 400 + Anthropic envelope
      // (invalid_request_error) via the centralized error handler.
      //
      // Fires AFTER req.resolvedBackend stamp (X-Model-Backend still flows on
      // the 400 reply) and BEFORE the breaker.check / semaphore.acquire
      // chain inside the try block.
      if (
        entry.backend === 'ollama-cloud' &&
        typeof body.max_tokens === 'number' &&
        body.max_tokens > CLOUD_MAX_TOKENS_CAP
      ) {
        throw new CloudMaxTokensExceededError(
          body.max_tokens,
          CLOUD_MAX_TOKENS_CAP,
          entry.name,
        );
      }

      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // D-A3 / D-F3 — translate Anthropic body → canonical with backend_model remap.
      // anthropicRequestToCanonical throws ZodError on shape/refinement violations;
      // the centralized error handler maps to 400 + Anthropic envelope.
      const canonical = anthropicRequestToCanonical({ ...body, model: entry.backend_model });

      // D-C2: capability gating — fire BEFORE adapter call so the user gets a clean
      // 400 instead of a backend-side malformed-image error. Plan 04-04 will add
      // tools gating (D-C3 says it's soft — let the model see the tools and decline).
      if (canonicalHasImage(canonical) && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }

      // ── AbortController plumbing (mirrors chat-completions.ts) ──────────────
      const controller = new AbortController();
      // Mutable closure so onClose can also stop the heartbeat once the stream branch
      // starts it. No-op until then.
      let stopHeartbeat: (() => void) | null = null;
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
        stopHeartbeat?.();
      };
      // WR-05 (chat-completions.ts) — log when req.raw.socket is undefined so the
      // SC3 abort-propagation degradation is observable. Same logic as chat-completions.
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'messages: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      // Plan 05-02 Task 3 — idempotent record closure (Pitfall 8).
      // Mirrors chat-completions.ts byte-for-byte; only protocol + upstreamMessageId differ.
      let recorded = false;
      const safeRecord = (ctx: OutcomeContext): void => {
        if (recorded) return;
        recorded = true;
        req.__recorded = true;
        opts.recordOutcome(ctx);
      };

      let caughtErr: Error | undefined;
      let canonicalResult: CanonicalResponse | undefined;

      try {
        // Plan 08-04 (CLOUD-03) — per-backend circuit breaker. Mirrors
        // chat-completions.ts: fires AFTER capability gate, BEFORE semaphore
        // acquire. On 'open' throws BreakerOpenError (503); on 'half-open'
        // this caller is the probe — falls through.
        const breakerResult = await opts.breaker.check(entry.backend);
        if (breakerResult.state === 'open') {
          void reply.header('Retry-After', String(opts.breakerCooldownSec));
          throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
        }

        const semaphore = opts.semaphores.get(entry.backend);
        release = await semaphore.acquire(controller.signal);
        released = false;

        if (body.stream === true) {
          // ── STREAM BRANCH (Plan 04-03 — ANTHR-01 stream / ANTHR-06 / ANTHR-07) ─
          //
          // Issue #6 resolution: pre-stream input_tokens hint computed ONCE here
          // and passed to the adapter via the new opts arg. The adapter forwards
          // it into openAIChunksToCanonicalEvents (or the Plan 05 native /api/chat
          // branch's ollamaNativeChunksToCanonicalEvents) so the synthetic
          // message_start event already carries a wire-correct input_tokens. The
          // route does NOT intercept the canonical event stream to back-patch.
          const inputTokensHint = countTokens(canonical);

          let upstream: AsyncIterable<CanonicalStreamEvent>;
          try {
            // Some SDKs throw synchronously on bad params; some return a thenable
            // that rejects. Wrap in try/catch so a PRE-STREAM error becomes a JSON
            // Anthropic envelope (not a half-written SSE response).
            upstream = await adapter.chatCompletionsCanonicalStream(
              canonical,
              controller.signal,
              { inputTokensHint },
            );
          } catch (err) {
            // Plan 08-04 — pre-stream adapter error; fire-and-forget breaker
            // failure signal. Classifier filters non-trip errors.
            void opts.breaker.recordFailure(entry.backend, err);
            // HTTP not yet 200; emit Anthropic envelope.
            req.raw.socket?.off('close', onClose);
            const env = toAnthropicErrorEnvelope(err);
            const status = mapToHttpStatus(err);
            // CR-02 (05-VERIFICATION.md gaps[1]): pre-stream error must produce a
            // request_log row. safeRecord is idempotent via the recorded flag
            // (lines 201-207) so calling it here AND from the finally is
            // structurally safe — only the first call observes effects.
            // ANTHROPIC_NO_ENVELOPE → client disconnect (APIUserAbortError) records
            // as 'disconnect' status_class with the 'client_disconnect' error_code.
            // The pre-stream catch fires BEFORE message_start ships, so no
            // upstreamMessageId is yet captured.
            if (env === ANTHROPIC_NO_ENVELOPE) {
              safeRecord({
                protocol: 'anthropic',
                route: req.url.split('?')[0] ?? req.url,
                backend: entry.backend,
                model: entry.name,
                statusClass: 'disconnect',
                httpStatus: status,
                durationMs: performance.now() - (req._t0 ?? performance.now()),
                errorCode: 'client_disconnect',
                agentId: req.agentId,
                requestId: req.id,
                timestamp: new Date(),
              });
              return; // client gone — defensive
            }
            const errInst = err instanceof Error ? err : new Error(String(err));
            safeRecord({
              protocol: 'anthropic',
              route: req.url.split('?')[0] ?? req.url,
              backend: entry.backend,
              model: entry.name,
              statusClass: deriveStatusClass(status, false),
              httpStatus: status,
              durationMs: performance.now() - (req._t0 ?? performance.now()),
              errorCode: mapErrorToCode(errInst),
              errorMessage: errInst.message,
              agentId: req.agentId,
              requestId: req.id,
              timestamp: new Date(),
            });
            return reply.code(status).send(env);
          }

          // Start heartbeat AFTER upstream resolves but BEFORE consuming. The SSE
          // plugin flushes headers on the first iteration; starting before the first
          // yield is equivalent to "after the first byte" (RESEARCH §Pattern 3).
          // Stops in both onCleanup AND onClose's stopHeartbeat hook.
          const heartbeat = startAnthropicHeartbeat(reply.raw);
          stopHeartbeat = () => heartbeat.stop();

          // sseCleanup runs in canonicalToAnthropicSse's finally on stream end /
          // abort / error. CRITICAL (Pitfall 1 / T-3-D4): MUST call safeRelease so
          // the semaphore slot is released when the SSE stream closes — NOT when
          // the adapter call returns (which is immediately for streaming).
          //
          // Plan 05-02 Task 3: safeRecord with final tokens + msg_<ulid> passed
          // from canonicalToAnthropicSse's widened onCleanup signature.
          //
          // CR-03 (05-VERIFICATION.md gaps[2]): when the translator reports a
          // mid-stream upstream error via final.error, override status_class /
          // error_code / error_message to reflect the real outcome. Without this
          // override, reply.statusCode === 200 (SSE headers already flushed) +
          // controller.signal.aborted === false → deriveStatusClass returns
          // 'success' — the audit trail would record success for a wire-correct
          // error. upstreamMessageId continues to flow alongside (the override
          // does NOT drop it — mid-stream errors after message_start ships still
          // have a meaningful upstream_message_id to record). Reuses existing
          // helpers (mapToHttpStatus + mapErrorToCode) — NO new helper duplication.
          const sseCleanup = (final?: {
            tokensIn: number;
            tokensOut: number;
            upstreamMessageId?: string;
            error?: Error;
          }): void => {
            heartbeat.stop();
            req.raw.socket?.off('close', onClose);
            safeRelease();
            // Plan 08-04 — fire-and-forget breaker signaling on stream end.
            if (final?.error !== undefined) {
              void opts.breaker.recordFailure(entry.backend, final.error);
            } else {
              void opts.breaker.recordSuccess(entry.backend);
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
            safeRecord({
              protocol: 'anthropic',
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
              requestId: req.id,
              upstreamMessageId: final?.upstreamMessageId,
              timestamp: new Date(),
            });
          };

          // WR-04 fix (chat-completions.ts:194-208): wrap reply.sse in try/finally
          // so the heartbeat is always stopped, including when reply.sse rejects
          // synchronously (headers already sent / plugin degraded). heartbeat.stop()
          // is idempotent — calling it twice (here AND from sseCleanup) is safe.
          try {
            await reply.sse(
              canonicalToAnthropicSse(upstream, {
                signal: controller.signal,
                onCleanup: sseCleanup,
                // Plan 04-05: displayModel rewrites message_start.message.model to
                // the registry name so backend model ids don't leak through.
                displayModel: entry.name,
              }),
            );
          } finally {
            heartbeat.stop();
          }

          // Belt-and-suspenders log: if the request ended with a client-abort, log info.
          // Byte-equivalent to chat-completions.ts:207-216.
          if (controller.signal.aborted) {
            req.log.info(
              {
                url: req.url,
                bytesEmitted: heartbeat.bytesSinceStart,
                msSinceStart: heartbeat.msSinceStart,
              },
              'stream: client disconnected',
            );
          }
          return;
        }

        // ── NON-STREAM BRANCH (Plan 04-05 — displayModel seam consumption) ───
        // Plan 05-02 Task 3: capture canonicalResult on the OUTER scope so the
        // finally block can populate request_log.tokens_in / tokens_out / upstream_message_id.
        canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
        // Plan 08-04 — fire-and-forget breaker success signal.
        void opts.breaker.recordSuccess(entry.backend);

        // Plan 04-05 Issue #5 resolution: the route hands the canonical result to
        // canonicalToAnthropicResponse with { displayModel: entry.name } so the
        // wire `model` field is the REGISTRY name (not the upstream backend id).
        // The canonical object is NOT mutated — downstream observers (Phase 5
        // logging, tests) still see canonical.model verbatim.
        req.raw.socket?.off('close', onClose);
        return reply.send(
          canonicalToAnthropicResponse(canonicalResult, { displayModel: entry.name }),
        );
      } catch (err) {
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        // Plan 08-04 — fire-and-forget breaker failure signal. Skip the
        // BreakerOpenError case so a breaker-open response doesn't recurse
        // into recordFailure on itself.
        if (!(err instanceof BreakerOpenError)) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        safeRelease();

        // CR-02 (05-VERIFICATION.md gaps[1]) + CR-03 (Plan 05-05 Task 5 deviation):
        // The plan instructed to drop the `body.stream !== true` guard entirely
        // and rely on safeRecord idempotency. In practice, fastify-sse-v2's
        // reply.sse(asyncIterable) RETURNS IMMEDIATELY (it pipes the iterable
        // via it-to-stream; the stream completes asynchronously) — so the route
        // handler's outer finally fires BEFORE sseCleanup runs. Without a guard,
        // the outer finally records status_class='success' (caughtErr=undefined,
        // reply.statusCode=200) and sseCleanup's later call is a recorded=true
        // no-op — which silently regresses the stream-success observability AND
        // invalidates the CR-03 status_class override (the override happens
        // inside sseCleanup, but sseCleanup never gets to write the row).
        //
        // Resolution (deviation Rule 1): re-instate the body.stream guard, but
        // keep CR-02's intent intact by adding a `caughtErr` exception clause —
        // when a stream-branch path throws BEFORE reply.sse spawns the iterable
        // (e.g. the outer try threw between adapter call and the inner sseCleanup
        // wiring), the outer finally MUST record because sseCleanup will not
        // fire. The inner pre-stream catch (CR-02 Task 2) covers the most common
        // stream-error path; the caughtErr clause here is the safety net for
        // anything else that throws in the stream branch outer scope.
        if (body.stream !== true || caughtErr) {
          const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : reply.statusCode;
          safeRecord({
            protocol: 'anthropic',
            route: req.url.split('?')[0] ?? req.url,
            backend: entry.backend,
            model: entry.name,
            statusClass: caughtErr
              ? deriveStatusClass(httpStatus, false)
              : deriveStatusClass(reply.statusCode, false),
            httpStatus,
            durationMs: performance.now() - (req._t0 ?? performance.now()),
            tokensIn: caughtErr ? undefined : canonicalResult?.usage.input_tokens,
            tokensOut: caughtErr ? undefined : canonicalResult?.usage.output_tokens,
            errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
            errorMessage: caughtErr?.message,
            agentId: req.agentId,
            requestId: req.id,
            upstreamMessageId: canonicalResult?.id,
            timestamp: new Date(),
          });
        }
      }
    },
  );
}
