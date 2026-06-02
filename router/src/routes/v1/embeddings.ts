/**
 * embeddings.ts — POST /v1/embeddings route (Plan 07-04, OAI-02 + EMBED-01).
 *
 * Phase 19 (v0.11.0 — EMBP-02): route refactored to delegate the
 * upstream-call + cache + dims-enforcement triad to
 * req.server.embeddingProvider.embed(...) (D-09 / D-10).
 *
 * The route is now a thin wrapper:
 *   applyPreflight → idempotency leader/follower
 *   → batch-size observe (D-07 — wire metric stays in route)
 *   → base64-bypass-increment (Risk #2 Option A — route owns this)
 *   → provider.embed(inputs, opts)
 *   → re-encode base64 if requested (D-02 — provider always returns number[][])
 *   → OpenAI list re-wrap
 *   → stamp cost BEFORE reply.send() (project_fastify_onsend_timing.md)
 *   → recordOutcome (finally)
 *
 * Wire surface: OpenAI Embeddings API (non-streaming). The Anthropic protocol
 * has no embeddings analog, so this surface is single-protocol unlike
 * /v1/chat/completions + /v1/messages.
 *
 * Bearer auth: gated automatically by makeBearerHook (auth/bearer.ts) because
 * /v1/embeddings is NOT in PUBLIC_PATHS. No route-level auth wiring needed.
 *
 * Centralized error handler (app.ts): maps thrown errors to the OpenAI envelope.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  EmbeddingsDimsMismatchError,
  RegistryUnknownModelError,
  mapToHttpStatus,
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
import type { EmbeddingProvider } from '../../providers/embedding-provider.js';

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
  /**
   * Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — optional idempotency multiplexer.
   * Embeddings is non-streaming, so the wiring is simpler than chat /
   * messages: leader runs the adapter and publishes the response body;
   * followers replay the cached body.
   */
  idempotency?: IdempotencyMultiplexer;
  /**
   * Phase 19 (v0.11.0 — EMBP-02 / D-10): optional EmbeddingProvider for
   * test injection (option-bag fallback when fastify.embeddingProvider
   * decorator is absent). Production composition root (index.ts — Plan 19-04)
   * wires the provider via BuildAppOpts.embeddingProvider → app.decorate.
   * Test fixtures that exercise cache behavior construct a provider via
   * makeOpenAIEmbeddingProvider({ cacheOverride, ... }) and pass it here.
   */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Phase 19 (v0.11.0 — EMBP-02 / D-07) — narrow metrics surface the route
   * reads. Mirrors chat-completions.ts.metrics: tests can pass undefined and
   * the route still functions (no metric observation). Route only reads
   * embeddingsBatchSize (D-07) and embeddingsCacheTotal for the base64 bypass
   * counter (Risk #2 Option A). The provider owns cache hit/miss and dims
   * metrics.
   */
  metrics?: {
    embeddingsCacheTotal: { inc(labels: { result: 'hit' | 'miss' | 'bypass' }): void };
    embeddingsBatchSize: { observe(value: number): void };
  };
}

/**
 * Encode a number[] vector to a base64 string using little-endian float32
 * representation (matches the OpenAI Embeddings API base64 encoding convention
 * used by sentence-transformer servers).
 *
 * D-02: Provider always returns number[][]; when the client requests
 * encoding_format='base64', the route re-encodes at the wire boundary.
 */
