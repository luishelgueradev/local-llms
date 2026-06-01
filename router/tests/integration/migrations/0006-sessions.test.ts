/**
 * Phase 17 / v0.11.0 — SESS-02 + P9-01 BLOCK + P4-01. Wave 0 scaffold (Plan 17-01).
 *
 * Real-Postgres integration test verifying that migration 0006 lands the
 * expected schema shape. Mirrors the `beforeEach(pg.Pool)` fixture pattern
 * from `tests/integration/cloud-spend-daily.test.ts` (PATTERNS line 787 —
 * "no prior phase has had a real-PG migration integration test").
 *
 * Wave 0 = it.todo only. Plan 17-02 lands the migration + Drizzle schema +
 * journal entry as an indivisible tuple; this test goes green at that point.
 *
 * Coverage (RESEARCH §Migration SQL lines 387-467):
 *   - `sessions` PRIMARY KEY (session_id)
 *   - `sessions.expires_at` NOT NULL (P4-01 BLOCK)
 *   - `sessions.has_pending_tool_call` BOOL NOT NULL DEFAULT false (SUMP-03)
 *   - `sessions.agent_id` NOT NULL (P4-03)
 *   - `conversation_turns` PRIMARY KEY (turn_id)
 *   - FK conversation_turns.session_id → sessions.session_id ON DELETE CASCADE
 *   - No FK from conversation_turns to request_log (P4-06 FLAG — intentional)
 *   - UNIQUE INDEX conversation_turns(session_id, turn_index)
 *   - idx_turns_session_index (session_id, turn_index)
 *   - idx_sessions_agent_expires (agent_id, expires_at)
 *   - COMMENT ON COLUMN sessions.agent_id citing SESS-03 / P4-03
 *   - Insert NULL into expires_at fails with not-null-violation
 */
import { describe, it } from 'vitest';
import { Pool } from 'pg';

// Wave-0 sentinel: pool constant is wired here so Plan 17-02 can flip the
// it.todo blocks to real beforeEach(pool) fixtures without an import-order
// churn. The eslint-disable suppresses the unused-binding warning until then.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _pool: Pool | undefined =
  process.env.POSTGRES_URL !== undefined
    ? new Pool({ connectionString: process.env.POSTGRES_URL })
    : undefined;

describe('Migration 0006 — sessions + conversation_turns schema', () => {
  it.todo('sessions table exists with PRIMARY KEY (session_id)');
  it.todo('sessions.expires_at column is NOT NULL (P4-01 BLOCK)');
  it.todo('sessions.has_pending_tool_call BOOL NOT NULL DEFAULT false (SUMP-03)');
  it.todo('sessions.agent_id NOT NULL (P4-03)');
  it.todo('conversation_turns table exists with PRIMARY KEY (turn_id)');
  it.todo('conversation_turns.session_id REFERENCES sessions(session_id) ON DELETE CASCADE');
  it.todo('conversation_turns has NO foreign key to request_log (P4-06 FLAG)');
  it.todo('UNIQUE INDEX conversation_turns(session_id, turn_index) exists');
  it.todo('idx_turns_session_index exists on (session_id, turn_index)');
  it.todo('idx_sessions_agent_expires exists on (agent_id, expires_at)');
  it.todo('COMMENT ON COLUMN sessions.agent_id mentions SESS-03 / P4-03');
  it.todo('Inserting NULL into expires_at fails with not-null-violation');
});
