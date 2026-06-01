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
import { registerEmbeddingsRoute } from './routes/v1/embeddings.js';
import { registerRerankRoute } from './routes/v1/rerank.js';
import { registerResponsesRoute } from './routes/v1/responses.js';
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
import { LIVENESS_INTERVAL_MS } from './config/constants.js';
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
import { scopedIdsPreHandler as defaultScopedIdsPreHandler } from './middleware/scopedIds.js';
import { sessionIdPreHandler as defaultSessionIdPreHandler } from './middleware/sessionId.js';
import { makeRateLimitPreHandler } from './middleware/rateLimit.js';
import type { SessionStore } from './providers/session-store.js';
import type { ContextProvider } from './providers/context-provider.js';
import type { SummaryProvider } from './providers/summary-provider.js';
import { countTokens } from './translation/count-tokens.js';
import { closeValkey, type ValkeyClient } from './clients/valkey.js';
import { mcpHostPlugin } from './mcp/host/index.js';
import { makeEmbeddingsCache } from './embeddings/cache.js';
import { makeCircuitBreaker, type CircuitBreaker } from './resilience/circuitBreaker.js';
import {
  makeIdempotencyMultiplexer,
  type IdempotencyMultiplexer,
} from './resilience/idempotency.js';
import { RateLimitExceededError } from './errors/envelope.js';
import type { Env } from './config/env.js';
import type { Logger } from 'pino';

