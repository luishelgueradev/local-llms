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

  return async function bearerPreHandler(req: FastifyRequest, reply: FastifyReply) {
    const path = (req.url.split('?')[0] ?? '/');
    if (PUBLIC_PATHS.has(path)) return;

    const auth = req.headers.authorization;
    // RFC 7235 §2.1 — the auth-scheme token is case-insensitive. Compare only the
    // 7-byte scheme prefix with toLowerCase(); the credential bytes remain untouched
    // so the constant-time timingSafeEqual below still sees the supplied token
    // verbatim. WR-02 fix.
    const SCHEME = 'bearer ';
    if (typeof auth !== 'string' || auth.length < SCHEME.length || auth.slice(0, SCHEME.length).toLowerCase() !== SCHEME) {
      req.log.warn({ url: req.url, hasHeader: typeof auth === 'string' }, 'auth: missing or malformed bearer header');
      return reply.code(401).send({
        error: {
          message: 'Missing or malformed Authorization header',
          type: 'authentication_error',
          code: 'unauthorized',
          param: null,
        },
      });
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
      req.log.warn({ url: req.url }, 'auth: bearer mismatch');
      return reply.code(401).send({
        error: {
          message: 'Invalid bearer token',
          type: 'authentication_error',
          code: 'unauthorized',
          param: null,
        },
      });
    }
  };
}

// Re-exported for callers that need to throw the error rather than return a 401 directly.
export { BearerAuthError } from '../errors/envelope.js';
