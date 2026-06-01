import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import { z } from 'zod/v4';
import { hasZodFastifySchemaValidationErrors } from '@bram-dc/fastify-type-provider-zod';
// Re-export BackendSaturatedError so callers can import from this file (same pattern as RegistryUnknownModelError).
export { BackendSaturatedError } from '../concurrency/semaphore.js';
import { BackendSaturatedError } from '../concurrency/semaphore.js';
// Plan 04-04 / 04-05: InvalidImageUrlError + ImageFetchError live in ollama-native-out.ts
// (where they are thrown by the SSRF + fetch-guard pipeline). Re-exported here so the
// envelope-mapping callers and unit tests have a single import surface.
export { InvalidImageUrlError, ImageFetchError } from '../translation/ollama-native-out.js';
import { InvalidImageUrlError, ImageFetchError } from '../translation/ollama-native-out.js';
// Phase 17 (v0.11.0 — SESS-01..04 + Pitfall 17-B): SessionStore errors. Only
// InvalidSessionIdError raises 4xx through the centralized envelope; the other
// three are caught locally by the route per RESEARCH §"Route policy" (lines
// 357-361). `mapToHttpStatus` still adds them (404/410/403) as defense-in-depth.
import {
  SessionNotFoundError,
  SessionExpiredError,
  SessionAgentMismatchError,
  InvalidSessionIdError,
} from '../providers/session-errors.js';

export type OpenAIErrorEnvelope = {
  error: { message: string; type: string; code: string; param: string | null };
};

/** Sentinel: callers that catch APIUserAbortError must NOT emit an envelope (client gone — RESEARCH Pitfall 8). */
export const NO_ENVELOPE = Symbol('NO_ENVELOPE');
export type EnvelopeOrSkip = OpenAIErrorEnvelope | typeof NO_ENVELOPE;

export class BearerAuthError extends Error {
  readonly code = 'unauthorized';
  constructor(message = 'Invalid bearer token') {
    super(message);
    this.name = 'BearerAuthError';
  }
}

export class RegistryUnknownModelError extends Error {
  readonly code = 'model_not_found';
  constructor(
    public readonly modelName: string,
    public readonly knownNames: string[],
  ) {
    super(`Unknown model "${modelName}"; registered: ${knownNames.join(', ')}`);
    this.name = 'RegistryUnknownModelError';
  }
}

/**
 * Plan 04-02 D-C2: thrown by the /v1/messages route when the requested model lacks
 * a declared capability the body needs (e.g. `vision` for an image-containing message,
 * or `tools` once Plan 04-04 lands tool calling). Maps to 400 + invalid_request_error
 * on both wire surfaces (OpenAI envelope: code=`model_capability_mismatch`,
 * Anthropic envelope: type=`invalid_request_error`).
 *
 * Plan 07-04 widening: also thrown by the /v1/embeddings route when the requested
 * model lacks the `embeddings` capability (e.g. a chat-only model like
 * `qwen2.5-7b-instruct-awq` is asked to embed). Same 400 / model_capability_mismatch
 * mapping — the third allowed value of `missingCapability` is `'embeddings'`.
 * Additionally, LlamacppOpenAIAdapter.embeddings() throws this error
 * unconditionally (with `backend` synthesized as the modelName argument
 * `'llamacpp'`) as defense-in-depth: llama.cpp-server does not expose /v1/embeddings,
 * so adapter-level throws back the route-level capability gate. See Plan 07-04
 * `<interfaces>` block for the contract.
 */
export class CapabilityNotSupportedError extends Error {
  readonly code = 'model_capability_mismatch';
  constructor(
    public readonly modelName: string,
    public readonly missingCapability: 'vision' | 'tools' | 'embeddings' | 'json_mode' | 'rerank',
  ) {
    super(
      `Model "${modelName}" does not support capability "${missingCapability}". ` +
        `Pick a model with "${missingCapability}" in its capabilities list.`,
    );
    this.name = 'CapabilityNotSupportedError';
  }
}

/**
 * Phase 10 (v0.10.0 — JSON-04): thrown when `response_format: {type: "json_object"|"json_schema"}`
 * is supplied AND the model's response fails JSON parse + schema validation AFTER the
 * single retry-with-repair attempt (JSON-03). Maps to 400 + invalid_structured_output.
 *
 * The `details` field contains the AJV validation errors (or parse error message) of the
 * FINAL attempt — the client receives an actionable failure rather than corrupt JSON.
 */
