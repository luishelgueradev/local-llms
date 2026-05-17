/**
 * Plan 08-06 (ROUTE-11 / D-D2 / D-D3) — RateLimitExceededError envelope mappings.
 *
 * Verifies:
 *   - mapToHttpStatus(RateLimitExceededError) -> 429 (Too Many Requests; same
 *     status as BackendSaturatedError but distinct code so request_log / metrics
 *     can split "too many requests per minute" from "backend at concurrency cap").
 *   - toOpenAIErrorEnvelope -> { error: { type: 'rate_limit_error',
 *       code: 'rate_limit_exceeded', param: null, message } }
 *   - toAnthropicErrorEnvelope -> { type: 'error',
 *       error: { type: 'rate_limit_error', message } }
 *   - mapErrorToCode -> 'rate_limit_exceeded' (distinct from 'backend_saturated'
 *     which BackendSaturatedError uses — D-D2 taxonomy split).
 *   - constructor wires .bearerHash, .currentCount, .limit, .code so the route /
 *     centralized handler can read the fields when stamping headers + log lines.
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_NO_ENVELOPE,
  NO_ENVELOPE,
  RateLimitExceededError,
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
  toOpenAIErrorEnvelope,
} from '../../src/errors/envelope.js';
import { mapErrorToCode } from '../../src/metrics/recordOutcome.js';

describe('RateLimitExceededError (Plan 08-06 / ROUTE-11)', () => {
  it('constructor wires bearerHash / currentCount / limit / code', () => {
    const err = new RateLimitExceededError('abcd1234', 700, 600);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitExceededError');
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.bearerHash).toBe('abcd1234');
    expect(err.currentCount).toBe(700);
    expect(err.limit).toBe(600);
    // Message must reference both current count and limit so log readers / SDK
    // surfaces can identify the offending bucket without inspecting fields.
    expect(err.message).toContain('700');
    expect(err.message).toContain('600');
  });

  it('mapToHttpStatus -> 429 (Too Many Requests)', () => {
    expect(mapToHttpStatus(new RateLimitExceededError('abcd1234', 700, 600))).toBe(429);
  });

  it('toOpenAIErrorEnvelope -> rate_limit_error / rate_limit_exceeded / param=null', () => {
    const err = new RateLimitExceededError('abcd1234', 700, 600);
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('rate_limit_error');
    expect(env.error.code).toBe('rate_limit_exceeded');
    expect(env.error.param).toBeNull();
    expect(env.error.message).toContain('700');
    expect(env.error.message).toContain('600');
  });

  it('toAnthropicErrorEnvelope -> rate_limit_error (Anthropic taxonomy)', () => {
    const err = new RateLimitExceededError('abcd1234', 700, 600);
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('rate_limit_error');
    expect(env.error.message).toContain('700');
    expect(env.error.message).toContain('600');
  });

  it("mapErrorToCode -> 'rate_limit_exceeded' (distinct from 'backend_saturated')", () => {
    expect(mapErrorToCode(new RateLimitExceededError('abcd1234', 700, 600))).toBe(
      'rate_limit_exceeded',
    );
  });
});
