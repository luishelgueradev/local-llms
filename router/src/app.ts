import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
} from 'fastify';
import type { Pool } from 'pg';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import {
  serializerCompiler,
  validatorCompiler,
} from '@bram-dc/fastify-type-provider-zod';
import { loggerOptions } from './log/logger.js';
import { makeBearerHook } from './auth/bearer.js';
import type { RegistryStore } from './config/registry.js';
import { registerHealthz } from './routes/healthz.js';
import { registerChatCompletionsRoute } from './routes/v1/chat-completions.js';
import { registerMessagesRoute } from './routes/v1/messages.js';
import { registerCountTokensRoute } from './routes/v1/count-tokens.js';
import type { AdapterFactory } from './backends/adapter.js';
import { registerModelsRoute } from './routes/v1/models.js';
import {
  toOpenAIErrorEnvelope,
  toAnthropicErrorEnvelope,
  mapToHttpStatus,
  NO_ENVELOPE,
  ANTHROPIC_NO_ENVELOPE,
} from './errors/envelope.js';
import { makeLivenessScheduler, type LivenessScheduler } from './backends/liveness.js';
import { makeAdapter as defaultMakeAdapter } from './backends/factory.js';
import { registerReadyz } from './routes/readyz.js';
import { BackendSemaphore } from './concurrency/semaphore.js';
import type { BufferedWriter } from './db/bufferedWriter.js';
import type { UsageDailyScheduler } from './db/usageDaily.js';
import type { MetricsRegistry } from './metrics/registry.js';
import {
  makeRecordRequestOutcome,
  deriveStatusClass,
  mapErrorToCode,
  truncateAndRedact,
} from './metrics/recordOutcome.js';
import { agentIdPreHandler as defaultAgentIdPreHandler } from './middleware/agentId.js';

// Fastify module augmentation so TypeScript knows about app.liveness + app.semaphores (decorators).
declare module 'fastify' {
  interface FastifyInstance {
    liveness: LivenessScheduler;
    semaphores: { get(backend: string): BackendSemaphore };
  }
}

export interface BuildAppOpts {
  registry: RegistryStore;
  bearerToken: string;
  loggerOpts?: FastifyServerOptions['logger'];
  /**
   * Optional adapter factory — defaults to OllamaOpenAIAdapter for every entry.
   * Tests inject a fake here to mock the upstream without msw (or without going
   * through the network at all).
   */
  makeAdapter?: AdapterFactory;
  /**
   * Optional liveness scheduler factory — defaults to makeLivenessScheduler.
   * Tests inject a fake here for deterministic, fast /readyz behavior without
   * spinning up real upstream probes.
   */
  livenessFactory?: (opts: Parameters<typeof makeLivenessScheduler>[0]) => LivenessScheduler;
  /**
   * Optional semaphore factory — defaults to new BackendSemaphore(...).
   * Tests inject a fake here for type-check compliance without exercising rate-limit behavior.
   * (Revision 1, Warning 5 — test fixtures must pass a fake semaphores opt when
   * RegisterChatCompletionsOpts requires the field.)
   */
  semaphoreFactory?: (name: string, concurrency: number, waitMs: number) => BackendSemaphore;
  /**
   * Optional semaphores override — bypasses the registry-derived Map entirely.
   * Used by concurrency integration tests that need a real BackendSemaphore with
   * direct access to stats(), and also by the existing chat-completions integration
   * test fixtures (Revision 1, Warning 5) that pass a fake semaphores opt.
   * When provided, semaphoreFactory is ignored.
   */
  semaphores?: { get(backend: string): BackendSemaphore };
  /**
   * Phase 5 (D-A4) — required for production wiring; in test fixtures pass a
   * fake `{ push: () => {}, drain: async () => {} }` (PATTERNS.md §"Fake
   * injection pattern"). The drain step is wired into the onClose hook so
   * SIGTERM gets a 3s grace period before in-process buffered rows are
   * dropped.
   */
  bufferedWriter: BufferedWriter;
  /**
   * Plan 05-02 (D-C3 + OBS-01) — required for production wiring; in test
   * fixtures construct via `makeMetricsRegistry()` (lightweight: fresh
   * Registry + 5 metrics + Node defaults). The /metrics route reads
   * `opts.metrics.register.contentType` and `.metrics()`.
   */
  metrics: MetricsRegistry;
  /**
   * Plan 05-02 (D-D5 / ROUTE-09) — preHandler that validates X-Agent-Id and
   * attaches req.agentId + decorates req.log child. Defaults to the
   * production agentIdPreHandler; tests override for hook-isolation cases.
   */
  agentIdPreHandler?: preHandlerAsyncHookHandler;
  /**
   * Plan 05-04 (DATA-04) — optional usage_daily scheduler. When supplied,
   * its start() runs after buildApp wires the routes and its stop() runs
   * in the onClose hook BEFORE the bufferedWriter drain (the drain races
   * an awaited timeout; the scheduler stop is synchronous). Production
   * wiring passes a real scheduler from index.ts; tests omit the field
   * to skip the daily aggregation entirely.
   */
  usageDailyScheduler?: UsageDailyScheduler;
  /**
   * Plan 05-04 (D-G2) — optional pg.Pool for the /readyz postgres probe.
   * When supplied, the LivenessScheduler registers a probe URL `postgres://pool`
   * alongside the backend URLs; its result is included in /readyz response
   * under `postgres` and gates the 200/503 aggregation. When omitted (most
   * test fixtures), /readyz behaves exactly as Phase 3 — no postgres field
   * in the response, no postgres entry in the scheduler. Production wiring
   * (index.ts) always passes the real pool.
   */
  pool?: Pool;
}

