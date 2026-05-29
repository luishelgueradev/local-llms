-- Migration 0004: cost_per_agent_daily view (Phase 13 / v0.10.0 — COST-03).
--
-- Per-day, per-agent, per-model breakdown of request cost. Companion to
-- cloud_spend_daily (0001) — that view aggregates ONLY by day for cloud-
-- backend roll-up; this view splits by agent + model so an operator can
-- answer "how much did each agent spend on each model today?".
--
-- Surface for ad-hoc ops queries:
--   docker compose exec postgres psql -U app -d router \
--     -c "SELECT * FROM cost_per_agent_daily LIMIT 30;"
--
-- Columns:
--   day            date_trunc('day', ts)::date — UTC-day buckets
--   agent_id       request_log.agent_id (NULL when no X-Agent-Id header)
--   model          registry display name (alias, not backend_model id)
--   request_count  COUNT(*)
--   cost_cents     SUM(cost_cents) — total per (day, agent, model)
--   tokens_in      SUM(tokens_in)
--   tokens_out     SUM(tokens_out)
--
-- The view filters `WHERE cost_cents IS NOT NULL` so local-only request_log
-- rows (NULL cost) don't dilute the cost roll-up with zero-cost rows. The
-- aggregation result `cost_cents` IS the SUM, not a per-row value — same
-- pattern as cloud_spend_daily's `spend_ms`.
--
-- agent_id stays nullable in the GROUP BY (Postgres groups NULLs into a
-- single bucket) so requests without X-Agent-Id are visible as a NULL row
-- rather than silently dropped — the operator can see "X cents spent by
-- unidentified callers" and trace it back from request_log.
--
-- The view is a thin read-only projection — no materialized table. Mirrors
-- the cloud_spend_daily rationale (single-host scale; materialize later if
-- cloud traffic ever scales to millions/day).
--
-- Idempotent: CREATE OR REPLACE VIEW. Re-running this migration is a no-op.

CREATE OR REPLACE VIEW cost_per_agent_daily AS
SELECT
  date_trunc('day', ts)::date AS day,
  agent_id,
  model,
  COUNT(*)                    AS request_count,
  SUM(cost_cents)             AS cost_cents,
  SUM(tokens_in)              AS tokens_in,
  SUM(tokens_out)             AS tokens_out
FROM request_log
WHERE cost_cents IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1 DESC, agent_id NULLS LAST, model;

COMMENT ON VIEW cost_per_agent_daily IS
  'COST-03 (Phase 13): per-(day, agent_id, model) cost roll-up. Filters request_log rows where cost_cents IS NOT NULL so the agg ignores local-backend zero-cost rows. NULL agent_id is its own bucket (unidentified callers).';
