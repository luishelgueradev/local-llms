import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import {
  BearerAuthError,
  RegistryUnknownModelError,
  BackendSaturatedError,
  CapabilityNotSupportedError,
  NO_ENVELOPE,
  ANTHROPIC_NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
  toAnthropicErrorEnvelope,
  midStreamErrorFrameLines,
} from '../../src/errors/envelope.js';

describe('toOpenAIErrorEnvelope (D-C1, D-C3)', () => {
  it('BearerAuthError -> 401 / authentication_error / unauthorized', () => {
    const env = toOpenAIErrorEnvelope(new BearerAuthError('nope'));
    expect(env).not.toBe(NO_ENVELOPE);
    expect(env).toEqual({ error: { message: 'nope', type: 'authentication_error', code: 'unauthorized', param: null } });
    expect(mapToHttpStatus(new BearerAuthError())).toBe(401);
  });

  it('ZodError -> 400 / invalid_request_error / invalid_request', () => {
    const result = z.object({ x: z.string() }).safeParse({ x: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const env = toOpenAIErrorEnvelope(result.error);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('invalid_request');
    expect(env.error.param).toBe('x');
    expect(mapToHttpStatus(result.error)).toBe(400);
  });

  it('RegistryUnknownModelError -> 404 / not_found_error / model_not_found', () => {
    const err = new RegistryUnknownModelError('foo:1b', ['llama3.2:3b-instruct-q4_K_M']);
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('not_found_error');
    expect(env.error.code).toBe('model_not_found');
    expect(env.error.message).toContain('foo:1b');
    expect(env.error.message).toContain('llama3.2:3b-instruct-q4_K_M');
    expect(mapToHttpStatus(err)).toBe(404);
  });

  it('APIConnectionError -> 502 / upstream_error / econnrefused', () => {
    const err = new APIConnectionError({ message: 'connect ECONNREFUSED', cause: new Error() });
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('upstream_error');
    expect(env.error.code).toBe('econnrefused');
    expect(mapToHttpStatus(err)).toBe(502);
  });

  it('APIConnectionTimeoutError -> 504 / timeout_error / upstream_timeout', () => {
    const err = new APIConnectionTimeoutError({ message: 'timed out' });
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('timeout_error');
    expect(env.error.code).toBe('upstream_timeout');
    expect(mapToHttpStatus(err)).toBe(504);
  });

  it('APIUserAbortError -> NO_ENVELOPE sentinel (RESEARCH Pitfall 8)', () => {
    const err = new APIUserAbortError({ message: 'aborted' });
    expect(toOpenAIErrorEnvelope(err)).toBe(NO_ENVELOPE);
  });

  it('default unknown error -> 500 / internal_error', () => {
    const err = new Error('boom');
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('internal_error');
    expect(mapToHttpStatus(err)).toBe(500);
  });

  it('mid-stream frame is byte-shaped per D-C2', () => {
    const env = toOpenAIErrorEnvelope(new BearerAuthError('x'));
    if (env === NO_ENVELOPE) throw new Error('unexpected');
    const lines = midStreamErrorFrameLines(env);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ event: 'error', data: JSON.stringify(env) });
    expect(lines[1]).toEqual({ event: '', data: '[DONE]' });
  });

  it('BackendSaturatedError -> 429 / rate_limit_error / backend_saturated (Plan 03-04, ROUTE-07)', () => {
    const err = new BackendSaturatedError('ollama', 1500);
    // HTTP status
    expect(mapToHttpStatus(err)).toBe(429);
    // Envelope
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('rate_limit_error');
    expect(env.error.code).toBe('backend_saturated');
    expect(env.error.param).toBeNull();
    expect(env.error.message).toContain('ollama');
    expect(env.error.message).toContain('saturated');
  });

  it('BackendSaturatedError re-exported from envelope — importable from this module', () => {
    // Verifies the re-export (Edit A from 03-PATTERNS.md §envelope.ts)
    const err = new BackendSaturatedError('llamacpp', 100);
    expect(err).toBeInstanceOf(BackendSaturatedError);
    expect(err.code).toBe('backend_saturated');
    expect(err.backend).toBe('llamacpp');
  });

  // Regression checks: existing mappings must be unaffected by Plan 03-04 changes.
  it('regression: BearerAuthError still maps to 401', () => {
    expect(mapToHttpStatus(new BearerAuthError())).toBe(401);
  });

  it('regression: RegistryUnknownModelError still maps to 404', () => {
    expect(mapToHttpStatus(new RegistryUnknownModelError('foo', []))).toBe(404);
  });

  // Plan 04-02 additions: CapabilityNotSupportedError + Anthropic envelope mapping.
  it('CapabilityNotSupportedError -> 400 / invalid_request_error / model_capability_mismatch (Plan 04-02 D-C2)', () => {
    const err = new CapabilityNotSupportedError('llama3.2:3b-instruct-q4_K_M', 'vision');
    expect(mapToHttpStatus(err)).toBe(400);
    const env = toOpenAIErrorEnvelope(err);
    expect(env).not.toBe(NO_ENVELOPE);
    if (env === NO_ENVELOPE) return;
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.code).toBe('model_capability_mismatch');
    expect(env.error.param).toBe('model');
    expect(env.error.message).toContain('llama3.2:3b-instruct-q4_K_M');
    expect(env.error.message).toContain('vision');
  });
});

