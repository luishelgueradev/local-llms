/**
 * http-dispatcher.ts — undici Agent configuration for all backend HTTP traffic.
 *
 * ─── Root cause (debug session router-504-stale-sockets) ────────────────────
 * The router probes every backend's /v1/models every 10s and dispatches client
 * chat requests by hostname (`ollama`, `llamacpp`, `vllm`, `vllm-embed`,
 * `ollama.com`). Node's default `dns.lookup` (which undici and global `fetch`
 * use to resolve those hostnames) runs `getaddrinfo` on libuv's THREADPOOL,
 * whose default size is 4 (`UV_THREADPOOL_SIZE` unset).
 *
 * When backends are DOWN (e.g. the optional llamacpp / vllm / vllm-embed
 * containers are not running, or the cloud host is unreachable), their probe
 * lookups hang in `getaddrinfo` for the full probe deadline. Five concurrent
 * probes against four blocking lookups SATURATE the 4-thread pool, so the ONE
 * lookup that should be instant — `getaddrinfo('ollama')` — QUEUES behind the
 * blocked threads and never returns within the 2s probe / 30s request deadline.
 *
 * Result: a healthy ollama backend's probe flips to `down`, and real chat
 * requests hang until the route's ~30s AbortSignal fires → HTTP 504
 * `upstream_timeout`. It "recovers on restart" because a fresh process has an
 * empty threadpool, then re-degrades as the down-backend probes re-saturate it.
 *
 * Proven empirically inside the running container: with the threadpool occupied
 * by hanging lookups, `dns.lookup('ollama')` took ~8s while a c-ares
 * `Resolver.resolve4('ollama')` (OFF the threadpool) returned in 1ms. A raw
 * `net.connect('ollama', 11434)` in the long-lived process also hung at the
 * 2s deadline, confirming the stall is in name resolution, NOT in sockets,
 * keep-alive, or the OpenAI SDK.
 *
 * ─── The fix: resolve backend hostnames OFF the libuv threadpool ─────────────
 * Give undici a custom `connect.lookup` hook backed by c-ares
 * (`dns.Resolver`), which performs DNS over its own async sockets and does NOT
 * use the libuv `getaddrinfo` threadpool. A down backend's slow/failing lookup
 * therefore cannot starve a healthy backend's lookup. A short in-process TTL
 * cache further insulates the hot path from repeated lookups and from a
 * transiently slow resolver.
 *
 * `UV_THREADPOOL_SIZE` is also raised in the router compose service as
 * defense-in-depth, but the lookup hook is the primary, code-level fix so the
 * router is correct even if that env var is ever dropped.
 *
 * Keep-alive is retained at sensible bounds: reusing a warm socket AVOIDS a
 * fresh DNS lookup + handshake per request, which is the opposite of what we
 * want now that we understand the bottleneck is resolution, not stale sockets.
 *
 * ─── What this MUST NOT regress ──────────────────────────────────────────────
 *   - SSE streaming / abort propagation / circuit breaker: unchanged — this
 *     only affects how hostnames are resolved during connect.
 *   - SSRF image-fetch guard: that path builds its OWN per-request Agent with a
 *     DNS-pinning `connect.lookup` and passes it explicitly as the request
 *     `dispatcher`, overriding the global one — so the guard is untouched.
 */
import { Resolver } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';

const HEADERS_TIMEOUT_MS = 45_000;
const BODY_TIMEOUT_MS = 45_000;
const KEEP_ALIVE_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 30_000;

/** TTL for the in-process DNS cache. Docker service IPs are stable for a
 * container's lifetime; 30s keeps us responsive to a backend restart while
 * collapsing repeated lookups to near-zero cost. */
const DNS_CACHE_TTL_MS = 30_000;

/** c-ares resolver — resolves over its own async sockets, NOT the libuv
 * getaddrinfo threadpool, so a hanging lookup to a down backend cannot starve
 * lookups to healthy backends. */
const resolver = new Resolver();

