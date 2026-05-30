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
    /**
     * Plan 08-03 (ROUTE-10) — the registry entry's backend value, stamped by
     * each route handler immediately after `registry.resolve(body.model)`. Read
     * by the onSend hook in app.ts to populate the `X-Model-Backend` response
     * header. Undefined on pre-resolve errors (unknown model, missing bearer),
     * which is the correct behavior — those responses have no resolved backend
     * to advertise.
     *
     * Valid values match LocalBackendEnum: 'ollama' | 'llamacpp' | 'vllm' |
     * 'vllm-embed' | 'ollama-cloud'. Typed as `string` to avoid a cross-module
     * dependency from middleware/ to config/.
     */
    resolvedBackend?: string;
    /**
     * Phase 13 (v0.10.0 — COST-02) — per-request cost in cents as a
     * NUMERIC(10,4) string (e.g. "0.0010"). Stamped by each route handler
     * BEFORE `return reply.send(...)` so the onSend hook in app.ts can read
     * it and stamp the `X-Cost-Cents` response header.
     *
     * Undefined when the model has no pricing declared (typical for local
     * backends) or when the request failed before tokens were known — in both
     * cases the header is intentionally absent (COST-02 contract).
     *
     * Typed as string (not number) for parity with the `cost_cents` request_log
     * column: Drizzle's numeric() maps to `string | null` to preserve the exact
     * decimal representation across the SQL/JS boundary.
     */
    computedCostCents?: string;
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

  // D-D5: parse X-Agent-Id if present. Absent header is the common case in
  // v0.11.0 (n8n, Unsloth Studio, ad-hoc curl) — that path must NOT short-circuit
  // before pino enrichment, otherwise tenant/project/workload IDs never reach
  // the structured logs (14-09-REVIEW CR-01 / D-20 contract).
  const raw = req.headers['x-agent-id'];
  let value: string | undefined;
  if (raw !== undefined) {
    // RFC 9110 §5.3 — duplicates may join with commas OR appear as an array
    // (Fastify normalizes duplicates to an array). First value wins.
    const candidate = Array.isArray(raw) ? raw[0] : raw;

    if (typeof candidate !== 'string' || !AGENT_ID_RE.test(candidate)) {
      // D-D5: regex violation → 400 + invalid_agent_id. The centralized
      // app.setErrorHandler routes to the matching wire envelope (OpenAI for
      // /v1/chat/completions; Anthropic for /v1/messages).
      throw new InvalidAgentIdError(typeof candidate === 'string' ? candidate : '');
    }

    value = candidate;
    req.agentId = value;
  }

  // Decorate the pino child logger so every subsequent log line carries
  // (when present) agent_id PLUS the scoped IDs stamped by scopedIdsPreHandler
  // (which runs before this hook — app.ts registration order guarantee).
  // pino's .child() silently omits undefined-valued keys (Assumption A2), so
  // omitting X-Agent-Id is graceful: agent_id is left out of the child fields
  // but tenant_id / project_id / workload_class still flow through. This is
  // the v0.11.0 fix for 14-09-REVIEW CR-01 — when X-Agent-Id is absent (the
  // common case), the previous early-return skipped enrichment entirely and
  // pino lines silently dropped scoped IDs, violating D-20.
  //
  // Phase 14 (v0.11.0 — POL-03/04 / D-20): tenant_id, project_id, workload_class
  // added here rather than in scopedIds.ts to preserve the Pitfall-9 invariant.
  // THIS IS THE ONLY pino child reassignment in router/src/ production source
  // (grep gate: grep -rn 'req\.log = ' router/src/ | grep -v '__tests__' | wc -l  == 1).
  req.log = req.log.child({
    agent_id: value,
    tenant_id: req.tenantId,
    project_id: req.projectId,
    workload_class: req.workloadClass,
  });
}