// Fastify module augmentation so TypeScript knows about app.liveness + app.semaphores (decorators).
declare module 'fastify' {
  interface FastifyInstance {
    liveness: LivenessScheduler;
    semaphores: { get(backend: string): BackendSemaphore };
    // Plan 08-01 (DATA-06) — optional decorator; test fixtures may omit.
    // Consumed by Plans 08-04 (breaker), 08-06 (rate limit), 08-07 (idempotency),
    // 08-09 (models cache).
    valkey?: ValkeyClient;
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
   * Phase 14 (v0.11.0 — POL-03/04 / D-19): preHandler that extracts
   * X-Tenant-ID, X-Project-ID, X-Workload-Class headers and stamps them on
   * req.tenantId / req.projectId / req.workloadClass. Must be registered
   * BEFORE agentIdPreHandler so the pino .child() call in agentId sees the
   * stamped fields (RESEARCH.md Pitfall 3 + D-18). Defaults to the production
   * scopedIdsPreHandler; tests override for hook-isolation cases.
   */
  scopedIdsPreHandler?: preHandlerAsyncHookHandler;
  /**
   * Phase 17 (v0.11.0 — SESS-01 / SESS-06 BuildAppOpts widening): optional
   * Postgres-backed session store. When undefined, the session-attach block
   * in every route is a no-op (SESS-06 stateless contract; byte-identical to
   * Phase 16 wire behavior). Production wiring (index.ts — Plan 17-07)
   * constructs a PostgresSessionStore from the Drizzle db handle and threads
   * it here.
   *
   * Optional: 4 Phase 17 BuildAppOpts fields (sessionStore + contextProvider
   * + summaryProvider + sessionIdPreHandler) are ALL optional so the full
   * Phase 14/15/16 integration test suite continues to build apps without
   * Phase 17 injection and observes byte-identical wire output.
   */
  sessionStore?: SessionStore;
  /**
   * Phase 17 (v0.11.0 — CTXP-01 BuildAppOpts widening): optional context
   * provider. When undefined, the route handler skips ContextProvider
   * invocation and passes body.messages verbatim (still a no-op when
   * sessionStore is also undefined). Default production wiring (Plan 17-07)
   * passes DefaultContextProvider (sliding-window + truncate strategies).
   */
  contextProvider?: ContextProvider;
  /**
   * Phase 17 (v0.11.0 — SUMP-01 / SUMP-02 BuildAppOpts widening): optional
   * summary provider. When undefined, the route falls back to
   * NoopSummaryProvider (which returns `''` / `[]` — and `null` when the
   * SUMP-03 BLOCK guard fires). Frame-03 binding: the v0.11.0 default is
   * always Noop; LlmSummaryProvider is deferred to SUMP-FUT-01 downstream.
   */
  summaryProvider?: SummaryProvider;
  /**
   * Phase 17 (v0.11.0 — SESS-05 BuildAppOpts widening): test seam for the
   * X-Session-ID preHandler. Production wiring (Plan 17-07) uses
   * `defaultSessionIdPreHandler` from `middleware/sessionId.js`. Tests
   * override for hook-isolation cases (mirror agentIdPreHandler? +
   * scopedIdsPreHandler? pattern).
   */
  sessionIdPreHandler?: preHandlerAsyncHookHandler;
  /**
   * Phase 14 (v0.11.0 — POL-05 / D-09 / P8-01 BLOCK) — Test seam for the
   * circuit breaker. Production path uses the breaker constructed from
   * opts.valkey + opts.env. Tests inject a spied wrapper to assert POL-05
   * (breaker counter unchanged after a policy 403 — `recordFailure` must be
   * called 0 times when applyPolicyGate throws before the breaker.check call).
   * When omitted, the existing breaker construction logic is used unchanged.
   */
  breaker?: CircuitBreaker;
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
  /**
   * Plan 08-01 (DATA-06) — required for production wiring; tests omit when
   * not exercising rate-limit / breaker / idempotency / models-cache paths.
   * Consumed by Plans 08-04 (breaker), 08-06 (rate limit), 08-07 (idempotency),
   * 08-09 (models cache). The client is opened in router/src/index.ts BEFORE
   * buildApp so the boot fails fast on a wrong VALKEY_PASSWORD / unreachable
   * service. closeValkey is awaited in onClose BEFORE bufferedWriter.drain so
   * any pending Valkey writes (e.g. a breaker state increment from an
   * in-flight request) flush before the pg drain races its 3 s timeout.
   */
  valkey?: ValkeyClient;
  /**
   * Plan 08-02 (CLOUD-01) — bearer apiKey threaded into the AdapterFactory
   * closure so OllamaCloudAdapter can authenticate against https://ollama.com.
   *
   * Optional in BuildAppOpts because test fixtures without cloud entries don't
   * need it; production wiring (index.ts) ALWAYS passes it (empty string is
   * acceptable when the registry has no cloud entries — assertCloudEnvIfConfigured
   * is the boot-time gate that refuses the misconfigured case BEFORE buildApp).
   *
   * The key is pre-bound into makeAdapterWithCloudKey at the top of buildApp;
   * route handlers + the liveness scheduler receive an AdapterFactory (single-arg)
   * with the key already closed-over, so they don't need to know about it.
   */
  cloudApiKey?: string;
  /**
   * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — env subset needed by the per-backend
   * circuit breaker. Production wiring (index.ts) passes the full env; test
   * fixtures omit unless exercising the breaker (in which case they pass an
   * explicit numeric subset alongside opts.valkey).
   *
   * Plan 08-06 (ROUTE-11) widening — ROUTER_RATE_LIMIT_RPM joins the env
   * subset so buildApp can construct the rate-limit hook against the same
   * Pick<Env, ...> shape. The gate is the same as the breaker's:
   * `opts.valkey && opts.env` — when either is absent, neither the breaker
   * NOR the rate-limit hook are registered, preserving the "test fixtures
   * built without these fields continue to work unmodified" contract.
   */
  env?: Pick<
    Env,
    | 'CIRCUIT_FAILURE_THRESHOLD'
    | 'CIRCUIT_WINDOW_MS'
    | 'CIRCUIT_COOLDOWN_MS'
    | 'ROUTER_RATE_LIMIT_RPM'
    | 'ROUTER_EMBED_CACHE_TTL_SEC'
  > &
    // Phase 15 (v0.11.0 — MCPS-01..06 / D-15) — MCP host plugin tunables.
    // Intersected as a Partial<Pick<...>> so existing fixtures that build
    // env with the older 5-key Pick still satisfy the BuildAppOpts shape.
    // When omitted, the buildApp call site below substitutes the schema
    // defaults (MCP_ENABLED=true, MCP_SESSION_TTL_SEC=3600,
    // MCP_GC_INTERVAL_MS=1_800_000). Production wiring (index.ts) always
    // passes the full env so the optional path is exclusively a
    // test-fixture concern.
    Partial<Pick<Env, 'MCP_ENABLED' | 'MCP_SESSION_TTL_SEC' | 'MCP_GC_INTERVAL_MS'>> &
    // Phase 15.1 housekeeping — upstream backend timeout. Partial so existing
    // test fixtures keep working; index.ts always passes the env value.
    Partial<Pick<Env, 'ROUTER_BACKEND_TIMEOUT_MS'>>;
  /**
   * Plan 08-04 — test injection seam for the breaker's clock. Tests can pass
   * a custom `now` so they can advance fake-time without real timers. When
   * omitted, the breaker uses `Date.now`. Production wiring (index.ts) does
   * not pass this field.
   */
  breakerNow?: () => number;
  /**
   * Plan 08-06 — test injection seam for the rate-limit hook's clock.
   * Mirrors `breakerNow`: tests advance fake-time deterministically without
   * `vi.useFakeTimers` (which freezes Fastify's internal timers and breaks
   * `app.inject`). When omitted, the hook uses `Date.now`. Production
   * wiring does not pass this field.
   */
  rateLimitNow?: () => number;
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

