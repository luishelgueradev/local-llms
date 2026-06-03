/**
 * Phase 20 (v0.12.0 — CAT-04 / D-02 + D-03): deprecation alias resolver.
 *
 * Provides operator-configurable backward-compat for renamed model aliases.
 * Consumers that call a deprecated alias (e.g. `qwen2.5-7b-instruct-q4km`)
 * get transparently routed to the canonical target (e.g. `chat-local`) while
 * the route layer stamps an `X-Deprecated-Alias` response header, emits a
 * structured pino warn log, and increments the
 * `router_deprecated_alias_used_total` Counter.
 *
 * Schema lives at the TOP LEVEL of `models.yaml` (not per-entry — D-03 LOCKED):
 *
 * ```yaml
 * deprecated_aliases:
 *   qwen2.5-7b-instruct-q4km:
 *     target: chat-local
 *     deprecated_since: v0.12.0
 *     removal_target: v0.13.0
 * ```
 *
 * Composition with Wave 0 (CAT-01): a disabled entry whose name is ALSO in
 * the deprecation map will resolve at dispatch time even though it is invisible
 * at the `/v1/models` surface. This asymmetry is intentional and documented in
 * 20-CONTEXT.md §6 — it gives n8n/Unsloth/artiscrapper consumers a 30+ day
 * grace window to update while still pushing them toward the canonical alias
 * via `/v1/models` discovery.
 *
 * D-03 LOCKED: removal target (`removal_target: v0.13.0`) is documented but
 * NOT enforced — the operator decides when to actually break by editing
 * models.yaml. The router never auto-removes entries.
 *
 * POL-06 invariant: the metric introduced for this surface
 * (`router_deprecated_alias_used_total`) uses `old_name` + `new_name` labels,
 * NOT `*_id` suffixes. Enforced by `scripts/check-prometheus-cardinality.ts`.
 */

import type { Registry } from './registry.js';

/**
 * Metadata returned by resolveAlias when a deprecated alias was hit. Route
 * handlers consume this to stamp the response header, emit the warn log, and
 * increment the counter.
 */
export interface DeprecationMeta {
  /** The alias the consumer called (deprecated). Becomes the `old_name` metric label. */
  old_name: string;
  /** The canonical target the dispatch actually resolved to. Becomes the `new_name` metric label AND the `X-Deprecated-Alias` header value. */
  new_name: string;
  /** Version when the deprecation took effect (informational; from models.yaml). */
  deprecated_since: string;
  /** Version when the operator intends to remove the alias (informational; NOT enforced). */
  removal_target: string;
}

/**
 * Operator-declared deprecation map shape. Lives at top-level of models.yaml
 * under the `deprecated_aliases:` block. Empty / absent = no deprecation
 * routing (Wave 3 ships an empty default — infrastructure is preventive for
 * future renames; v0.12.0 has zero entries declared per D-02 LOCKED: no
 * renames in this milestone).
 */
export type DeprecationMap = Record<string, {
  target: string;
  deprecated_since: string;
  removal_target: string;
}>;

/**
 * Result returned by resolveAlias. When the input was NOT a deprecated alias,
 * `canonical === input` and `deprecation_meta === undefined`. When the input
 * WAS deprecated, `canonical` is the operator-declared target and
 * `deprecation_meta` carries the labels/header value/log fields.
 */
export interface ResolveAliasResult {
  /** The canonical alias to actually dispatch against. Equals input when no deprecation entry hits. */
  canonical: string;
  /** Populated only when the input was a deprecated alias. */
  deprecation_meta: DeprecationMeta | undefined;
}

/**
 * Pure function — given an alias and a registry snapshot, return the canonical
 * alias to dispatch against plus optional deprecation metadata for the route
 * layer to surface (header + log + metric).
 *
 * Does NOT validate that `canonical` resolves at the registry — that is the
 * caller's responsibility (the canonical target SHOULD exist by virtue of the
 * cross-field validation in RegistrySchema.superRefine, but defensive code
 * paths in applyPreflight still call registry.resolve() afterward).
 *
 * Unknown aliases (not in the registry, not in the deprecation map) pass
 * through unchanged — the downstream registry.resolve() will throw
 * RegistryUnknownModelError as usual.
 */
export function resolveAlias(alias: string, registry: Registry): ResolveAliasResult {
  const dep = registry.deprecated_aliases?.[alias];
  if (!dep) {
    return { canonical: alias, deprecation_meta: undefined };
  }
  return {
    canonical: dep.target,
    deprecation_meta: {
      old_name: alias,
      new_name: dep.target,
      deprecated_since: dep.deprecated_since,
      removal_target: dep.removal_target,
    },
  };
}
