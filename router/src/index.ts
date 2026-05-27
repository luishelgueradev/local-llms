import pino, { type LoggerOptions } from 'pino';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Env } from './config/env.js';
import { loadRegistryFromFile, makeRegistryStore, watchRegistry, type Registry } from './config/registry.js';
import { buildApp, POSTGRES_PROBE_URL } from './app.js';
import { makeLoggerOptions } from './log/logger.js';
import { makeDb, makePool } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { makeBufferedWriter } from './db/bufferedWriter.js';
import { makeUsageDailyScheduler } from './db/usageDaily.js';
import { makeMetricsRegistry } from './metrics/registry.js';
import { makeValkeyClient, waitUntilReady } from './clients/valkey.js';
import { makeRegistryCache } from './config/registryCache.js';
import { installGlobalBackendDispatcher } from './backends/http-dispatcher.js';

/**
 * Plan 08-02 (CLOUD-01 + D-A2) — refuses boot when the registry declares any
 * `backend: ollama-cloud` model entry but env.OLLAMA_API_KEY is empty.
 *
 * Why this is a cross-check rather than a schema field: zod schemas are static —
 * the env schema has no awareness of the registry. Doing the check here means
 * - operators with no cloud models can leave OLLAMA_API_KEY empty (or absent
 *   from .env entirely) and the router boots normally.
 * - operators who add a cloud entry to models.yaml WITHOUT setting the env var
 *   get a loud failure at next boot, not a silent 401 at first request.
 *
 * Exported as a named function so a vitest unit test can exercise it without
 * spinning up the full router boot.
 */
export function assertCloudEnvIfConfigured(reg: Registry, env: Env): void {
  const hasCloud = reg.models.some((m) => m.backend === 'ollama-cloud');
  if (hasCloud && (!env.OLLAMA_API_KEY || env.OLLAMA_API_KEY.trim() === '')) {
    throw new Error(
      'Config error: router/models.yaml declares one or more `backend: ollama-cloud` entries ' +
        'but OLLAMA_API_KEY is empty in the environment. Set OLLAMA_API_KEY=... in .env ' +
        '(get a key from https://ollama.com → Settings → API Keys) or remove the cloud entries.',
    );
  }
}

