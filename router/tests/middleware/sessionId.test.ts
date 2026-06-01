/**
 * Phase 17 / v0.11.0 — SESS-05 / SESS-06.
 *
 * Unit tests for the sessionIdPreHandler — mirrors the scopedIds.ts preHandler
 * unit-test fixture idiom (src/middleware/__tests__/scopedIds.test.ts).
 *
 * Contract (RESEARCH §"Hook + preHandler design" + PATTERNS lines 41-97):
 *   - absent X-Session-ID → req.sessionId stays undefined (SESS-06 stateless)
 *   - valid X-Session-ID matching /^[A-Za-z0-9._:-]{1,128}$/ → stamped on req
 *   - invalid (regex fail / length / control chars / empty) → InvalidSessionIdError (400)
 *   - duplicate header values → first-wins (RFC 9110 §5.3)
 *
 * Test style: construct a minimal FastifyRequest stub `{ headers }` — no full
 * Fastify instance needed for these unit assertions. Mirrors PLAN.md §Task 1
 * action block.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionIdPreHandler } from '../../src/middleware/sessionId.js';
import { InvalidSessionIdError } from '../../src/providers/session-errors.js';

// ---------------------------------------------------------------------------
// Minimal Fastify request stub. The preHandler only reads .headers and
// (optionally) writes .sessionId; nothing else from FastifyRequest is touched.
// Cast through `unknown` to satisfy the FastifyRequest type without pulling in
// the full IncomingMessage / log machinery.
// ---------------------------------------------------------------------------
function makeReq(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const NOOP_REPLY = {} as unknown as FastifyReply;

describe('sessionIdPreHandler — SESS-05/06', () => {
  // -------------------------------------------------------------------------
  // SESS-06: absent header → silent-NULL (stateless mode)
  // -------------------------------------------------------------------------
  it('absent X-Session-ID header → req.sessionId remains undefined (SESS-06 stateless)', async () => {
    const req = makeReq({});
    await sessionIdPreHandler(req, NOOP_REPLY);
    expect(req.sessionId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // SESS-05: valid header → stamped on req
  // -------------------------------------------------------------------------
  it('valid X-Session-ID matches /^[A-Za-z0-9._:-]{1,128}$/ → req.sessionId stamped', async () => {
    const req = makeReq({ 'x-session-id': 'sess-abc.123_def:ghi-jkl' });
    await sessionIdPreHandler(req, NOOP_REPLY);
    expect(req.sessionId).toBe('sess-abc.123_def:ghi-jkl');
  });

  // -------------------------------------------------------------------------
  // Strict path: control chars / spaces → throws InvalidSessionIdError (400)
  // -------------------------------------------------------------------------
  it('invalid X-Session-ID (control chars) → throws InvalidSessionIdError (400)', async () => {
    const reqSpace = makeReq({ 'x-session-id': 'has space' });
    await expect(sessionIdPreHandler(reqSpace, NOOP_REPLY)).rejects.toThrow(
      InvalidSessionIdError,
    );

    // Second assertion needs a fresh request (the previous one threw before
    // stamping anything — but a fresh instance keeps the test semantically
    // clear that each rejection assertion is independent).
    const reqAgain = makeReq({ 'x-session-id': 'has space' });
    await expect(sessionIdPreHandler(reqAgain, NOOP_REPLY)).rejects.toMatchObject({
      code: 'invalid_session_id',
      httpStatus: 400,
    });
  });

  // -------------------------------------------------------------------------
  // Length cap: > 128 chars → throws InvalidSessionIdError
  // -------------------------------------------------------------------------
  it('X-Session-ID length > 128 → throws InvalidSessionIdError', async () => {
    const oversized = 'a'.repeat(129);
    const req = makeReq({ 'x-session-id': oversized });
    await expect(sessionIdPreHandler(req, NOOP_REPLY)).rejects.toThrow(
      InvalidSessionIdError,
    );

    // Boundary check: exactly 128 chars MUST pass (the regex is /{1,128}/).
    const atLimit = 'a'.repeat(128);
    const reqAtLimit = makeReq({ 'x-session-id': atLimit });
    await sessionIdPreHandler(reqAtLimit, NOOP_REPLY);
    expect(reqAtLimit.sessionId).toBe(atLimit);
  });

  // -------------------------------------------------------------------------
  // RFC 9110 §5.3: array (duplicate headers) → first-wins
  // -------------------------------------------------------------------------
  it('X-Session-ID multi-value array → first wins (RFC 9110 §5.3)', async () => {
    const req = makeReq({ 'x-session-id': ['valid-1', 'valid-2'] });
    await sessionIdPreHandler(req, NOOP_REPLY);
    expect(req.sessionId).toBe('valid-1');
  });

  // -------------------------------------------------------------------------
  // Empty-string value → throws (regex requires {1,128} — 0-length fails)
  // -------------------------------------------------------------------------
  it('X-Session-ID empty string → throws InvalidSessionIdError', async () => {
    const req = makeReq({ 'x-session-id': '' });
    await expect(sessionIdPreHandler(req, NOOP_REPLY)).rejects.toThrow(
      InvalidSessionIdError,
    );
  });
});