interface CacheEntry {
  address: string;
  family: 4 | 6;
  expires: number;
}
const dnsCache = new Map<string, CacheEntry>();

/**
 * undici `connect.lookup` shim. Signature matches Node's `dns.lookup` callback
 * contract that undici expects: `(hostname, options, callback)`. Resolves via
 * c-ares (off-threadpool) with a short TTL cache. Literal IPs and `localhost`
 * short-circuit without a lookup.
 */
const caresLookup: LookupFunction = (hostname, options, callback): void => {
  // Node's net.connect invokes this with `options.all === true` for some code
  // paths and expects `cb(null, [{ address, family }, ...])` in that case, but
  // `cb(null, address, family)` when `all` is falsy. Returning the wrong shape
  // surfaces as `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`. Bridge
  // both shapes (same trap the SSRF lookup in ollama-native-out.ts handles).
  const wantsAll = !!(options as { all?: boolean } | undefined)?.all;
  const deliver = (address: string, family: 4 | 6): void => {
    if (wantsAll) {
      (callback as unknown as (
        err: NodeJS.ErrnoException | null,
        addrs: Array<{ address: string; family: number }>,
      ) => void)(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    deliver(hostname, ipVersion as 4 | 6);
    return;
  }
  if (hostname === 'localhost') {
    deliver('127.0.0.1', 4);
    return;
  }

  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > now) {
    deliver(cached.address, cached.family);
    return;
  }

  resolver
    .resolve4(hostname)
    .then((addrs) => {
      const address = addrs[0];
      if (!address) throw new Error(`no A record for "${hostname}"`);
      dnsCache.set(hostname, { address, family: 4, expires: now + DNS_CACHE_TTL_MS });
      deliver(address, 4);
    })
    .catch((err4: unknown) => {
      // Fall back to AAAA so IPv6-only services still resolve.
      resolver
        .resolve6(hostname)
        .then((addrs) => {
          const address = addrs[0];
          if (!address) throw new Error(`no AAAA record for "${hostname}"`);
          dnsCache.set(hostname, { address, family: 6, expires: now + DNS_CACHE_TTL_MS });
          deliver(address, 6);
        })
        .catch(() => {
          const e = err4 instanceof Error ? err4 : new Error(String(err4));
          callback(e as NodeJS.ErrnoException, '', 0);
        });
    });
};

/** The single configured Agent options — shared by the global install and the
 * per-backend factory. */
function backendAgentOptions(): Agent.Options {
  return {
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connect: {
      // c-ares lookup OFF the libuv threadpool — the core fix.
      lookup: caresLookup,
    },
  };
}

/**
 * Install the threadpool-starvation-proof Agent as the PROCESS-WIDE undici
 * dispatcher. Call ONCE, as early as possible in boot (index.ts main()),
 * before any backend adapter is constructed or any request is made.
 *
 * This is the primary fix: it guarantees every undici request (OpenAI SDK +
 * native fetch + global `fetch`) resolves backend hostnames via c-ares,
 * independent of whether the SDK honors per-client `fetchOptions.dispatcher`.
 */
export function installGlobalBackendDispatcher(): void {
  setGlobalDispatcher(new Agent(backendAgentOptions()));
}

/**
 * Build a fresh per-backend undici Agent with the same config. Retained as a
 * belt-and-suspenders mechanism wired via the SDK's `fetchOptions.dispatcher`
 * and the native fetch path's request `dispatcher`, so the intended behavior
 * holds even if the SDK's fetch resolution changes in a future version.
 */
export function makeBackendAgent(): Agent {
  return new Agent(backendAgentOptions());
}

/**
 * Build the OpenAI SDK `fetchOptions` wiring in a NEW per-backend dispatcher.
 *
 * `dispatcher` is undici's RequestInit extension (not in lib.dom's RequestInit);
 * the SDK's `fetchOptions` is typed as `MergedRequestInit` (which includes
 * undici's RequestInit) so `dispatcher` is accepted directly.
 */
export function backendFetchOptions(): { dispatcher: Agent } {
  return { dispatcher: makeBackendAgent() };
}
