/**
 * rerank.ts — Phase 11 (v0.10.0 — RERANK-01..06) — POST /v1/rerank.
 *
 * Wire surface: Cohere/Jina-compatible rerank API (non-streaming). Cross-encoder
 * scoring of N candidate documents against a single query. Mirrors embeddings.ts
 * end-to-end — same auth + breaker + semaphore + idempotency + request_log plumbing
 * — only the adapter call and the wire shape differ.
 *
 * Pipeline:
 *   zod-validated body → registry.resolve(model) → capability gate
 *   ('rerank' in entry.capabilities) → breaker.check → idempotency.acquire →
 *   semaphore acquire → adapter.rerank → top_n post-filter → response back.
 *
 * Body shape:
 *   { model, query: string, documents: string[], top_n?: number, return_documents?: boolean }
 *
 * Response shape:
 *   { model, results: [{ index, relevance_score, document? }], usage: { total_tokens } }
 *
 * `top_n` post-filter: the route enforces the cap AFTER the adapter returns; this
 * lets adapters that don't natively support top_n still satisfy the contract.
 * `return_documents`: when true, each result includes the original document text;
 * default false to keep the response compact (Cohere parity).
 *
 * Bearer auth: gated automatically by makeBearerHook (/v1/rerank is NOT in PUBLIC_PATHS).
 * Centralized error handler (app.ts) maps thrown errors to the OpenAI envelope.
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

/**
 * Cohere-compatible rerank body. `query` MUST be non-empty; `documents` MUST be a
 * non-empty array of non-empty strings (mirrors the embeddings Pitfall E-1 rationale).
 * `top_n` is OPTIONAL and bounded to [1, documents.length] post-filter.
 * `return_documents` defaults to false — Cohere parity.
 */
export const RerankRequestSchema = z
  .object({
    model: z.string().min(1),
    query: z.string().min(1),
    documents: z.array(z.string().min(1)).min(1),
    top_n: z.number().int().positive().optional(),
    return_documents: z.boolean().optional(),
  })
  .passthrough();

export type RerankRequest = z.infer<typeof RerankRequestSchema>;

export interface RegisterRerankOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };
  recordOutcome: RecordRequestOutcome;
  breaker: CircuitBreaker;
  breakerCooldownSec: number;
  idempotency?: IdempotencyMultiplexer;
  /**
   * Phase 20 (v0.12.0 — CAT-04 / D-03 LOCKED): narrow metrics slice for the
   * deprecation surface. Optional so existing rerank fixtures keep compiling.
   * Production wiring threads opts.metrics.routerDeprecatedAliasUsedTotal from
   * app.ts. When undefined the deprecation surface still fires header + log.
   */
  metrics?: {
    routerDeprecatedAliasUsedTotal?: import('prom-client').Counter<'old_name' | 'new_name'>;
  };
}

export function registerRerankRoute(app: FastifyInstance, opts: RegisterRerankOpts): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/rerank',
    { schema: { body: RerankRequestSchema } },
    async (req, reply) => {
      const body = req.body;
      // Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): consolidated preflight.
      // applyPreflight runs resolve → applyPolicyGate → breaker.check in one
      // helper, shared with MCP tool handlers (Wave 4). breakerState='open' is
      // RETURNED so the HTTP caller stamps Retry-After before BreakerOpenError.
      const { entry, breakerState, deprecation_meta } = await applyPreflight(body.model, {
        registry: opts.registry,
        breaker: opts.breaker,
      });
      req.resolvedBackend = entry.backend;

      // ─── Phase 20 deprecation surface (CAT-04 / D-03 LOCKED) ──────────────
      // Identical block as chat-completions / messages / responses. See
      // chat-completions.ts for the canonical version + rationale.
      if (deprecation_meta) {
        void reply.header('X-Deprecated-Alias', deprecation_meta.new_name);
        req.log.warn(
          {
            event: 'deprecated_alias_used',
            old_name: deprecation_meta.old_name,
            new_name: deprecation_meta.new_name,
            deprecated_since: deprecation_meta.deprecated_since,
            removal_target: deprecation_meta.removal_target,
          },
          'deprecated alias resolved to canonical target',
        );
        opts.metrics?.routerDeprecatedAliasUsedTotal
          ?.labels({
            old_name: deprecation_meta.old_name,
            new_name: deprecation_meta.new_name,
          })
          .inc();
      }
      // ─── End Phase 20 deprecation surface ─────────────────────────────────

      // Plan 08-04 (CLOUD-03) — sentinel-open branch.
      if (breakerState === 'open') {
        void reply.header('Retry-After', String(opts.breakerCooldownSec));
        throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
      }

      const adapter: BackendAdapter = opts.makeAdapter(entry);

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
          'rerank: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
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
      let result: Awaited<ReturnType<BackendAdapter['rerank']>> | undefined;

      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyRole: 'leader' | 'follower' | undefined;
      let followerUpstreamMessageId: string | undefined;

      try {
        // RERANK-05 — capability gate. Mirror of embeddings.ts at the same position.
        if (!entry.capabilities.includes('rerank')) {
          throw new CapabilityNotSupportedError(entry.name, 'rerank');
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
            req.raw.socket?.off('close', onClose);
            return reply.send(cachedBody);
          }
        }

        const semaphore = opts.semaphores.get(entry.backend);
        release = await semaphore.acquire(controller.signal);
        released = false;

        result = await adapter.rerank(
          body.query,
          body.documents,
          entry.backend_model,
          controller.signal,
          { ...(body.top_n !== undefined ? { top_n: body.top_n } : {}), return_documents: body.return_documents ?? false },
        );

        // RERANK-01 — top_n post-filter. Adapter MAY return all documents (the upstream
        // Cohere semantics: top_n is a hint, not a constraint). Enforce the cap here
        // so the wire contract is uniform across adapters.
        const sorted = [...result.results].sort((a, b) => b.relevance_score - a.relevance_score);
        const capped =
          body.top_n !== undefined ? sorted.slice(0, body.top_n) : sorted;

        const wireBody = {
          model: entry.name, // RERANK-04 — surface the registry name, not the upstream backend_model
          results: capped,
          usage: result.usage,
        };

        void opts.breaker.recordSuccess(entry.backend);
        req.raw.socket?.off('close', onClose);

        // Phase 13 (v0.10.0 — COST-02/04): stamp X-Cost-Cents header source
        // BEFORE reply.send() (onSend fires synchronously inside .send()).
        const earlyCost =
          computeCostCents({
            entry,
            tokensIn: result.usage?.total_tokens ?? 0,
            tokensOut: 0,
          }) ?? undefined;
        if (earlyCost !== undefined) {
          req.computedCostCents = earlyCost;
        }

        if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
          try {
            await opts.idempotency.publishNonStream(idempotencyKey, wireBody, undefined);
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
        // Rerank: total_tokens covers BOTH the query and the documents — emit it as tokensIn.
        // Mirror embeddings.ts pattern: tokensOut: 0 (not NULL) so SUM aggregations stay clean.
        const tokensIn = caughtErr ? undefined : result?.usage?.total_tokens ?? 0;
        const tokensOut = caughtErr ? undefined : 0;
        // Phase 13 (v0.10.0 — COST-01/02/04): rerank cost computed from upstream
        // total_tokens × input_per_1m. Local rerankers (no pricing) → null → no
        // header + NULL column; cloud rerankers (when Ollama Cloud adds the
        // capability + bills it) compute via the same helper.
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
