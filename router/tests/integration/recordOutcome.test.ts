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
  type StatusClass,
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
  mapToHttpStatus,
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
    expect(
      mapErrorToCode(new InvalidImageUrlError('https://example.com/x.png', 'malformed_url')),
    ).toBe('invalid_request');
  });
  it('ImageFetchError → invalid_request', () => {
    expect(
      mapErrorToCode(
        new ImageFetchError('https://example.com/x.png', 'http_error', 'http err'),
      ),
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

// Module-scope `makeDeps()` so the coverage-matrix describe at the END of the
// file (Task 6 of Plan 05-05) can reuse the same fakeBuffered/metrics shape
// without inlining a parallel construction. Lifted from inside the original
// `describe('makeRecordRequestOutcome — D-D1 row shape + metric observations')`
// block so vitest's describe-time scope can see it. The original-callsite
// describes still reference this helper directly (see the destructure on the
// first line of each `it(...)` body below).
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

describe('makeRecordRequestOutcome — D-D1 row shape + metric observations', () => {

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

// ─── Plan 05-05 Task 6: coverage matrix (regression gate for CR-02 / CR-03) ──
//
// Table-driven assertion that every typed error class produces the expected
// (status_class, error_code, http_status) triple AND that error_message stays
// non-null + post-redaction (no 'Bearer ' substring) after the
// makeRecordRequestOutcome → bufferedWriter.push pipeline. This is the future
// regression gate for both CR-02 (which only tests one error class per route)
// and CR-03 (same), AND for any new error class added to errors/envelope.ts —
// any drift in mapToHttpStatus / mapErrorToCode will surface here BEFORE it
// silently regresses request_log audit fidelity.
//
// The matrix omits InvalidToolArgumentsError / InvalidImageUrlError /
// ImageFetchError because those have non-trivial constructors that are awkward
// to invoke in a table; the existing per-error `it(...)` cases in the
// `describe('mapErrorToCode (D-D2 taxonomy)', ...)` block above already cover
// them individually.
describe('coverage matrix — every typed error class produces expected status_class + error_code (regression gate for CR-02 / CR-03)', () => {
  interface MatrixCase {
    name: string;
    err: Error;
    expectedStatusClass: StatusClass;
    expectedErrorCode: string;
    expectedHttpStatus: number;
  }

  const cases: MatrixCase[] = [
    {
      name: 'RegistryUnknownModelError',
      err: new RegistryUnknownModelError('foo', ['bar']),
      expectedStatusClass: 'client_error',
      expectedErrorCode: 'unknown_model',
      expectedHttpStatus: 404,
    },
    {
      name: 'BackendSaturatedError',
      err: new BackendSaturatedError('ollama', 30_000),
      expectedStatusClass: 'client_error',
      expectedErrorCode: 'backend_saturated',
      expectedHttpStatus: 429,
    },
    {
      name: 'CapabilityNotSupportedError(vision)',
      err: new CapabilityNotSupportedError('llama-3-7b', 'vision'),
      expectedStatusClass: 'client_error',
      expectedErrorCode: 'model_capability_mismatch',
      expectedHttpStatus: 400,
    },
    {
      name: 'InvalidAgentIdError',
      err: new InvalidAgentIdError('weird;value'),
      expectedStatusClass: 'client_error',
      expectedErrorCode: 'invalid_request',
      expectedHttpStatus: 400,
    },
    {
      name: 'APIConnectionError',
      // Seeded message contains 'Bearer abc123' so the redaction assertion
      // below proves the truncateAndRedact path stripped it.
      err: new APIConnectionError({
        message: 'connect ECONNREFUSED Bearer abc123',
        cause: new Error('ECONNREFUSED'),
      } as never),
      expectedStatusClass: 'server_error',
      expectedErrorCode: 'upstream_timeout',
      expectedHttpStatus: 502,
    },
    {
      name: 'APIConnectionTimeoutError',
      err: new APIConnectionTimeoutError({ message: 'connect ETIMEDOUT' } as never),
      expectedStatusClass: 'server_error',
      expectedErrorCode: 'upstream_timeout',
      expectedHttpStatus: 504,
    },
    {
      name: 'plain Error with statusCode 5xx',
      err: Object.assign(new Error('upstream bad gateway'), { statusCode: 502 }),
      expectedStatusClass: 'server_error',
      expectedErrorCode: 'upstream_5xx',
      // mapToHttpStatus only special-cases statusCode === 400; 5xx falls
      // through to the default 500. mapErrorToCode independently recognizes
      // statusCode 5xx → 'upstream_5xx'. The matrix asserts both contracts
      // separately so a future widening of mapToHttpStatus to honor 5xx
      // statusCode hints surfaces here as a clear failure.
      expectedHttpStatus: 500,
    },
    {
      name: 'default Error',
      err: new Error('boom'),
      expectedStatusClass: 'server_error',
      expectedErrorCode: 'internal_error',
      expectedHttpStatus: 500,
    },
  ];

  it.each(cases)(
    '$name → status_class=$expectedStatusClass + error_code=$expectedErrorCode + http_status=$expectedHttpStatus',
    ({ name, err, expectedStatusClass, expectedErrorCode, expectedHttpStatus }) => {
      const { record, pushed } = makeDeps();

      // Step 1: assert the mapToHttpStatus contract for this error class —
      // catches regressions in errors/envelope.ts BEFORE the status_class
      // assertion runs (so a status mapping drift surfaces with a clear name).
      const httpStatus = mapToHttpStatus(err);
      expect(httpStatus).toBe(expectedHttpStatus);

      // Step 2: build the OutcomeContext from the case row; non-error fields
      // are fixed values per the plan spec.
      const ctx: OutcomeContext = {
        protocol: 'openai',
        route: '/v1/chat/completions',
        backend: 'ollama',
        model: 'llama-3-7b',
        statusClass: deriveStatusClass(httpStatus, false),
        httpStatus,
        durationMs: 100,
        errorCode: mapErrorToCode(err),
        errorMessage: err.message,
        agentId: 'claude-code:cov',
        requestId: `req-cov-${name}`,
        timestamp: new Date(),
      };

      // Step 3: invoke record() and assert the row landed.
      record(ctx);
      expect(pushed.length).toBe(1);
      expect(pushed[0].status_class).toBe(expectedStatusClass);
      expect(pushed[0].error_code).toBe(expectedErrorCode);
      expect(pushed[0].http_status).toBe(expectedHttpStatus);

      // Step 4: D-D3 redaction gate — the seeded 'Bearer abc123' substring on
      // APIConnectionError must be stripped post-write. Other rows whose
      // seeded message does not contain 'Bearer' trivially pass this check.
      expect(pushed[0].error_message).not.toBeNull();
      expect(pushed[0].error_message).not.toContain('Bearer ');
    },
  );
});
