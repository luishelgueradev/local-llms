/**
 * Phase 15 (v0.11.0 — MCPS-01..06 / CONTEXT.md D-09): Shared preflight pipeline.
 *
 * applyPreflight consolidates the trio that today lives inline in five HTTP
 * routes (chat-completions.ts:161/225/331, messages.ts, embeddings.ts,
 * rerank.ts, responses.ts). It will ALSO be called from every MCP tool
 * handler in Wave 4 so policy + breaker semantics are identical across HTTP
 * and MCP surfaces.
 *
 * Pipeline (fixed order — must not be reordered):
 *   1. registry.resolve(model)       — throws RegistryUnknownModelError
 *   2. applyPolicyGate(...)          — throws AllowlistViolationError / CloudNotAllowedError
 *   3. breaker.check(entry.backend)  — RETURNS state (does NOT throw)
 *
 * Phase 14 invariants preserved verbatim:
 *   - POL-05 (gate-before-breaker): policy violations short-circuit before the
 *     breaker is touched, so the breaker fail counter is NEVER mutated by a 403.
 *     Enforced structurally — step 3 only runs if step 2 returned cleanly.
 *
 * Option A sentinel return (RESEARCH §Pattern 5):
 *   The breaker's state is RETURNED in `breakerState` rather than thrown.
 *   Rationale: HTTP callers must stamp `Retry-After` on the reply BEFORE
 *   raising `BreakerOpenError` (so the centralized error handler's envelope
 *   ships with the back-off hint). MCP tool handlers throw without setting
 *   any header. Returning the sentinel keeps the helper protocol-agnostic
 *   and lets each caller add its own context to `BreakerOpenError`
 *   (including its own `cooldownSec`).
 *
 * Protocol-agnosticism: this module has NO imports from `router/src/mcp/` and
 * NO imports from `router/src/routes/`. It is consumed by both surfaces.
 */

import type { RegistryStore, ModelEntry } from '../config/registry.js';
import type { CircuitBreaker, BreakerState } from '../resilience/circuitBreaker.js';
import { applyPolicyGate } from '../policy/gate.js';

export interface ApplyPreflightOpts {
  registry: RegistryStore;
  breaker: CircuitBreaker;
}

export interface ApplyPreflightResult {
  entry: ModelEntry;
  breakerState: BreakerState;
}

/**
 * Run the canonical preflight pipeline for `requested_model`.
 *
 * @throws RegistryUnknownModelError when the model is not in the registry.
 * @throws AllowlistViolationError when policies.default.model_allowlist denies it.
 * @throws CloudNotAllowedError when the resolved cloud entry's policy.cloud_allowed=false.
 *
 * Does NOT throw on `breakerState === 'open'` — caller decides how to react.
 */
export async function applyPreflight(
  requested_model: string,
  opts: ApplyPreflightOpts,
): Promise<ApplyPreflightResult> {
  // Snapshot taken once so the gate sees the same registry as resolve(); a
  // concurrent hot-reload between these lines would otherwise risk reading
  // entry from snapshot N and policies from snapshot N+1.
  const snapshot = opts.registry.get();

  // Step 1: resolve. Lets RegistryUnknownModelError propagate verbatim so the
  // centralized error handler maps it to 404 (envelope.ts mapToHttpStatus).
  const entry = opts.registry.resolve(requested_model);

  // Step 2: policy gate. Lets AllowlistViolationError / CloudNotAllowedError
  // propagate verbatim so the centralized error handler maps each to 403.
  // POL-05 invariant: this MUST execute before step 3 — a thrown policy error
  // short-circuits before the breaker counter could ever be mutated.
  applyPolicyGate(snapshot.policies, entry, requested_model);

  // Step 3: breaker check. RETURN the state via the sentinel; do NOT throw.
  const breakerResult = await opts.breaker.check(entry.backend);
  return { entry, breakerState: breakerResult.state };
}