export class InvalidStructuredOutputError extends Error {
  readonly code = 'invalid_structured_output';
  constructor(
    public readonly modelName: string,
    public readonly details: string,
  ) {
    super(
      `Model "${modelName}" failed to produce a response matching the requested response_format ` +
        `after one repair attempt. Details: ${details}`,
    );
    this.name = 'InvalidStructuredOutputError';
  }
}

/**
 * Phase 12 (v0.10.0 — EMB-H02): thrown by /v1/embeddings when the upstream
 * adapter returns a vector whose length does not match the `dims` declared
 * for the model in `models.yaml`. The router refuses to propagate the broken
 * vector to a downstream vector store — a silent dims drift would invalidate
 * the entire index. Surfaces as 500 (server_error bucket — this is an upstream
 * misconfiguration, not a client error). The structured log line is the
 * operator signal to investigate model swap / quantization changes.
 *
 * The error message includes BOTH the expected and observed dims so the
 * operator can correlate against models.yaml in one glance.
 */
export class EmbeddingsDimsMismatchError extends Error {
  readonly code: 'embeddings_dims_mismatch' = 'embeddings_dims_mismatch';
  constructor(
    public readonly modelName: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Model "${modelName}" returned an embedding of ${actual} dimensions, ` +
        `but models.yaml declares dims=${expected}. The router refused to propagate ` +
        `the mismatched vector — verify the upstream model version / quantization or ` +
        `update the dims field in models.yaml.`,
    );
    this.name = 'EmbeddingsDimsMismatchError';
  }
}

/**
 * Plan 08-04 (CLOUD-03 / D-B1..D-B4): thrown when a request is rejected
 * because the per-backend circuit breaker is open (or another probe is
 * in flight while the breaker is half-open).
 *
 * Maps to:
 *   - HTTP 503 (Service Unavailable — backend temporarily unhealthy;
 *     more accurate than 429 which is per-client rate-limit semantics)
 *   - OpenAI envelope: type: 'api_error', code: 'backend_circuit_open'
 *   - Anthropic envelope: type: 'overloaded_error'
 *
 * The route handler that throws this error MUST also set the Retry-After
 * response header to retryAfterSec (mirrors the BackendSaturatedError
 * pattern in chat-completions.ts:170s) so well-behaved SDKs back off
 * appropriately rather than retry-storming.
 */
export class BreakerOpenError extends Error {
  readonly code = 'backend_circuit_open';
  constructor(
    public readonly backend: string,
    public readonly retryAfterSec: number,
  ) {
    super(`Backend "${backend}" circuit breaker is open; retry after ${retryAfterSec}s`);
    this.name = 'BreakerOpenError';
  }
}

/**
 * Plan 08-05 (CLOUD-04 / D-C1, D-C2): thrown by the /v1/chat/completions and
 * /v1/messages routes when a `backend: ollama-cloud` request specifies
 * `max_tokens > CLOUD_MAX_TOKENS_CAP` (16,384 per PITFALLS Pitfall 9).
 *
 * The cap is enforced at the router boundary — Ollama Cloud silently
 * truncates oversized requests, which is exactly the opacity D-C1 forbids
 * ("never silently clip — the client must know its request was modified").
 * Rejecting with a structured 400 lets the agent reduce max_tokens and retry
 * deterministically.
 *
 * Maps to:
 *   - HTTP 400 (invalid_request bucket)
 *   - OpenAI envelope: { error: { message, type: 'invalid_request_error',
 *       code: 'cloud_max_tokens_exceeded', param: 'max_tokens' } }
 *   - Anthropic envelope: { type: 'error',
 *       error: { type: 'invalid_request_error', message } }
 *
 * The error carries both the requested value and the cap so clients can
 * construct a helpful retry payload (e.g., "use max_tokens=16384 instead")
 * directly from the response body.
 *
 * Local models are unaffected — only entries with `backend === 'ollama-cloud'`
 * trigger this throw. The route handler gates BEFORE the breaker.check call so
 * an oversized request doesn't consume a half-open probe slot.
 */
export class CloudMaxTokensExceededError extends Error {
  readonly code: 'cloud_max_tokens_exceeded' = 'cloud_max_tokens_exceeded';
  constructor(
    public readonly requested: number,
    public readonly cap: number,
    public readonly modelName: string,
  ) {
    super(
      `Cloud model "${modelName}" rejects max_tokens=${requested}: hard cap is ${cap}. ` +
        `Reduce max_tokens to <= ${cap} and retry; cloud-served models cannot exceed this limit.`,
    );
    this.name = 'CloudMaxTokensExceededError';
  }
}

/**
 * Plan 08-06 (ROUTE-11 / D-D2 / D-D3): thrown by the rate-limit onRequest hook
 * when a bearer token's per-minute counter exceeds ROUTER_RATE_LIMIT_RPM (600
 * by default).
 *
 * Maps to:
 *   - HTTP 429 (Too Many Requests)
 *   - OpenAI envelope: type: 'rate_limit_error', code: 'rate_limit_exceeded'
 *   - Anthropic envelope: type: 'rate_limit_error'
 *   - Retry-After: 60 (seconds until the per-minute bucket rolls over —
 *     stamped by the centralized error handler in app.ts)
 *
 * Distinct from BackendSaturatedError (which is a per-backend concurrency
 * cap, also 429 but code='backend_saturated'). The request_log row's
 * error_code distinguishes the two via mapErrorToCode in recordOutcome.ts —
 * 'rate_limit_exceeded' for this error vs 'backend_saturated' for the
 * concurrency cap. Both share the wire-level type='rate_limit_error' (D-D2
 * taxonomy choice — both surfaces are "client must back off"), but the
 * D-D2 taxonomy bucket on the request_log side keeps them queryable apart.
 */
export class RateLimitExceededError extends Error {
  readonly code: 'rate_limit_exceeded' = 'rate_limit_exceeded';
  constructor(
    public readonly bearerHash: string,
    public readonly currentCount: number,
    public readonly limit: number,
  ) {
    super(
      `Rate limit exceeded: ${currentCount}/${limit} requests per minute for this bearer token. ` +
        `Retry after the next minute boundary (Retry-After header).`,
    );
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Plan 08-07 (ROUTE-12 / D-D5): thrown by extractIdempotencyKey when an
 * Idempotency-Key header is present but violates the regex
 * `/^[A-Za-z0-9._:-]{1,256}$/`. The regex is permissive enough for ULID,
 * UUID, and operator-chosen strings; the 256-char ceiling bounds Valkey
 * key length so a misbehaving client can't bloat the keyspace.
 *
 * Maps to:
 *   - HTTP 400 (invalid_request bucket)
 *   - OpenAI envelope: type: 'invalid_request_error',
 *       code: 'invalid_idempotency_key', param: 'Idempotency-Key'
 *   - Anthropic envelope: type: 'invalid_request_error'
 *
 * Symmetric to InvalidAgentIdError (D-D5 same regex shape, broader length
 * cap because Idempotency-Key may legitimately be a 128-bit hex digest).
 * Truncates the supplied value to 32 chars in the message body so an
 * attacker spraying long keys can't bloat error envelopes / log lines.
 */
export class InvalidIdempotencyKeyError extends Error {
  readonly code: 'invalid_idempotency_key' = 'invalid_idempotency_key';
  constructor(public readonly suppliedValue: string) {
    // 08-REVIEW WR-01 fix: sanitize before display.
    //
    // The supplied value is attacker-controlled (any HTTP header value). The
    // pre-fix code length-capped to 32 chars but did NOT scrub control
    // characters or shell-quoting chars; the full value also reached pino logs
    // via the centralized error handler's `req.log.warn({ err, ... })`. Both
    // surfaces are now scrubbed: any character outside the allowed regex set
    // `[A-Za-z0-9._:-]` (the same set the validator accepts) is replaced with
    // `?`, then truncated to 32 chars. This keeps the error message readable
    // for the operator while neutralizing newline / ANSI escape / null-byte
    // log-injection vectors.
    const raw = String(suppliedValue ?? '');
    const sanitized = raw.replace(/[^A-Za-z0-9._:,\-]/g, '?');
    const display =
      sanitized.length > 32 ? `${sanitized.slice(0, 32)}...` : sanitized;
    super(
      `Idempotency-Key "${display}" violates regex /^[A-Za-z0-9._:-]{1,256}$/`,
    );
    this.name = 'InvalidIdempotencyKeyError';
  }
}

/**
 * Plan 05-02 D-D5 / ROUTE-09: thrown by the agentIdPreHandler when an inbound
 * X-Agent-Id header violates the regex `/^[A-Za-z0-9._:-]{1,128}$/`. Maps to
 * 400 + invalid_request_error on both wire surfaces (OpenAI envelope:
 * code='invalid_agent_id'; Anthropic envelope: type='invalid_request_error').
 *
 * The supplied value is truncated to 32 chars in the message body so an
 * attacker spraying long agent-ids can't bloat error envelopes / log lines
 * (defense in depth).
 */
export class InvalidAgentIdError extends Error {
  readonly code = 'invalid_agent_id';
  constructor(public readonly suppliedValue: string) {
    const display =
      typeof suppliedValue === 'string' && suppliedValue.length > 32
        ? `${suppliedValue.slice(0, 32)}...`
        : String(suppliedValue ?? '');
    super(
      `X-Agent-Id "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`,
    );
    this.name = 'InvalidAgentIdError';
  }
}


