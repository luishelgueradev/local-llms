import { timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { BearerAuthError } from '../errors/envelope.js';

/** Routes that skip bearer auth. ROUTE-04 is the single source of truth. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz']);

export function makeBearerHook(expectedToken: string) {
  if (!expectedToken || expectedToken.length < 8) {
    throw new Error('makeBearerHook: expectedToken must be at least 8 characters (env validation should catch this earlier)');
  }
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  // Pad buffer of equal length we use when supplied is shorter — keeps timingSafeEqual
  // happy and ensures the comparison still runs in constant time.
  const padBuf = randomBytes(expectedBuf.length);

  return async function bearerOnRequest(req: FastifyRequest, _reply: FastifyReply) {
    const path = (req.url.split('?')[0] ?? '/');
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
    const suppliedBuf = Buffer.from(supplied, 'utf8');

    let ok = false;
    if (suppliedBuf.length === expectedBuf.length) {
      ok = timingSafeEqual(suppliedBuf, expectedBuf);
    } else {
      // Pad to expected length so timingSafeEqual doesn't throw; compare against padBuf
      // so the work still happens (constant-time false). This defeats length-based timing leaks.
      const sized = Buffer.alloc(expectedBuf.length);
      suppliedBuf.copy(sized, 0, 0, Math.min(suppliedBuf.length, expectedBuf.length));
      // Run the compare for side effects on timing; result is always false because lengths differ.
      timingSafeEqual(sized, padBuf);
      ok = false;
    }

    if (!ok) {
      throw new BearerAuthError('Invalid bearer token');
    }
  };
}

// Re-exported for callers that need to throw the error rather than return a 401 directly.
export { BearerAuthError } from '../errors/envelope.js';
