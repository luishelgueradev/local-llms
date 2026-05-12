import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';
import {
  BearerAuthError,
  RegistryUnknownModelError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
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
});
