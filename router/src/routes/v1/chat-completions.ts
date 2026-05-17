import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startHeartbeat } from '../../sse/heartbeat.js';
import { openAIRequestToCanonical } from '../../translation/openai-in.js';
import { canonicalToOpenAIResponse, canonicalToOpenAISse } from '../../translation/openai-out.js';
import type { CanonicalResponse, CanonicalStreamEvent } from '../../translation/canonical.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  CloudMaxTokensExceededError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
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
 * OpenAI chat-completions request body. Required fields are zod-validated;
 * everything else (temperature, max_tokens, top_p, tools, tool_choice, response_format,
 * seed, presence_penalty, frequency_penalty, logit_bias, user, etc.) PASSES THROUGH
 * to the upstream SDK call without router-side reshaping.
 *
 * Phase 4 (Plan 04-01) flows the parsed body through openAIRequestToCanonical →
 * adapter.chatCompletionsCanonical{,Stream} → canonicalToOpenAIResponse|canonicalToOpenAISse.
 * The wire output stays byte-identical to Phase 2/3 (the existing chat-completions
 * integration tests are the regression gate).
 */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]), // string OR array of content blocks (vision in Phase 4)
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface RegisterChatCompletionsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  /** Per-backend semaphore map (Plan 03-04, ROUTE-07). */
  semaphores: { get(backend: string): BackendSemaphore };
  /**
   * Plan 05-02 (D-C6) — single helper that records prom-client metrics +
   * enqueues the request_log row. Called from BOTH sseCleanup (stream) and
   * the non-stream finally branch via a per-request safeRecord closure
   * (Pitfall 8 idempotency).
   */
  recordOutcome: RecordRequestOutcome;
  /**
   * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — per-backend circuit breaker. The
   * route calls breaker.check(entry.backend) AFTER capability gating and
   * BEFORE semaphore acquire; on state='open' throws BreakerOpenError (503).
   * recordSuccess/recordFailure are fire-and-forget around the adapter call.
   *
   * Construction lives in app.ts; tests pass either a real Valkey-backed
   * breaker or the no-op fallback (check always 'closed').
   */
  breaker: CircuitBreaker;
  /**
   * Plan 08-04 — Retry-After header value (seconds) when the breaker is
   * open. Derived from env.CIRCUIT_COOLDOWN_MS in app.ts so the route
   * doesn't need access to the env object.
   */
  breakerCooldownSec: number;
}

/**
 * Register POST /v1/chat/completions on the typed Fastify instance.
 *
 * Plan 04-01 (D-A3, D-F3): zod parse → openAIRequestToCanonical → adapter.canonical
 * → canonicalToOpenAI{Response,Sse}. The AbortController + onClose + safeRelease
 * + semaphore + heartbeat + sseCleanup plumbing is unchanged byte-for-byte from
 * Phase 3 — only the middle-three-lines translator pipeline differs.
 */
