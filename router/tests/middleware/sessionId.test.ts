/**
 * Phase 17 / v0.11.0 — SESS-05 / SESS-06. Wave 0 scaffold (Plan 17-01).
 *
 * Unit tests for the sessionIdPreHandler — mirrors the scopedIds.ts preHandler
 * unit-test fixture idiom (src/middleware/__tests__/scopedIds.test.ts).
 *
 * Contract (RESEARCH §middleware/sessionId.ts + PATTERNS lines 41-97):
 *   - absent X-Session-ID → req.sessionId stays undefined (SESS-06 stateless)
 *   - valid X-Session-ID matching /^[A-Za-z0-9._:-]{1,128}$/ → stamped on req
 *   - invalid (regex fail / length / control chars / empty) → InvalidSessionIdError (400)
 *   - duplicate header values → first-wins (RFC 9110 §5.3)
 *
 * Import fails until Plan 17-05 lands `src/middleware/sessionId.ts` — Wave-0 signal.
 */
import { describe, it } from 'vitest';
import { sessionIdPreHandler } from '../../src/middleware/sessionId.js';

// Wave-0 import gate.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _preHandlerRef = sessionIdPreHandler;

describe('sessionIdPreHandler — SESS-05/06', () => {
  it.todo('absent X-Session-ID header → req.sessionId remains undefined (SESS-06 stateless)');
  it.todo('valid X-Session-ID matches /^[A-Za-z0-9._:-]{1,128}$/ → req.sessionId stamped');
  it.todo('invalid X-Session-ID (control chars) → throws InvalidSessionIdError (400)');
  it.todo('X-Session-ID length > 128 → throws InvalidSessionIdError');
  it.todo('X-Session-ID multi-value array → first wins (RFC 9110 §5.3)');
  it.todo('X-Session-ID empty string → throws InvalidSessionIdError');
});