/**
 * Phase 14 (v0.11.0 — POL-01): thrown by applyPolicyGate() when the requested
 * model is not in `policies.default.model_allowlist`. Fires BEFORE the
 * circuit-breaker check so policy violations never count as backend failures
 * (P8-01 BLOCK). Maps to 403 + policy_violation on both wire surfaces.
 */
export class AllowlistViolationError extends Error {
  readonly code = 'model_not_in_allowlist';
  constructor(public readonly modelName: string) {
    super(
      `Model "${modelName}" is not in policies.default.model_allowlist. ` +
        `Either add it to the allowlist in models.yaml or use a model from the allowed set.`,
    );
    this.name = 'AllowlistViolationError';
  }
}

/**
 * Phase 14 (v0.11.0 — POL-02): thrown by applyPolicyGate() when the resolved
 * registry entry has `backend: ollama-cloud` AND `policy.cloud_allowed: false`.
 * Fires BEFORE the circuit-breaker check (P8-01). Maps to 403 + policy_violation.
 */
export class CloudNotAllowedError extends Error {
  readonly code = 'cloud_not_allowed';
  constructor(public readonly modelName: string) {
    super(
      `Model "${modelName}" resolves to an ollama-cloud entry whose policy.cloud_allowed=false. ` +
        `Cloud routing is denied for this entry; pick a local-backend model.`,
    );
    this.name = 'CloudNotAllowedError';
  }
}

