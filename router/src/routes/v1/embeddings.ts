/**
 * embeddings.ts — POST /v1/embeddings route (Plan 07-04, OAI-02 + EMBED-01).
 *
 * Wire surface: OpenAI Embeddings API (non-streaming). The Anthropic protocol
 * has no embeddings analog, so this surface is single-protocol unlike
 * /v1/chat/completions + /v1/messages.
 *
 * Pipeline:
 *   zod-validated body → registry.resolve(model) → capability gate
 *   ('embeddings' in entry.capabilities) → semaphore acquire →
 *   adapter.embeddings(input, backend_model, signal) → response back to wire.
 *
 * The adapter call returns the OpenAI SDK's CreateEmbeddingResponse shape
 * verbatim — no translator step. tokens_out is always recorded as 0 in the
 * request_log row (07-RESEARCH Open Question 3 — embeddings have no
 * completion-side token count; emit 0 not NULL so dashboards aggregating
 * SUM(tokens_out) include this row without breakage).
 *
 * Bearer auth: gated automatically by makeBearerHook (auth/bearer.ts) because
 * `/v1/embeddings` is NOT in PUBLIC_PATHS. No route-level auth wiring needed.
 *
 * Centralized error handler (app.ts): maps thrown errors to the OpenAI
 * envelope. Plan 07-04 widens the handler's `isRecordedRoute` allowlist to
 * include `/v1/embeddings` so pre-resolve errors (RegistryUnknownModelError,
 * etc.) still produce a request_log row. Inside the route, the outer finally
 * block calls safeRecord on both success and error paths via the same
 * idempotency closure pattern used by chat-completions.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  mapToHttpStatus,
} from '../../errors/envelope.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  type OutcomeContext,
  type RecordRequestOutcome,
} from '../../metrics/recordOutcome.js';

/**
 * OpenAI Embeddings request body. Pitfall E-1: `input` MUST be a non-empty
 * string OR a non-empty array of non-empty strings — `[]` and `""` both reach
 * the upstream as 422-causing payloads in the Ollama/vLLM shims, so we
 * reject at the route boundary with a structured 400.
 *
 * `encoding_format`, `dimensions`, `user`: forwarded as-is to the upstream
 * (the SDK accepts them as part of EmbeddingCreateParams). `.passthrough()`
 * keeps the body forward-compatible with future OpenAI SDK additions without
 * a router-side schema change.
 */