  // Plan 08-02 (CLOUD-01) — wrap defaultMakeAdapter in a closure that pre-binds
  // the cloud apiKey for OllamaCloudAdapter construction. Local adapters ignore
  // the deps arg entirely; cloud adapters require it. The closure keeps the
  // AdapterFactory type single-arg (no churn at the 4 call sites below), with
  // the key safely captured at buildApp time.
  //
  // Empty-string fallback is intentional: assertCloudEnvIfConfigured (index.ts)
  // refuses to boot when models.yaml has cloud entries + empty key, so an empty
  // cloudApiKey here can only mean "no cloud entries in registry, key not
  // needed". If a cloud entry somehow reaches the factory with this empty
  // closure key, factory.ts throws with a clear "requires cloudApiKey" error.
  const cloudApiKey = opts.cloudApiKey ?? '';
  // Phase 15.1 housekeeping — env.ROUTER_BACKEND_TIMEOUT_MS is the single source
  // of truth for the local-backend upstream timeout (ollama / llamacpp / vllm).
  // Default 300_000 (5 min) tolerates cold model loads on WSL2 + shared GPU; the
  // env schema rejects values below 60_000 (see config/env.ts rationale).
  const backendTimeoutMs = opts.env?.ROUTER_BACKEND_TIMEOUT_MS ?? 300_000;
  const makeAdapterWithCloudKey: AdapterFactory = (entry) =>
    defaultMakeAdapter(entry, { cloudApiKey, backendTimeoutMs });

  // WR-02 (TD-03 fix) — stamp `req._t0` at the earliest possible hook so
  // latency_ms is non-zero for pre-preHandler errors (preValidation zod
  // rejection, bearer auth fail-through, rate-limit 429). The preHandler
  // capture in agentIdPreHandler still overwrites this with a tighter
  // measurement for happy-path requests where bearer + rate-limit add a
  // few µs that aren't really "request processing". For error paths, this
  // ensures the recorded duration reflects when the request actually
  // arrived rather than reporting 0 ms.
  app.addHook('onRequest', async (req) => {
    if (req._t0 === undefined) req._t0 = performance.now();
  });

  // Bearer auth — onRequest hook runs BEFORE body parsing and zod validation,
  // so invalid tokens are rejected before any route-level processing occurs.
  // Using 'onRequest' (not 'preHandler') ensures auth is the first gate (Rule 1 fix).
  app.addHook('onRequest', makeBearerHook(opts.bearerToken));

  // Plan 08-06 (ROUTE-11) — per-bearer-token-per-minute rate limit. Runs AFTER
  // bearer auth (we need a validated token to hash) and BEFORE body parsing
  // (don't waste parser cycles on requests we'd reject). Gate: only register
  // when BOTH opts.valkey AND opts.env are present — preserves the contract
  // that pre-08-06 test fixtures (no valkey, no env) are unaffected.
  //
  // Fails open on Valkey errors — the hook logs warn and proceeds. Rationale
  // in middleware/rateLimit.ts header.
  if (opts.valkey && opts.env) {
    const rateLimitPreHandler = makeRateLimitPreHandler({
      valkey: opts.valkey,
      log: app.log as Logger,
      rpmLimit: opts.env.ROUTER_RATE_LIMIT_RPM,
      now: opts.rateLimitNow,
    });
    app.addHook('onRequest', rateLimitPreHandler);
  }