/**
 * Phase 14 (v0.11.0 — POL-04): thrown by scopedIdsPreHandler when an inbound
 * X-Tenant-ID or X-Project-ID header violates regex /^[A-Za-z0-9._:-]{1,128}$/.
 * Mirrors InvalidAgentIdError (same regex, same 400 mapping). Diverges from
 * X-Workload-Class (silent-NULL) because tenant/project IDs are operationally
 * load-bearing.
 *
 * `headerLabel` is the header name for the error message (e.g. 'X-Tenant-ID').
 * Truncates `suppliedValue` to 32 chars in the message body (log-injection defense,
 * T-14-04 mitigation — mirrors InvalidAgentIdError pattern).
 */
export class InvalidScopedIdError extends Error {
  readonly code: 'invalid_scoped_id' = 'invalid_scoped_id';
  constructor(
    public readonly headerLabel: string,
    public readonly suppliedValue: string,
  ) {
    const display =
      typeof suppliedValue === 'string' && suppliedValue.length > 32
        ? `${suppliedValue.slice(0, 32)}...`
        : String(suppliedValue ?? '');
    super(
      `${headerLabel} "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`,
    );
    this.name = 'InvalidScopedIdError';
  }
}

/**
 * Plan 04-04 T-04-02 mitigation: thrown by openai-in.ts when an OpenAI assistant
 * `tool_calls[i].function.arguments` string is not valid JSON. Maps to 400 +
 * invalid_request_error with code:'invalid_tool_arguments' on both wire surfaces.
 *
 * The translator is the trust boundary that catches malformed model output (or
 * client-supplied bad data on a /v1/chat/completions continuation request); adapters
 * NEVER do JSON.parse on tool args (grep gate S7).
 */
export class InvalidToolArgumentsError extends Error {
  readonly code: 'invalid_tool_arguments' = 'invalid_tool_arguments';
  constructor(
    public readonly toolCallId: string,
    public readonly cause: Error,
  ) {
    super(
      `tool_calls[id="${toolCallId}"].function.arguments is not valid JSON: ${cause.message}`,
    );
    this.name = 'InvalidToolArgumentsError';
  }
}

// InvalidImageUrlError + ImageFetchError are declared in ollama-native-out.ts and
// re-exported above (single source of truth for the runtime throw sites).

