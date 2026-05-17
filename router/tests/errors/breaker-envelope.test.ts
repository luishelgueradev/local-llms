/**
 * Plan 08-04 (CLOUD-03, D-B1..D-B4) — BreakerOpenError envelope mappings.
 *
 * Verifies:
 *   - mapToHttpStatus(BreakerOpenError) -> 503 (Service Unavailable; more
 *     accurate than 429 Rate-Limit because the breaker reflects backend
 *     temporary unhealth, not a per-client rate cap)
 *   - toOpenAIErrorEnvelope -> { error: { type: 'api_error',
 *       code: 'backend_circuit_open', param: null, message: ... } }
 *   - toAnthropicErrorEnvelope -> { type: 'error',
 *       error: { type: 'overloaded_error', message: ... } }
 *   - constructor wires .backend, .retryAfterSec, .code so the route can read
 *     retryAfterSec for the Retry-After header (mirrors BackendSaturatedError).
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_NO_ENVELOPE,
  BreakerOpenError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
  toOpenAIErrorEnvelope,
} from '../../src/errors/envelope.js';

describe('BreakerOpenError (Plan 08-04)', () => {
  it('constructor wires backend / retryAfterSec / code', () => {
    const err = new BreakerOpenError('ollama-cloud', 60);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BreakerOpenError');
    expect(err.code).toBe('backend_circuit_open');
    expect(err.backend).toBe('ollama-cloud');
    expect(err.retryAfterSec).toBe(60);
    expect(err.message).toContain('ollama-cloud');
    expect(err.message).toContain('60');
  });

  it('mapToHttpStatus -> 503 (Service Unavailable)', () => {
    expect(mapToHttpStatus(new BreakerOpenError('ollama-cloud', 60))).toBe(503);
  });

  it('toOpenAIErrorEnvelope -> api_error / backend_circuit_open / param=null', () => {
    const err = new BreakerOpenError('ollama-cloud', 60);
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('api_error');
    expect(env.error.code).toBe('backend_circuit_open');
    expect(env.error.param).toBeNull();
    expect(env.error.message).toContain('ollama-cloud');
  });

  it('toAnthropicErrorEnvelope -> overloaded_error', () => {
    const err = new BreakerOpenError('ollama-cloud', 60);
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('overloaded_error');
    expect(env.error.message).toContain('ollama-cloud');
  });
});
