-- Migration 0002: add request_log.idempotency_key (Phase 8 Plan 07 / 08-REVIEW CR-01).
--
-- The Idempotency-Key multiplexer (Plan 08-07) was wired at the route layer
-- but the corresponding request_log column was never added to the schema.
-- Smoke tests + the README documented `WHERE idempotency_key = '...'` dedup
-- verification queries against a column that did not exist. This migration
-- closes the gap.
--
-- Column shape:
--   idempotency_key  text NULLABLE — the OPTIONAL Idempotency-Key header
--                                    value, validated against the regex
--                                    /^[A-Za-z0-9._:-]{1,256}$/ at ingress.
--                                    Populated for BOTH leader and follower
--                                    rows by the multiplexer-aware wiring in
--                                    chat-completions / messages / embeddings.
--
-- Index shape:
--   idx_request_log_idempotency_key — partial btree on (idempotency_key)
--                                     WHERE idempotency_key IS NOT NULL.
--                                     The vast majority of requests don't
--                                     carry the header; a partial index keeps
--                                     the on-disk size proportional to the
--                                     subset of rows that actually use it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS so a
-- re-run is a no-op (parity with 0001_cloud_spend_daily.sql conventions).
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_request_log_idempotency_key"
  ON "request_log" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