export function registerChatCompletionsRoute(
  app: FastifyInstance,
  opts: RegisterChatCompletionsOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionRequestSchema } },
    async (req, reply) => {
      const body = req.body;

      // Resolve model -> entry -> adapter. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + OpenAI envelope (D-C3 row).
      const entry = opts.registry.resolve(body.model);
      req.resolvedBackend = entry.backend;       // Plan 08-03 (ROUTE-10) — stamp for onSend hook

      // Plan 08-05 (CLOUD-04 / D-C1, D-C2): cloud-served models hard-cap
      // max_tokens at CLOUD_MAX_TOKENS_CAP (Ollama Cloud documented ceiling).
      // Reject (never silently clip — D-C1). The guard fires:
      //   - AFTER req.resolvedBackend stamp (so the 400 response still carries
      //     X-Model-Backend: ollama-cloud via Plan 08-03's onSend hook).
      //   - BEFORE the breaker.check (so a request that would 400 doesn't
      //     consume a half-open probe slot).
      //   - BEFORE semaphore.acquire (so it doesn't queue against the cloud
      //     semaphore).
      // Local models are unaffected — only entries with backend === 'ollama-cloud'
      // enforce the cap. typeof guard skips undefined max_tokens (the
      // OpenAI body schema is .passthrough() so the field may be absent).
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

      // Plan 04-01 (D-A3, D-F3): translate inbound OpenAI body → canonical with the
      // backend_model id remapped BEFORE translation so the canonical's `model` field
      // already points to the upstream model id when the adapter receives it.
      // openAIRequestToCanonical throws ZodError on shape violations — the centralized
      // error handler maps to 400 + invalid_request envelope (envelope.ts:60-69).
      const canonical = openAIRequestToCanonical({ ...body, model: entry.backend_model });

      // Plan 04-05 D-C2 / VISION-02: capability gating on the OpenAI surface too.
      // Fire BEFORE semaphore acquire / adapter call so non-vision-model image
      // requests get a clean 400 without consuming a slot. CapabilityNotSupportedError
      // → 400 + OpenAI envelope (model_capability_mismatch) per envelope.ts.
      const hasImage = canonical.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'),
      );
      if (hasImage && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }

      // ── AbortController: load-bearing for SC3 ──────────────────────────────
      // The signal is forwarded to undici by the openai SDK, which closes the
      // upstream TCP socket when controller.abort() fires. RESEARCH Pitfall 2.
      const controller = new AbortController();

      // BLOCKER fix (D-C4): exactly ONE 'close' listener; heartbeat-stop wired through
      // a mutable closure variable so the listener can clean up BOTH the abort and the
      // heartbeat. Adding a second anonymous listener would leak (no .off() ref).
      let stopHeartbeat: (() => void) | null = null;

      // IMPORTANT: Use req.raw.socket.once('close') NOT req.raw.once('close').
      // IncomingMessage 'close' fires when the HTTP message body is fully consumed
      // by Fastify's body parser — i.e., IMMEDIATELY after the body is parsed, not
      // when the TCP connection closes. This was verified empirically in plan 02-03
      // (see "Socket vs IncomingMessage close" decision) and confirmed in plan 02-04
      // live testing: using req.raw.once('close') caused controller.abort() to fire
      // before chatCompletionsStream() was called, producing empty 200 responses.
      // Socket 'close' fires only when the underlying TCP connection is destroyed,
      // which is the correct signal for client disconnect.
      // Not using req.raw.once('aborted') because 'aborted' is HTTP/1.1-only.
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
        stopHeartbeat?.();  // no-op until heartbeat starts in the stream branch
      };
      // WR-05 fix: silent optional-chain previously masked the no-socket case
      // (app.inject() under vitest; future HTTP/2 where IncomingMessage.socket
      // detaches). Without a `socket`, the 'close' listener never registers and
      // SC3 (client-disconnect → abort propagation) silently degrades to "router
      // holds the stream open until upstream completes". Log a warn when this
      // happens so the degradation is observable in production logs.
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'stream: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      // ── Semaphore acquire (Plan 03-04, D-B5) ─────────────────────────────────
      // Acquire BEFORE the adapter call. If the backend is saturated the acquire
      // rejects with BackendSaturatedError which is caught in the outer catch below
      // and forwarded to the centralized error handler as a 429.
      //
      // The signal is controller.signal so a client disconnect (onClose → controller.abort())
      // also aborts the queue-wait (T-3-D6 mitigation).
      //
      // IMPORTANT: The acquire is inside the try block so that BackendSaturatedError
      // is caught by the catch clause that sets the Retry-After header before re-throw.
      // If acquire were outside the try, the header would never be set.
      //
      // WR-01 fix: opts.semaphores.get() is also inside the try block so a missing
      // semaphore entry (hot-reload adds a new backend whose Map entry was not rebuilt
      // — IN-01 forward-looking issue) cleans up the socket 'close' listener via the
      // catch clause's req.raw.socket?.off('close', onClose) call.

      // Idempotent release closure — mirrors heartbeat.stop() pattern.
      // Called from BOTH the finally block AND sseCleanup (Pitfall 1 / T-3-D4).
      // Initialized as a no-op until acquire succeeds; ensures finally never panics.
      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      // Plan 05-02 Task 3 (Pitfall 8): idempotent record closure mirrors the
      // safeRelease shape. sseCleanup may fire twice in rare error paths
      // (stream end + onClose + error handler); without this guard we'd
      // double-row the request_log AND double-count the metric.
      let recorded = false;
      const safeRecord = (ctx: OutcomeContext): void => {
        if (recorded) return;
        recorded = true;
        req.__recorded = true; // suppress app.setErrorHandler from also recording
        opts.recordOutcome(ctx);
      };

      // Captured by both catch + finally so safeRecord can know whether to
      // populate error_code / errorMessage vs tokens.
      let caughtErr: Error | undefined;
      let canonicalResult: CanonicalResponse | undefined;

      try {
        // Plan 08-04 (CLOUD-03) — per-backend circuit breaker gate. Fires AFTER
        // capability gating (above) and BEFORE semaphore acquire so a backend
        // outage fails fast in <1ms without consuming a slot. On state='open',
        // throw BreakerOpenError (503 + structured envelope); on 'half-open',
        // this caller IS the probe — fall through to the adapter call.
        const breakerResult = await opts.breaker.check(entry.backend);
        if (breakerResult.state === 'open') {
          // Stamp Retry-After header BEFORE throw so the centralized error
          // handler's envelope ships with the back-off hint (mirror of
          // BackendSaturatedError's Retry-After pattern below).
          void reply.header('Retry-After', String(opts.breakerCooldownSec));
          throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
        }

        // Lookup the semaphore for the resolved backend. Inside the try so a missing
        // entry routes through the centralized error handler with proper listener cleanup.
        const semaphore = opts.semaphores.get(entry.backend);
        // Acquire the semaphore slot INSIDE the try block so BackendSaturatedError
        // is caught below and Retry-After can be set before re-throw.
        release = await semaphore.acquire(controller.signal);
        released = false; // reset: the slot is now held
        if (body.stream === true) {
          // ── STREAM BRANCH (RESEARCH §Pattern 3 — load-bearing for SC1 + SC3) ──
          let upstream: AsyncIterable<CanonicalStreamEvent>;
          try {
            // Some SDKs throw synchronously on bad params; some return a thenable that
            // rejects. Wrap in try/catch so a PRE-STREAM error becomes a JSON envelope
            // rather than starting an SSE response we can't recover from.
            upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
          } catch (err) {
            // Plan 08-04 — pre-stream adapter error (the SDK threw before the
            // stream began). The classifier filters non-trip errors; fire-and-
            // forget so the JSON envelope below isn't delayed by Valkey RTT.
            void opts.breaker.recordFailure(entry.backend, err);
            // HTTP not yet 200; emit envelope.
            req.raw.socket?.off('close', onClose);
            const env = toOpenAIErrorEnvelope(err);
            const status = mapToHttpStatus(err);
            // CR-02 (05-VERIFICATION.md gaps[1]): pre-stream error must produce a
            // request_log row. safeRecord is idempotent via the recorded flag (lines
            // 181-187) so calling it here AND from the finally is structurally safe —
            // only the first call observes effects. NO_ENVELOPE → client disconnect
            // (APIUserAbortError) records as 'disconnect' status_class with the
            // 'client_disconnect' error_code. Regular envelope → typed error_code
            // via mapErrorToCode + redactable error_message via err.message.
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
                agentId: req.agentId,
                requestId: req.id,
                timestamp: new Date(),
              });
              return; // client gone — defensive
            }
            const errInst = err instanceof Error ? err : new Error(String(err));
            safeRecord({
              protocol: 'openai',
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

          // Start the heartbeat AFTER the upstream resolves but BEFORE consuming.
          // Pattern 3 line 488 starts it after the first byte; in our shape, reply.sse(...)
          // flushes headers on the first iteration, so starting before the first yield
          // is equivalent. Stops in the iterator's onCleanup AND via onClose's stopHeartbeat
          // hook (single listener, belt-and-suspenders cleanup paths).
          const heartbeat = startHeartbeat(reply.raw);
          stopHeartbeat = () => heartbeat.stop();  // wires onClose to also stop heartbeat

          // sseCleanup is called by canonicalToOpenAISse onCleanup on stream end / abort / error.
          // CRITICAL (Pitfall 1 / T-3-D4): sseCleanup MUST call safeRelease so the semaphore
          // slot is released when the SSE stream closes — NOT when the adapter call returns
          // (which is immediately for streaming). Revision 1 Warning 7 makes this grep-verifiable.
          //
          // Plan 05-02 Task 3: also call safeRecord with the final tokens passed
          // from canonicalToOpenAISse's widened onCleanup signature. The route is
          // the structural enforcement point for the request_log row (D-D6).
          //
          // CR-03 (05-VERIFICATION.md gaps[2]): when the translator reports a
          // mid-stream upstream error via final.error, override status_class /
          // error_code / error_message to reflect the real outcome. Without this
          // override, reply.statusCode === 200 (SSE headers already flushed) +
          // controller.signal.aborted === false → deriveStatusClass returns
          // 'success' — the audit trail would record success for a wire-correct
          // error. Reuses existing helpers (mapToHttpStatus + mapErrorToCode) —
          // NO new helper duplication.
          const sseCleanup = (final?: {
            tokensIn: number;
            tokensOut: number;
            error?: Error;
          }): void => {
            heartbeat.stop();
            req.raw.socket?.off('close', onClose);
            safeRelease();  // Pitfall 1 mitigation — slot released on stream end/abort/error
            // Plan 08-04 — stream-branch breaker signaling. Fire-and-forget so
            // sseCleanup stays synchronous. final.error => recordFailure
            // (the classifier filters non-trip errors anyway); otherwise
            // recordSuccess closes a half-open probe / no-op on closed.
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
              requestId: req.id,
              timestamp: new Date(),
            });
          };

          // The SSE plugin sets Content-Type + Cache-Control + Connection on first yield
          // and calls reply.raw.end() when the iterable completes.
          //
          // WR-04 fix: wrap in try/finally so the heartbeat is always stopped, including
          // when `reply.sse(...)` rejects synchronously (e.g., headers already sent /
          // plugin in a degraded state). Without this, the `onCleanup` callback inside
          // the iterator never runs, and `onClose`/`stopHeartbeat` may also have been
          // detached, leaving an unref'd interval scheduled until the next EPIPE.
          // `heartbeat.stop()` is idempotent — calling it twice (here AND from
          // sseCleanup) is safe.
          try {
            await reply.sse(canonicalToOpenAISse(upstream, {
              signal: controller.signal,
              onCleanup: sseCleanup,
              // Plan 04-05: registry name on the wire (parity with Anthropic surface).
              displayModel: entry.name,
            }));
          } finally {
            heartbeat.stop();
          }

          // Belt-and-suspenders log: if the request ended with a client-abort, log info.
          if (controller.signal.aborted) {
            req.log.info({
              url: req.url,
              bytesEmitted: heartbeat.bytesSinceStart,
              msSinceStart: heartbeat.msSinceStart,
            }, 'stream: client disconnected');
          }
          return;
        }

        // ── NON-STREAM BRANCH (Plan 04-01 D-A3 / D-F3) ───────────────────────
        // adapter.chatCompletionsCanonical returns a CanonicalResponse; we map it
        // back to OpenAI ChatCompletion shape (preserving body.id via _upstreamId).
        // Plan 04-05: pass displayModel so the wire `model` field is the registry
        // name (parity with the Anthropic surface).
        // Plan 05-02 Task 3: capture canonicalResult on the OUTER scope so the
        // finally block can populate request_log.tokens_in / tokens_out for the
        // non-stream branch.
        canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
        // Plan 08-04 — fire-and-forget breaker success signal. Not awaited so
        // it doesn't add tail latency to the response. If Valkey is slow / down,
        // the breaker's internal client-options (lazyConnect:false +
        // enableOfflineQueue:false) surface a rejection that pino logs via the
        // breaker's `log.warn`; the route is unaffected.
        void opts.breaker.recordSuccess(entry.backend);
        req.raw.socket?.off('close', onClose);
        return reply.send(canonicalToOpenAIResponse(canonicalResult, { displayModel: entry.name }));
      } catch (err) {
        // Defense in depth — anything thrown synchronously / from the non-stream branch
        // ends up here. setErrorHandler in app.ts will turn it into the OpenAI envelope;
        // re-throw so the centralized handler sees it.
        //
        // BackendSaturatedError: set Retry-After header before re-throw (per 03-PATTERNS.md
        // line 705-707). The centralized error handler in app.ts maps the error to 429 +
        // rate_limit_error envelope; we set the header here so it's present on the reply.
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        // Plan 08-04 — fire-and-forget breaker failure signal. The classifier
        // (isBreakerTrip) filters out non-trip errors (4xx, ZodError, abort,
        // BreakerOpenError itself), so calling on every catch is safe; only
        // trip-eligible errors actually increment the counter. NOT awaited
        // (same rationale as the success path).
        if (!(err instanceof BreakerOpenError)) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        // Always release the semaphore slot. safeRelease is idempotent — if sseCleanup
        // already called it (stream end / abort), this is a no-op. For non-stream and
        // error paths, this is the primary release point.
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
          // Status / http_status from reply (set by reply.send for success or by
          // the centralized error handler for re-thrown errors).
          const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : reply.statusCode;
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
            tokensIn: caughtErr ? undefined : canonicalResult?.usage.input_tokens,
            tokensOut: caughtErr ? undefined : canonicalResult?.usage.output_tokens,
            errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
            errorMessage: caughtErr?.message,
            agentId: req.agentId,
            requestId: req.id,
            timestamp: new Date(),
          });
        }
      }
    },
  );
}