function encodeBase64(vec: number[]): string {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i] as number, i * 4);
  }
  return buf.toString('base64');
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

      // Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): consolidated preflight.
      // applyPreflight runs resolve → applyPolicyGate → breaker.check in one
      // helper, shared with MCP tool handlers (Wave 4). Throws propagate to the
      // centralized error handler (404 / 403 envelopes); breakerState='open' is
      // RETURNED so the HTTP caller stamps Retry-After before the BreakerOpenError
      // throw. POL-05 (gate-before-breaker) preserved structurally inside the
      // helper.
      const { entry, breakerState } = await applyPreflight(body.model, {
        registry: opts.registry,
        breaker: opts.breaker,
      });
      req.resolvedBackend = entry.backend;       // Plan 08-03 (ROUTE-10) — stamp for onSend hook
      if (breakerState === 'open') {
        void reply.header('Retry-After', String(opts.breakerCooldownSec));
        throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
      }

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

      // Phase 19 review-deferred fix: semaphore acquisition moved into the
      // provider (scoped to the actual adapter.embeddings call), so the
      // route no longer needs a release closure. Pre-fix the route held a
      // slot through the entire cache-lookup path, inverting EMB-H01's
      // intent (hot cache should be free, not throttled). The provider
      // receives `semaphores` via its factory opts in the composition root.
      // `safeRelease` retained as a no-op so call sites stay symmetrical
      // (the catch block + finally still invoke it).
      const safeRelease = (): void => {};

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
        | {
            object: 'list';
            data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }>;
            model: string;
            usage: { prompt_tokens: number; total_tokens: number };
          }
        | undefined;

      // Plan 08-07 (ROUTE-12 / D-D5) — extract + validate Idempotency-Key.
      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyRole: 'leader' | 'follower' | undefined;
      let followerUpstreamMessageId: string | undefined;

      try {
        // Capability gate (T-07-11 mitigate, defense-in-depth layer 1). Inside
        // the try block so the outer finally records the error path with the
        // resolved entry's backend/model labels (rather than 'unknown' which
        // the centralized setErrorHandler emits on pre-route throws). Fires
        // BEFORE semaphore acquire so a chat-only model gets a clean 400
        // without consuming a slot.
        if (!entry.capabilities.includes('embeddings')) {
          throw new CapabilityNotSupportedError(entry.name, 'embeddings');
        }

        // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency-Key acquire +
        // follower replay. Embeddings is always non-stream, so the follower
        // path always uses awaitNonStreamResult.
        if (idempotencyKey && opts.idempotency) {
          const acq = await opts.idempotency.acquire(idempotencyKey, req.id);
          idempotencyRole = acq.role;
          if (acq.role === 'follower') {
            const { body: cachedBody, upstreamMessageId } =
              await opts.idempotency.awaitNonStreamResult(idempotencyKey, req.id);
            followerUpstreamMessageId = upstreamMessageId;
            req.raw.socket?.off('close', onClose);
            return reply.send(cachedBody);
          }
        }

        // Phase 12 (EMB-H03): observe batch size before any cache work — we want
        // the histogram to reflect what the client SENT, not what we ended up
        // fetching after cache deduplication. D-07: wire-shape metric stays in route.
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        opts.metrics?.embeddingsBatchSize.observe(inputs.length);

        // Phase 19 review fix (Risk #2): the route NO LONGER emits the
        // `bypass` metric. The provider now owns it (alongside hit/miss),
        // because it knows whether the cache is actually wired. Emitting
        // bypass from the route resulted in:
        //   - double counts (route bypass + provider hit/miss for the same input)
        //   - bypass emissions when no cache existed (predicate drifted to
        //     `metrics presence` instead of `cache presence`)
        // The provider receives encoding_format via callOpts and decides.

        // Phase 19 (EMBP-02 / D-09 / D-10): delegate upstream call + cache +
        // dims-enforcement to EmbeddingProvider. The provider is sourced from:
        //   1. opts.embeddingProvider (test injection option-bag — Plan 19-03)
        //   2. req.server.embeddingProvider (Fastify decorator — Plan 19-04)
        // If neither is available, throw a clear error (should never happen in
        // production — composition root always provides a provider).
        const provider: EmbeddingProvider | undefined =
          opts.embeddingProvider ??
          (req.server as { embeddingProvider?: EmbeddingProvider }).embeddingProvider;
        if (!provider) {
          throw new Error(
            'embeddings: EmbeddingProvider not injected via opts or fastify.embeddingProvider decorator',
          );
        }

        // Phase 19 review-deferred fix: semaphore acquisition moved inside
        // the provider, scoped to the actual adapter.embeddings() call. The
        // route no longer acquires here so all-cache-hit requests don't
        // consume a concurrency slot. opts.semaphores is still threaded
        // into the provider via the composition root (index.ts + app.ts).

        const providerResult = await provider.embed(inputs, {
          model: body.model,
          dimensions: body.dimensions,
          user: body.user,
          // Phase 19 review fix: thread encoding_format so the provider can
          // honor EMB-H06 (base64 bypasses cache) without the route emitting
          // a parallel bypass metric.
          encoding_format: body.encoding_format,
          // Phase 19 review fix: thread the AbortSignal so the upstream HTTP
          // call inside the adapter is actually cancelled on client disconnect
          // (SC3 propagation — was previously dropped at the provider boundary
          // via `undefined as unknown as AbortSignal`).
          signal: controller.signal,
          // Phase 19 review-deferred fix: pass the already-resolved entry so
          // the provider does NOT re-resolve. Without this, a models.yaml
          // hot-reload between applyPreflight (above) and provider.embed
          // would yield two different ModelEntries — semaphore acquired on
          // one backend, upstream HTTP call against another. `entry` is from
          // the same applyPreflight snapshot used for breaker + recordOutcome
          // + request_log stamping.
          entry,
          // Phase 19 review-deferred fix: hand the provider the specific
          // BackendSemaphore for entry.backend so it acquires ONLY when an
          // upstream call is needed (cache misses). Pre-fix the route held
          // a slot through cache-lookups too, inverting EMB-H01.
          semaphore: opts.semaphores.get(entry.backend),
        });

        // Plan 08-04 — fire-and-forget breaker success signal.
        void opts.breaker.recordSuccess(entry.backend);

        // D-02: re-encode to base64 if client asked. Provider always returns
        // number[][] (float). Route re-encodes at the wire boundary.
        const data = providerResult.embeddings.map((vec, i) => ({
          object: 'embedding' as const,
          index: i,
          embedding: (body.encoding_format === 'base64' ? encodeBase64(vec) : vec) as
            | number[]
            | string,
        }));

        result = {
          object: 'list' as const,
          data,
          model: providerResult.model,
          usage: providerResult.usage,
        };

        // Phase 13 (v0.10.0 — COST-02/04): stamp req.computedCostCents BEFORE
        // reply.send() — Fastify v5 onSend fires synchronously inside .send().
        // Outer finally still records the same cost to the request_log row.
        // D-08: route owns cost; provider returns usage (cache-miss only).
        const earlyCost =
          computeCostCents({
            entry,
            tokensIn: result.usage?.prompt_tokens ?? 0,
            tokensOut: 0,
          }) ?? undefined;
        if (earlyCost !== undefined) {
          req.computedCostCents = earlyCost;
        }

        // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — leader publishes the embeddings
        // response body so concurrent followers can replay it.
        if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
          try {
            const upstreamId = (result as { id?: string }).id;
            await opts.idempotency.publishNonStream(idempotencyKey, result, upstreamId);
          } catch (err) {
            req.log.warn(
              { err, idempotencyKey },
              'idempotency: publishNonStream failed (leader response still returned)',
            );
          }
        }
        // Phase 19 review fix (CR-02): remove the socket close listener on the
        // success path. Pre-Phase-19 the route did this off() here; the refactor
        // dropped it, leaving the controller closure pinned on keep-alive
        // sockets and risking phantom abort() on subsequent requests reusing
        // the same socket. Mirrors the follower (L240) and catch (L350) paths.
        req.raw.socket?.off('close', onClose);
        return reply.send(result);
      } catch (err) {
        // BackendSaturatedError: set Retry-After before re-throw — same pattern as
        // chat-completions.ts. The centralized error handler then emits 429 + envelope.
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        // Plan 08-04 — fire-and-forget breaker failure signal.
        // Skip BreakerOpenError (avoid recursive trip on the breaker's own surfaced error).
        // Phase 19 review fix (recordFailure scope): also skip provider-internal errors
        // that do NOT represent a backend failure — RegistryUnknownModelError /
        // CapabilityNotSupportedError / EmbeddingsDimsMismatchError can be raised
        // by the provider's internal re-resolve and validation when the registry
        // is mutated mid-request or when an upstream returns an out-of-contract
        // shape; attributing those to the backend trips the breaker and takes
        // out unrelated routes (chat-completions) on the same backend.
        if (
          !(err instanceof BreakerOpenError) &&
          !(err instanceof RegistryUnknownModelError) &&
          !(err instanceof CapabilityNotSupportedError) &&
          !(err instanceof EmbeddingsDimsMismatchError)
        ) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        safeRelease();

        // The outer finally always records — embeddings is non-streaming, so unlike
        // chat-completions.ts there is no sseCleanup race to guard against.
        const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : reply.statusCode;
        const tokensIn = caughtErr ? undefined : result?.usage?.prompt_tokens ?? 0;
        const tokensOut = caughtErr ? undefined : 0; // tokensOut: 0 (plan-verify grep gate)
        // Phase 13 (v0.10.0 — COST-01/02/04): embeddings cost computed from
        // upstream usage. For cloud-served embeddings the rate-card lives in
        // entry.pricing; for local backends pricing is absent and the helper
        // returns null → no header, no cost_cents column.
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
          upstreamMessageId: followerUpstreamMessageId,
          idempotencyKey,
          costCents,
          timestamp: new Date(),
        });
      }
    },
  );
}