/** D-C3 status mapping — single source of truth. */
export function mapToHttpStatus(err: unknown): number {
  if (err instanceof BearerAuthError) return 401;
  if (err instanceof z.ZodError) return 400;
  // Fastify wraps zod validation errors into its own ValidationError shape (statusCode: 400).
  // hasZodFastifySchemaValidationErrors checks for the Fastify+zod validation error sentinel.
  if (hasZodFastifySchemaValidationErrors(err)) return 400;
  if (typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 400) return 400;
  if (err instanceof RegistryUnknownModelError) return 404;
  // Plan 04-02 D-C2: missing capability for the requested model — pre-adapter 400.
  if (err instanceof CapabilityNotSupportedError) return 400;
  // Phase 10 (v0.10.0 — JSON-04): structured output validation failed after repair — 400.
  if (err instanceof InvalidStructuredOutputError) return 400;
  // Plan 08-05 (CLOUD-04 / D-C1): cloud model max_tokens > 16384 — pre-adapter 400.
  if (err instanceof CloudMaxTokensExceededError) return 400;
  // Plan 05-02 D-D5 / ROUTE-09: X-Agent-Id regex violation — pre-route 400.
  if (err instanceof InvalidAgentIdError) return 400;
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violations → 403.
  if (err instanceof AllowlistViolationError) return 403;
  if (err instanceof CloudNotAllowedError) return 403;
  // Phase 14 (v0.11.0 — POL-04): tenant/project header regex violation → 400
  // (mirrors InvalidAgentIdError pattern).
  if (err instanceof InvalidScopedIdError) return 400;
  // Plan 08-07 (ROUTE-12 / D-D5): Idempotency-Key regex violation — 400.
  if (err instanceof InvalidIdempotencyKeyError) return 400;
  // Phase 17 (v0.11.0 — SESS-01..04 + Pitfall 17-B):
  //   - InvalidSessionIdError → 400 (BUBBLES through envelope — bad header).
  //   - SessionNotFoundError → 404 (defense-in-depth; routes catch locally).
  //   - SessionExpiredError → 410 (defense-in-depth; routes catch locally).
  //   - SessionAgentMismatchError → 403 (bubbles from appendTurn only;
  //     loadHistory catches locally to avoid leaking session_id existence).
  if (err instanceof InvalidSessionIdError) return 400;
  if (err instanceof SessionNotFoundError) return 404;
  if (err instanceof SessionExpiredError) return 410;
  if (err instanceof SessionAgentMismatchError) return 403;
  // Plan 04-04 T-04-02: malformed tool_calls[].function.arguments — 400.
  if (err instanceof InvalidToolArgumentsError) return 400;
  // Plan 04-04 T-04-01: image URL or fetch failures — 400 (Plan 05 consumer / D-C4 SSRF).
  if (err instanceof InvalidImageUrlError) return 400;
  if (err instanceof ImageFetchError) return 400;
  // BackendSaturatedError (Plan 03-04, ROUTE-07) — backend concurrency cap exceeded.
  if (err instanceof BackendSaturatedError) return 429;
  // Plan 08-06 (ROUTE-11 / D-D2) — per-bearer-token RPM exceeded → 429 with
  // Retry-After (set by the centralized error handler). Same status as
  // BackendSaturatedError because the wire taxonomy collapses both to
  // rate_limit_error; the distinct error code keeps them queryable apart.
  if (err instanceof RateLimitExceededError) return 429;
  // Plan 08-04 (CLOUD-03) — per-backend circuit breaker is open → 503 Service Unavailable.
  if (err instanceof BreakerOpenError) return 503;
  // Phase 12 (v0.10.0 — EMB-H02): dims mismatch is a server-side guarantee violation;
  // map to 500 so it's surfaced as server_error in dashboards (clients can't fix it).
  if (err instanceof EmbeddingsDimsMismatchError) return 500;
  // APIConnectionTimeoutError extends APIConnectionError — check FIRST for 504, before the 502 below
  if (err instanceof APIConnectionTimeoutError) return 504;
  if (err instanceof APIConnectionError) return 502;
  if (err instanceof APIUserAbortError) return 499; // client closed — never actually sent
  return 500;
}

