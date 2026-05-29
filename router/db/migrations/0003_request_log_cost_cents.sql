-- Migration 0003: add request_log.cost_cents (Phase 13 / v0.10.0 — COST-01).
--
-- Per-request cost in cents, NULL for local backends (no pricing declared in
-- models.yaml) and a NUMERIC(10,4) value for cloud backends. NUMERIC instead of
-- integer-cents-only because cents at 4 decimal places is the natural unit for
-- per-token costs (e.g. 100 tokens at $0.10/1M = 0.001 cents = 0.0010 in this
-- column). The 10-digit precision caps the per-request value at $99,999,999.99
-- cents — astronomically beyond any single request.
--
-- Drizzle's `numeric()` maps to TypeScript `string | null` to preserve the
-- exact decimal representation (avoids IEEE-754 drift on aggregation). The
-- computeCostCents helper produces the string via `.toFixed(4)`.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — re-runs are no-ops.

ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "cost_cents" numeric(10, 4);

COMMENT ON COLUMN "request_log"."cost_cents" IS
  'COST-01 (Phase 13): per-request cost in cents. NULL for requests against models with no `pricing` declared in models.yaml (typically local backends). Computed by computeCostCents() from (tokens_in × input_per_1m + tokens_out × output_per_1m) / 10_000.';
