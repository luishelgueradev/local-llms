// router/src/middleware/rateLimit.ts — Phase 8 Plan 06 (ROUTE-11 / D-D2 / D-D3).
//
// Per-bearer-token-per-minute fixed-window rate limit, Valkey-backed.
//
// Key shape: ratelimit:${bearer_hash_8char}:${epoch_minute}
//   - bearer_hash: first 8 hex chars of SHA-256(authorization.slice(7))
//     (after stripping the 'Bearer ' prefix). Hashing protects the token from
//     `MONITOR` / loglevel-verbose observability (D-D2) — even an attacker
//     with Valkey CLI access can't reverse the hash to the bearer.
//   - epoch_minute: Math.floor(Date.now() / 60_000). Fixed per-minute bucket.
//
// INCR returns the new count. If count === 1 (first request of the minute),
// EXPIRE the key with TTL 65s — that's 60s for the minute itself plus a 5s
// margin to handle the boundary race where the request arrives at second
// :59.9 of minute N and the EXPIRE fires at :00.1 of minute N+1. If count
// > rpmLimit → throw RateLimitExceededError; the centralized handler in
// app.ts stamps `Retry-After: 60` and translates to the wire envelope.
//
// Public paths (`/healthz`, `/readyz`, `/metrics`) are skipped entirely —
// same set as auth/bearer.ts so health/scrape traffic never hits Valkey.
//
// Fail-open on Valkey errors: when Valkey is down (ENOTFOUND, ECONNREFUSED,
// AUTH failed, OOM), the hook logs at `warn` and PROCEEDS without rate-limit.
// Rationale: Valkey-down should not also break legitimate traffic — the
// alternative (fail-closed) would 503 every authenticated request, which is
// strictly worse than no rate limit. Defense in depth: the per-backend
// semaphore (Phase 3) is the hard cap on concurrent in-flight requests, and
// the circuit breaker (Plan 08-04) protects against retry-storm backends.
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ValkeyClient } from '../clients/valkey.js';
import { RateLimitExceededError } from '../errors/envelope.js';
import { PUBLIC_PATHS } from '../auth/bearer.js';

export interface MakeRateLimitOpts {
  valkey: ValkeyClient;
  log: Logger;
  rpmLimit: number;
  /** For tests — defaults to Date.now. */
  now?: () => number;
}

/**
 * Hash a bearer token to 8 hex chars (deterministic, non-reversible). Exported
 * for unit testing — production callers do not need to invoke this directly.
 *
 * 8 hex chars = 32 bits of entropy, sufficient to keep distinct bearers in
 * separate buckets at single-operator scale. Collisions across operators are
 * not a concern (the bearer set has cardinality 1 — single configured token —
 * per CONTEXT D-A1).
 */
export function bearerHash(rawBearer: string): string {
  return createHash('sha256').update(rawBearer, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Plan 08-06 (ROUTE-11) factory — returns an onRequest hook (assignable to
 * Fastify's hook signature) suitable for `app.addHook('onRequest', ...)`.
 *
 * Hook ordering contract: this hook MUST be registered AFTER the bearer-auth
 * onRequest hook so we can rely on the Authorization header being well-formed
 * (the bearer hook throws BearerAuthError BEFORE this hook runs for malformed
 * / missing headers on non-public paths). The defensive "auth.length < 8 →
 * return" branch below covers the public-path / pre-routing edge cases.
 */
export function makeRateLimitPreHandler(opts: MakeRateLimitOpts) {
  const { valkey, log, rpmLimit } = opts;
  const now = opts.now ?? (() => Date.now());

  return async function rateLimit(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    // Strip query string from the URL for path matching. Fastify's req.url is
    // always a string in production, but split('?')[0] is the canonical idiom
    // also used by auth/bearer.ts.
    const path = req.url.split('?')[0];
    if (path && PUBLIC_PATHS.has(path)) return;

    const auth = req.headers.authorization;
    // The bearer-auth hook runs BEFORE this one (hook registration order in
    // app.ts:240-258) and throws BearerAuthError on missing / malformed
    // headers, so this hook should never observe an absent Authorization
    // on a non-public path. The check below is a defense-in-depth assertion
    // — if hook ordering ever drifts (e.g. someone reorders the calls), we
    // surface the misconfiguration at error level rather than silently
    // failing open with no audit trail.
    //
    // 08-REVIEW WR-02 fix: the pre-fix `auth.length < 8` magic number was
    // misleading — it claimed to defend against "no usable Authorization
    // header" but a 1-char-token "Bearer x" (9 chars total) sailed past it
    // and was hashed normally. Replace with a structural check on the
    // bearer prefix that matches what auth/bearer.ts expects.
    if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
      log.error(
        { url: req.url },
        'rate-limit: missing or malformed Authorization (bearer hook ordering broken?)',
      );
      return;
    }

    // bearer.ts already validated the scheme is case-insensitive 'bearer '
    // (7 chars). Slice without re-validating; the hash function is total over
    // any input string, so even a malformed remainder is hashed deterministically.
    const SCHEME_LEN = 'bearer '.length;
    const supplied = auth.slice(SCHEME_LEN);
    const hash = bearerHash(supplied);
    const minute = Math.floor(now() / 60_000);
    const key = `ratelimit:${hash}:${minute}`;

    try {
      const count = await valkey.incr(key);
      if (count === 1) {
        // First request of this minute — set TTL with a 5s margin to tolerate
        // the second-boundary race where this EXPIRE fires after the next
        // minute has already started. The key expires harmlessly in either
        // case; the only risk would be DOUBLE-COUNTING (TTL not set, key
        // lives forever) which the margin prevents.
        await valkey.expire(key, 65);
      }
      if (count > rpmLimit) {
        throw new RateLimitExceededError(hash, count, rpmLimit);
      }
    } catch (err) {
      // Re-throw RateLimitExceededError unchanged so the centralized error
      // handler can map it to 429 + Retry-After. Any OTHER error (Valkey
      // down, network error, auth failure) is logged and SWALLOWED — fail
      // open per the D-D3 policy comment at the top of this file.
      if (err instanceof RateLimitExceededError) throw err;
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          hash,
          minute,
        },
        'rate-limit: valkey error, failing open',
      );
    }
  };
}