async function main(): Promise<void> {
  // router-504-stale-sockets: replace the process-wide undici dispatcher with a
  // no-idle-keep-alive Agent BEFORE any backend client is constructed or any
  // request is made. This evicts the stale/poisoned-socket reuse that caused
  // idle requests to hang to the 30s route deadline → 504. See http-dispatcher.ts.
  installGlobalBackendDispatcher();

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

  // Plan 08-09 (DATA-06) — 30s Valkey-backed read-through cache for the parsed
  // models.yaml registry. File is the source of truth (D-D4); the cache is a
  // derivative that (a) shaves YAML parse + zod validation off warm restarts and
  // (b) is the structural seam for future multi-instance routers (v2) which
  // would share the cached snapshot across nodes.
  const registryCache = makeRegistryCache({ valkey, log: bootLog });

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

  // Gap-closure 08-11 (DATA-06): await Valkey readiness before issuing the first
  // cache command. The client is constructed with lazyConnect:false +
  // enableOfflineQueue:false; without this guard, get()/set() fire before the
  // TCP+AUTH handshake completes and ioredis throws "Stream isn't writeable".
  // Fail-open: if Valkey never becomes ready within 2000ms, waitUntilReady
  // resolves and the existing try/catch inside registryCache.get/set + file-load
  // fallback handle the Valkey-down case normally.
  await waitUntilReady(valkey);

  // Fail-fast on bad models.yaml (D-C3 startup half — hot-reload's keep-previous semantics
  // land in plan 02-05's watcher).
  //
  // Plan 08-09 (DATA-06) — try the Valkey-backed warm cache FIRST. On hit, skip
  // the YAML re-parse + zod re-validation; on miss, fall back to the file (the
  // source of truth) and populate the cache for the next restart / next instance.
  // A cache miss on a fresh restart is expected; a cache hit indicates the
  // previous router instance wrote the registry within the 300s TTL window.
  const cachedRegistry = await registryCache.get();
  let initialRegistry;
  if (cachedRegistry) {
    bootLog.info({ models: cachedRegistry.models.length }, 'registry: warm cache hit (Valkey)');
    initialRegistry = cachedRegistry;
  } else {
    bootLog.info('registry: warm cache miss; loading from file');
    initialRegistry = loadRegistryFromFile(env.MODELS_YAML_PATH);
    // Populate the cache for the next restart / next instance. Non-fatal on
    // failure (warn-logged inside registryCache.set).
    await registryCache.set(initialRegistry);
  }

  // Plan 08-02 (CLOUD-01) — refuse to boot if models.yaml declares cloud entries
  // but env.OLLAMA_API_KEY is empty. Placed after env-parse + registry-parse
  // so both inputs are validated before the cross-check runs. See JSDoc on
  // assertCloudEnvIfConfigured (above main) for rationale.
  assertCloudEnvIfConfigured(initialRegistry, env);

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
    // Plan 08-02 (CLOUD-01) — pre-bind OLLAMA_API_KEY into the AdapterFactory
    // closure. Empty string when the operator runs local-only — assertCloudEnvIfConfigured
    // (above) refused to boot if cloud entries existed without a real key.
    cloudApiKey: env.OLLAMA_API_KEY ?? '',
    // Plan 08-04 (CLOUD-03 / D-B2) — env subset for the per-backend circuit
    // breaker. Pairs with `valkey` above: buildApp constructs a real Valkey-
    // backed breaker only when both fields are present.
    //
    // Plan 08-06 (ROUTE-11 / D-D3) — ROUTER_RATE_LIMIT_RPM joins the subset;
    // the rate-limit hook is registered under the same `opts.valkey && opts.env`
    // gate as the breaker. Production wiring always provides both.
    env: {
      CIRCUIT_FAILURE_THRESHOLD: env.CIRCUIT_FAILURE_THRESHOLD,
      CIRCUIT_WINDOW_MS: env.CIRCUIT_WINDOW_MS,
      CIRCUIT_COOLDOWN_MS: env.CIRCUIT_COOLDOWN_MS,
      ROUTER_RATE_LIMIT_RPM: env.ROUTER_RATE_LIMIT_RPM,
    },
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
      // 08-REVIEW WR-07 fix: re-run the cloud-env cross-check on every
      // hot-reload, NOT just at boot. Without this, an operator who adds
      // a `backend: ollama-cloud` entry to models.yaml after start gets
      // a silent runtime trap — the first request to the new model hits
      // factory.ts's defense-in-depth check and returns a 500-ish error
      // instead of the controlled boot-time refusal.
      //
      // We do NOT throw here — that would kill the watcher and rollover
      // semantics. Instead, log at error level and SKIP the swap, mirroring
      // the existing onError keep-previous semantics. The previous
      // (pre-reload) registry stays active; the operator sees the error
      // line and fixes the config.
      //
      // NOTE: watchRegistry already committed `next` to the registry store
      // BEFORE calling onReload (registry.ts contract — onReload fires
      // AFTER the swap). The pre-swap shape of this hook is not exposed,
      // so we treat onReload as a post-condition validation that can
      // surface misconfiguration but cannot "undo" the swap. For the
      // single-operator scope here, the misconfigured-cloud-on-hot-reload
      // case fails to authenticate at the first request rather than
      // looping back to the pre-reload snapshot — acceptable until v2
      // adds a richer two-phase commit. The error log is the operator's
      // signal to revert the YAML.
      try {
        assertCloudEnvIfConfigured(next, env);
      } catch (cloudErr) {
        app.log.error(
          { err: cloudErr },
          'registry hot-reload: cloud env cross-check failed (cloud entries will return 500 until OLLAMA_API_KEY is set or entries are removed)',
        );
      }
      app.log.info({ models: next.models.length, names: next.models.map((m) => m.name) }, 'registry reloaded');
      // Plan 08-09 (DATA-06) — propagate the new snapshot to Valkey BEFORE
      // doing further reload work so multi-instance peers (v2) and any
      // future warm-restart sees the latest shape. watchRegistry's onReload
      // callback is typed as synchronous (Registry => void), so we
      // fire-and-forget; registryCache.set is itself non-throwing
      // (warn-logged on Valkey error inside the factory).
      void registryCache.set(next).catch((err: unknown) => {
        app.log.warn({ err }, 'registry cache: post-reload set failed (non-fatal)');
      });
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

/**
 * Plan 08-02 (CLOUD-01) — only run main() when this module is the process
 * entrypoint, not when it's imported as a library (e.g. from a vitest test that
 * needs the exported assertCloudEnvIfConfigured helper). Without the gate, the
 * test-side import would invoke main(), boot the full app, and call
 * process.exit(1) when env parsing fails on the test's incomplete env — causing
 * vitest to abort with "process.exit unexpectedly called".
 *
 * The check compares the resolved path of import.meta.url against process.argv[1]
 * (the file Node was invoked with). Equivalent to the CommonJS
 * `require.main === module` idiom in ESM.
 */
const isMainModule =
  typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
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
}