  // Phase 14 (v0.11.0 — POL-03/04): scoped-ID extraction runs BEFORE the
  // agentId preHandler. Both register at the preHandler hook; Fastify v5
  // preserves addHook('preHandler', ...) registration order — first-registered
  // runs first. Ordering matters: agentIdPreHandler enriches the pino child
  // with scoped IDs by reading req.tenantId / req.projectId / req.workloadClass
  // — which scopedIdsPreHandler MUST stamp first (RESEARCH.md Pitfall 3 +
  // D-18 + D-20). Sibling module pattern: scopedIds stamps fields, agentId
  // enriches the pino child with all four IDs in a single assignment (Pitfall-9).
  app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);

  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler runs AFTER bearer
  // auth (onRequest) and BEFORE the route handler. Hook ordering verified
  // against fastify.dev/docs/v5.8.x/Reference/Hooks/: onRequest → ... →
  // preHandler. Bearer must pass first; agent-id is post-auth metadata
  // enrichment. The handler also stamps req._t0 = performance.now() — the
  // latency_ms source for the request_log row (D-D6 + Plan 05-02 Task 3).
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);

  // Phase 17 (v0.11.0 — SESS-05/06): X-Session-ID preHandler runs AFTER
  // agentIdPreHandler — the route session-attach block reads req.agentId to
  // scope SessionStore.loadHistory (P4-03 BLOCK — agent_id is the privileged-
  // write boundary on appendTurn and the anti-cross-agent-leak filter on
  // loadHistory). Absent header is silent-NULL (req.sessionId stays undefined,
  // route short-circuits to Phase 16 stateless byte-identical behavior —
  // SESS-06 regression contract). Invalid header throws InvalidSessionIdError
  // → 400 invalid_session_id envelope via the centralized setErrorHandler
  // below (Plan 17-03 envelope wiring).
  app.addHook('preHandler', opts.sessionIdPreHandler ?? defaultSessionIdPreHandler);

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

    // Plan 08-06 (ROUTE-11) — stamp Retry-After: 60 on RateLimitExceededError
    // BEFORE serializing the envelope. The 60s is fixed (one minute window;
    // the next epoch_minute bucket starts after ≤60s). Co-located with the
    // envelope mapping so the header + body stay in sync if the wire shape
    // ever evolves. Mirrors the BackendSaturatedError pattern in
    // chat-completions.ts (where Retry-After is stamped on the route side
    // before throwing — the centralized path covers the rate-limit case
    // because the hook throws BEFORE the route handler runs).
    if (err instanceof RateLimitExceededError) {
      void reply.header('Retry-After', '60');
    }

    // D-D4 — coverage policy. Record /v1/chat/completions, /v1/messages,
    // /v1/embeddings (Plan 07-04), /v1/rerank (Phase 11, RERANK-04), and
    // /v1/responses (Phase 13, RESP-03) outcomes (but NOT /v1/messages/count_tokens
    // and NOT 401 BearerAuthError — D-D4 forbids recording pre-auth failures).
    const isRecordedRoute =
      (route === '/v1/chat/completions' ||
        route === '/v1/messages' ||
        route === '/v1/embeddings' ||
        route === '/v1/rerank' ||
        route === '/v1/responses') &&
      status !== 401;
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
        // Phase 14: pre-resolve errors still get scoped-ID context if scopedIdsPreHandler ran before the error.
        tenantId: req.tenantId,
        projectId: req.projectId,
        workloadClass: req.workloadClass,
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

  // Adapter cache for probes — one adapter instance per (backend, url) pair.
  // Cleared on app.close() so connections are released on graceful shutdown.
  //
  // Phase 8 Plan 00 (closes 07-REVIEW-FIX §CR-02) — the cache key shape is
  // `${backend}|${url}` (NOT bare url). This is the runtime belt-and-suspenders
  // guarantee that pairs with RegistrySchema.superRefine's "shared backend_url
  // across distinct backends" gate: the schema prevents the ambiguity at boot,
  // and this composite key prevents it at runtime even if a hot-reload were
  // to somehow leak a violating snapshot. Phase 8's OllamaCloudAdapter
  // (`backend: ollama-cloud`, https://ollama.com/v1) can ship without URL
  // collisions even if a future entry shares its URL.
  //
  // Plan 08-00 also widens to respect opts.makeAdapter — previously the probe
  // path hardcoded defaultMakeAdapter, making the probe cache impossible to
  // mock from tests. The BuildAppOpts.makeAdapter contract (see app.ts:62)
  // is "tests inject a fake here to mock the upstream"; probeAdapterFor now
  // honors that contract.
  // Plan 08-02 (CLOUD-01) — when opts.makeAdapter is not supplied (production),
  // fall back to makeAdapterWithCloudKey so probes against a cloud backend's
  // /v1/models surface authenticate correctly. Tests still inject opts.makeAdapter.
  const probeAdapters = new Map<string, ReturnType<typeof defaultMakeAdapter>>();
  const probeMakeAdapter = opts.makeAdapter ?? makeAdapterWithCloudKey;
  const probeAdapterFor = (backend: string, url: string) => {
    const key = `${backend}|${url}`;
    let a = probeAdapters.get(key);
    if (!a) {
      const reg = opts.registry.get();
      const entry = reg.models.find((m) => m.backend === backend && m.backend_url === url);
      if (!entry) throw new Error(`No registry entry for (backend "${backend}", URL "${url}")`);
      a = probeMakeAdapter(entry);
      probeAdapters.set(key, a);
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
    intervalMs: LIVENESS_INTERVAL_MS,
    timeoutMs: 2_000,
    logger: app.log as Parameters<typeof makeLivenessScheduler>[0]['logger'],
    probe: async (url, signal) => {
      // Dispatch on URL prefix (PATTERNS.md §router/src/backends/liveness.ts
      // option b — single scheduler, probe function branches on the synthetic
      // postgres URL). Backend URLs continue to use the adapter probe path.
      if (pgProbe && url === POSTGRES_PROBE_URL) return pgProbe(url, signal);
      // Phase 8 Plan 00 — resolve backend from registry BEFORE calling
      // probeAdapterFor (which now requires both args). The url-first
      // .find() is deterministic because RegistrySchema.superRefine
      // guarantees no two distinct backends share a URL.
      // Unknown URLs (e.g. a stale URL still in the scheduler's URL set
      // after a hot-reload removed the entry) return a synthetic down
      // probe result rather than throwing — the scheduler does not
      // unwrap thrown errors from this callback, and a throw would
      // surface as an uncaught rejection in the timer tick.
      const reg = opts.registry.get();
      const entry = reg.models.find((m) => m.backend_url === url);
      if (!entry) {
        return { ok: false, latencyMs: 0, error: `no registry entry for url "${url}"` };
      }
      const adapter = probeAdapterFor(entry.backend, url);
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

  // Plan 08-01 (DATA-06) — decorate Valkey when present so Phase 8 consumers
  // (breaker / rate-limit / idempotency / models-cache) can read `app.valkey`.
  // The decorator is conditional because most test fixtures construct buildApp
  // without a Valkey client — they exercise routes that don't touch it.
  if (opts.valkey) app.decorate('valkey', opts.valkey);

  // Plan 08-04 (CLOUD-03 / D-B1..D-B4) — per-backend circuit breaker. When
  // both opts.valkey AND opts.env are present, construct a real Valkey-backed
  // breaker; otherwise fall back to a no-op breaker so existing test fixtures
  // (which omit both fields) continue to work unmodified.
  //
  // Production wiring (index.ts) always passes a real Valkey client + the
  // CIRCUIT_* env subset, so the no-op path is exclusively a test-fixture
  // concern.
  // Phase 14 (v0.11.0 — POL-05 / P8-01 BLOCK): opts.breaker is the test injection
  // seam added to BuildAppOpts. When present, it overrides the valkey/env construction
  // (test spy asserts breaker counter unchanged after policy 403). Production path
  // (opts.breaker absent) uses the existing valkey+env construction unchanged.
  const breaker: CircuitBreaker =
    opts.breaker ??
    (opts.valkey && opts.env
      ? makeCircuitBreaker({
          valkey: opts.valkey,
          log: app.log as Logger,
          env: opts.env,
          now: opts.breakerNow,
        })
      : {
          check: async () => ({ state: 'closed' as const }),
          recordFailure: async () => {
            /* no-op */
          },
          recordSuccess: async () => {
            /* no-op */
          },
          reset: async () => {
            /* no-op */
          },
        });

  // Pre-compute the Retry-After value (seconds, rounded up from ms) so the
  // routes can stamp it without re-reading env.
  const breakerCooldownSec = opts.env
    ? Math.ceil(opts.env.CIRCUIT_COOLDOWN_MS / 1000)
    : 60;

  // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency-Key multiplexer.
  // Gated on opts.valkey (the multiplexer NEEDS pub/sub — there is no
  // sensible no-op fallback because the wire semantics differ when keys
  // are honored vs. ignored). When valkey is absent (test fixtures, dev
  // without Valkey), the multiplexer is undefined and the route helpers
  // skip the idempotency branch entirely — the header is silently ignored
  // (better than a 503 when the operator hasn't deployed Valkey yet).
  //
  // Production wiring (index.ts) always passes opts.valkey, so the
  // multiplexer is always constructed at runtime. Subscriber-mode
  // connections are created via valkey.duplicate() per ioredis pub/sub
  // semantics — a subscribed connection cannot issue other commands.
  let idempotency: IdempotencyMultiplexer | undefined;
  if (opts.valkey) {
    idempotency = makeIdempotencyMultiplexer({
      valkey: opts.valkey,
      log: app.log as Logger,
      // Type-safe-ish: ioredis exposes `.duplicate()` on Redis instances.
      // Cast through unknown because the ValkeyClient alias doesn't expose
      // the duplicate method in its public type (test fixtures often
      // hand-roll mocks without it).
      subscriberFactory: () =>
        (opts.valkey as unknown as { duplicate(): typeof opts.valkey }).duplicate() as NonNullable<typeof opts.valkey>,
    });
  }

  // Shutdown hook (D-D7) — clears all timers so process exit is clean.
  // semaphoreMap.clear() tidies the Map; active timer waiters inside the semaphore
  // will reject on their own setTimeout fires (process is exiting).
  //
  // Phase 5 (D-A4): drain the bufferedWriter LAST — after the semaphore map
  // is cleared, in-flight requests have stopped. The 3 s race lets a final
  // flush land before SIGTERM hardstops. Compose's default stop_grace_period
  // is 10s, so 3s fits comfortably.
  //
  // Phase 8 (DATA-06): closeValkey runs BETWEEN usageDailyScheduler.stop() and
  // bufferedWriter.drain(). Rationale: a Valkey write from an in-flight request
  // (breaker state, rate-limit INCR, idempotency SETNX) should flush BEFORE the
  // pg drain races its 3 s timeout — otherwise the request_log row might land
  // pointing at a "current breaker state" that never made it into Valkey.
  // closeValkey races its own 1 s timeout (see clients/valkey.ts).
  app.addHook('onClose', async () => {
    liveness.stop();
    probeAdapters.clear();
    semaphoreMap.clear();
    // Plan 05-04 — stop the usage_daily scheduler BEFORE the bufferedWriter
    // drain. Both are idempotent + synchronous (stop just clears timers).
    // The drain is awaited LAST because it races a setTimeout(3_000).
    opts.usageDailyScheduler?.stop();
    // Plan 08-01 (DATA-06) — close Valkey BEFORE bufferedWriter.drain so any
    // pending Valkey-bound writes (breaker / rate-limit / idempotency state)
    // settle before the pg drain runs.
    if (opts.valkey) await closeValkey(opts.valkey, app.log as Logger);
    await opts.bufferedWriter.drain(3_000);
  });

  // -------------------------------------------------------------------------
  // Phase 15 (v0.11.0 — MCPS-01..06 / 15-CONTEXT D-15) — MCP host plugin
  // -------------------------------------------------------------------------
  //
  // Registered AFTER FastifySSEPlugin (line 243) and AFTER the bearer
  // onRequest hook + scopedIdsPreHandler + agentIdPreHandler (lines 268-311)
  // so that requests to /mcp inherit the same auth + scoped-ID + pino-child
  // pipeline as /v1/*. The plugin itself uses raw `req.raw`/`reply.raw`
  // against `@modelcontextprotocol/sdk@^1.29.0`'s StreamableHTTPServerTransport.
  //
  // Registered AFTER the main onClose hook above so Fastify v5 fires that
  // hook FIRST (liveness.stop → probeAdapters.clear → semaphoreMap.clear →
  // usageDailyScheduler.stop → closeValkey → bufferedWriter.drain(3_000)),
  // and the MCP plugin's own onClose hook fires AFTER (shutdownSessions
  // with 5s Promise.race ceiling). This ordering matches the existing
  // 10s Compose stop_grace_period budget: 3s drain + 5s MCP race ≈ 8s.
  //
  // When opts.env?.MCP_ENABLED is false (operator override), the plugin's
  // body short-circuits before registering the /mcp route — /mcp then 404s.
  await app.register(mcpHostPlugin, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    bufferedWriter: opts.bufferedWriter,
    metrics: opts.metrics,
    breaker,
    env: {
      MCP_ENABLED: opts.env?.MCP_ENABLED ?? true,
      MCP_SESSION_TTL_SEC: opts.env?.MCP_SESSION_TTL_SEC ?? 3600,
      MCP_GC_INTERVAL_MS: opts.env?.MCP_GC_INTERVAL_MS ?? 1_800_000,
    },
  });

  // -------------------------------------------------------------------------
  // X-Model-Backend response header (Plan 08-03, ROUTE-10)
  // -------------------------------------------------------------------------
  //
  // onSend fires after the route handler returns and BEFORE the body is
  // serialized + flushed. For non-stream responses, this places the header
  // cleanly in the initial HTTP response. For SSE streams (chat-completions,
  // messages stream branch), the SSE plugin (fastify-sse-v2) flushes headers
  // on the first reply.sse(...) call AFTER all onSend hooks have run — so the
  // header lands in the initial response block, BEFORE the first `data:` frame.
  //
  // Skip the header when req.resolvedBackend is undefined: pre-resolve errors
  // (unknown model 404, missing bearer 401) and routes that never resolve a
  // backend (/healthz, /readyz, /metrics, /v1/models, /v1/messages/count_tokens)
  // all naturally produce responses without the header.
  //
  // Each route handler stamps req.resolvedBackend = entry.backend immediately
  // after the registry.resolve(body.model) call. count-tokens deliberately
  // does NOT stamp (pure-CPU token estimate; no backend dispatch — D-F1).
  //
  // D-E2: Traefik passes custom response headers through by default; Plan 08-10's
  // smoke verifies the header survives the edge and is present on SSE streams.
  // T-08-T-03 mitigation: reply.header() replaces (not appends), so any upstream
  // X-Model-Backend echo cannot tamper with the value we stamp here.
  app.addHook('onSend', async (req, reply, payload) => {
    const backend = req.resolvedBackend;
    if (backend) {
      void reply.header('X-Model-Backend', backend);
    }
    // Phase 13 (v0.10.0 — COST-02): X-Cost-Cents response header. Routes stamp
    // req.computedCostCents BEFORE return reply.send(...) when entry.pricing was
    // declared AND tokens were known. Header is intentionally absent when the
    // value is undefined (local backends, pre-token failures) — that's the
    // COST-02 contract ("header ausente cuando cost_cents es NULL").
    const cost = req.computedCostCents;
    if (cost !== undefined) {
      void reply.header('X-Cost-Cents', cost);
    }
    return payload;
  });

  // -------------------------------------------------------------------------
  // Phase 17 (v0.11.0 — Pitfall 17-I): countTokens boot warmup
  // -------------------------------------------------------------------------
  //
  // Warm up gpt-tokenizer's cl100k_base encoding tables at boot so the first
  // session-attached request doesn't eat ~50-200 ms of lazy-load latency
  // inside the route handler (the cl100k_base BPE dictionary is ~1 MB and
  // loads on first import + first encode() call). Same module already used by
  // /v1/messages/count_tokens since Phase 4 — warmup is safe and idempotent.
  //
  // Pass a minimal valid CanonicalRequest so the encoder exercises the real
  // code path (encode() of system + a text message). Wrapped in try/catch
  // because countTokens is best-effort — a failure here MUST NOT prevent
  // boot. Route handlers tolerate countTokens failures (return 0) so any
  // future regression surfaces as a warn log + observable cold-start
  // latency, not a startup crash.
  try {
    countTokens({
      model: 'warmup',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'warmup' }] }],
    });
  } catch (warmupErr) {
    app.log.warn(
      { err: warmupErr },
      'countTokens warmup failed (non-fatal — first request will incur tokenizer init latency)',
    );
  }

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
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    semaphores,
    recordOutcome,
    breaker,
    breakerCooldownSec,
    idempotency,
    // Phase 10 (v0.10.0 — JSON-06): inject just the counter the route needs.
    metrics: { jsonValidationTotal: opts.metrics.jsonValidationTotal },
    // Phase 17 (v0.11.0 — SESS-01..06 / CTXP-01..03 / SUMP-02): pass-through.
    // When opts.sessionStore is undefined the route is byte-identical to
    // Phase 16 (SESS-06 stateless contract — all three are optional).
    sessionStore: opts.sessionStore,
    contextProvider: opts.contextProvider,
    summaryProvider: opts.summaryProvider,
  });

  // Plan 04-02 (ANTHR-02, ANTHR-03, ANTHR-04, ANTHR-05):
  //  - POST /v1/messages — Anthropic Messages API non-stream branch (stream→501 stub,
  //    replaced by Plan 04-03's SSE pipeline).
  //  - POST /v1/messages/count_tokens — pure CPU; no backend call, no semaphore (D-F1).
  registerMessagesRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    semaphores,
    recordOutcome,
    breaker,
    breakerCooldownSec,
    idempotency,
    // Phase 17 (v0.11.0 — SESS-01..06 / CTXP-01..03 / SUMP-02): pass-through.
    sessionStore: opts.sessionStore,
    contextProvider: opts.contextProvider,
    summaryProvider: opts.summaryProvider,
  });
  registerCountTokensRoute(app, { registry: opts.registry });

  // GET /v1/models — bearer-gated; lists all registry models (Plan 03-02, OAI-03).
  registerModelsRoute(app, opts.registry);

  // Phase 12 (v0.10.0 — EMB-H01..04) — Valkey-backed per-input cache for
  // /v1/embeddings. Gated on opts.valkey AND opts.env (which carries the TTL).
  // When either is absent, embeddingsCache is undefined and the route falls
  // back to Phase 7 behavior (every item hits the adapter; dims still enforced).
  // Fail-open semantics live inside the route — see embeddings.ts header.
  const embeddingsCache =
    opts.valkey && opts.env
      ? makeEmbeddingsCache({
          valkey: opts.valkey,
          ttlSec: opts.env.ROUTER_EMBED_CACHE_TTL_SEC,
          log: app.log as Logger,
        })
      : undefined;

  // Plan 07-04 (OAI-02, EMBED-01):
  //  - POST /v1/embeddings — OpenAI-compat embedding endpoint dispatching to
  //    Ollama (bge-m3) or vLLM-embed (BAAI/bge-m3) via the factory.
  //    Non-streaming; reuses semaphores + recordOutcome from Phase 3 + Phase 5.
  //    Capability gate enforces entry.capabilities.includes('embeddings')
  //    BEFORE the adapter call (T-07-11 mitigation, route-side layer).
  // Phase 12 (v0.10.0): cache + 3 new metrics threaded in via opts.
  registerEmbeddingsRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    semaphores,
    recordOutcome,
    breaker,
    breakerCooldownSec,
    idempotency,
    cache: embeddingsCache,
    metrics: {
      embeddingsCacheTotal: opts.metrics.embeddingsCacheTotal,
      embeddingsBatchSize: opts.metrics.embeddingsBatchSize,
      embeddingsDimsTotal: opts.metrics.embeddingsDimsTotal,
    },
  });

  // Phase 11 (v0.10.0 — RERANK-01..06) — POST /v1/rerank.
  registerRerankRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    semaphores,
    recordOutcome,
    breaker,
    breakerCooldownSec,
    idempotency,
  });

  // Phase 13 (v0.10.0 — RESP-01..04) — POST /v1/responses (minimal, non-stream).
  // Shares the full plumbing: auth, rate-limit, breaker, semaphore, idempotency,
  // request_log, X-Model-Backend, X-Cost-Cents. Streaming deferred to v0.11.
  registerResponsesRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeAdapterWithCloudKey,
    semaphores,
    recordOutcome,
    breaker,
    breakerCooldownSec,
    idempotency,
    // Phase 17 (v0.11.0 — SESS-01..06 / CTXP-01..03 / SUMP-02): pass-through.
    sessionStore: opts.sessionStore,
    contextProvider: opts.contextProvider,
    summaryProvider: opts.summaryProvider,
  });

  // Plan 05-04 — start the usage_daily scheduler last, after all routes are
  // registered. The first refresh fires at the next UTC midnight; runNow()
  // is exposed for ops + tests. The onClose hook (above) stops the timers.
  opts.usageDailyScheduler?.start();

  return app;
}
