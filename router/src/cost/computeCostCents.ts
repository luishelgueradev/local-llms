// router/src/cost/computeCostCents.ts — Phase 13 (v0.10.0 — COST-01).
//
// Pure cost calculator. Converts (pricing, tokens_in, tokens_out) → cost in cents.
//
// Pricing convention (models.yaml + registry.ts):
//   input_per_1m  = USD dollars per 1,000,000 input tokens
//   output_per_1m = USD dollars per 1,000,000 output tokens
//
// Math derivation (kept here so the formula is auditable):
//   cost_dollars = (tokens_in × input_per_1m + tokens_out × output_per_1m) / 1_000_000
//   cost_cents   = cost_dollars × 100
//                = (tokens_in × input_per_1m + tokens_out × output_per_1m) / 10_000
//
// The result is rounded to 4 decimal places — matches the request_log column
// shape NUMERIC(10,4). Returns the value as a STRING (Drizzle's numeric type
// expects string | null to avoid IEEE-754 precision drift on aggregation),
// formatted with a fixed scale=4.
//
// EMB-H02-equivalent contract for cost: when the model has no pricing block,
// return null. The route then leaves req.computedCostCents undefined → no
// X-Cost-Cents header + cost_cents column NULL in request_log (COST-01).

import type { ModelEntry } from '../config/registry.js';

export interface CostInputs {
  /** Registry entry — only `pricing` is read. */
  entry: Pick<ModelEntry, 'pricing'>;
  tokensIn: number | undefined;
  tokensOut: number | undefined;
}

/**
 * Returns the cost in cents as a string with 4 decimal places, or `null` if
 * the model declares no pricing (local backends typically). When tokens are
 * undefined or zero, returns "0.0000" (cost was zero, not unknown) for a
 * model that DOES have pricing — the distinction matters because the
 * dashboards' `SUM(cost_cents)` treats NULL and 0 differently when paired
 * with `WHERE cost_cents IS NOT NULL` filters.
 */
export function computeCostCents(inputs: CostInputs): string | null {
  const { entry, tokensIn, tokensOut } = inputs;
  if (!entry.pricing) return null;

  const tin = typeof tokensIn === 'number' && Number.isFinite(tokensIn) ? tokensIn : 0;
  const tout = typeof tokensOut === 'number' && Number.isFinite(tokensOut) ? tokensOut : 0;

  const cents =
    (tin * entry.pricing.input_per_1m + tout * entry.pricing.output_per_1m) / 10_000;

  // NUMERIC(10,4) — 4 fractional digits. `toFixed(4)` gives a canonical string
  // representation Drizzle / pg writes verbatim into the numeric column.
  return cents.toFixed(4);
}
