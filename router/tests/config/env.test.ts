/**
 * Plan 08-04 (CLOUD-03, D-B2) — env-schema gates for the circuit breaker
 * tunables (CIRCUIT_FAILURE_THRESHOLD / CIRCUIT_WINDOW_MS / CIRCUIT_COOLDOWN_MS).
 *
 * Verifies:
 *   - defaults are applied when env vars are absent (5 / 30000 / 60000)
 *   - operator overrides via env are honored (coerced from string to int)
 *   - out-of-range values are rejected (negative / zero / below-min) — ZodError
 *
 * The schema-level gate is the only protection: env.ts is the single trust
 * boundary between operator-supplied env strings and the breaker's numeric
 * config. Out-of-range values must fail loudly at boot.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

// Minimal viable env that satisfies the other required fields (bearer token,
// DB URL, Valkey password). The CIRCUIT_* fields are layered on top per test.
const baseEnv: NodeJS.ProcessEnv = {
  ROUTER_BEARER_TOKEN: 'x'.repeat(16),
  ROUTER_DATABASE_URL: 'postgres://router:pw@db:5432/router',
  ROUTER_VALKEY_PASSWORD: 'valkey-pw-1234',
};

describe('EnvSchema — CIRCUIT_* defaults + overrides (Plan 08-04)', () => {
  it('defaults: CIRCUIT_FAILURE_THRESHOLD=5, CIRCUIT_WINDOW_MS=30000, CIRCUIT_COOLDOWN_MS=60000', () => {
    const env = loadEnv(baseEnv);
    expect(env.CIRCUIT_FAILURE_THRESHOLD).toBe(5);
    expect(env.CIRCUIT_WINDOW_MS).toBe(30_000);
    expect(env.CIRCUIT_COOLDOWN_MS).toBe(60_000);
  });

  it('accepts operator overrides via env (string -> int coercion)', () => {
    const env = loadEnv({
      ...baseEnv,
      CIRCUIT_FAILURE_THRESHOLD: '10',
      CIRCUIT_WINDOW_MS: '45000',
      CIRCUIT_COOLDOWN_MS: '120000',
    });
    expect(env.CIRCUIT_FAILURE_THRESHOLD).toBe(10);
    expect(env.CIRCUIT_WINDOW_MS).toBe(45_000);
    expect(env.CIRCUIT_COOLDOWN_MS).toBe(120_000);
  });

  it('rejects CIRCUIT_FAILURE_THRESHOLD=0 with ZodError (min=1)', () => {
    expect(() => loadEnv({ ...baseEnv, CIRCUIT_FAILURE_THRESHOLD: '0' })).toThrow();
  });

  it('rejects CIRCUIT_WINDOW_MS below 1000 with ZodError', () => {
    expect(() => loadEnv({ ...baseEnv, CIRCUIT_WINDOW_MS: '500' })).toThrow();
  });

  it('rejects CIRCUIT_COOLDOWN_MS below 1000 with ZodError', () => {
    expect(() => loadEnv({ ...baseEnv, CIRCUIT_COOLDOWN_MS: '999' })).toThrow();
  });

  it('rejects negative CIRCUIT_FAILURE_THRESHOLD with ZodError', () => {
    expect(() => loadEnv({ ...baseEnv, CIRCUIT_FAILURE_THRESHOLD: '-1' })).toThrow();
  });
});
