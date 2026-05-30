-- Migration 0005: request_log scoped-ID columns + workload_class
--   (Phase 14 / v0.11.0 — POL-03/POL-04, migration filename per D-22,
--    columns include workload_class per D-14).
--
-- Adds three nullable TEXT columns to request_log for multi-tenant tracing:
--
--   tenant_id      Source header: X-Tenant-ID
--                  Validation regex: /^[A-Za-z0-9._:-]{1,128}$/  (shared with X-Agent-Id per D-15)
--                  Invalid header → 400 InvalidScopedIdError (D-16)
--                  Missing header → NULL (D-17)
--
--   project_id     Source header: X-Project-ID
--                  Validation regex: /^[A-Za-z0-9._:-]{1,128}$/  (shared with X-Agent-Id per D-15)
--                  Invalid header → 400 InvalidScopedIdError (D-16)
--                  Missing header → NULL (D-17)
--
--   workload_class Source header: X-Workload-Class
--                  Validation regex: /^[A-Za-z0-9._-]{1,64}$/, normalized to lowercase (D-11)
--                  Invalid header → silent NULL — opaque metadata, not operationally load-bearing (D-12)
--                  Missing header → NULL (D-13)
--
-- NO new indexes (D-24): existing (ts DESC), (agent_id, ts DESC), status_class
-- indexes suffice. Add (tenant_id, ts DESC) in a future migration if query
-- plans demand it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — re-running this migration is a no-op.
-- Mirrors the 0002_request_log_idempotency_key.sql precedent.

ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "workload_class" text;

COMMENT ON COLUMN "request_log"."tenant_id" IS
  'POL-04 (Phase 14): tenant scoping header X-Tenant-ID. Regex /^[A-Za-z0-9._:-]{1,128}$/. Invalid → 400; missing → NULL.';
COMMENT ON COLUMN "request_log"."project_id" IS
  'POL-04 (Phase 14): project scoping header X-Project-ID. Regex /^[A-Za-z0-9._:-]{1,128}$/. Invalid → 400; missing → NULL.';
COMMENT ON COLUMN "request_log"."workload_class" IS
  'POL-03 (Phase 14): opaque workload metadata from X-Workload-Class. Regex /^[A-Za-z0-9._-]{1,64}$/, lowercased. Invalid → silent NULL (D-12). No routing impact (Frame-04).';
