// router/src/middleware/sessionId.ts — Fastify preHandler for X-Session-ID
// (Phase 17 / v0.11.0 — SESS-05, SESS-06).
//
// HOOK-ORDERING DEPENDENCY (17-RESEARCH.md §"Hook + preHandler design"):
// This preHandler MUST be registered AFTER agentIdPreHandler in app.ts. The
// session-attach block in each route reads req.agentId (stamped by
// agentIdPreHandler) to scope SessionStore.loadHistory — agent_id MUST already
// be stamped when this hook runs.  Registration order in app.ts is therefore:
//
//   scopedIdsPreHandler → agentIdPreHandler → sessionIdPreHandler
//
// Module augmentation extends FastifyRequest with `sessionId` so route files
// type-check without `as any`.
//
// CRITICAL DIVERGENCE FROM scopedIds (PATTERNS line 97):
//   scopedIds.ts takes a MIXED strict/silent path: invalid X-Tenant-ID /
//   X-Project-ID throws 400 (D-16), but invalid X-Workload-Class is silent-NULL
//   (D-12 — opaque metadata).
//   sessionId.ts takes the STRICT path uniformly — invalid X-Session-ID always
//   throws InvalidSessionIdError (400). Rationale: the session ID is
//   operationally load-bearing (it scopes loadHistory + appendTurn), so a
//   malformed value is a caller bug deserving a 4xx, not silently-dropped
//   metadata. Same rationale as D-15 (agent_id strict) vs D-11 (workload_class
//   silent).
//
// ABSENT-HEADER PATH (SESS-06 stateless contract):
//   When the X-Session-ID header is entirely absent (raw === undefined), this
//   handler returns without modifying `req`. The downstream route's session-
//   attach block sees `req.sessionId === undefined` and short-circuits to the
//   Phase 16 stateless behavior (byte-identical response — verified by P9-02
//   golden snapshot regression in Plan 17-07).
//
// ReDoS analysis: /^[A-Za-z0-9._:-]{1,128}$/ has NO nested quantifiers, NO
// alternation overlap, is anchored at both ends, and is length-bounded {1,128}.
// Safe — no ReDoS hazard. Identical shape to agentId.ts AGENT_ID_RE and
// scopedIds.ts ID_RE (RESEARCH §"Session-ID regex" line 884).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidSessionIdError } from '../providers/session-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Phase 17 (v0.11.0 — SESS-05/06): X-Session-ID validated by
     * sessionIdPreHandler; undefined when header absent (stateless mode per
     * SESS-06 — byte-identical to Phase 16 wire behavior).
     */
    sessionId?: string;
  }
}

/**
 * RESEARCH §Session-ID regex (line 884) — alphanumerics, dot, underscore,
 * colon, hyphen; 1–128 chars. Anchored + bounded + no nested quantifiers —
 * ReDoS-safe. Identical character set + length bound as scopedIds.ts ID_RE
 * (the session ID and the agent/tenant/project IDs share a common opaque-
 * identifier shape — SESS-03 / P4-03 use them interchangeably as composite
 * lookup keys).
 */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Phase 17 (v0.11.0 — SESS-05/SESS-06): preHandler that extracts the
 * X-Session-ID header and stamps it on `req` for downstream use (the route
 * handler reads `req.sessionId` to gate the session-attach block).
 *
 * Contract:
 *   - X-Session-ID absent → req.sessionId stays undefined (SESS-06 stateless).
 *   - X-Session-ID valid (regex passes) → req.sessionId = value.
 *   - X-Session-ID invalid (regex fails / length / control chars / empty) →
 *     throws InvalidSessionIdError → 400 invalid_session_id envelope.
 *   - X-Session-ID duplicate (Fastify normalizes to array) → first value wins
 *     per RFC 9110 §5.3 (same idiom as agentId.ts:92 + scopedIds.ts:82).
 *
 * Does NOT load the session from Postgres — that I/O happens inside the route
 * handler. This hook is the SAME PATTERN as scopedIdsPreHandler /
 * agentIdPreHandler: stamp + validate, never touch I/O.
 *
 * Pitfall-9 invariant: this file MUST NOT contain a pino child reassignment.
 * The single pino enrichment lives in agentId.ts — see scopedIds.ts header.
 */
export async function sessionIdPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const raw = req.headers['x-session-id'];
  if (raw === undefined) {
    // SESS-06: stateless mode — header entirely absent. Leave req.sessionId
    // undefined; the route session-attach block short-circuits and the
    // response is byte-identical to Phase 16.
    return;
  }

  // RFC 9110 §5.3 — duplicates may join with commas OR appear as an array
  // (Fastify normalizes duplicates to an array). First value wins — mirrors
  // agentId.ts:92 and scopedIds.ts:82 idiom exactly.
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    // Strict path (see CRITICAL DIVERGENCE note in header): regex violation
    // on X-Session-ID is a caller bug → 400. mapToHttpStatus + envelope.ts
    // (Plan 17-03) routes InvalidSessionIdError to invalid_session_id +
    // status 400 in both OpenAI and Anthropic envelopes.
    throw new InvalidSessionIdError(typeof value === 'string' ? value : '');
  }

  req.sessionId = value;
}
