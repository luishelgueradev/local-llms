import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { BearerAuthError } from '../errors/envelope.js';

/**
 * Constant-time, length-independent secret compare. Hashes both inputs to a
 * fixed 32-byte SHA-256 digest and then runs timingSafeEqual on the digests.
 * Because both digests are exactly 32 bytes regardless of input length, the
 * comparison cost is independent of the supplied-token length — fixes the
 * WR-06 (TD-03) length-leak documented at the call site below.
 */
function secretEqual(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a, 'utf8').digest();
  const bHash = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aHash, bHash);
}

/** Routes that skip bearer auth. ROUTE-04 is the single source of truth. */
// TODO Phase 6: Traefik MUST add a middleware returning 404 for external
// /metrics requests (CONTEXT D-C5, RESEARCH Pitfall 11). Currently safe
// because router binds 127.0.0.1:3000 (compose.yml line 224). Phase 6
// removes that binding — DO NOT FORGET TO ADD THE PATH BLACKLIST when
// Traefik lands. The /metrics surface is operational telemetry (request
// rates, error rates per backend) and IS reconnaissance data for an attacker.
// Phase 20 (v0.12.0 — OPS-02 / D-08): /version added — public endpoint exposing
// build metadata (build_sha, build_time, node_version, git_dirty) for operator
// tooling (bin/deploy-router.sh check). Same trust model as /healthz which
// already exposes phase + registry_models (T-20-14 accepted in plan threat register).
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics', '/version']);

export function makeBearerHook(expectedToken: string) {
  if (!expectedToken || expectedToken.length < 8) {
    throw new Error('makeBearerHook: expectedToken must be at least 8 characters (env validation should catch this earlier)');
  }

  return async function bearerOnRequest(req: FastifyRequest, _reply: FastifyReply) {
    // String.prototype.split always returns a non-empty array, so [0] is never
    // undefined — the previous `?? '/'` fallback was dead code (IN-02).
    const path = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(path)) return;

    const auth = req.headers.authorization;
    // RFC 7235 §2.1 — the auth-scheme token is case-insensitive. Compare only the
    // 7-byte scheme prefix with toLowerCase(); the credential bytes remain untouched
    // so the constant-time timingSafeEqual below still sees the supplied token
    // verbatim. WR-02 fix.
    const SCHEME = 'bearer ';
    // WR-06 fix: throw BearerAuthError instead of building the envelope here.
    // app.setErrorHandler in app.ts (D-C1) translates it via toOpenAIErrorEnvelope
    // -> 401 / authentication_error / unauthorized — same wire shape as the old
    // inline `reply.code(401).send(...)`, but with a single source of truth.
    // The centralized handler also runs `req.log.warn({ err, url, status }, ...)`,
    // so the auth-fail audit line still appears in production logs.
    if (typeof auth !== 'string' || auth.length < SCHEME.length || auth.slice(0, SCHEME.length).toLowerCase() !== SCHEME) {
      throw new BearerAuthError('Missing or malformed Authorization header');
    }

    const supplied = auth.slice(SCHEME.length);
    // WR-06 (TD-03) fix: secretEqual hashes both sides to a fixed 32-byte
    // digest before timingSafeEqual, so the comparison cost is independent
    // of the supplied-token length. The previous two-branch implementation
    // (length-equal => direct compare; length-mismatch => pad + compare-vs-pad)
    // was constant-time WITHIN a branch but the branches were not perfectly
    // equivalent — a precise timing attack could distinguish length parity.
    if (!secretEqual(supplied, expectedToken)) {
      throw new BearerAuthError('Invalid bearer token');
    }
  };
}

// Re-exported for callers that need to throw the error rather than return a 401 directly.
export { BearerAuthError } from '../errors/envelope.js';
