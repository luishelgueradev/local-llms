// router/src/metrics/recordOutcome.ts — single-call-site lifecycle helper
// for the request_log row + the 5 prom-client metric observations.
//
// CONTEXT D-C6: ONE helper, two effects co-located. Calling this from BOTH
// route files at the same lifecycle hook points (sseCleanup for streams,
// finally for non-stream) is the structural guarantee that label set and
// column set stay synchronized as the surface evolves.
//
// RESEARCH §"Pattern 2" lines 270–331 is the literal implementation shape.
//
// BackendSaturatedError — Open Question Q4 resolution: status_class =
// 'client_error' (4xx group per D-C4 since the HTTP status is 429) AND
// error_code = 'backend_saturated' (D-D2 taxonomy). The taxonomy split is
// what differentiates saturation from generic 4xx client errors when
// querying request_log.
//
// Client-disconnect is NOT routed through mapErrorToCode — callers pass
// errorCode: 'client_disconnect' directly when they detect
// controller.signal.aborted.
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { z } from 'zod/v4';
import { hasZodFastifySchemaValidationErrors } from '@bram-dc/fastify-type-provider-zod';
import {
  AllowlistViolationError,
  BackendSaturatedError,
  CapabilityNotSupportedError,
  CloudMaxTokensExceededError,
  CloudNotAllowedError,
  ImageFetchError,
  InvalidAgentIdError,
  InvalidIdempotencyKeyError,
  InvalidImageUrlError,
  InvalidScopedIdError,
  InvalidStructuredOutputError,
  InvalidToolArgumentsError,
  RateLimitExceededError,
  RegistryUnknownModelError,
} from '../errors/envelope.js';
import type { BufferedWriter } from '../db/bufferedWriter.js';
import type { RequestLogInsert } from '../db/schema/index.js';
import type { MetricsRegistry } from './registry.js';

export type StatusClass = 'success' | 'client_error' | 'server_error' | 'disconnect';

/**
 * D-D6 field-source map — every field below maps 1:1 to a request_log column
 * (D-D1) and/or a prom-client metric label (D-C3).
 *
 * - protocol/route/backend/model — derived at route handler, NOT mutable
 * - statusClass — derived via deriveStatusClass(httpStatus, clientAborted)
 * - httpStatus — reply.statusCode at lifecycle hook
 * - durationMs — performance.now() - req._t0 (req._t0 captured by agentIdPreHandler)
 * - ttftMs — heartbeat.msSinceStart (stream only; non-stream leaves undefined)
 * - tokensIn/tokensOut — canonical {input_tokens, output_tokens} aggregated
 *   by openai-out / anthropic-out translators
 * - errorCode/errorMessage — D-D2 taxonomy via mapErrorToCode (or
 *   'client_disconnect' set directly by route)
 * - agentId — req.agentId from agentIdPreHandler (undefined → NULL column)
 * - requestId — req.id (Fastify default)
 * - upstreamMessageId — Anthropic-only msg_<ulid> from canonical
 * - timestamp — new Date() at call site (tested with deterministic values)
 */
export interface OutcomeContext {
  // Phase 15 (v0.11.0 — MCPS-05 / CONTEXT D-07 / RESEARCH Pitfall 7): widened to
  // include 'mcp' so Wave 4 tool handlers push request_log rows + prom-client
  // observations under `protocol: 'mcp'` without `as any` casts. The
  // `request_log.protocol` column is TEXT NOT NULL with no CHECK constraint, so
  // 'mcp' writes cleanly (no migration). prom-client Counter `.inc({ protocol: 'mcp', ... })`
  // accepts any string value for the `protocol` label.
  protocol: 'openai' | 'anthropic' | 'mcp';
  route: string;
  backend: string;
  model: string;
  statusClass: StatusClass;
  httpStatus: number;
  durationMs: number;
  ttftMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  errorCode?: string;
  errorMessage?: string;
  agentId?: string;
  // Phase 14 (v0.11.0 — POL-03/POL-04): scoped IDs stamped by scopedIdsPreHandler.
  // Mirrors the agentId? pattern — undefined when header absent or invalid.
  tenantId?: string;
  projectId?: string;
  workloadClass?: string;
  requestId: string;
  upstreamMessageId?: string;
  /**
   * Phase 8 Plan 07 (ROUTE-12 / D-D5) + 08-REVIEW CR-01 fix: the validated
   * Idempotency-Key header value, when present. Populated for BOTH leader
   * and follower request_log rows so operators can filter on this column
   * when verifying dedup (smoke-test-cloud.sh / README "verify dedup" recipe).
   * Undefined when the request did not carry the header (vast majority).
   */
  idempotencyKey?: string;
  /**
   * Phase 13 (v0.10.0 — COST-01): per-request cost in cents, as a NUMERIC(10,4)
   * string (e.g. "0.0010"). Undefined when the route did NOT compute a cost —
   * either the model has no pricing declared (local backends) or the request
   * failed before tokens were known. The request_log row stores null in either
   * absent-or-undefined case. The route computes via computeCostCents() before
   * calling this helper, so the cost column stays consistent with the X-Cost-Cents
   * response header (both derived from the same source).
   */
  costCents?: string;
  timestamp: Date;
}

