// router/src/middleware/agentId.ts — Fastify preHandler for X-Agent-Id
// (Plan 05-02 D-D5 / ROUTE-09).
//
// Hook ordering (verified against fastify.dev/docs/v5.8.x/Reference/Hooks/):
// - `onRequest` runs FIRST → bearer-auth gates here (auth/bearer.ts)
// - `preHandler` runs AFTER body parsing / zod validation → agent-id
//   enrichment lives here. Bearer must pass first; agent-id is post-auth
//   metadata enrichment.
//
// Module augmentation extends FastifyRequest with `agentId`, `_t0`, and
// `__recorded` so the route files type-check without `as any`:
// - agentId  : the validated X-Agent-Id (undefined if absent)
// - _t0      : performance.now() captured here for latency_ms (D-D6)
// - __recorded: set by route safeRecord so app.setErrorHandler does not
//   double-write a request_log row (Pitfall 8)
//
// ReDoS analysis: /^[A-Za-z0-9._:-]{1,128}$/ has NO nested quantifiers, NO
// alternation that overlaps itself, and IS anchored at both ends.
// Length-bounded {1,128}. Safe — no ReDoS hazard (T-5-10).
//
// req.log reassignment: this file is the ONLY production source that
// reassigns req.log via .child(...). The Pitfall 9 grep gate enforces this:
//   grep -rn 'req\.log = ' router/src/ | wc -l   # must equal 1
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidAgentIdError } from '../errors/envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** X-Agent-Id validated by agentIdPreHandler; undefined when header absent. */
    agentId?: string;
    /** performance.now() captured at preHandler entry — latency_ms source (D-D6). */
    _t0?: number;
    /**
     * Set by route safeRecord closures to true after recordOutcome has fired.
     * app.setErrorHandler reads this so pre-resolve errors (caught after route
     * body runs) do not double-write a request_log row.
     */
    __recorded?: boolean;
  }
}

/**
 * D-D5 regex: alphanumerics, dot, underscore, colon, hyphen; 1–128 chars.
 * Anchored + bounded + no nested quantifiers — ReDoS-safe (T-5-10).
 */
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export async function agentIdPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // Earliest post-auth capture — bearer onRequest has already run, so this
  // measures only the request-processing portion (not the auth gate).
  req._t0 = performance.now();

  const raw = req.headers['x-agent-id'];
  if (raw === undefined) {
    // D-D5: absent → agentId stays undefined → request_log.agent_id NULL.
    return;
  }

  // RFC 9110 §5.3 — duplicates may join with commas OR appear as an array
  // (Fastify normalizes duplicates to an array). First value wins.
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    // D-D5: regex violation → 400 + invalid_agent_id. The centralized
    // app.setErrorHandler routes to the matching wire envelope (OpenAI for
    // /v1/chat/completions; Anthropic for /v1/messages).
    throw new InvalidAgentIdError(typeof value === 'string' ? value : '');
  }

  req.agentId = value;
  // Decorate req.log so every subsequent pino line carries agent_id.
  // THIS IS THE ONLY req.log reassignment in router/src/ (Pitfall 9 gate).
  req.log = req.log.child({ agent_id: value });
}
