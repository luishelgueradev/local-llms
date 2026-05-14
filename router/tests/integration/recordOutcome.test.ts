/**
 * Plan 05-02 Task 2 — recordOutcome integration tests.
 *
 * Covers D-D1 row shape, D-D2 error_code taxonomy, D-D3 truncateAndRedact,
 * D-D4 skip list. The actual route wiring (recordOutcome call sites in
 * chat-completions.ts + messages.ts) lands in Task 3. These tests exercise:
 *   - the helper directly (truncateAndRedact, deriveStatusClass, mapErrorToCode)
 *   - the helper invoked via `makeRecordRequestOutcome(deps)` to assert the
 *     full D-D1 row shape and the metric observation side effect.
 *
 * Skip-list cases live in route integration tests (Task 3 lands those — the
 * route is the structural enforcement point, not the helper).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveStatusClass,
  makeRecordRequestOutcome,
  mapErrorToCode,
  truncateAndRedact,
  type OutcomeContext,
} from '../../src/metrics/recordOutcome.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';
import {
  BackendSaturatedError,
  CapabilityNotSupportedError,
  ImageFetchError,
  InvalidAgentIdError,
  InvalidImageUrlError,
  InvalidToolArgumentsError,
  RegistryUnknownModelError,
} from '../../src/errors/envelope.js';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

describe('truncateAndRedact (D-D3 + Pitfall 12)', () => {
  it('strips Bearer + token from "error: Bearer abc123def456 expired"', () => {
    const out = truncateAndRedact('error: Bearer abc123def456 expired');
    expect(out).not.toContain('abc123def456');
    expect(/[Bb]earer\s+\S+/.test(out)).toBe(false);
  });

  it('strips apiKey="secret-12345" form', () => {
    const out = truncateAndRedact('apiKey="secret-12345"');
    expect(out).not.toContain('secret-12345');
  });

  it('strips api_key=val and api-key:val forms', () => {
    expect(truncateAndRedact('api_key=topsecret-xyz')).not.toContain('topsecret-xyz');
    expect(truncateAndRedact('api-key: another-secret')).not.toContain('another-secret');
  });

  it('strips Authorization: Bearer XYZ', () => {
    const out = truncateAndRedact('Authorization: Bearer xyz123abc');
    expect(out).not.toContain('xyz123abc');
  });

  it('truncates messages longer than maxLen (default 500) and appends ...', () => {
    const long = 'a'.repeat(1000);
    const out = truncateAndRedact(long);
    expect(out.length).toBeLessThanOrEqual(503);
    expect(out.endsWith('...')).toBe(true);
  });

  it('leaves short clean messages unchanged', () => {
    expect(truncateAndRedact('plain error message')).toBe('plain error message');
  });
});

describe('deriveStatusClass (D-C4)', () => {
  it('clientAborted=true returns "disconnect" regardless of httpStatus', () => {
    expect(deriveStatusClass(200, true)).toBe('disconnect');
    expect(deriveStatusClass(500, true)).toBe('disconnect');
  });
  it('200-299 → success', () => {
    expect(deriveStatusClass(200, false)).toBe('success');
    expect(deriveStatusClass(204, false)).toBe('success');
  });
  it('400-499 → client_error', () => {
    expect(deriveStatusClass(400, false)).toBe('client_error');
    expect(deriveStatusClass(404, false)).toBe('client_error');
    expect(deriveStatusClass(429, false)).toBe('client_error');
  });
  it('500+ → server_error', () => {
    expect(deriveStatusClass(500, false)).toBe('server_error');
    expect(deriveStatusClass(502, false)).toBe('server_error');
    expect(deriveStatusClass(504, false)).toBe('server_error');
  });
});

describe('mapErrorToCode (D-D2 taxonomy)', () => {
  it('RegistryUnknownModelError → unknown_model', () => {
    expect(mapErrorToCode(new RegistryUnknownModelError('m', ['a']))).toBe('unknown_model');
  });
  it('BackendSaturatedError → backend_saturated', () => {
    expect(mapErrorToCode(new BackendSaturatedError('ollama', 1000))).toBe('backend_saturated');
  });
  it('CapabilityNotSupportedError → model_capability_mismatch', () => {
    expect(mapErrorToCode(new CapabilityNotSupportedError('m', 'vision'))).toBe(
      'model_capability_mismatch',
    );
  });
  it('InvalidAgentIdError → invalid_request', () => {
    expect(mapErrorToCode(new InvalidAgentIdError('bad'))).toBe('invalid_request');
  });
  it('InvalidToolArgumentsError → invalid_request', () => {
    expect(
      mapErrorToCode(new InvalidToolArgumentsError('tc1', new Error('json'))),
    ).toBe('invalid_request');
  });
  it('InvalidImageUrlError → invalid_request', () => {
    expect(mapErrorToCode(new InvalidImageUrlError('bad'))).toBe('invalid_request');
  });
  it('ImageFetchError → invalid_request', () => {
    expect(
      mapErrorToCode(new ImageFetchError('http_error', 'http err')),
    ).toBe('invalid_request');
  });
  it('APIConnectionTimeoutError → upstream_timeout', () => {
    const err = new APIConnectionTimeoutError({ message: 'timeout' } as never);
    expect(mapErrorToCode(err)).toBe('upstream_timeout');
  });
  it('APIConnectionError → upstream_timeout', () => {
    const err = new APIConnectionError({ message: 'conn' } as never);
    expect(mapErrorToCode(err)).toBe('upstream_timeout');
  });
  it('Error with statusCode 5xx → upstream_5xx', () => {
    const err = Object.assign(new Error('upstream 502'), { statusCode: 502 });
    expect(mapErrorToCode(err)).toBe('upstream_5xx');
  });
  it('default → internal_error', () => {
    expect(mapErrorToCode(new Error('anything'))).toBe('internal_error');
  });
});

describe('makeRecordRequestOutcome — D-D1 row shape + metric observations', () => {
  function makeDeps() {
    const pushed: RequestLogInsert[] = [];
    const fakeBuffered = {
      push: (row: RequestLogInsert) => pushed.push(row),
      drain: async () => {},
      get size() {
        return 0;
      },
    };
    const metrics = makeMetricsRegistry();
    const record = makeRecordRequestOutcome({ metrics, bufferedWriter: fakeBuffered });
    return { record, pushed, metrics };
  }

  it('1. success non-stream openai — row matches D-D1 shape with success/200 + no error fields', async () => {
    const { record, pushed, metrics } = makeDeps();
    const ctx: OutcomeContext = {
      protocol: 'openai',
      route: '/v1/chat/completions',
      backend: 'ollama',
      model: 'llama3.2:3b',
      statusClass: 'success',
      httpStatus: 200,
      durationMs: 412,
      tokensIn: 10,
      tokensOut: 20,
      agentId: 'claude-code:luis',
      requestId: 'req-1',
      timestamp: new Date('2026-05-14T18:00:00Z'),
    };
    record(ctx);
    expect(pushed).toHaveLength(1);
    const row = pushed[0];
    expect(row.protocol).toBe('openai');
    expect(row.route).toBe('/v1/chat/completions');
    expect(row.backend).toBe('ollama');
    expect(row.model).toBe('llama3.2:3b');
    expect(row.status_class).toBe('success');
    expect(row.http_status).toBe(200);
    expect(row.tokens_in).toBe(10);
    expect(row.tokens_out).toBe(20);
    expect(row.ttft_ms).toBeNull();
    expect(row.latency_ms).toBe(412);
    expect(row.error_code).toBeNull();
    expect(row.error_message).toBeNull();
    expect(row.agent_id).toBe('claude-code:luis');
    expect(row.request_id).toBe('req-1');
    expect(row.upstream_message_id).toBeNull();

    // Metric side-effect: router_requests_total incremented.
    const text = await metrics.register.metrics();
    expect(text).toMatch(/router_requests_total\{[^}]*status_class="success"[^}]*\}\s+1/);
  });

  it('2. success stream openai — ttft_ms populated; tokens_in/out counters incremented in both directions', async () => {
    const { record, pushed, metrics } = makeDeps();
    record({
      protocol: 'openai',
      route: '/v1/chat/completions',
      backend: 'ollama',
      model: 'llama3.2:3b',
      statusClass: 'success',
      httpStatus: 200,
      durationMs: 3000,
      ttftMs: 250,
      tokensIn: 50,
      tokensOut: 200,
      requestId: 'req-stream-1',
      timestamp: new Date(),
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].ttft_ms).toBe(250);
    const text = await metrics.register.metrics();
    expect(text).toMatch(/router_tokens_total\{[^}]*direction="input"[^}]*\}\s+50/);
    expect(text).toMatch(/router_tokens_total\{[^}]*direction="output"[^}]*\}\s+200/);
  });

  it('3. anthropic success — protocol=anthropic + upstream_message_id populated', () => {
    const { record, pushed } = makeDeps();
    record({
      protocol: 'anthropic',
      route: '/v1/messages',
      backend: 'ollama',
      model: 'm',
      statusClass: 'success',
      httpStatus: 200,
      durationMs: 100,
      tokensIn: 5,
      tokensOut: 5,
      upstreamMessageId: 'msg_01ARZHHFTW2Z3DBE',
      requestId: 'req-anth-1',
      timestamp: new Date(),
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].protocol).toBe('anthropic');
    expect(pushed[0].upstream_message_id).toBe('msg_01ARZHHFTW2Z3DBE');
  });

  it('4. RegistryUnknownModelError — error_code=unknown_model, status_class=client_error, http_status=404', () => {
    const { record, pushed } = makeDeps();
    record({
      protocol: 'openai',
      route: '/v1/chat/completions',
      backend: 'unknown',
      model: 'no-such',
      statusClass: 'client_error',
      httpStatus: 404,
      durationMs: 5,
      errorCode: 'unknown_model',
      errorMessage: 'Unknown model "no-such"; registered: a, b, c',
      requestId: 'req-err-1',
      timestamp: new Date(),
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].status_class).toBe('client_error');
    expect(pushed[0].http_status).toBe(404);
    expect(pushed[0].error_code).toBe('unknown_model');
    expect(pushed[0].error_message).toContain('Unknown model');
  });

  it('5. error_message is truncated + redacted before write', () => {
    const { record, pushed } = makeDeps();
    record({
      protocol: 'openai',
      route: '/v1/chat/completions',
      backend: 'ollama',
      model: 'm',
      statusClass: 'server_error',
      httpStatus: 500,
      durationMs: 100,
      errorCode: 'internal_error',
      // Pretend an upstream SDK error embedded a bearer token in its message.
      errorMessage: 'upstream returned: Bearer sk-leaked-secret-1234567 expired',
      requestId: 'req-err-2',
      timestamp: new Date(),
    });
    expect(pushed).toHaveLength(1);
    const stored = pushed[0].error_message ?? '';
    expect(stored).not.toContain('sk-leaked-secret-1234567');
    expect(/[Bb]earer\s+\S+/.test(stored)).toBe(false);
  });

  it('6. client-disconnect stream — status_class=disconnect, error_code=client_disconnect, partial tokens_out > 0', () => {
    const { record, pushed } = makeDeps();
    record({
      protocol: 'openai',
      route: '/v1/chat/completions',
      backend: 'ollama',
      model: 'm',
      statusClass: 'disconnect',
      httpStatus: 200,
      durationMs: 750,
      ttftMs: 100,
      tokensIn: 10,
      tokensOut: 47, // partial — client killed mid-stream
      errorCode: 'client_disconnect',
      requestId: 'req-disconnect',
      timestamp: new Date(),
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].status_class).toBe('disconnect');
    expect(pushed[0].error_code).toBe('client_disconnect');
    expect(pushed[0].tokens_out).toBe(47);
  });
});
