/**
 * Plan 08-05 (CLOUD-04 / D-C1, D-C2) — CloudMaxTokensExceededError envelope mappings.
 *
 * Verifies:
 *   - CLOUD_MAX_TOKENS_CAP exports the literal value 16384 (D-C2 — single
 *     source of truth, not env-configurable in v1).
 *   - mapToHttpStatus(CloudMaxTokensExceededError) -> 400 (invalid_request_error
 *     bucket per D-C3).
 *   - toOpenAIErrorEnvelope -> structured shape with
 *       code: 'cloud_max_tokens_exceeded', type: 'invalid_request_error',
 *       param: 'max_tokens', message containing both the requested value and
 *       the cap so clients can self-correct.
 *   - toAnthropicErrorEnvelope -> { type: 'error',
 *       error: { type: 'invalid_request_error', message: ... } } (the
 *       Anthropic taxonomy has no specific cloud-cap type; collapses to the
 *       generic invalid_request_error in line with other 400s).
 *   - mapErrorToCode -> 'invalid_request' (joins ZodError / InvalidAgentIdError
 *     in the existing taxonomy bucket; response envelope carries the more
 *     specific code while the request_log row records the bucket label).
 *   - constructor wires .requested, .cap, .modelName, .code so the route
 *     can build a meaningful 400 payload and tests can introspect.
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_NO_ENVELOPE,
  CloudMaxTokensExceededError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
  toOpenAIErrorEnvelope,
} from '../../src/errors/envelope.js';
import { CLOUD_MAX_TOKENS_CAP } from '../../src/config/constants.js';
import { mapErrorToCode } from '../../src/metrics/recordOutcome.js';

describe('CLOUD_MAX_TOKENS_CAP (Plan 08-05 D-C2)', () => {
  it('exports the literal value 16384 (Ollama Cloud documented ceiling)', () => {
    expect(CLOUD_MAX_TOKENS_CAP).toBe(16_384);
  });
});

describe('CloudMaxTokensExceededError (Plan 08-05 / CLOUD-04)', () => {
  it('constructor wires requested / cap / modelName / code', () => {
    const err = new CloudMaxTokensExceededError(32_768, 16_384, 'gpt-oss:120b-cloud');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CloudMaxTokensExceededError');
    expect(err.code).toBe('cloud_max_tokens_exceeded');
    expect(err.requested).toBe(32_768);
    expect(err.cap).toBe(16_384);
    expect(err.modelName).toBe('gpt-oss:120b-cloud');
    // Message must mention both numbers + the model name so clients can build
    // a sensible retry payload without inspecting the structured fields.
    expect(err.message).toContain('32768');
    expect(err.message).toContain('16384');
    expect(err.message).toContain('gpt-oss:120b-cloud');
  });

  it('mapToHttpStatus -> 400 (invalid_request_error bucket)', () => {
    expect(
      mapToHttpStatus(
        new CloudMaxTokensExceededError(32_768, 16_384, 'gpt-oss:120b-cloud'),
      ),
    ).toBe(400);
  });

  it('toOpenAIErrorEnvelope -> invalid_request_error / cloud_max_tokens_exceeded / param=max_tokens', () => {
    const err = new CloudMaxTokensExceededError(32_768, 16_384, 'gpt-oss:120b-cloud');
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('cloud_max_tokens_exceeded');
    expect(env.error.param).toBe('max_tokens');
    expect(env.error.message).toContain('32768');
    expect(env.error.message).toContain('16384');
  });

  it('toAnthropicErrorEnvelope -> invalid_request_error (Anthropic taxonomy)', () => {
    const err = new CloudMaxTokensExceededError(32_768, 16_384, 'gpt-oss:120b-cloud');
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message).toContain('32768');
    expect(env.error.message).toContain('16384');
  });

  it("mapErrorToCode -> 'invalid_request' (D-D2 taxonomy bucket)", () => {
    expect(
      mapErrorToCode(
        new CloudMaxTokensExceededError(32_768, 16_384, 'gpt-oss:120b-cloud'),
      ),
    ).toBe('invalid_request');
  });
});