/** D-C1 envelope; D-C3 type/code mapping. APIUserAbortError -> NO_ENVELOPE (RESEARCH Pitfall 8). */
export function toOpenAIErrorEnvelope(err: unknown): EnvelopeOrSkip {
  if (err instanceof APIUserAbortError) return NO_ENVELOPE;

  if (err instanceof BearerAuthError) {
    return { error: { message: err.message, type: 'authentication_error', code: 'unauthorized', param: null } };
  }
  if (err instanceof z.ZodError) {
    return {
      error: {
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'invalid request',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: err.issues[0]?.path.join('.') ?? null,
      },
    };
  }
  // Fastify wraps zod validation errors into its own shape with a `validation` array.
  // The type provider uses the ZodFastifySchemaValidationError sentinel symbol.
  if (hasZodFastifySchemaValidationErrors(err)) {
    const first = err.validation[0];
    const message = err.validation.map((v) => `${v.instancePath}: ${v.message}`).join('; ') || 'invalid request body';
    return {
      error: {
        message,
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: first?.instancePath?.replace(/^\//, '') ?? null,
      },
    };
  }
  if (err instanceof RegistryUnknownModelError) {
    return { error: { message: err.message, type: 'not_found_error', code: 'model_not_found', param: 'model' } };
  }
  // Plan 04-02 D-C2: CapabilityNotSupportedError on /v1/chat/completions surface.
  if (err instanceof CapabilityNotSupportedError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'model_capability_mismatch',
        param: 'model',
      },
    };
  }
  // Phase 10 (v0.10.0 — JSON-04): structured output validation failed → 400 with details.
  if (err instanceof InvalidStructuredOutputError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_structured_output',
        param: 'response_format',
      },
    };
  }
  // Plan 08-05 (CLOUD-04 / D-C1): cloud max_tokens cap exceeded → 400 +
  // invalid_request_error with the specific 'cloud_max_tokens_exceeded' code
  // and param='max_tokens' so clients can map the failure to the offending
  // body field directly. err.message already contains both requested + cap.
  if (err instanceof CloudMaxTokensExceededError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'cloud_max_tokens_exceeded',
        param: 'max_tokens',
      },
    };
  }
  // Plan 05-02 D-D5: X-Agent-Id regex violation — OpenAI envelope.
  if (err instanceof InvalidAgentIdError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_agent_id',
        param: 'X-Agent-Id',
      },
    };
  }
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violation envelopes.
  // type='policy_violation' is a new wire-level type — distinct from
  // invalid_request_error (the request was well-formed; the policy refused it).
  if (err instanceof AllowlistViolationError) {
    return {
      error: {
        message: err.message,
        type: 'policy_violation',
        code: 'model_not_in_allowlist',
        param: 'model',
      },
    };
  }
  if (err instanceof CloudNotAllowedError) {
    return {
      error: {
        message: err.message,
        type: 'policy_violation',
        code: 'cloud_not_allowed',
        param: 'model',
      },
    };
  }
  // Phase 14 (v0.11.0 — POL-04): scoped-ID regex violation — OpenAI envelope.
  if (err instanceof InvalidScopedIdError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_scoped_id',
        param: err.headerLabel,
      },
    };
  }
  // Plan 08-07 (ROUTE-12 / D-D5): Idempotency-Key regex violation — OpenAI envelope.
  if (err instanceof InvalidIdempotencyKeyError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_idempotency_key',
        param: 'Idempotency-Key',
      },
    };
  }
  // Phase 17 (v0.11.0 — SESS-05 / Pitfall 17-B): only InvalidSessionIdError
  // ever bubbles to the OpenAI envelope. SessionNotFoundError /
  // SessionExpiredError / SessionAgentMismatchError are caught locally by the
  // route's session-attach try/catch and never reach this mapper (RESEARCH
  // lines 357-361). Param mirrors the InvalidAgentIdError pattern at line 499.
  if (err instanceof InvalidSessionIdError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_session_id',
        param: 'X-Session-ID',
      },
    };
  }
  // Plan 04-04 T-04-02: malformed tool_calls JSON arguments.
  if (err instanceof InvalidToolArgumentsError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_tool_arguments',
        param: 'tool_calls',
      },
    };
  }
  // Plan 04-04 T-04-01 / Plan 04-05 D-C4: image URL invalid (non-https / SSRF guard).
  // param points at the source.url path so clients can map the failure to the block.
  if (err instanceof InvalidImageUrlError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_image_url',
        param: 'messages[].content[].source.url',
      },
    };
  }
  // Plan 04-04 T-04-01: image fetch failure — per-instance `code` field carries the
  // specific reason (image_too_large / image_invalid_content_type / http_error).
  if (err instanceof ImageFetchError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: err.code,
        param: 'messages[].content[].source.url',
      },
    };
  }
  // BackendSaturatedError (Plan 03-04, ROUTE-07) — backend concurrency cap exceeded; maps to 429 rate_limit_error.
  if (err instanceof BackendSaturatedError) {
    return {
      error: {
        message: err.message,
        type: 'rate_limit_error',
        code: 'backend_saturated',
        param: null,
      },
    };
  }
  // Plan 08-06 (ROUTE-11 / D-D2) — per-bearer-token RPM exceeded; 429 +
  // rate_limit_error with the specific `rate_limit_exceeded` code that
  // distinguishes "too many req/min" from BackendSaturatedError's
  // "backend at concurrency cap". Both share the wire-level type per the
  // D-D2 taxonomy.
  if (err instanceof RateLimitExceededError) {
    return {
      error: {
        message: err.message,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        param: null,
      },
    };
  }
  // Plan 08-04 (CLOUD-03) — per-backend circuit breaker open → api_error with
  // code='backend_circuit_open'. The route also stamps Retry-After: <cooldown>
  // (mirror of BackendSaturatedError's Retry-After path).
  if (err instanceof BreakerOpenError) {
    return {
      error: {
        message: err.message,
        type: 'api_error',
        code: 'backend_circuit_open',
        param: null,
      },
    };
  }
  // Phase 12 (v0.10.0 — EMB-H02): dims mismatch is an api_error (the upstream
  // returned a vector the router refuses to propagate). param=null because the
  // failure is server-side, not tied to a client-supplied field.
  if (err instanceof EmbeddingsDimsMismatchError) {
    return {
      error: {
        message: err.message,
        type: 'api_error',
        code: 'embeddings_dims_mismatch',
        param: null,
      },
    };
  }
  // APIConnectionTimeoutError extends APIConnectionError — check FIRST so we get 504 timeout semantics
  if (err instanceof APIConnectionTimeoutError) {
    return { error: { message: err.message || 'upstream timeout', type: 'timeout_error', code: 'upstream_timeout', param: null } };
  }
  if (err instanceof APIConnectionError) {
    return { error: { message: err.message || 'upstream connection error', type: 'upstream_error', code: 'econnrefused', param: null } };
  }
  const msg = err instanceof Error ? err.message : 'internal error';
  return { error: { message: msg, type: 'internal_error', code: 'internal_error', param: null } };
}