describe('toAnthropicErrorEnvelope (Plan 04-02 D-C2)', () => {
  it('CapabilityNotSupportedError -> invalid_request_error envelope', () => {
    const err = new CapabilityNotSupportedError('llama3.2:3b-instruct-q4_K_M', 'vision');
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('invalid_request_error');
    expect(env.error.message).toContain('vision');
  });

  it('BearerAuthError -> authentication_error envelope', () => {
    const env = toAnthropicErrorEnvelope(new BearerAuthError('nope'));
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.type).toBe('error');
    expect(env.error.type).toBe('authentication_error');
    expect(env.error.message).toBe('nope');
  });

  it('RegistryUnknownModelError -> not_found_error envelope', () => {
    const err = new RegistryUnknownModelError('foo:1b', ['bar']);
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('not_found_error');
    expect(env.error.message).toContain('foo:1b');
  });

  it('ZodError -> invalid_request_error envelope', () => {
    const r = z.object({ x: z.string() }).safeParse({ x: 1 });
    if (r.success) throw new Error('expected zod failure');
    const env = toAnthropicErrorEnvelope(r.error);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('invalid_request_error');
  });

  it('BackendSaturatedError -> rate_limit_error envelope', () => {
    const env = toAnthropicErrorEnvelope(new BackendSaturatedError('ollama', 1500));
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('rate_limit_error');
  });

  it('APIConnectionError -> api_error envelope', () => {
    const err = new APIConnectionError({ message: 'connect refused', cause: new Error() });
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('api_error');
  });

  it('APIConnectionTimeoutError -> api_error envelope (mapped to api_error per Anthropic taxonomy)', () => {
    const err = new APIConnectionTimeoutError({ message: 'timed out' });
    const env = toAnthropicErrorEnvelope(err);
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('api_error');
  });

  it('APIUserAbortError -> ANTHROPIC_NO_ENVELOPE sentinel', () => {
    const err = new APIUserAbortError({ message: 'aborted' });
    expect(toAnthropicErrorEnvelope(err)).toBe(ANTHROPIC_NO_ENVELOPE);
  });

  it('unknown error -> api_error envelope', () => {
    const env = toAnthropicErrorEnvelope(new Error('boom'));
    expect(env).not.toBe(ANTHROPIC_NO_ENVELOPE);
    if (env === ANTHROPIC_NO_ENVELOPE) return;
    expect(env.error.type).toBe('api_error');
    expect(env.error.message).toBe('boom');
  });
});
