import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import { z } from 'zod/v4';
import { hasZodFastifySchemaValidationErrors } from '@bram-dc/fastify-type-provider-zod';
// Re-export BackendSaturatedError so callers can import from this file (same pattern as RegistryUnknownModelError).
export { BackendSaturatedError } from '../concurrency/semaphore.js';
import { BackendSaturatedError } from '../concurrency/semaphore.js';

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

/** D-C3 status mapping — single source of truth. */
export function mapToHttpStatus(err: unknown): number {
  if (err instanceof BearerAuthError) return 401;
  if (err instanceof z.ZodError) return 400;
  // Fastify wraps zod validation errors into its own ValidationError shape (statusCode: 400).
  // hasZodFastifySchemaValidationErrors checks for the Fastify+zod validation error sentinel.
  if (hasZodFastifySchemaValidationErrors(err)) return 400;
  if (typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 400) return 400;
  if (err instanceof RegistryUnknownModelError) return 404;
  // BackendSaturatedError (Plan 03-04, ROUTE-07) — backend concurrency cap exceeded.
  if (err instanceof BackendSaturatedError) return 429;
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