/** D-C2: serialize the mid-stream error frame (event: error + data + [DONE]). Used by plan 02-04's stream handler. */
export function midStreamErrorFrameLines(envelope: OpenAIErrorEnvelope): { event: string; data: string }[] {
  return [
    { event: 'error', data: JSON.stringify(envelope) },
    { event: '', data: '[DONE]' },
  ];
}

/**
 * Plan 04-03 (ANTHR-06, FINDING 1.1): Anthropic mid-stream error frame.
 *
 * Anthropic emits a SINGLE `event: error\ndata: {...}` frame on stream error and the
 * stream ends — there is NO `data: [DONE]` follow-up (Anthropic does not use [DONE]
 * as a terminator at all; the OpenAI-style terminator is replaced by the typed
 * `event: message_stop` frame on success and by silence on error).
 *
 * The single-frame return shape (NOT an array) is the deliberate distinguishing
 * feature vs. `midStreamErrorFrameLines` — tests assert `Array.isArray(frame) === false`.
 */
export function anthropicErrorFrame(envelope: AnthropicErrorEnvelope): {
  event: string;
  data: string;
} {
  return { event: 'error', data: JSON.stringify(envelope) };
}

// ── Anthropic-shape envelope (Plan 04-02 D-C2) ──────────────────────────────────
//
// /v1/messages* routes serialize errors as Anthropic's wire envelope. The error
// `type` taxonomy is: invalid_request_error | authentication_error | permission_error
// | not_found_error | rate_limit_error | api_error | overloaded_error.
//
// app.ts centralized error handler routes to toAnthropicErrorEnvelope iff
// req.url.startsWith('/v1/messages'); otherwise it uses toOpenAIErrorEnvelope.

export type AnthropicErrorEnvelope = {
  type: 'error';
  error: { type: string; message: string };
};

/** Sentinel: client gone (APIUserAbortError) — Anthropic surface must not write a body. */
export const ANTHROPIC_NO_ENVELOPE = Symbol('ANTHROPIC_NO_ENVELOPE');
export type AnthropicEnvelopeOrSkip =
  | AnthropicErrorEnvelope
  | typeof ANTHROPIC_NO_ENVELOPE;

/**
 * Anthropic-surface error envelope. Mirrors `toOpenAIErrorEnvelope` semantics but
 * emits Anthropic's wire-shape with the Anthropic error-type taxonomy:
 *   - BearerAuthError              → authentication_error
 *   - z.ZodError / Fastify zod val → invalid_request_error
 *   - RegistryUnknownModelError    → not_found_error
 *   - CapabilityNotSupportedError  → invalid_request_error
 *   - BackendSaturatedError        → rate_limit_error
 *   - APIConnectionTimeoutError    → api_error (Anthropic has no "timeout" type)
 *   - APIConnectionError           → api_error
 *   - APIUserAbortError            → ANTHROPIC_NO_ENVELOPE (client gone)
 *   - default                      → api_error
 */
