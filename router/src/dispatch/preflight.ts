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
import { resolveAlias } from '../config/deprecation.js';
import type { DeprecationMeta } from '../config/deprecation.js';

export interface ApplyPreflightOpts {
  registry: RegistryStore;
  breaker: CircuitBreaker;
}

export interface ApplyPreflightResult {
  entry: ModelEntry;
  breakerState: BreakerState;
  /**
   * Phase 20 (v0.12.0 — CAT-04 / D-03 LOCKED): populated ONLY when the
   * `requested_model` was a deprecated alias that was redirected to a canonical
   * target via the operator-declared `deprecated_aliases` map. Route handlers
   * consume this to:
   *   1. Stamp the `X-Deprecated-Alias: <new_name>` response header.
   *   2. Emit a structured pino warn log (event='deprecated_alias_used').
   *   3. Increment `router_deprecated_alias_used_total{old_name, new_name}`.
   *
   * Undefined for the canonical-name happy path AND for unknown aliases
   * (unknown aliases pass through resolveAlias unchanged; downstream
   * registry.resolve() raises RegistryUnknownModelError as usual).
   */
  deprecation_meta?: DeprecationMeta;
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

  // Phase 20 (v0.12.0 — CAT-04 / D-03 LOCKED): operator-declared deprecation
  // map intercepts BEFORE registry.resolve(). If the requested_model is in
  // `deprecated_aliases`, the canonical target is what we actually dispatch
  // against; the deprecation_meta rides through to the route handler so it
  // can stamp the X-Deprecated-Alias header + warn log + increment the
  // counter. Unknown / non-deprecated aliases pass through unchanged
  // (canonical === requested_model, deprecation_meta === undefined).
  //
  // Composition with Wave 0 (CAT-01): a disabled entry whose name is also in
  // the deprecation map RESOLVES at dispatch time (via the canonical target)
  // even though it is invisible at /v1/models. This intentional asymmetry
  // gives consumers a grace window without auto-enabling the disabled stub.
  // See 20-CONTEXT.md §6.
  const aliasResult = resolveAlias(requested_model, snapshot);
  const canonical = aliasResult.canonical;

  // Step 1: resolve the CANONICAL alias. RegistryUnknownModelError still
  // propagates verbatim for genuinely-unknown aliases (resolveAlias's
  // pass-through case → registry.resolve throws → centralized handler 404).
  // For redirected aliases, the canonical target MUST exist + be enabled (the
  // RegistrySchema.superRefine cross-field validation rejects YAML where a
  // deprecation target is missing or disabled).
  const entry = opts.registry.resolve(canonical);

  // Step 2: policy gate runs against the canonical target's policy block (NOT
  // the deprecated alias's policy — once redirected, the deprecated entry's
  // policy is moot). The third argument to applyPolicyGate is the model name
  // used for error messages; passing the canonical so the AllowlistViolationError
  // / CloudNotAllowedError messages reflect the actual dispatched alias.
  applyPolicyGate(snapshot.policies, entry, canonical);

  // Step 3: breaker check. RETURN the state via the sentinel; do NOT throw.
  const breakerResult = await opts.breaker.check(entry.backend);
  return {
    entry,
    breakerState: breakerResult.state,
    deprecation_meta: aliasResult.deprecation_meta,
  };
}
