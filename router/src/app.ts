import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
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
import { makeOllamaAdapterFromEntry } from './backends/ollama-openai.js';
import type { AdapterFactory } from './backends/adapter.js';
import { registerModelsRoute } from './routes/v1/models.js';
import { toOpenAIErrorEnvelope, mapToHttpStatus, NO_ENVELOPE } from './errors/envelope.js';
import { makeLivenessScheduler, type LivenessScheduler } from './backends/liveness.js';
import { makeAdapter as defaultMakeAdapter } from './backends/factory.js';
import { registerReadyz } from './routes/readyz.js';
import { BackendSemaphore } from './concurrency/semaphore.js';

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
}

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

  // Centralized error handler — D-C1 envelope for ANY uncaught error from a route.
  // The route handlers in plan 02-03 + 02-04 may also handle errors locally; this is the
  // catch-all for "the route threw".
  app.setErrorHandler((err, req, reply) => {
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      // Client disconnected mid-pre-stream — nothing to send.
      return;
    }
    const status = mapToHttpStatus(err);
    req.log.warn({ err, url: req.url, status }, 'route error -> envelope');
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

  const schedulerOpts: Parameters<typeof makeLivenessScheduler>[0] = {
    intervalMs: 10_000,
    timeoutMs: 2_000,
    logger: app.log as Parameters<typeof makeLivenessScheduler>[0]['logger'],
    probe: async (url, signal) => {
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
  const distinctUrls = Array.from(new Set(opts.registry.get().models.map((m) => m.backend_url)));
  liveness.start(distinctUrls);

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
  app.addHook('onClose', async () => {
    liveness.stop();
    probeAdapters.clear();
    semaphoreMap.clear();
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  registerHealthz(app, opts.registry);

  // GET /readyz — public, per-backend liveness summary (Plan 03-03, ROUTE-06).
  registerReadyz(app, opts.registry, liveness);

  // Chat completions — non-stream branch in plan 02-03; stream branch in plan 02-04
  // (same route file; plan 02-04 replaces the 501 stub).
  // Plan 03-04: semaphores injected for per-backend concurrency cap (ROUTE-07).
  registerChatCompletionsRoute(app, {
    registry: opts.registry,
    makeAdapter: opts.makeAdapter ?? makeOllamaAdapterFromEntry,
    semaphores,
  });

  // GET /v1/models — bearer-gated; lists all registry models (Plan 03-02, OAI-03).
  // Option β: app.ts keeps makeOllamaAdapterFromEntry for chat; Plan 03-01 (wave 2)
  // will swap it to defaultMakeAdapter from factory.ts.
  registerModelsRoute(app, opts.registry);

  return app;
}
