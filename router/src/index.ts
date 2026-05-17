import pino, { type LoggerOptions } from 'pino';
import { loadEnv } from './config/env.js';
import { loadRegistryFromFile, makeRegistryStore, watchRegistry } from './config/registry.js';
import { buildApp, POSTGRES_PROBE_URL } from './app.js';
import { makeLoggerOptions } from './log/logger.js';
import { makeDb, makePool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { makeBufferedWriter } from './db/bufferedWriter.js';
import { makeUsageDailyScheduler } from './db/usageDaily.js';
import { makeMetricsRegistry } from './metrics/registry.js';
import { makeValkeyClient } from './clients/valkey.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const loggerOpts = makeLoggerOptions({ level: env.LOG_LEVEL, isDev: env.NODE_ENV !== 'production' });

  // Phase 5 boot wiring (D-B2 + D-B5 + D-A4): pool → migrate → bufferedWriter
  // BEFORE buildApp so the writer (a required BuildAppOpts field) is ready.
  //
  // The makeBufferedWriter logger param needs a pino instance, but app.log
  // doesn't exist until after buildApp returns. Resolution per the plan:
  // construct a standalone pino instance from the same loggerOpts so the
  // bootLog and app.log share level + redact config. (Fastify v5 takes the
  // same options shape internally and produces a logger whose root has
  // identical configuration.)
  const bootLog = pino(loggerOpts as LoggerOptions);

  const pool = makePool(env.ROUTER_DATABASE_URL);
  const db = makeDb(pool);
  await runMigrations(db, bootLog);

  // Plan 08-01 (DATA-06) — open the Valkey connection BEFORE buildApp so any
  // misconfiguration (wrong VALKEY_PASSWORD, network unreachable) surfaces as
  // a fast boot failure rather than a silent runtime first-INCR throw. The
  // client is configured with enableOfflineQueue: false + maxRetriesPerRequest: 1
  // (see clients/valkey.ts) so it does NOT block the boot path; a Valkey outage
  // emits a 'error' log line, and downstream consumers (rate-limit / breaker /
  // idempotency / models-cache) handle the per-route fallback per their own
  // policy (Plans 08-04, 08-06, 08-07, 08-09).
  const valkey = makeValkeyClient({
    url: env.ROUTER_VALKEY_URL,
    password: env.ROUTER_VALKEY_PASSWORD,
    log: bootLog,
  });

  // Plan 05-02 (D-C3, OBS-01) — fresh prom-client registry per process.
  // Constructed BEFORE the bufferedWriter so its logBufferDroppedTotal
  // counter wires into the writer as the real counter (replacing the
  // stub from Plan 05-01).
  const metrics = makeMetricsRegistry();

  const bufferedWriter = makeBufferedWriter({
    db,
    droppedCounter: metrics.logBufferDroppedTotal,
    logger: bootLog,
  });

  // Plan 05-04 (DATA-04) — usage_daily refresh scheduler. start() is called
  // inside buildApp() after route wiring; stop() is called in the onClose
  // hook BEFORE bufferedWriter.drain. The first refresh fires at the next
  // UTC midnight; idempotent UPSERT means a missed midnight (router was
  // offline) is recovered at the next tick.
  const usageDailyScheduler = makeUsageDailyScheduler({ db, log: bootLog });

  // Fail-fast on bad models.yaml (D-C3 startup half — hot-reload's keep-previous semantics
  // land in plan 02-05's watcher).
  const initialRegistry = loadRegistryFromFile(env.MODELS_YAML_PATH);
  const registry = makeRegistryStore(initialRegistry);

  const app = await buildApp({
    registry,
    bearerToken: env.ROUTER_BEARER_TOKEN,
    loggerOpts,
    bufferedWriter,
    metrics,
    usageDailyScheduler,
    pool, // Plan 05-04 D-G2 — enables /readyz postgres probe
    valkey, // Plan 08-01 DATA-06 — decorates app.valkey for Phase 8 consumers
  });

  // RESEARCH A4 / Pitfall 7 — operator opts into polling fallback for WSL2 + Docker
  // Desktop bind-mount flakiness via env. Default false (event-based fs.watch).
  const usePolling = process.env.MODELS_YAML_WATCH === 'poll';
  if (usePolling) app.log.info('registry hot-reload: polling fallback enabled (MODELS_YAML_WATCH=poll)');

  const watcher = watchRegistry(env.MODELS_YAML_PATH, registry, {
    debounceMs: 250,
    usePolling,
    pollingIntervalMs: 1000,
    onReload: (next) => {
      app.log.info({ models: next.models.length, names: next.models.map((m) => m.name) }, 'registry reloaded');
      // Phase 3: re-register liveness probes against the new URL set.
      // liveness.start() is idempotent — de-dups timers; clears removed URLs (Pitfall 6).
      const backendUrls = Array.from(new Set(next.models.map((m) => m.backend_url)));
      // CR-01 (05-VERIFICATION.md gaps[0]): mirror app.ts:308-311 boot wiring so the
      // postgres /readyz probe survives hot-reloads. Without this re-add, the
      // liveness scheduler's start(urls) deletion-semantics (liveness.ts:104-111)
      // clear the postgres probe timer + cache entry on every reload, leaving
      // /readyz returning 503 + postgres.status='down — never probed' until process
      // restart. `pool` is in closure scope from the outer-scope `const pool` above.
      const urls = pool ? [...backendUrls, POSTGRES_PROBE_URL] : backendUrls;
      app.liveness.start(urls);
      // IN-01 (03-REVIEW.md): semaphoreMap is NOT rebuilt here. It is built once
      // at buildApp() time from the initial registry snapshot (app.ts). Within Phase 3
      // this is safe because the zod schema restricts backend to ['ollama', 'llamacpp']
      // (LocalBackendEnum) — both semaphores are always present at boot.
      //
      // IMPORTANT: If a future phase widens LocalBackendEnum (e.g. adds 'vllm' in
      // Phase 7), adding a new backend entry to models.yaml via hot-reload will cause
      // opts.semaphores.get('vllm') to throw Error("No semaphore for backend \"vllm\""),
      // producing 500 responses for that backend until the router restarts.
      //
      // Resolution before widening the enum: either (a) rebuild semaphoreMap here
      // by passing a rebuild callback out of buildApp(), or (b) require a router
      // restart whenever a new backend TYPE is introduced (only model variants of
      // existing backends can be hot-reloaded safely).
    },
    onError: (err) => {
      // D-C3 — keep previous registry, log at error, do not crash.
      app.log.error({ err }, 'registry hot-reload failed (keeping previous in-memory registry)');
    },
  });

  const closeGracefully = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'received shutdown signal — closing');
    try {
      watcher.stop();
      await app.close();
      // Belt-and-suspenders (Phase 5): release the pg pool's sockets after
      // app.close() so the process exits cleanly even on networks where
      // idleTimeoutMillis hasn't elapsed yet.
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void closeGracefully('SIGTERM'));
  process.once('SIGINT', () => void closeGracefully('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info({ port: env.PORT, registry_models: registry.get().models.length }, 'router listening');
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // No app.log available yet (we crashed before or during buildApp). Emit a single
  // pino-shaped JSON line on stderr so log shippers still parse it; level 60 = fatal.
  // WR-03 fix — surface pre-listen throws (loadEnv / loadRegistryFromFile / buildApp)
  // through structured logging instead of as an unhandled promise rejection.
  const e = err as { name?: string; message?: string; stack?: string } | undefined;
  process.stderr.write(
    `${JSON.stringify({
      level: 60,
      time: Date.now(),
      msg: 'failed to start',
      err: { name: e?.name, message: e?.message, stack: e?.stack },
    })}\n`,
  );
  process.exit(1);
});