export function toAnthropicErrorEnvelope(err: unknown): AnthropicEnvelopeOrSkip {
  if (err instanceof APIUserAbortError) return ANTHROPIC_NO_ENVELOPE;

  if (err instanceof BearerAuthError) {
    return { type: 'error', error: { type: 'authentication_error', message: err.message } };
  }
  if (err instanceof z.ZodError) {
    const message =
      err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') || 'invalid request';
    return { type: 'error', error: { type: 'invalid_request_error', message } };
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const message =
      err.validation.map((v) => `${v.instancePath}: ${v.message}`).join('; ') || 'invalid request body';
    return { type: 'error', error: { type: 'invalid_request_error', message } };
  }
  if (err instanceof RegistryUnknownModelError) {
    return { type: 'error', error: { type: 'not_found_error', message: err.message } };
  }
  if (err instanceof CapabilityNotSupportedError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Phase 10 (v0.10.0 — JSON-04): structured-output validation failure — Anthropic taxonomy
  // collapses to invalid_request_error (parity with the OpenAI envelope which carries the
  // specific `code` field).
  if (err instanceof InvalidStructuredOutputError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Plan 08-05 (CLOUD-04 / D-C1): cloud max_tokens cap exceeded — Anthropic
  // taxonomy has no specific cloud-cap type; collapse to invalid_request_error
  // (parity with the OpenAI envelope which carries the specific `code` field).
  if (err instanceof CloudMaxTokensExceededError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Plan 05-02 D-D5: X-Agent-Id regex violation — Anthropic envelope.
  if (err instanceof InvalidAgentIdError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violation envelopes.
  // Anthropic's wire taxonomy reserves permission_error for policy-style
  // refusals — matches the semantics of "the request was well-formed but
  // policy refused it" better than the closer 'invalid_request_error'.
  if (err instanceof AllowlistViolationError) {
    return { type: 'error', error: { type: 'permission_error', message: err.message } };
  }
  if (err instanceof CloudNotAllowedError) {
    return { type: 'error', error: { type: 'permission_error', message: err.message } };
  }
  // Phase 14 (v0.11.0 — POL-04): scoped-ID regex violation — Anthropic envelope.
  if (err instanceof InvalidScopedIdError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Plan 08-07 (ROUTE-12 / D-D5): Idempotency-Key regex violation — Anthropic envelope.
  if (err instanceof InvalidIdempotencyKeyError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Phase 17 (v0.11.0 — SESS-05 / Pitfall 17-B): only InvalidSessionIdError
  // bubbles to the Anthropic envelope. Same rationale as the OpenAI branch
  // above — the other three SessionStore errors are caught locally.
  if (err instanceof InvalidSessionIdError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  // Plan 04-04 / Plan 04-05: InvalidToolArgumentsError + InvalidImageUrlError + ImageFetchError
  // all map to invalid_request_error on the Anthropic surface (taxonomy has no specific
  // image_url or tool_arguments type — parity with toOpenAIErrorEnvelope which uses
  // invalid_request_error + per-class code).
  if (
    err instanceof InvalidToolArgumentsError ||
    err instanceof InvalidImageUrlError ||
    err instanceof ImageFetchError
  ) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
  if (err instanceof BackendSaturatedError) {
    return { type: 'error', error: { type: 'rate_limit_error', message: err.message } };
  }
  // Plan 08-06 (ROUTE-11 / D-D2) — per-bearer-token RPM exceeded → Anthropic
  // taxonomy rate_limit_error (same enum value as BackendSaturatedError on the
  // Anthropic surface; the distinct error code in the OpenAI envelope is the
  // surfacing point of the split).
  if (err instanceof RateLimitExceededError) {
    return { type: 'error', error: { type: 'rate_limit_error', message: err.message } };
  }
  // Plan 08-04 (CLOUD-03) — breaker open → Anthropic-taxonomy `overloaded_error`.
  // Anthropic's wire taxonomy reserves overloaded_error for "backend is degraded
  // and clients should back off", which matches the breaker semantics 1:1.
  if (err instanceof BreakerOpenError) {
    return { type: 'error', error: { type: 'overloaded_error', message: err.message } };
  }
  // APIConnectionTimeoutError extends APIConnectionError — order matters only on
  // mapToHttpStatus (different HTTP codes); the Anthropic taxonomy collapses both
  // into `api_error` (Anthropic has no `timeout_error` enum value).
  if (err instanceof APIConnectionTimeoutError) {
    return { type: 'error', error: { type: 'api_error', message: err.message || 'upstream timeout' } };
  }
  if (err instanceof APIConnectionError) {
    return {
      type: 'error',
      error: { type: 'api_error', message: err.message || 'upstream connection error' },
    };
  }
  const msg = err instanceof Error ? err.message : 'internal error';
  return { type: 'error', error: { type: 'api_error', message: msg } };
}
