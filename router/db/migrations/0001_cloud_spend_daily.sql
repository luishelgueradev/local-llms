-- Migration 0001: cloud_spend_daily view (Plan 08-08 / CLOUD-05 / D-C3).
--
-- Per-day breakdown of cloud-backend request activity. Surface for ad-hoc
-- ops queries:
--   docker compose exec postgres psql -U app -d router \
--     -c "SELECT * FROM cloud_spend_daily LIMIT 30;"
-- (D-C4 — no HTTP admin endpoint; psql is the canonical query path.)
--
-- Columns:
--   day                  date_trunc('day', ts) — UTC-day buckets
--   request_count        COUNT(*) — total cloud-backed request_log rows
--   spend_ms             SUM(latency_ms) — D-C3 cost-proxy metric
--                        (generation_duration_ms proxy: latency_ms includes
--                        the full request lifecycle, which is what Ollama
--                        Cloud bills GPU-time against; USD conversion is
--                        COST-01 — explicit v2 backlog).
--   distinct_generations COUNT(DISTINCT upstream_message_id) — collapses
--                        the N+1 follower retries from Plan 08-07's
--                        idempotency multiplexer to 1 (followers share the
--                        leader's upstream_message_id by design). The N+1
--                        rows STILL contribute to spend_ms via their
--                        latency_ms, so distinct_generations is the better
--                        "unique billable cost units" signal.
--   avg_latency_ms       AVG(latency_ms)::int — quick eyeballable per-day
--                        average; useful when scanning the view by hand.
--
-- The view filters to backend = 'ollama-cloud' so local Ollama + llama.cpp +
-- vLLM rows are excluded. The Phase 2 OllamaCloudAdapter (Plan 08-02) emits
-- backend='ollama-cloud' to request_log via the existing recordRequestOutcome
-- path (Phase 5 D-C6).
--
-- The view is a thin read-only projection — no materialized table. With
-- single-operator traffic patterns (tens-to-hundreds of cloud rows per day),
-- the live aggregation is cheaper than maintaining a materialized variant.
-- If cloud traffic ever scales to millions/day, swapping to a materialized
-- view + refresh schedule is a one-line follow-up.
--
-- Idempotent: CREATE OR REPLACE VIEW. Re-running this migration is a no-op
-- (Plan 08-08 Test 5).

CREATE OR REPLACE VIEW cloud_spend_daily AS
SELECT
  date_trunc('day', ts)                AS day,
  COUNT(*)                             AS request_count,
  SUM(latency_ms)                      AS spend_ms,
  COUNT(DISTINCT upstream_message_id)  AS distinct_generations,
  AVG(latency_ms)::int                 AS avg_latency_ms
FROM request_log
WHERE backend = 'ollama-cloud'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW cloud_spend_daily IS
  'CLOUD-05 (Plan 08-08): per-day cloud-backend request stats. spend_ms = SUM(latency_ms) = generation_duration_ms proxy. distinct_generations = COUNT(DISTINCT upstream_message_id) = unique billable units (collapses Plan 08-07 follower retries).';
