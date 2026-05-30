/**
 * Phase 14 (v0.11.0 — POL-01 / POL-02): Policy gate helper (CONTEXT.md D-07/D-08).
 *
 * D-07: Exports one function — `applyPolicyGate(policies, entry, requested_model): void`.
 * D-08: Shared helper vs inline duplication in 5 routes. Fastify preHandler was rejected
 *       because the gate requires the RESOLVED registry entry (route-specific work).
 * D-09 / P8-01 BLOCK: Call AFTER capability gate, BEFORE `opts.breaker.check()`.
 *       Policy violations MUST NOT count as backend failures.
 *
 * T-14-01: `allow.includes()` is case-sensitive — typos surface as 403, not silent passes.
 * T-14-PITFALL-04: Uses strict `=== false`. Negation form (`! cloud_allowed`) is FORBIDDEN —
 *                  it would misfire when `policy` is undefined. Gate test 10 regresses this.
 * T-14-CIRC-01: One-way import — gate.ts → envelope.ts; envelope.ts does NOT import gate.ts.
 */

import { AllowlistViolationError, CloudNotAllowedError } from '../errors/envelope.js';
import type { Registry, ModelEntry } from '../config/registry.js';

/**
 * Applies two policy rules; returns void on pass, throws on violation.
 *
 * Rule 1 — Allowlist (POL-01): if `policies.default.model_allowlist` is non-empty AND
 *   `requested_model` is not in it, throws `AllowlistViolationError`. Empty or absent
 *   allowlist = allow-all (D-04).
 *
 * Rule 2 — Cloud-not-allowed (POL-02): if `entry.backend === 'ollama-cloud'` AND
 *   `entry.policy?.cloud_allowed === false`, throws `CloudNotAllowedError`. Local-backend
 *   entries with cloud_allowed=false are vacuous (never fire, D-05).
 */
export function applyPolicyGate(
  policies: Registry['policies'],
  entry: ModelEntry,
  requested_model: string,
): void {
  // Rule 1: model allowlist. Empty or absent = allow-all (D-04).
  const allow = policies?.default?.model_allowlist ?? [];
  if (allow.length > 0 && !allow.includes(requested_model)) {
    throw new AllowlistViolationError(requested_model);
  }

  // Rule 2: cloud-not-allowed. Strict === false avoids misfiring on undefined (Pitfall 4).
  if (entry.backend === 'ollama-cloud' && entry.policy?.cloud_allowed === false) {
    throw new CloudNotAllowedError(requested_model);
  }
}
