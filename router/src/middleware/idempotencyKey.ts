// router/src/middleware/idempotencyKey.ts — Phase 8 Plan 07 (ROUTE-12 / D-D5).
//
// Helper for validating and extracting the Idempotency-Key header. The header
// is OPTIONAL — when absent, callers proceed as if the multiplexer were not
// installed. When present, it MUST match the regex /^[A-Za-z0-9._:-]{1,256}$/
// (permissive for ULIDs, UUIDs, operator-chosen strings; the 256-char ceiling
// bounds Valkey key length so a misbehaving client can't bloat the keyspace).
//
// Duplicate Idempotency-Key headers (Fastify normalizes duplicates to an
// array) are treated as invalid — the wire spec is unambiguous that exactly
// one value is expected.
//
// ReDoS analysis: the regex is anchored at both ends, has no alternation, and
// uses a bounded quantifier ({1,256}). Safe — no nested quantifiers to
// catastrophically backtrack on.
import { InvalidIdempotencyKeyError } from '../errors/envelope.js';

/** D-D5 regex: 1..256 chars from [A-Za-z0-9._:-]. ReDoS-safe (anchored, bounded). */
const KEY_RE = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Extract + validate the Idempotency-Key header. Returns undefined when the
 * header is absent. Throws InvalidIdempotencyKeyError on regex violation or
 * when the header appears multiple times (array form from Fastify).
 */
export function extractIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['idempotency-key'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    // Duplicate header — RFC 9110 §5.3 allows comma-joining for some headers
    // but Idempotency-Key is single-valued by convention. Reject as invalid.
    throw new InvalidIdempotencyKeyError(raw.join(','));
  }
  if (typeof raw !== 'string' || !KEY_RE.test(raw)) {
    throw new InvalidIdempotencyKeyError(typeof raw === 'string' ? raw : '');
  }
  return raw;
}
