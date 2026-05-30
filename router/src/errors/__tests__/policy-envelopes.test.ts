/**
 * Phase 14 (v0.11.0 — POL-01 / POL-02 / POL-04): Unit tests for the three new
 * policy error classes and their 9 mapping branches in envelope.ts.
 *
 * Covers D-10 (AllowlistViolationError + CloudNotAllowedError → dual-surface 403),
 * D-16 (InvalidScopedIdError → dual-surface 400), and the log-injection truncation
 * defense (T-14-04).
 *
 * 13 assertion paths total:
 *   Tests 1–4:  error class construction (code, name, message, truncation)
 *   Tests 5–7:  mapToHttpStatus (403, 403, 400)
 *   Tests 8–10: toOpenAIErrorEnvelope (policy_violation×2, invalid_request_error)
 *   Tests 11–13: toAnthropicErrorEnvelope (permission_error×2, invalid_request_error)
 */

import { describe, it, expect } from 'vitest';
import {
  AllowlistViolationError,
  CloudNotAllowedError,
  InvalidScopedIdError,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
  toAnthropicErrorEnvelope,
} from '../envelope.js';

// ── Error class construction ──────────────────────────────────────────────────

describe('AllowlistViolationError — D-10 construction', () => {
  it('Test 1: code, name, message include the model name', () => {
    const err = new AllowlistViolationError('foo');
    expect(err.code).toBe('model_not_in_allowlist');
    expect(err.name).toBe('AllowlistViolationError');
    expect(err.message).toContain('foo');
  });
});

describe('CloudNotAllowedError — D-10 construction', () => {
  it('Test 2: code, name, message include the model name', () => {
    const err = new CloudNotAllowedError('bar');
    expect(err.code).toBe('cloud_not_allowed');
    expect(err.name).toBe('CloudNotAllowedError');
    expect(err.message).toContain('bar');
  });
});

describe('InvalidScopedIdError — D-16 construction', () => {
  it('Test 3: code includes regex and label in the message', () => {
    const err = new InvalidScopedIdError('X-Tenant-ID', 'abc!def');
    expect(err.code).toBe('invalid_scoped_id');
    expect(err.message).toContain('/^[A-Za-z0-9._:-]{1,128}$/');
    expect(err.message).toContain('X-Tenant-ID');
  });

  it('Test 4 (truncation defense — T-14-04): 40-char value truncated to 32 + "..." in message', () => {
    const longValue = 'a'.repeat(40);
    const err = new InvalidScopedIdError('X-Tenant-ID', longValue);
    const truncated = 'a'.repeat(32) + '...';
    expect(err.message).toContain(truncated);
    expect(err.message).not.toContain(longValue);
  });
});

// ── mapToHttpStatus ───────────────────────────────────────────────────────────

describe('mapToHttpStatus — D-10 / D-16 status codes', () => {
  it('Test 5: AllowlistViolationError → 403', () => {
    expect(mapToHttpStatus(new AllowlistViolationError('m'))).toBe(403);
  });

  it('Test 6: CloudNotAllowedError → 403', () => {
    expect(mapToHttpStatus(new CloudNotAllowedError('m'))).toBe(403);
  });

  it('Test 7: InvalidScopedIdError → 400', () => {
    expect(mapToHttpStatus(new InvalidScopedIdError('X-Tenant-ID', 'x'))).toBe(400);
  });
});

// ── toOpenAIErrorEnvelope ─────────────────────────────────────────────────────

describe('toOpenAIErrorEnvelope — D-10 policy_violation envelopes', () => {
  it('Test 8: AllowlistViolationError → policy_violation + model_not_in_allowlist + param=model', () => {
    const result = toOpenAIErrorEnvelope(new AllowlistViolationError('m'));
    expect(result).toMatchObject({
      error: {
        type: 'policy_violation',
        code: 'model_not_in_allowlist',
        param: 'model',
      },
    });
    expect((result as { error: { message: string } }).error.message).toBeTruthy();
  });

  it('Test 9: CloudNotAllowedError → policy_violation + cloud_not_allowed + param=model', () => {
    const result = toOpenAIErrorEnvelope(new CloudNotAllowedError('m'));
    expect(result).toMatchObject({
      error: {
        type: 'policy_violation',
        code: 'cloud_not_allowed',
        param: 'model',
      },
    });
    expect((result as { error: { message: string } }).error.message).toBeTruthy();
  });

  it('Test 10: InvalidScopedIdError → invalid_request_error + invalid_scoped_id + param=headerLabel', () => {
    const result = toOpenAIErrorEnvelope(new InvalidScopedIdError('X-Project-ID', 'x'));
    expect(result).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_scoped_id',
        param: 'X-Project-ID',
      },
    });
    expect((result as { error: { message: string } }).error.message).toBeTruthy();
  });
});

// ── toAnthropicErrorEnvelope ──────────────────────────────────────────────────

describe('toAnthropicErrorEnvelope — D-10 permission_error envelopes', () => {
  it('Test 11: AllowlistViolationError → permission_error', () => {
    const result = toAnthropicErrorEnvelope(new AllowlistViolationError('m'));
    expect(result).toMatchObject({
      type: 'error',
      error: { type: 'permission_error' },
    });
    expect((result as { type: string; error: { message: string } }).error.message).toBeTruthy();
  });

  it('Test 12: CloudNotAllowedError → permission_error', () => {
    const result = toAnthropicErrorEnvelope(new CloudNotAllowedError('m'));
    expect(result).toMatchObject({
      type: 'error',
      error: { type: 'permission_error' },
    });
    expect((result as { type: string; error: { message: string } }).error.message).toBeTruthy();
  });

  it('Test 13: InvalidScopedIdError → invalid_request_error', () => {
    const result = toAnthropicErrorEnvelope(new InvalidScopedIdError('X-Tenant-ID', 'x'));
    expect(result).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    expect((result as { type: string; error: { message: string } }).error.message).toBeTruthy();
  });
});
