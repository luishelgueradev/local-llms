import pino, { type LoggerOptions } from 'pino';
import { loadEnv } from './config/env.js';
import { loadRegistryFromFile, makeRegistryStore, watchRegistry } from './config/registry.js';
import { buildApp } from './app.js';
import { makeLoggerOptions } from './log/logger.js';
import { makeDb, makePool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { makeBufferedWriter } from './db/bufferedWriter.js';
import { makeMetricsRegistry } from './metrics/registry.js';

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
      const urls = Array.from(new Set(next.models.map((m) => m.backend_url)));
      app.liveness.start(urls);
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
