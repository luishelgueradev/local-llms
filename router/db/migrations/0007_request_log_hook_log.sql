-- Migration 0007: request_log.hook_log JSONB column
--   (Phase 18 / v0.11.0 — RETR-04, P5-05, P9-01 BLOCK indivisible-tuple invariant).
-- Adds a nullable JSONB column to request_log for the pre-completion hook audit trail.
-- Schema-by-convention: shape documented in router/src/hooks/pre-completion.ts HookLogEntry[]
-- (lands in Plan 18-06).
-- No index — write-heavy column, queries are operator forensics (rare jsonb extracts).
-- Idempotent: IF NOT EXISTS — re-running this migration is a no-op.
--
-- Postgres 17 note: ADD COLUMN on a nullable JSONB column is metadata-only (no table
-- rewrite), so this is safe to run on a large request_log table without long lock.

ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "hook_log" jsonb;
--> statement-breakpoint
COMMENT ON COLUMN "request_log"."hook_log" IS 'Phase 18 (RETR-04): array of HookLogEntry per pre-completion hook invocation. NULL when no hooks ran. JSON-array shape: [{hook_name, context_hash, latency_ms, chars_retrieved, status, error_message?}]. Hashes only — full retrieved content never stored here (P5-05).';