// ── truncateAndRedact (D-D3 + Pitfall 12) ───────────────────────────────────
//
// pino's `redact` config covers the LOG record, not the DB column. The
// upstream SDK error may embed the bearer token / apiKey in its message for
// "debug helpfulness" — re-apply a regex strip before writing the row.
//
// All three RegExps are precompiled at module load to avoid per-call
// recompilation. The 'g' flag means each regex is applied globally.
// The 'i' flag covers case-insensitive Bearer/Authorization.
//
// IMPORTANT: replacement is a LITERAL string '[REDACTED]' — must_haves truth
// requires the post-redaction text to contain NEITHER the token NOR the
// literal `Bearer ` substring (so `SELECT error_message ... ~ '[Bb]earer'`
// returns 0 rows). The capture group must therefore be greedy enough to
// absorb the entire pattern including the keyword.
const BEARER_RE = /\bBearer\s+\S+/gi;
const AUTH_RE = /\bAuthorization\s*:\s*\S+/gi;
const APIKEY_RE = /(?:apiKey|api_key|api-key)\s*['"]?\s*[:=]\s*['"]?\S+/gi;

/**
 * Redact bearer / authorization / apiKey patterns; truncate to maxLen with
 * '...' suffix. Exported so unit tests can assert against literals.
 */
export function truncateAndRedact(msg: string, maxLen = 500): string {
  let out = msg
    .replace(BEARER_RE, '[REDACTED]')
    .replace(AUTH_RE, '[REDACTED]')
    .replace(APIKEY_RE, '[REDACTED]');
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}...`;
  }
  return out;
}

// ── deriveStatusClass (D-C4) ─────────────────────────────────────────────────

/**
 * D-C4 status_class derivation. clientAborted has precedence — even a 200
 * mid-stream becomes 'disconnect' if the client torn down the socket.
 */
export function deriveStatusClass(httpStatus: number, clientAborted: boolean): StatusClass {
  if (clientAborted) return 'disconnect';
  if (httpStatus >= 200 && httpStatus < 300) return 'success';
  if (httpStatus >= 400 && httpStatus < 500) return 'client_error';
  if (httpStatus >= 500) return 'server_error';
  return 'server_error'; // defensive (1xx / 3xx don't reach this helper)
}

// ── mapErrorToCode (D-D2 taxonomy) ───────────────────────────────────────────

/**
 * Map a thrown error to the D-D2 error_code taxonomy. Client-disconnect is
 * NOT routed through this helper — callers pass errorCode: 'client_disconnect'
 * directly when they detect controller.signal.aborted.
 */
export function mapErrorToCode(err: unknown): string {
  if (err instanceof RegistryUnknownModelError) return 'unknown_model';
  if (err instanceof BackendSaturatedError) return 'backend_saturated';
  // Plan 08-06 (ROUTE-11 / D-D2) — per-bearer-token RPM exceeded; bucket label
  // 'rate_limit_exceeded' keeps it separable from 'backend_saturated' in the
  // request_log error_code column even though both share the wire-level
  // type='rate_limit_error' envelope.
  if (err instanceof RateLimitExceededError) return 'rate_limit_exceeded';
  if (err instanceof CapabilityNotSupportedError) return 'model_capability_mismatch';
  // Phase 14 (v0.11.0 — POL-01/POL-02): policy violations get their own D-D2
  // taxonomy labels so the request_log error_code separates policy-403s from
  // other client errors. Mirrors the CapabilityNotSupportedError precedent.
  if (err instanceof AllowlistViolationError) return 'model_not_in_allowlist';
  if (err instanceof CloudNotAllowedError) return 'cloud_not_allowed';
  // Phase 14 (v0.11.0 — POL-03/POL-04): scoped-ID regex violations join the
  // invalid_request D-D2 bucket — mirrors InvalidAgentIdError above.
  if (err instanceof InvalidScopedIdError) return 'invalid_request';
  // Phase 10 (v0.10.0 — JSON-06): post-retry structured-output validation failure
  // gets its OWN bucket label so the metric `router_json_validation_total{result="failed"}`
  // (recorded in the route handler) and the request_log error_code stay aligned.
  if (err instanceof InvalidStructuredOutputError) return 'invalid_structured_output';
  if (
    err instanceof InvalidAgentIdError ||
    // Plan 08-07 (ROUTE-12 / D-D5): Idempotency-Key regex violation joins
    // the invalid_request D-D2 bucket. The response envelope carries the
    // specific 'invalid_idempotency_key' code; the request_log row's
    // error_code collapses to the bucket label for SQL aggregation
    // (parity with InvalidAgentIdError above).
    err instanceof InvalidIdempotencyKeyError ||
    err instanceof InvalidToolArgumentsError ||
    err instanceof InvalidImageUrlError ||
    err instanceof ImageFetchError ||
    // Plan 08-05 (CLOUD-04): cloud max_tokens cap exceeded joins the
    // invalid_request D-D2 bucket. The response envelope still carries the
    // specific 'cloud_max_tokens_exceeded' code; only the request_log row's
    // error_code collapses to the bucket label for SQL aggregation.
    err instanceof CloudMaxTokensExceededError ||
    err instanceof z.ZodError ||
    hasZodFastifySchemaValidationErrors(err)
  ) {
    return 'invalid_request';
  }
  // APIConnectionTimeoutError extends APIConnectionError — both map to
  // upstream_timeout (D-D2 has no separate 'upstream_econnrefused' bucket;
  // they're operationally equivalent at the log-query level).
  if (err instanceof APIConnectionTimeoutError) return 'upstream_timeout';
  if (err instanceof APIConnectionError) return 'upstream_timeout';
  // Any other Error with a 5xx statusCode → upstream_5xx (covers undici
  // BadGateway and similar wrapped fetch errors).
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const s = (err as { statusCode: unknown }).statusCode;
    if (typeof s === 'number' && s >= 500 && s < 600) return 'upstream_5xx';
  }
  return 'internal_error';
}

// ── makeRecordRequestOutcome (D-C6) ──────────────────────────────────────────

export interface RecordRequestOutcomeDeps {
  metrics: MetricsRegistry;
  bufferedWriter: Pick<BufferedWriter, 'push'>;
}

/**
 * Factory that returns the per-request recordRequestOutcome helper. The
 * route handlers wrap the returned function in a safeRecord closure
 * (Pitfall 8 idempotency) so calling it twice from a re-entrant sseCleanup
 * is a no-op.
 *
 * Effects, in order:
 *   (a) Observe 5 prom-client metrics on the {protocol, backend, model}
 *       label triple + status_class / direction as appropriate.
 *   (b) Enqueue a request_log row via bufferedWriter.push with EVERY
 *       D-D1 column populated per the D-D6 field map. error_message is
 *       passed through truncateAndRedact before the push.
 */
export function makeRecordRequestOutcome(deps: RecordRequestOutcomeDeps) {
  const { metrics, bufferedWriter } = deps;

  return function recordRequestOutcome(ctx: OutcomeContext): void {
    const labels = { protocol: ctx.protocol, backend: ctx.backend, model: ctx.model };

    // (a) Metric observations — D-C3.
    metrics.requestsTotal.inc({ ...labels, status_class: ctx.statusClass });
    metrics.requestDurationSeconds.observe(labels, ctx.durationMs / 1000);
    if (ctx.ttftMs !== undefined) {
      metrics.ttftSeconds.observe(labels, ctx.ttftMs / 1000);
    }
    if (ctx.tokensIn !== undefined && ctx.tokensIn > 0) {
      metrics.tokensTotal.inc({ ...labels, direction: 'input' }, ctx.tokensIn);
    }
    if (ctx.tokensOut !== undefined && ctx.tokensOut > 0) {
      metrics.tokensTotal.inc({ ...labels, direction: 'output' }, ctx.tokensOut);
    }

    // (b) request_log enqueue — D-D1 columns via D-D6 field map.
    const row: RequestLogInsert = {
      ts: ctx.timestamp,
      protocol: ctx.protocol,
      route: ctx.route,
      backend: ctx.backend,
      model: ctx.model,
      status_class: ctx.statusClass,
      http_status: ctx.httpStatus,
      tokens_in: ctx.tokensIn ?? null,
      tokens_out: ctx.tokensOut ?? null,
      ttft_ms: ctx.ttftMs ?? null,
      latency_ms: Math.round(ctx.durationMs),
      error_code: ctx.errorCode ?? null,
      error_message:
        ctx.errorMessage !== undefined ? truncateAndRedact(ctx.errorMessage) : null,
      agent_id: ctx.agentId ?? null,
      // Phase 14 (v0.11.0 — POL-03/POL-04): scoped-ID columns. ?? null mirrors
      // agent_id pattern — undefined (absent/invalid header) becomes NULL in the row.
      tenant_id: ctx.tenantId ?? null,
      project_id: ctx.projectId ?? null,
      workload_class: ctx.workloadClass ?? null,
      request_id: ctx.requestId,
      upstream_message_id: ctx.upstreamMessageId ?? null,
      // 08-REVIEW CR-01: Idempotency-Key column (Plan 08-07 / D-D5). Populated
      // for both leader and follower rows; null for the (vast) majority of
      // requests that don't carry the header.
      idempotency_key: ctx.idempotencyKey ?? null,
      // Phase 13 (v0.10.0 — COST-01): cost in cents as NUMERIC(10,4) string;
      // null when the model has no pricing or the request failed before tokens
      // were known. The route computes this via computeCostCents() before
      // calling safeRecord — the helper does NOT compute it here because it
      // doesn't have the registry entry in scope and the route's onSend hook
      // needs the same value to stamp X-Cost-Cents.
      cost_cents: ctx.costCents ?? null,
    };
    bufferedWriter.push(row);
  };
}

export type RecordRequestOutcome = ReturnType<typeof makeRecordRequestOutcome>;
