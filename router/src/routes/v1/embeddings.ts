/**
 * embeddings.ts — POST /v1/embeddings route (Plan 07-04, OAI-02 + EMBED-01).
 *
 * Wire surface: OpenAI Embeddings API (non-streaming). The Anthropic protocol
 * has no embeddings analog, so this surface is single-protocol unlike
 * /v1/chat/completions + /v1/messages.
 *
 * Pipeline (Phase 7 baseline):
 *   zod-validated body → registry.resolve(model) → capability gate
 *   ('embeddings' in entry.capabilities) → semaphore acquire →
 *   adapter.embeddings(input, backend_model, signal) → response back to wire.
 *
 * Phase 12 (v0.10.0 — EMB-H01..06) additions:
 *
 *   - Per-input-item Valkey cache keyed by (backend, backend_model, encoding_format,
 *     dimensions, input). Batch inputs are looked up item-by-item; misses go to the
 *     adapter as a sub-batch preserving order; the response is reassembled into the
 *     original input order. (EMB-H01, EMB-H05)
 *
 *   - Dims enforcement: when entry.dims is declared (now required for any
 *     embeddings-capability model — see registry.ts superRefine), the route refuses
 *     any vector whose length does not match. Throws EmbeddingsDimsMismatchError →
 *     500 + structured log. (EMB-H02)
 *
 *   - Three new metrics: router_embeddings_cache_total{result=hit|miss|bypass},
 *     router_embeddings_batch_size (histogram), router_embeddings_dims_total{model,dims}.
 *     (EMB-H03)
 *
 *   - Fail-open on Valkey errors: cache.get()/set() throws are caught per-call, the
 *     route logs warn and falls through to upstream. The contract is "no metric
 *     increment on Valkey error" (EMB-H04) so the cache_total counter labels remain
 *     a faithful representation of real cache outcomes.
 *
 * Bearer auth: gated automatically by makeBearerHook (auth/bearer.ts) because
 * `/v1/embeddings` is NOT in PUBLIC_PATHS. No route-level auth wiring needed.
 *
 * Centralized error handler (app.ts): maps thrown errors to the OpenAI envelope.
 * Plan 07-04 widens the handler's `isRecordedRoute` allowlist to include
 * `/v1/embeddings` so pre-resolve errors (RegistryUnknownModelError, etc.) still
 * produce a request_log row. Inside the route, the outer finally block calls
 * safeRecord on both success and error paths via the same idempotency closure
 * pattern used by chat-completions.ts.
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
  EmbeddingsDimsMismatchError,
  mapToHttpStatus,
} from '../../errors/envelope.js';
import { applyPolicyGate } from '../../policy/gate.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import type { IdempotencyMultiplexer } from '../../resilience/idempotency.js';
import { extractIdempotencyKey } from '../../middleware/idempotencyKey.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  type OutcomeContext,
  type RecordRequestOutcome,
} from '../../metrics/recordOutcome.js';
import {
  embeddingsCacheKey,
  type CachedVector,
  type EmbeddingsCache,
} from '../../embeddings/cache.js';
import { computeCostCents } from '../../cost/computeCostCents.js';

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
   * followers replay the cached body. EMBED requests are typically
   * idempotent by nature (same input → same embedding) but PITFALLS
   * Pitfall 14 (SDK retry-storms) still applies — the multiplexer
   * collapses N concurrent retries into 1 upstream call.
   */
  idempotency?: IdempotencyMultiplexer;
  /**
   * Phase 12 (v0.10.0 — EMB-H01) — optional Valkey-backed per-item cache.
   * When undefined (no Valkey wired — test fixtures, dev), the route behaves
   * exactly as Phase 7 (all items hit the adapter, dims still enforced if
   * declared). When defined, cacheable items are looked up + populated.
   */
  cache?: EmbeddingsCache;
  /**
   * Phase 12 (v0.10.0 — EMB-H03) — narrow metrics surface the route reads.
   * Mirrors chat-completions.ts.metrics: tests can pass undefined and the
   * route still functions (no metric observation).
   */
  metrics?: {
    embeddingsCacheTotal: { inc(labels: { result: 'hit' | 'miss' | 'bypass' }): void };
    embeddingsBatchSize: { observe(value: number): void };
    embeddingsDimsTotal: {
      inc(labels: { model: string; dims: string }, value?: number): void;
    };
  };
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

      // Plan 08-07 (ROUTE-12 / D-D5) — extract + validate Idempotency-Key.
      // Outside the try block because extractIdempotencyKey throws an
      // InvalidIdempotencyKeyError that the centralized handler maps to 400
      // — we want the standard path, not the route's safeRecord (which would
      // populate the backend/model labels). With no socket listener attached
      // yet, this is safe.
      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyRole: 'leader' | 'follower' | undefined;
      let followerUpstreamMessageId: string | undefined;

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

        // Phase 14 (v0.11.0 — POL-01 / POL-02 / P8-01 BLOCK): policy gate fires
        // AFTER capability gate, BEFORE the breaker check, so a policy 403 never
        // mutates the breaker counter (P8-01). Snapshot fetched here — registry.get()
        // is the existing seam; hot-reload swaps the snapshot atomically.
        applyPolicyGate(opts.registry.get().policies, entry, body.model);

        // Plan 08-04 (CLOUD-03) — circuit breaker gate. Fires AFTER capability
        // gate, BEFORE semaphore acquire. Same pattern as chat-completions.ts.
        const breakerResult = await opts.breaker.check(entry.backend);
        if (breakerResult.state === 'open') {
          void reply.header('Retry-After', String(opts.breakerCooldownSec));
          throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
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
        // fetching after cache deduplication.
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        opts.metrics?.embeddingsBatchSize.observe(inputs.length);

        // Phase 12 (EMB-H01 + EMB-H04): per-item Valkey cache. The cache is skipped
        // entirely for encoding_format='base64' (the wire shape is a string the route
        // would have to round-trip through JSON anyway, and base64 callers are typically
        // dimension-reducing pipelines that don't benefit from caching). Skipped when
        // opts.cache is undefined (no Valkey wired — Phase 7 behavior preserved).
        const cacheable = opts.cache !== undefined && body.encoding_format !== 'base64';
        const slots: Array<CachedVector | null> = new Array(inputs.length).fill(null);
        const missIndices: number[] = [];

        for (let i = 0; i < inputs.length; i++) {
          const item = inputs[i] as string;
          if (!cacheable) {
            missIndices.push(i);
            // bypass: cache exists but is being skipped intentionally (base64).
            // When opts.cache is undefined entirely, no metric event is emitted —
            // there's nothing to bypass; the route is operating in pre-cache mode.
            if (opts.cache !== undefined) {
              opts.metrics?.embeddingsCacheTotal.inc({ result: 'bypass' });
            }
            continue;
          }
          const key = embeddingsCacheKey({
            backend: entry.backend,
            backend_model: entry.backend_model,
            encoding_format: body.encoding_format,
            dimensions: body.dimensions,
            input: item,
          });
          try {
            const cached = await opts.cache!.get(key);
            if (cached !== null) {
              slots[i] = cached;
              opts.metrics?.embeddingsCacheTotal.inc({ result: 'hit' });
            } else {
              missIndices.push(i);
              opts.metrics?.embeddingsCacheTotal.inc({ result: 'miss' });
            }
          } catch (err) {
            // EMB-H04 — fail-open. Treat as if cache were absent for this item;
            // do NOT increment the metric (the contract is "metric stays a
            // faithful representation of real cache outcomes"). The item still
            // goes to upstream below.
            req.log.warn(
              { err, key },
              'embeddings cache: get failed; falling through to upstream (fail-open)',
            );
            missIndices.push(i);
          }
        }

        // Adapter call — only for items that missed the cache (or for ALL items
        // when cache is absent/disabled). When everything was a hit, this branch
        // is skipped entirely and the request_log row records tokens_in=0 (the
        // request didn't cost any upstream tokens).
        let upstreamUsage = { prompt_tokens: 0, total_tokens: 0 };
        let upstreamModel = entry.backend_model;
        if (missIndices.length > 0) {
          const semaphore = opts.semaphores.get(entry.backend);
          release = await semaphore.acquire(controller.signal);
          released = false;

          // Preserve original input shape for the upstream call: if the client
          // sent a string and we missed it, send a string back (not [string]).
          // Some upstreams (older Ollama versions) special-case single-string
          // input — keeping byte-identical to pre-Phase-12 behavior here is the
          // safest move.
          const missInputs = missIndices.map((i) => inputs[i] as string);
          const adapterInput: string | string[] =
            !Array.isArray(body.input) && missInputs.length === 1
              ? missInputs[0]!
              : missInputs;

          // 07-REVIEW CR-01: forward optional EmbeddingCreateParams that the
          // schema validates. Without this, encoding_format='base64' and
          // dimensions=N pass zod but are silently dropped at the SDK boundary,
          // violating the documented OpenAI-compat contract.
          const upstreamResult = await adapter.embeddings(
            adapterInput,
            entry.backend_model,
            controller.signal,
            {
              encoding_format: body.encoding_format,
              dimensions: body.dimensions,
              user: body.user,
            },
          );
          // Plan 08-04 — fire-and-forget breaker success signal.
          void opts.breaker.recordSuccess(entry.backend);

          upstreamUsage = upstreamResult.usage;
          upstreamModel = upstreamResult.model;

          // Place upstream vectors into their original slots AND populate cache.
          // The upstream returns results in the order of the input array; map
          // them back via missIndices[j].
          if (upstreamResult.data.length !== missIndices.length) {
            // Defensive: upstream returned a different count than we asked for.
            // This is an upstream contract violation; fail fast rather than
            // serve mis-aligned vectors.
            throw new Error(
              `embeddings: upstream returned ${upstreamResult.data.length} vectors for ${missIndices.length} inputs (count mismatch)`,
            );
          }
          for (let j = 0; j < upstreamResult.data.length; j++) {
            const origIdx = missIndices[j]!;
            const vec = upstreamResult.data[j]!.embedding;
            slots[origIdx] = vec;
            if (cacheable) {
              const key = embeddingsCacheKey({
                backend: entry.backend,
                backend_model: entry.backend_model,
                encoding_format: body.encoding_format,
                dimensions: body.dimensions,
                input: inputs[origIdx] as string,
              });
              try {
                await opts.cache!.set(key, vec);
              } catch (err) {
                // EMB-H04 — fail-open. The vector was served; the cache write
                // failure just means the next identical request will miss again.
                req.log.warn(
                  { err, key },
                  'embeddings cache: set failed; vector served but not cached',
                );
              }
            }
          }
        }

        // EMB-H02 — dims enforcement. registry.ts.superRefine guarantees that any
        // model with the `embeddings` capability declares `dims` (non-optional in
        // practice), so the entry.dims === undefined branch is dead code from the
        // route's POV — keep it as a defense-in-depth no-op rather than throw
        // here. Skip the check for base64 strings (we can't measure dimensions
        // without decoding) — operators using base64 + dims enforcement combined
        // are accepting that the gate is array-only.
        if (entry.dims !== undefined) {
          for (let i = 0; i < slots.length; i++) {
            const v = slots[i];
            if (Array.isArray(v) && v.length !== entry.dims) {
              req.log.error(
                {
                  model: entry.name,
                  backend: entry.backend,
                  expected_dims: entry.dims,
                  actual_dims: v.length,
                  index: i,
                },
                'embeddings dims mismatch: refusing to propagate',
              );
              throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, v.length);
            }
          }
          // EMB-H03 — record per-(model,dims) success. inputs.length covers both
          // hits and misses since the response includes all of them.
          opts.metrics?.embeddingsDimsTotal.inc(
            { model: entry.name, dims: String(entry.dims) },
            inputs.length,
          );
        }

        req.raw.socket?.off('close', onClose);

        // Build the wire response. Shape matches the OpenAI SDK's
        // CreateEmbeddingResponse: object='list', data[].index increments from 0,
        // model echoes the upstream id (preserved for byte-identical behavior
        // with the pre-cache implementation), usage reflects only what actually
        // hit the upstream (fully cached → 0 tokens, which is honest accounting).
        result = {
          object: 'list' as const,
          data: slots.map((vec, i) => ({
            object: 'embedding' as const,
            index: i,
            // slots[i] is guaranteed non-null after the loop above (cache hit or
            // upstream fill); the `!` is a runtime invariant assertion.
            embedding: vec!,
          })),
          model: upstreamModel,
          usage: upstreamUsage,
        };

        // Phase 13 (v0.10.0 — COST-02/04): stamp req.computedCostCents BEFORE
        // reply.send() — Fastify v5 onSend fires synchronously inside .send().
        // Outer finally still records the same cost to the request_log row.
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
        // response body so concurrent followers can replay it. Embedding
        // responses don't carry an Anthropic-style msg_<ulid>; we use the
        // OpenAI completion id field if present (sentence-transformer servers
        // commonly omit it) or undefined. Plan 08-08 cost-attribution groups
        // by upstream_message_id but embeddings rarely needs that grouping
        // (single tier, predictable cost) — undefined is acceptable.
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
        const tokensIn = caughtErr ? undefined : result?.usage?.prompt_tokens ?? 0;
        const tokensOut = caughtErr ? undefined : 0; // tokensOut: 0 (plan-verify grep gate)
        // Phase 13 (v0.10.0 — COST-01/02/04): embeddings cost computed from
        // upstream usage. For cloud-served embeddings the rate-card lives in
        // entry.pricing; for local backends pricing is absent and the helper
        // returns null → no header, no cost_cents column. Stamped on req before
        // the function returns so onSend can emit X-Cost-Cents.
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
          // 07-RESEARCH Open Question 3 — emit `tokensOut: 0` (not NULL) so dashboards
          // aggregating SUM(tokens_out) over request_log include embedding rows without
          // a COALESCE. Error path leaves it undefined → NULL column (canonical pattern
          // shared with chat-completions.ts).
          tokensIn,
          tokensOut,
          errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
          errorMessage: caughtErr?.message,
          agentId: req.agentId,
          tenantId: req.tenantId,
          projectId: req.projectId,
          workloadClass: req.workloadClass,
          requestId: req.id,
          // Plan 08-07 (D-D5) — follower request_log row carries the leader's
          // upstream_message_id for cost-attribution grouping (Plan 08-08).
          upstreamMessageId: followerUpstreamMessageId,
          // 08-REVIEW CR-01: persist Idempotency-Key for dedup verification.
          idempotencyKey,
          costCents,
          timestamp: new Date(),
        });
      }
    },
  );
}
