/**
 * Phase 14 (v0.11.0 — POL-01 / POL-02): Unit tests for applyPolicyGate().
 *
 * 10-case matrix covering all branches of the two hard-coded rules:
 *   (1) Allowlist check   — fires when model_allowlist non-empty AND requested_model not in it
 *   (2) Cloud-not-allowed — fires when backend==='ollama-cloud' AND policy.cloud_allowed===false
 *
 * Tests 1–2:  allow-all paths (no policies block, empty allowlist)
 * Tests 3–4:  allowlist hit/miss
 * Tests 5–6:  cloud_allowed missing/true (no throw)
 * Test  7:    cloud_allowed=false on cloud entry (throw CloudNotAllowedError)
 * Test  8:    cloud_allowed=false on LOCAL entry — vacuous, no throw (D-05)
 * Test  9:    both violations possible — allowlist runs first (AllowlistViolationError wins)
 * Test  10:   Pitfall 4 strict-equality — policy:undefined on cloud entry must NOT throw
 */

import { describe, it, expect } from 'vitest';
import { applyPolicyGate } from '../gate.js';
import { AllowlistViolationError, CloudNotAllowedError } from '../../errors/envelope.js';
import type { ModelEntry, Registry } from '../../config/registry.js';

// ── Minimal ModelEntry fixture factory ───────────────────────────────────────
// ModelEntry has many Zod-required fields (capabilities, vram_budget_gb, backend_url, etc.)
// that are irrelevant to the gate logic. We cast minimal shapes via `as unknown as ModelEntry`
// to keep test fixtures focused on the fields the gate actually reads (backend + policy).
// The cast is safe here because applyPolicyGate only reads `entry.backend` and
// `entry.policy?.cloud_allowed` — Zod-required fields are never accessed in the helper.

function makeEntry(
  backend: string,
  policy?: { cloud_allowed: boolean },
  name = 'test-model',
): ModelEntry {
  return {
    name,
    backend,
    policy,
  } as unknown as ModelEntry;
}

// ── Test matrix ───────────────────────────────────────────────────────────────

describe('applyPolicyGate — allowlist rule (POL-01)', () => {
  it('Test 1: no policies block → allow-all, no throw', () => {
    const entry = makeEntry('ollama', undefined, 'chat-local');
    expect(() => applyPolicyGate(undefined, entry, 'chat-local')).not.toThrow();
  });

  it('Test 2: empty allowlist → allow-all, no throw', () => {
    const policies: Registry['policies'] = { default: { model_allowlist: [] } };
    const entry = makeEntry('ollama', undefined, 'any');
    expect(() => applyPolicyGate(policies, entry, 'any')).not.toThrow();
  });

  it('Test 3: non-empty allowlist, requested_model IS in it → no throw', () => {
    const policies: Registry['policies'] = { default: { model_allowlist: ['chat-local'] } };
    const entry = makeEntry('ollama', undefined, 'chat-local');
    expect(() => applyPolicyGate(policies, entry, 'chat-local')).not.toThrow();
  });

  it('Test 4: non-empty allowlist, requested_model NOT in it → throws AllowlistViolationError', () => {
    const policies: Registry['policies'] = { default: { model_allowlist: ['chat-local'] } };
    const entry = makeEntry('ollama-cloud', undefined, 'big-cloud');
    expect(() => applyPolicyGate(policies, entry, 'big-cloud')).toThrow(AllowlistViolationError);
    try {
      applyPolicyGate(policies, entry, 'big-cloud');
    } catch (err) {
      expect(err).toBeInstanceOf(AllowlistViolationError);
      expect((err as AllowlistViolationError).code).toBe('model_not_in_allowlist');
      expect((err as AllowlistViolationError).modelName).toBe('big-cloud');
    }
  });
});

describe('applyPolicyGate — cloud-not-allowed rule (POL-02)', () => {
  it('Test 5: cloud entry, policy undefined (defaults to allow) → no throw', () => {
    const entry = makeEntry('ollama-cloud', undefined, 'big-cloud');
    expect(() => applyPolicyGate(undefined, entry, 'big-cloud')).not.toThrow();
  });

  it('Test 6: cloud entry, cloud_allowed=true → no throw', () => {
    const entry = makeEntry('ollama-cloud', { cloud_allowed: true }, 'big-cloud');
    expect(() => applyPolicyGate(undefined, entry, 'big-cloud')).not.toThrow();
  });

  it('Test 7: cloud entry, cloud_allowed=false → throws CloudNotAllowedError', () => {
    const entry = makeEntry('ollama-cloud', { cloud_allowed: false }, 'big-cloud');
    expect(() => applyPolicyGate(undefined, entry, 'big-cloud')).toThrow(CloudNotAllowedError);
    try {
      applyPolicyGate(undefined, entry, 'big-cloud');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudNotAllowedError);
      expect((err as CloudNotAllowedError).code).toBe('cloud_not_allowed');
      expect((err as CloudNotAllowedError).modelName).toBe('big-cloud');
    }
  });

  it('Test 8: LOCAL entry with cloud_allowed=false → vacuous, no throw (D-05)', () => {
    // Local-backend entries can legally set cloud_allowed:false; the gate only fires
    // for backend==='ollama-cloud'. A false on a local entry is vacuous (D-05).
    const entry = makeEntry('ollama', { cloud_allowed: false }, 'chat-local');
    expect(() => applyPolicyGate(undefined, entry, 'chat-local')).not.toThrow();
  });
});

describe('applyPolicyGate — rule precedence + Pitfall 4', () => {
  it('Test 9: both violations possible — allowlist check runs FIRST (AllowlistViolationError wins)', () => {
    // model_allowlist does not include 'big-cloud', AND entry has cloud_allowed:false.
    // The allowlist check fires first so AllowlistViolationError (not CloudNotAllowedError) is thrown.
    const policies: Registry['policies'] = { default: { model_allowlist: ['chat-local'] } };
    const entry = makeEntry('ollama-cloud', { cloud_allowed: false }, 'big-cloud');
    expect(() => applyPolicyGate(policies, entry, 'big-cloud')).toThrow(AllowlistViolationError);
  });

  it('Test 10 (Pitfall 4 strict-equality): policy:undefined on cloud entry → no throw', () => {
    // Verifies `entry.policy?.cloud_allowed === false` (not `!entry.policy?.cloud_allowed`).
    // When policy is undefined, `undefined === false` is false → no throw.
    // The forbidden form `!entry.policy?.cloud_allowed` would incorrectly fire here
    // because `!undefined` is `true`.
    const entry = makeEntry('ollama-cloud', undefined, 'big-cloud');
    expect(() => applyPolicyGate(undefined, entry, 'big-cloud')).not.toThrow();
  });
});
