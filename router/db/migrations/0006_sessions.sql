-- Migration 0006: sessions + conversation_turns
--   (Phase 17 / v0.11.0 — SESS-02, SESS-03, P4-01 BLOCK, P4-06 FLAG,
--    SUMP-03 BLOCK, P9-01 BLOCK indivisible-tuple invariant).
--
-- Creates two tables: sessions (session-level state) and conversation_turns
-- (the actual messages). Schema decisions baked in here:
--
--   sessions.expires_at TIMESTAMPTZ NOT NULL    — P4-01 BLOCK
--   sessions.agent_id   TEXT NOT NULL           — P4-03 BLOCK (loadHistory scope key)
--   sessions.has_pending_tool_call BOOL NOT NULL DEFAULT false
--                                                — SUMP-03 BLOCK (P6-01 guard column)
--   conversation_turns has NO FK to request_log — P4-06 FLAG (sessions are
--                                                independently deletable)
--   conversation_turns.session_id → sessions.session_id ON DELETE CASCADE
--                                                — STACK §4 + REQ SESS-01
--                                                  (deleteSession cleans up turns)
--
-- Indexes:
--   conversation_turns: (session_id, turn_index)           — loadHistory primary path
--   conversation_turns: (session_id, ts)                   — wall-clock fallback ordering
--   sessions:          (agent_id, expires_at)              — listSessions + GC scan
--   sessions:          (agent_id, updated_at DESC)         — recency-ordered listSessions
--
-- Idempotent: CREATE TABLE IF NOT EXISTS — re-running this migration is a no-op.
-- Mirrors the 0005_request_log_scoped_ids.sql precedent for header + breakpoint
-- + COMMENT idioms.

CREATE TABLE IF NOT EXISTS "sessions" (
  "session_id"            text PRIMARY KEY,
  "agent_id"              text NOT NULL,
  "tenant_id"             text,
  "project_id"            text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"            timestamp with time zone NOT NULL,
  "has_pending_tool_call" boolean NOT NULL DEFAULT false,
  "turn_count"            integer NOT NULL DEFAULT 0,
  "metadata"              jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_agent_expires"
  ON "sessions" ("agent_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_agent_updated"
  ON "sessions" ("agent_id", "updated_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_turns" (
  "turn_id"      text PRIMARY KEY,
  "session_id"   text NOT NULL REFERENCES "sessions"("session_id") ON DELETE CASCADE,
  "agent_id"     text NOT NULL,
  "turn_index"   integer NOT NULL,
  "role"         text NOT NULL,
  "content"      jsonb NOT NULL,
  "tool_calls"   jsonb,
  "tool_call_id" text,
  "model"        text,
  "tokens_in"    integer,
  "tokens_out"   integer,
  "ts"           timestamp with time zone NOT NULL DEFAULT now(),
  "metadata"     jsonb,
  CONSTRAINT "conversation_turns_session_turn_idx_uq"
    UNIQUE ("session_id", "turn_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turns_session_index"
  ON "conversation_turns" ("session_id", "turn_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turns_session_ts"
  ON "conversation_turns" ("session_id", "ts");

COMMENT ON COLUMN "sessions"."agent_id" IS
  'SESS-03 / P4-03 BLOCK: every loadHistory call must filter on agent_id to prevent cross-agent leakage.';
COMMENT ON COLUMN "sessions"."expires_at" IS
  'P4-01 BLOCK: TTL anchor. Default 7 days from created_at; configurable via SESSION_TTL_DAYS env. NEVER NULL.';
COMMENT ON COLUMN "sessions"."has_pending_tool_call" IS
  'SUMP-03 / P6-01 BLOCK: true when the last assistant turn emits tool_calls without matching tool turn(s). SummaryProvider MUST check this flag and skip summarization when true.';
COMMENT ON COLUMN "conversation_turns"."agent_id" IS
  'Denormalized from sessions.agent_id at insert time. Enables agent_id-filtered queries without joining sessions, AND survives if the FK CASCADE chain mutates.';
COMMENT ON TABLE "conversation_turns" IS
  'P4-06 FLAG: deliberately NO foreign key to request_log. Sessions must be independently deletable for compliance-driven erasure paths.';
