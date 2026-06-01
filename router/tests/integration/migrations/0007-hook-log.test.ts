/**
 * Phase 18 / v0.11.0 — RETR-04 (migration 0007: request_log.hook_log JSONB).
 * Plan 18-02 (flipped from Wave 0). Real-Postgres integration test.
 *
 * Real-Postgres integration test verifying that migration 0007 lands the
 * expected `request_log.hook_log` JSONB column. Mirrors the Phase 17
 * `tests/integration/migrations/0006-sessions.test.ts` pattern (same
 * `Pool` + `beforeAll`/`afterAll` fixture, same PG_TESTS=1 env gate).
 *
 * Schema invariants under test:
 *   - `request_log.hook_log` is `JSONB NULL` (no default — NULL means
 *     "no hooks ran on this request", an `[]` would imply an empty chain
 *     ran which is distinct).
 *   - The column carries a `COMMENT` citing Phase 18 + RETR-04 + the
 *     `HookLogEntry` shape.
 *   - NO index on the column (write-heavy column per design — POL-06
 *     cardinality discipline does not justify the index cost).
 *
 * Drizzle parity: the `requestLog` schema in `src/db/schema/request_log.ts`
 * gains a `hook_log: jsonb('hook_log')` column; the `$inferSelect` type
 * widens accordingly so downstream queries are type-safe.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-02's flip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const PG_URL =
  process.env.POSTGRES_URL ?? process.env.ROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
const PG_TESTS_ENABLED = process.env.PG_TESTS === '1' && PG_URL !== undefined;
const describeMaybe = PG_TESTS_ENABLED ? describe : describe.skip;

describeMaybe('Migration 0007: request_log.hook_log JSONB column', () => {
  let pool: Pool;

  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: PG_TESTS_ENABLED implies PG_URL is defined
    pool = new Pool({ connectionString: PG_URL! });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('request_log.hook_log column exists with data_type=jsonb', async () => {
    const r = await pool.query(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_log'
          AND column_name = 'hook_log'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].data_type).toBe('jsonb');
  });

  it('request_log.hook_log is NULLABLE (is_nullable=YES)', async () => {
    const r = await pool.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_log'
          AND column_name = 'hook_log'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].is_nullable).toBe('YES');
  });

  it('COMMENT ON COLUMN request_log.hook_log mentions Phase 18 + RETR-04 + HookLogEntry shape', async () => {
    // pg_description tracks COMMENT metadata. col_description() resolves a
    // column comment from (table_oid, column_position).
    const r = await pool.query(`
      SELECT col_description(
               (SELECT oid FROM pg_class WHERE relname = 'request_log'),
               (SELECT ordinal_position
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'request_log'
                   AND column_name = 'hook_log')
             ) AS comment
    `);
    expect(r.rowCount).toBe(1);
    const comment = r.rows[0].comment as string | null;
    expect(comment).not.toBeNull();
    expect(comment).toMatch(/Phase 18/);
    expect(comment).toMatch(/RETR-04/);
    expect(comment).toMatch(/HookLogEntry|hook_name/);
  });

  it('no index on hook_log (write-heavy column per design)', async () => {
    // Inspect pg_indexes for any index whose definition references hook_log.
    const r = await pool.query(`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'request_log'
         AND indexdef ILIKE '%hook_log%'
    `);
    expect(r.rowCount).toBe(0);
  });

  it('inserting JSON array of HookLogEntry objects round-trips through SELECT', async () => {
    const hookLog = [
      {
        hook_name: 'doc_retriever',
        context_hash: 'sha256:abcd',
        latency_ms: 42,
        chars_retrieved: 1234,
        status: 'ok',
      },
    ];
    const insert = await pool.query(
      `INSERT INTO request_log
         (protocol, route, backend, model, status_class, http_status, latency_ms, request_id, hook_log)
       VALUES ('openai', '/v1/chat/completions', 'ollama', 'chat-local', 'success', 200, 100, $1, $2)
       RETURNING id, hook_log`,
      [`test-req-${Date.now()}-hookjson`, JSON.stringify(hookLog)],
    );
    expect(insert.rowCount).toBe(1);
    expect(insert.rows[0].hook_log).toEqual(hookLog);
    // Cleanup so the test stays self-contained.
    await pool.query('DELETE FROM request_log WHERE id = $1', [insert.rows[0].id]);
  });

  it('NULL value selects back as NULL (no default array)', async () => {
    const insert = await pool.query(
      `INSERT INTO request_log
         (protocol, route, backend, model, status_class, http_status, latency_ms, request_id)
       VALUES ('openai', '/v1/chat/completions', 'ollama', 'chat-local', 'success', 200, 100, $1)
       RETURNING id, hook_log`,
      [`test-req-${Date.now()}-hooknull`],
    );
    expect(insert.rowCount).toBe(1);
    expect(insert.rows[0].hook_log).toBeNull();
    await pool.query('DELETE FROM request_log WHERE id = $1', [insert.rows[0].id]);
  });

  it('Drizzle schema request_log.hook_log declared as jsonb (verified via $inferSelect type)', async () => {
    // Runtime check: the Drizzle pgTable handle should expose hook_log as a
    // jsonb column. Drizzle pg-core columns carry `.dataType === 'json'` for
    // jsonb columns (Drizzle collapses json + jsonb to dataType:'json' since
    // PG returns JS objects for both — see drizzle-orm/pg-core source).
    const mod = await import('../../../src/db/schema/request_log.js');
    const col = (mod.requestLog as unknown as Record<string, unknown>).hook_log as {
      notNull?: boolean;
      dataType?: string;
      columnType?: string;
    };
    expect(col).toBeDefined();
    // hook_log must NOT be notNull — i.e. nullable.
    expect(col.notNull).toBe(false);
    // Drizzle's `dataType` for jsonb() is 'json' (jsonb and json share the JS-decoded shape).
    expect(col.dataType).toBe('json');
  });
});

// ── Phase 19 OBSV-04 re-verification ─────────────────────────────────
// D-22: NO new migration in Phase 19. This describe block re-verifies
// the Plan 18-02 migration 0007 still holds in the live Postgres.
// If the column is missing or its type drifted, OBSV-04 fails — the
// safety-net REQ text ("if not already added in Phase 18, migration
// 0007 adds it here") is satisfied by structural verification, not
// by a redundant migration.
describeMaybe('Migration 0007: re-verified by Phase 19 (OBSV-04)', () => {
  let pool: Pool;

  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: PG_TESTS_ENABLED implies PG_URL is defined
    pool = new Pool({ connectionString: PG_URL! });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('Phase 19 OBSV-04: hook_log column still present + still JSONB + still nullable', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_log'
          AND column_name = 'hook_log'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].data_type).toBe('jsonb');
    expect(r.rows[0].is_nullable).toBe('YES');
  });
});
