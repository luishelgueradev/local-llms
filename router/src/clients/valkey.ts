// router/src/clients/valkey.ts — Phase 8 (DATA-06).
//
// Single Valkey/ioredis client construction + graceful shutdown helper.
// Used by:
//   - Plan 08-04 (circuit breaker — state writes per backend on failure/success)
//   - Plan 08-06 (rate limit — INCR + EXPIRE on bearer-hash key)
//   - Plan 08-07 (idempotency mux — SETNX + pub/sub)
//   - Plan 08-09 (models.yaml cache — GET/SET with 30s TTL)
//
// Client tuning:
//   - lazyConnect: false — the constructor opens the TCP connection eagerly so
//     boot fails fast if Valkey is unreachable (preferable to a silent runtime
//     failure on the first INCR).
//   - enableOfflineQueue: false — when Valkey is down, commands REJECT instead
//     of queuing forever. Rate-limit + breaker code paths MUST surface "Valkey
//     down" as an explicit error so the route can fail fast (open the breaker)
//     rather than block the request indefinitely.
//   - maxRetriesPerRequest: 1 — single quick retry; second failure throws.
//     ioredis's default is 20 which is way too high for a low-latency surface.
//   - connectTimeout: 2_000 ms — boot fails fast if the network is wrong.
//
// On shutdown: closeValkey(client) awaits client.quit() with a 1 s race; if
// the QUIT command itself wedges (rare — usually only on a half-open socket),
// the race throws and the caller logs + force-disconnects. Same pattern as
// bufferedWriter.drain(3_000).
// ioredis is published as CommonJS. The .d.ts re-exports both a `default`
// AND a named `Redis` (both alias the same class). The runtime sets
// `module.exports = require('./Redis').default` so `require('ioredis')` IS
// the Redis class. Under tsconfig `module: nodenext` + `verbatimModuleSyntax`,
// importing the default + a type-only named import in the same statement
// triggers TS2351 (the default value is seen as the namespace, not the
// class). Resolution: import the named `Redis` export (which IS the same
// class — see node_modules/ioredis/built/index.d.ts) as the runtime value,
// and lift options/instance types via `import type`.
import { Redis as IORedis } from 'ioredis';
import type { Redis as IORedisClient, RedisOptions } from 'ioredis';
import type { Logger } from 'pino';

export interface MakeValkeyClientOpts {
  url: string;
  password: string;
  log: Logger;
}

export function makeValkeyClient(opts: MakeValkeyClientOpts): IORedisClient {
  const { url, password, log } = opts;
  const ioRedisOpts: RedisOptions = {
    password,
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  };
  const client = new IORedis(url, ioRedisOpts);
  client.on('error', (err: Error) => log.warn({ err }, 'valkey client error'));
  client.on('connect', () => log.info({ url }, 'valkey connected'));
  return client;
}

export async function closeValkey(client: IORedisClient, log?: Logger): Promise<void> {
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('valkey-quit-timeout-1s')), 1_000),
      ),
    ]);
  } catch (err) {
    log?.warn({ err }, 'valkey quit wedged; forcing disconnect');
    try {
      client.disconnect(false);
    } catch {
      /* idempotent */
    }
  }
}

// Re-export the IORedis client type so downstream Phase 8 plans import a single
// stable name (`type ValkeyClient = IORedisClient`) — easier to mock in tests.
export type ValkeyClient = IORedisClient;