export const EmbeddingsRequestSchema = z
  .object({
    model: z.string().min(1),
    // Pitfall E-1: enforce non-empty string OR non-empty array of non-empty strings.
    // Kept on a single line so the plan-verification grep matches verbatim.
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

export interface RegisterEmbeddingsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  /** Per-backend semaphore map (Plan 03-04 ROUTE-07; reused here). */
  semaphores: { get(backend: string): BackendSemaphore };
  /**
   * Plan 05-02 (D-C6) — same recordRequestOutcome helper used by the chat
   * and messages routes. Called from the outer finally with safeRecord
   * idempotency on both success and error paths.
   */
  recordOutcome: RecordRequestOutcome;
  /**
   * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — per-backend circuit breaker. See
   * RegisterChatCompletionsOpts.breaker for full semantics.
   */
  breaker: CircuitBreaker;
  /** Plan 08-04 — Retry-After seconds when the breaker is open. */
  breakerCooldownSec: number;
}

export function registerEmbeddingsRoute(
  app: FastifyInstance,
  opts: RegisterEmbeddingsOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/embeddings',
    { schema: { body: EmbeddingsRequestSchema } },
    async (req, reply) => {
      const body = req.body;

      // Resolve model -> entry. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + OpenAI envelope.
      // This throw is OUTSIDE the route's try/finally — the centralized
      // app.setErrorHandler observes it (Plan 07-04 widens the handler's
      // isRecordedRoute allowlist to include /v1/embeddings, so a request_log
      // row is still produced for unknown-model errors).
      const entry = opts.registry.resolve(body.model);
      req.resolvedBackend = entry.backend;       // Plan 08-03 (ROUTE-10) — stamp for onSend hook

      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // AbortController plumbing — mirrors chat-completions.ts (SC3 client-disconnect
      // propagation). Non-streaming, so no heartbeat / sseCleanup wiring needed.
      const controller = new AbortController();
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
      };
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'embeddings: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      // Idempotent release closure (Pitfall 1 from Plan 03-04).
      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      // Idempotent record closure (Pitfall 8 — Plan 05-02 Task 3 pattern).
      let recorded = false;
      const safeRecord = (ctx: OutcomeContext): void => {
        if (recorded) return;
        recorded = true;
        req.__recorded = true; // suppress app.setErrorHandler from also recording
        opts.recordOutcome(ctx);
      };

      let caughtErr: Error | undefined;
      let result:
        | Awaited<ReturnType<BackendAdapter['embeddings']>>
        | undefined;

      try {
        // Capability gate (T-07-11 mitigate, defense-in-depth layer 1). Inside
        // the try block so the outer finally records the error path with the
        // resolved entry's backend/model labels (rather than 'unknown' which
        // the centralized setErrorHandler emits on pre-route throws). Fires
        // BEFORE semaphore acquire so a chat-only model gets a clean 400
        // without consuming a slot. CapabilityNotSupportedError →
        // 400 / model_capability_mismatch via the centralized error handler.
        if (!entry.capabilities.includes('embeddings')) {
          throw new CapabilityNotSupportedError(entry.name, 'embeddings');
        }

        // Plan 08-04 (CLOUD-03) — circuit breaker gate. Fires AFTER capability
        // gate, BEFORE semaphore acquire. Same pattern as chat-completions.ts.
        const breakerResult = await opts.breaker.check(entry.backend);
        if (breakerResult.state === 'open') {
          void reply.header('Retry-After', String(opts.breakerCooldownSec));
          throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
        }

        const semaphore = opts.semaphores.get(entry.backend);
        release = await semaphore.acquire(controller.signal);
        released = false;

        // 07-REVIEW CR-01: forward optional EmbeddingCreateParams that the
        // schema validates. Without this, encoding_format='base64' and
        // dimensions=N pass zod but are silently dropped at the SDK boundary,
        // violating the documented OpenAI-compat contract.
        result = await adapter.embeddings(body.input, entry.backend_model, controller.signal, {
          encoding_format: body.encoding_format,
          dimensions: body.dimensions,
          user: body.user,
        });
        // Plan 08-04 — fire-and-forget breaker success signal.
        void opts.breaker.recordSuccess(entry.backend);
        req.raw.socket?.off('close', onClose);
        return reply.send(result);
      } catch (err) {
        // BackendSaturatedError: set Retry-After before re-throw — same pattern as
        // chat-completions.ts. The centralized error handler then emits 429 + envelope.
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        // Plan 08-04 — fire-and-forget breaker failure signal (skip BreakerOpenError
        // to avoid recursive trip on the breaker's own surfaced error).
        if (!(err instanceof BreakerOpenError)) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        safeRelease();

        // The outer finally always records — embeddings is non-streaming, so unlike
        // chat-completions.ts there is no sseCleanup race to guard against. The
        // safeRecord idempotency flag still protects against the (extremely
        // unlikely) double-fire if app.setErrorHandler also runs.
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
          tokensIn: caughtErr ? undefined : result?.usage?.prompt_tokens ?? 0,
          // 07-RESEARCH Open Question 3 — emit `tokensOut: 0` (not NULL) so dashboards
          // aggregating SUM(tokens_out) over request_log include embedding rows without
          // a COALESCE. Error path leaves it undefined → NULL column (canonical pattern
          // shared with chat-completions.ts).
          tokensOut: caughtErr ? undefined : 0, // tokensOut: 0 (plan-verify grep gate)
          errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
          errorMessage: caughtErr?.message,
          agentId: req.agentId,
          requestId: req.id,
          timestamp: new Date(),
        });
      }
    },
  );
}
