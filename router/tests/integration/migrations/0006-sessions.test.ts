/**
 * Phase 17 / v0.11.0 — SESS-02 + P9-01 BLOCK + P4-01 + P4-06. Plan 17-02
 * (flipped from Wave 0).
 *
 * Real-Postgres integration test verifying that migration 0006 lands the
 * expected schema shape. Follows the `Pool` + `beforeAll/afterAll` fixture
 * pattern from `tests/integration/cloud-spend-daily.test.ts` (PATTERNS line
 * 787) and the PG_TESTS=1 env-gate convention used elsewhere in this suite.
 *
 * Env gate: the describe block runs only when EITHER `PG_TESTS=1` AND a
 * Postgres URL is reachable (POSTGRES_URL or ROUTER_DATABASE_URL). Otherwise
 * `describe.skip` keeps the suite green in CI without a live database.
 *
 * Coverage (RESEARCH §Migration SQL lines 387-467):
 *   - `sessions` PRIMARY KEY (session_id)
 *   - `sessions.expires_at` NOT NULL (P4-01 BLOCK)
 *   - `sessions.has_pending_tool_call` BOOL NOT NULL DEFAULT false (SUMP-03)
 *   - `sessions.agent_id` NOT NULL (P4-03)
 *   - `conversation_turns` PRIMARY KEY (turn_id)
 *   - FK conversation_turns.session_id → sessions.session_id ON DELETE CASCADE
 *   - No FK from conversation_turns to request_log (P4-06 FLAG — intentional)
 *   - UNIQUE conversation_turns(session_id, turn_index)
 *   - idx_turns_session_index (session_id, turn_index)
 *   - idx_sessions_agent_expires (agent_id, expires_at)
 *   - COMMENT ON COLUMN sessions.agent_id citing SESS-03 / P4-03
 *   - Insert with NULL expires_at fails with not-null-violation
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// Resolve the Postgres URL once. Per the local-llms convention,
// `ROUTER_DATABASE_URL` is the canonical name used elsewhere in the suite
// (e.g. cloud-spend-daily.test.ts:133); the plan also accepts the more
// generic `POSTGRES_URL` / `DATABASE_URL` for portability.
const PG_URL =
  process.env.POSTGRES_URL ?? process.env.ROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
const PG_TESTS_ENABLED = process.env.PG_TESTS === '1' && PG_URL !== undefined;
const describeMaybe = PG_TESTS_ENABLED ? describe : describe.skip;

describeMaybe('Migration 0006 — sessions + conversation_turns schema', () => {
  let pool: Pool;

  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: PG_TESTS_ENABLED implies PG_URL is defined
    pool = new Pool({ connectionString: PG_URL! });
  });

  afterAll(async () => {
    await pool.end();
  });

  // Reset state between tests so insert-failure tests don't interfere with
  // schema-shape tests. Both DELETEs are no-ops on a fresh schema; the FK
  // CASCADE means the order doesn't matter for clean wipes, but we keep
  // turns-before-sessions out of habit for FK-strict databases.
  beforeEach(async () => {
    await pool.query('DELETE FROM conversation_turns');
    await pool.query('DELETE FROM sessions');
  });

  it('sessions table exists with PRIMARY KEY (session_id)', async () => {
    const r = await pool.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sessions'`,
    );
    expect(r.rowCount).toBe(1);
    const pk = await pool.query(`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = 'sessions' AND tc.constraint_type = 'PRIMARY KEY'`);
    expect(pk.rows.map((row: { column_name: string }) => row.column_name)).toEqual(['session_id']);
  });

  it('sessions.expires_at column is NOT NULL (P4-01 BLOCK)', async () => {
    const r = await pool.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'expires_at'`,
    );
    expect(r.rows[0].is_nullable).toBe('NO');
  });

  it('sessions.has_pending_tool_call BOOL NOT NULL DEFAULT false (SUMP-03)', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'has_pending_tool_call'`,
    );
    expect(r.rows[0].data_type).toBe('boolean');
    expect(r.rows[0].is_nullable).toBe('NO');
    // Postgres echoes the default as 'false' (text form of the boolean literal).
    expect(r.rows[0].column_default).toBe('false');
  });

  it('sessions.agent_id NOT NULL (P4-03)', async () => {
    const r = await pool.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'agent_id'`,
    );
    expect(r.rows[0].is_nullable).toBe('NO');
  });

  it('conversation_turns table exists with PRIMARY KEY (turn_id)', async () => {
    const r = await pool.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'conversation_turns'`,
    );
    expect(r.rowCount).toBe(1);
    const pk = await pool.query(`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = 'conversation_turns' AND tc.constraint_type = 'PRIMARY KEY'`);
    expect(pk.rows.map((row: { column_name: string }) => row.column_name)).toEqual(['turn_id']);
  });

  it('conversation_turns.session_id REFERENCES sessions(session_id) ON DELETE CASCADE', async () => {
    const r = await pool.query(`
      SELECT rc.delete_rule, kcu.column_name AS fk_column,
             ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON rc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
       WHERE kcu.table_name = 'conversation_turns'
         AND kcu.column_name = 'session_id'`);
    expect(r.rowCount).toBe(1);
    const row = r.rows[0];
    expect(row.delete_rule).toBe('CASCADE');
    expect(row.referenced_table).toBe('sessions');
    expect(row.referenced_column).toBe('session_id');
  });

  it('conversation_turns has NO foreign key to request_log (P4-06 FLAG)', async () => {
    const r = await pool.query(`
      SELECT count(*)::int AS n
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON rc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
       WHERE kcu.table_name = 'conversation_turns'
         AND ccu.table_name = 'request_log'`);
    expect(r.rows[0].n).toBe(0);
  });

  it('UNIQUE conversation_turns(session_id, turn_index) exists', async () => {
    const r = await pool.query(`
      SELECT tc.constraint_name,
             string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = 'conversation_turns'
         AND tc.constraint_type = 'UNIQUE'
       GROUP BY tc.constraint_name`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].constraint_name).toBe('conversation_turns_session_turn_idx_uq');
    expect(r.rows[0].cols).toBe('session_id,turn_index');
  });

  it('idx_turns_session_index exists on (session_id, turn_index)', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_turns_session_index'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/\(session_id, turn_index\)/);
  });

  it('idx_sessions_agent_expires exists on (agent_id, expires_at)', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_sessions_agent_expires'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/\(agent_id, expires_at\)/);
  });

  it('COMMENT ON COLUMN sessions.agent_id mentions SESS-03 / P4-03', async () => {
    const r = await pool.query(`
      SELECT col_description(c.oid, a.attnum) AS comment
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relname = 'sessions'
         AND a.attname = 'agent_id'`);
    const comment = r.rows[0]?.comment as string | null;
    expect(comment).toBeTruthy();
    // SESS-03 OR P4-03 must appear — the comment text cites both per the plan.
    expect(comment).toMatch(/SESS-03/);
    expect(comment).toMatch(/P4-03/);
  });

  it('Inserting NULL into expires_at fails with not-null-violation', async () => {
    // Omit expires_at — it has no default, so the column receives NULL and Postgres rejects.
    await expect(
      pool.query(
        `INSERT INTO sessions (session_id, agent_id) VALUES ('test-null-expires', 'agent-x')`,
      ),
    ).rejects.toMatchObject({
      code: '23502', // not_null_violation
      // Error column = 'expires_at' (the offending column).
      column: 'expires_at',
    });
  });
});