/**
 * Plan 05-04 (D-G2) — synthetic URL used as the probe key for the postgres
 * pool reachability check. Distinguishable from any backend HTTP URL.
 * Exported so tests can seed the fake scheduler's results map under this key.
 */
export const POSTGRES_PROBE_URL = 'postgres://pool';

export async function buildApp(opts: BuildAppOpts): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.loggerOpts ?? loggerOptions, // pass OPTIONS, not an instance — Fastify v5 contract
    bodyLimit: 8 * 1024 * 1024, // 8 MB; Phase 4 vision blows past 1 MB easily
    trustProxy: false, // Phase 6 (Traefik) flips this to true
  });

  // Register zod type provider compilers BEFORE route declarations
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // SSE plugin — registered now so plan 02-04's stream branch can call reply.sse(...)
  // without re-registering. No options — defaults are correct.
  await app.register(FastifySSEPlugin);

  // Bearer auth — onRequest hook runs BEFORE body parsing and zod validation,
  // so invalid tokens are rejected before any route-level processing occurs.
  // Using 'onRequest' (not 'preHandler') ensures auth is the first gate (Rule 1 fix).
  app.addHook('onRequest', makeBearerHook(opts.bearerToken));

  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler runs AFTER bearer
  // auth (onRequest) and BEFORE the route handler. Hook ordering verified
  // against fastify.dev/docs/v5.8.x/Reference/Hooks/: onRequest → ... →
  // preHandler. Bearer must pass first; agent-id is post-auth metadata
  // enrichment. The handler also stamps req._t0 = performance.now() — the
  // latency_ms source for the request_log row (D-D6 + Plan 05-02 Task 3).
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);

  // Centralized error handler — D-C1 envelope for ANY uncaught error from a route.
  // The route handlers in plan 02-03 + 02-04 may also handle errors locally; this is the
  // catch-all for "the route threw".
  //
  // Plan 04-02 D-F5: split by request URL prefix.
  //   - /v1/messages*       → Anthropic-shape envelope (toAnthropicErrorEnvelope)
  //   - everything else     → OpenAI-shape envelope (toOpenAIErrorEnvelope)
  // req.url may be undefined in pre-routing failures (rare; Fastify typically populates
  // it during the request lifecycle). The fallback uses the OpenAI envelope — same as
  // every pre-04 route — since the OpenAI surface is the dominant one and pre-routing
  // errors don't carry an Anthropic-version expectation.
  // Plan 05-02 Task 3 — wire recordOutcome here so pre-resolve errors
  // (e.g., RegistryUnknownModelError thrown by registry.resolve() BEFORE the
  // route's try block runs; preValidation zod failures; InvalidAgentIdError
  // from agentIdPreHandler) still produce a request_log row. The route's
  // safeRecord closure SETS req.__recorded = true after recording so this
  // path does NOT double-write for errors that the route already handled.
  //
  // SKIP routes per D-D4: /healthz, /readyz, /metrics, /v1/models,
  // /v1/messages/count_tokens. Bearer-auth 401 (BearerAuthError) is also
  // skipped — D-D4 forbids recording pre-auth bearer failures (attacker
  // could bloat the table; auth-failure audit lives in pino logs).
  const recordOutcome = makeRecordRequestOutcome({
    metrics: opts.metrics,
    bufferedWriter: opts.bufferedWriter,
  });

  app.setErrorHandler((err, req, reply) => {
    const url = req.url ?? '';
    const route = url.split('?')[0] ?? '';
    const isAnthropicRoute = route.startsWith('/v1/messages');
    const status = mapToHttpStatus(err);

    // D-D4 — coverage policy. Record /v1/chat/completions and /v1/messages
    // outcomes (but NOT /v1/messages/count_tokens and NOT 401 BearerAuthError).
    const isRecordedRoute =
      (route === '/v1/chat/completions' || route === '/v1/messages') && status !== 401;
    if (isRecordedRoute && req.__recorded !== true) {
      req.__recorded = true;
      recordOutcome({
        protocol: isAnthropicRoute ? 'anthropic' : 'openai',
        route,
        backend: 'unknown', // pre-resolve path — no entry bound
        model: 'unknown',
        statusClass: deriveStatusClass(status, false),
        httpStatus: status,
        durationMs: performance.now() - (req._t0 ?? performance.now()),
        errorCode: mapErrorToCode(err),
        errorMessage: truncateAndRedact(err instanceof Error ? err.message : String(err)),
        agentId: req.agentId,
        requestId: req.id,
        timestamp: new Date(),
      });
    }

    if (isAnthropicRoute) {
      const env = toAnthropicErrorEnvelope(err);
      if (env === ANTHROPIC_NO_ENVELOPE) {
        return;
      }
      req.log.warn({ err, url, status }, 'route error -> anthropic envelope');
      reply.code(status).send(env);
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      // Client disconnected mid-pre-stream — nothing to send.
      return;
    }
    req.log.warn({ err, url, status }, 'route error -> envelope');
    reply.code(status).send(env);
  });

  // -------------------------------------------------------------------------
  // Liveness scheduler (Plan 03-03, ROUTE-06)
  // -------------------------------------------------------------------------

  // Adapter cache for probes — one adapter instance per distinct URL.
  // Cleared on app.close() so connections are released on graceful shutdown.
  const probeAdapters = new Map<string, ReturnType<typeof defaultMakeAdapter>>();
  const probeAdapterFor = (url: string) => {
    let a = probeAdapters.get(url);
    if (!a) {
      const reg = opts.registry.get();
      const entry = reg.models.find((m) => m.backend_url === url);
      if (!entry) throw new Error(`No registry entry for URL "${url}"`);
      a = defaultMakeAdapter(entry);
      probeAdapters.set(url, a);
    }
    return a;
  };

  // Plan 05-04 (D-G2) — postgres pool probe. Implements RESEARCH §"Don't
  // Hand-Roll" line 491: Promise.race(pool.query('SELECT 1'), 1s timeout).
  // The signal parameter is unused by the pg probe — Promise.race IS the
  // cancellation mechanism here (the outer scheduler's timeoutMs is a
  // second line of defense against a wedged pool). DO NOT add
  // signal.addEventListener('abort', ...) plumbing — it would race the
  // Promise.race in subtly wrong ways. The pool's connectionTimeoutMillis
  // (set to 2_000 in db/index.ts per Pitfall 3) caps the underlying connect.
  const pool = opts.pool;
  const pgProbe = pool
    ? async (
        _url: string,
        _signal: AbortSignal,
      ): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
        const t0 = performance.now();
        try {
          await Promise.race([
            pool.query('SELECT 1'),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('pg-probe-timeout-1s')), 1_000),
            ),
          ]);
          return { ok: true, latencyMs: performance.now() - t0 };
        } catch (err) {
          return {
            ok: false,
            latencyMs: performance.now() - t0,
            error: (err as Error).message,
          };
        }
      }
    : null;

  const schedulerOpts: Parameters<typeof makeLivenessScheduler>[0] = {
    intervalMs: 10_000,
    timeoutMs: 2_000,
    logger: app.log as Parameters<typeof makeLivenessScheduler>[0]['logger'],
    probe: async (url, signal) => {
      // Dispatch on URL prefix (PATTERNS.md §router/src/backends/liveness.ts
      // option b — single scheduler, probe function branches on the synthetic
      // postgres URL). Backend URLs continue to use the adapter probe path.
      if (pgProbe && url === POSTGRES_PROBE_URL) return pgProbe(url, signal);
      const adapter = probeAdapterFor(url);
      return adapter.probeLiveness(signal);
    },
  };

  // Allow tests to inject a fake scheduler for deterministic behavior.
  const factory = opts.livenessFactory ?? makeLivenessScheduler;
  const liveness = factory(schedulerOpts);

  // Decorate so index.ts can call liveness.start(urls) on hot-reload.
  // TypeScript sees it via the FastifyInstance augmentation above.
  app.decorate('liveness', liveness);

  // Kick off the first probe set against the current registry snapshot.
  // Plan 05-04 — when a pool is configured, also probe the postgres URL.
  const distinctBackendUrls = Array.from(
    new Set(opts.registry.get().models.map((m) => m.backend_url)),
  );
  const initialUrls = pool ? [...distinctBackendUrls, POSTGRES_PROBE_URL] : distinctBackendUrls;
  liveness.start(initialUrls);

  // -------------------------------------------------------------------------
  // Per-backend semaphore Map (Plan 03-04, ROUTE-07)
  // -------------------------------------------------------------------------
  // Build one BackendSemaphore per distinct backend name. Uses the `backends:` section
  // from the registry schema (Plan 03-02) for concurrency + queue_max_wait_ms, with
  // sensible defaults per D-B3 (concurrency: 2, queue_max_wait_ms: 30_000).
  //
  // Per 03-02 SUMMARY note: registry.get().backends may be undefined when the `backends:`
  // section is absent from models.yaml — always use ?? 2 / ?? 30_000 as fallbacks.

  const semaphoreFactory = opts.semaphoreFactory ?? ((n, c, w) => new BackendSemaphore(n, c, w));
  const semaphoreMap = new Map<string, BackendSemaphore>();
  {
    const reg = opts.registry.get();
    const seenBackends = new Set<string>();
    for (const m of reg.models) {
      if (seenBackends.has(m.backend)) continue;
      seenBackends.add(m.backend);
      const cfg = reg.backends?.[m.backend];
      const concurrency = cfg?.concurrency ?? 2;
      const queueMaxWaitMs = cfg?.queue_max_wait_ms ?? 30_000;
      semaphoreMap.set(m.backend, semaphoreFactory(m.backend, concurrency, queueMaxWaitMs));
    }
  }

  // Use the opts.semaphores override if provided (test injection); else use the registry-derived Map.
  const semaphores = opts.semaphores ?? {
    get: (backend: string): BackendSemaphore => {
      const s = semaphoreMap.get(backend);
      if (!s) throw new Error(`No semaphore for backend "${backend}"`);
      return s;
    },
  };

  app.decorate('semaphores', semaphores);

  // Shutdown hook (D-D7) — clears all timers so process exit is clean.
  // semaphoreMap.clear() tidies the Map; active timer waiters inside the semaphore
  // will reject on their own setTimeout fires (process is exiting).
  //
  // Phase 5 (D-A4): drain the bufferedWriter LAST — after the semaphore map
  // is cleared, in-flight requests have stopped. The 3 s race lets a final
  // flush land before SIGTERM hardstops. Compose's default stop_grace_period
  // is 10s, so 3s fits comfortably.
  app.addHook('onClose', async () => {
    liveness.stop();
    probeAdapters.clear();
    semaphoreMap.clear();
    // Plan 05-04 — stop the usage_daily scheduler BEFORE the bufferedWriter
    // drain. Both are idempotent + synchronous (stop just clears timers).
    // The drain is awaited LAST because it races a setTimeout(3_000).
    opts.usageDailyScheduler?.stop();
    await opts.bufferedWriter.drain(3_000);
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  registerHealthz(app, opts.registry);

  // GET /readyz — public, per-backend liveness summary (Plan 03-03, ROUTE-06).
  // Plan 05-04 (D-G2): when pool is supplied, /readyz also includes a postgres
  // probe entry and gates 200/503 on its alive status.
  registerReadyz(app, opts.registry, liveness, Boolean(pool));

  // GET /metrics — Plan 05-02 (D-C3, D-C5, OBS-01). Prometheus text/plain format.
  // Public (skip-list in auth/bearer.ts), loopback-bound until Phase 6 (Pitfall 11).
  // No compress middleware here (forbidden globally on streaming routes since
  // Phase 2; /metrics is short text but the precedent stands — Prometheus
  // scrapers reject gzip without negotiation).
  app.get('/metrics', async (_req, reply) => {
    void reply.type(opts.metrics.register.contentType);
    return opts.metrics.register.metrics();
  });

  // Chat completions — non-stream branch in plan 02-03; stream branch in plan 02-04
  // (same route file; plan 02-04 replaces the 501 stub).
  // Plan 03-04: semaphores injected for per-backend concurrency cap (ROUTE-07).
  // Plan 03-01 (deferred CR-01): dispatch by entry.backend via the factory — replaces
  // the Option β stopgap that hard-coded the Ollama adapter regardless of backend.
  // Required before Phase 8's OllamaCloudAdapter (different auth surface).
  registerChatCompletionsRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
    semaphores,
    recordOutcome,
  });

  // Plan 04-02 (ANTHR-02, ANTHR-03, ANTHR-04, ANTHR-05):
  //  - POST /v1/messages — Anthropic Messages API non-stream branch (stream→501 stub,
  //    replaced by Plan 04-03's SSE pipeline).
  //  - POST /v1/messages/count_tokens — pure CPU; no backend call, no semaphore (D-F1).
  registerMessagesRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
    semaphores,
    recordOutcome,
  });
  registerCountTokensRoute(app, { registry: opts.registry });

  // GET /v1/models — bearer-gated; lists all registry models (Plan 03-02, OAI-03).
  registerModelsRoute(app, opts.registry);

  // Plan 05-04 — start the usage_daily scheduler last, after all routes are
  // registered. The first refresh fires at the next UTC midnight; runNow()
  // is exposed for ops + tests. The onClose hook (above) stops the timers.
  opts.usageDailyScheduler?.start();

  return app;
}
