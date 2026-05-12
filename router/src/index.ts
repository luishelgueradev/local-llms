import { loadEnv } from './config/env.js';
import { loadRegistryFromFile, makeRegistryStore, watchRegistry } from './config/registry.js';
import { buildApp } from './app.js';
import { makeLoggerOptions } from './log/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const loggerOpts = makeLoggerOptions({ level: env.LOG_LEVEL, isDev: env.NODE_ENV !== 'production' });

  // Fail-fast on bad models.yaml (D-C3 startup half — hot-reload's keep-previous semantics
  // land in plan 02-05's watcher).
  const initialRegistry = loadRegistryFromFile(env.MODELS_YAML_PATH);
  const registry = makeRegistryStore(initialRegistry);

  const app = await buildApp({ registry, bearerToken: env.ROUTER_BEARER_TOKEN, loggerOpts });

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

void main();
