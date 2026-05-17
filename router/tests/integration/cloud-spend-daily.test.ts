/**
 * Plan 08-08 integration tests — `cloud_spend_daily` Postgres view (CLOUD-05 / D-C3).
 *
 * Strategy mirrors `tests/integration/usageDaily.test.ts`:
 *   1. Lightweight unit-style tests that load the migration SQL file from
 *      disk and assert its shape (view DDL, filter predicate, aggregate
 *      expressions, idempotency keyword). These always run.
 *   2. Drizzle journal integrity check — confirms the migration is registered
 *      in `meta/_journal.json` so `runMigrations()` will pick it up at boot.
 *   3. Optional real-Postgres exercise under `PG_TESTS=1` env-gate (matches
 *      `tests/integration/hotreload.test.ts` pattern per PATTERNS.md and
 *      Plan 05-04's usageDaily real-DB cases). The worktree environment
 *      lacks a reachable Postgres; the real-DB exercise is anchored to
 *      Plan 08-10's smoke gate against the live stack.
 *
 * Behaviors covered (Plan 08-08 <behavior> Tests 1-5):
 *   Test 1: View returns 0 rows when request_log is empty.
 *   Test 2: View aggregates ollama-cloud rows (excludes ollama rows);
 *           spend_ms = SUM(latency_ms); request_count = COUNT(*);
 *           distinct_generations = COUNT(DISTINCT upstream_message_id).
 *   Test 3: 3 follower rows sharing one upstream_message_id collapse to
 *           1 distinct generation (Plan 08-07 idempotency-multiplexer surface);
 *           spend_ms still includes all rows' latency_ms.
 *   Test 4: Rows on different days produce separate view rows
 *           (date_trunc('day', ts) grouping).
 *   Test 5: Migration is idempotent (CREATE OR REPLACE VIEW).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0001_cloud_spend_daily.sql';
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');

describe('Plan 08-08: cloud_spend_daily migration SQL shape', () => {
  it('1. migration file exists at db/migrations/0001_cloud_spend_daily.sql', () => {
    expect(() => readFileSync(MIGRATION_PATH, 'utf8')).not.toThrow();
  });

  it('2. SQL defines the view via CREATE OR REPLACE VIEW (idempotent — Plan 08-08 Test 5)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+cloud_spend_daily/i);
  });

  it("3. filter predicate is `backend = 'ollama-cloud'` (excludes ollama / llamacpp rows — Plan 08-08 Test 2)", () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/backend\s*=\s*'ollama-cloud'/i);
  });

  it('4. aggregates SUM(latency_ms) AS spend_ms (D-C3 cost-proxy metric)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/SUM\s*\(\s*latency_ms\s*\)\s+AS\s+spend_ms/i);
  });

  it('5. aggregates COUNT(*) AS request_count (Plan 08-08 Test 2)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/COUNT\s*\(\s*\*\s*\)\s+AS\s+request_count/i);
  });

  it('6. aggregates COUNT(DISTINCT upstream_message_id) AS distinct_generations — collapses Plan 08-07 follower retries (Plan 08-08 Test 3)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/COUNT\s*\(\s*DISTINCT\s+upstream_message_id\s*\)\s+AS\s+distinct_generations/i);
  });

  it("7. groups by date_trunc('day', ts) — per-day buckets (Plan 08-08 Test 4)", () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/date_trunc\s*\(\s*'day'\s*,\s*ts\s*\)/i);
  });

  it('8. SELECTs from request_log (Phase 5 D-A1 / D-D1)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/FROM\s+request_log/i);
  });

  it('9. orders by day DESC (recent-first for operator psql queries)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ORDER\s+BY\s+1\s+DESC|ORDER\s+BY\s+day\s+DESC/i);
  });

  it('10. carries a COMMENT ON VIEW with CLOUD-05 lineage (operator-facing docs)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/COMMENT\s+ON\s+VIEW\s+cloud_spend_daily/i);
    expect(sql).toMatch(/CLOUD-05/);
  });
});

describe('Plan 08-08: Drizzle migration journal integrity', () => {
  it('11. _journal.json registers the new migration so runMigrations() picks it up at boot (Phase 5 D-B5)', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }>;
    };
    const tag = '0001_cloud_spend_daily';
    const entry = journal.entries.find((e) => e.tag === tag);
    expect(entry, `journal must include entry with tag=${tag}`).toBeDefined();
    expect(entry?.idx).toBe(1); // 0000_init is idx 0; this is the next slot
    expect(typeof entry?.when).toBe('number');
  });

  it('12. journal entries are ordered by idx so the migrator applies them in sequence', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const idxs = journal.entries.map((e) => e.idx);
    const sorted = [...idxs].sort((a, b) => a - b);
    expect(idxs).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Optional: real-Postgres aggregation correctness.
//
// Mirrors `tests/integration/usageDaily.test.ts` PG_TESTS gating pattern. The
// suite runs full Plan 08-08 <behavior> Tests 1-4 when PG_TESTS=1 is set AND
// a Postgres is reachable at ROUTER_DATABASE_URL. Real-DB exercise is owned
// by Plan 08-10's smoke gate against the live stack.
// ---------------------------------------------------------------------------

const PG_TESTS_ENABLED = process.env.PG_TESTS === '1';

describe.skipIf(!PG_TESTS_ENABLED)(
  'Plan 08-08: cloud_spend_daily aggregation against real Postgres (PG_TESTS=1)',
  () => {
    it('13. view returns 0 rows when request_log is empty (Plan 08-08 Test 1)', async () => {
      // Real-DB exercise: smoke gate Plan 08-10. Worktree environment lacks
      // a reachable Postgres; this case asserts the operator-facing contract.
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { sql } = await import('drizzle-orm');
      const { runMigrations } = await import('../../src/db/migrate.js');

      const url = process.env.ROUTER_DATABASE_URL;
      if (!url) throw new Error('PG_TESTS=1 requires ROUTER_DATABASE_URL');
      const pool = new Pool({ connectionString: url });
      const db = drizzle(pool);
      const silentLog = { info: () => {}, warn: () => {} };
      try {
        await runMigrations(db, silentLog);
        await db.execute(sql`TRUNCATE TABLE request_log`);
        const result = (await db.execute(sql`SELECT * FROM cloud_spend_daily`)) as {
          rows: unknown[];
        };
        expect(result.rows).toEqual([]);
      } finally {
        await pool.end();
      }
    });

    it('14. view excludes non-cloud backends and sums latency_ms (Plan 08-08 Test 2)', async () => {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { sql } = await import('drizzle-orm');
      const { runMigrations } = await import('../../src/db/migrate.js');

      const url = process.env.ROUTER_DATABASE_URL;
      if (!url) throw new Error('PG_TESTS=1 requires ROUTER_DATABASE_URL');
      const pool = new Pool({ connectionString: url });
      const db = drizzle(pool);
      const silentLog = { info: () => {}, warn: () => {} };
      try {
        await runMigrations(db, silentLog);
        await db.execute(sql`TRUNCATE TABLE request_log`);
        // 3 cloud rows on 2026-05-17 + 2 local-ollama rows (must be excluded).
        await db.execute(sql`
          INSERT INTO request_log
            (ts, protocol, route, backend, model, status_class, http_status,
             latency_ms, request_id, upstream_message_id)
          VALUES
            ('2026-05-17T10:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 100, 'req-1', 'msg-a'),
            ('2026-05-17T11:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 200, 'req-2', 'msg-b'),
            ('2026-05-17T12:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 300, 'req-3', 'msg-c'),
            ('2026-05-17T13:00:00Z', 'openai', '/v1/chat/completions', 'ollama',
             'llama3.1:8b', 'success', 200, 50, 'req-4', NULL),
            ('2026-05-17T14:00:00Z', 'openai', '/v1/chat/completions', 'ollama',
             'llama3.1:8b', 'success', 200, 75, 'req-5', NULL)
        `);
        const result = (await db.execute(
          sql`SELECT day::text AS day, request_count, spend_ms, distinct_generations
              FROM cloud_spend_daily`,
        )) as { rows: Array<Record<string, unknown>> };
        expect(result.rows.length).toBe(1);
        const row = result.rows[0];
        expect(row.day).toMatch(/^2026-05-17/);
        expect(Number(row.request_count)).toBe(3);
        expect(Number(row.spend_ms)).toBe(600);
        expect(Number(row.distinct_generations)).toBe(3);
      } finally {
        await pool.end();
      }
    });

    it('15. shared upstream_message_id collapses follower retries (Plan 08-08 Test 3)', async () => {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { sql } = await import('drizzle-orm');
      const { runMigrations } = await import('../../src/db/migrate.js');

      const url = process.env.ROUTER_DATABASE_URL;
      if (!url) throw new Error('PG_TESTS=1 requires ROUTER_DATABASE_URL');
      const pool = new Pool({ connectionString: url });
      const db = drizzle(pool);
      const silentLog = { info: () => {}, warn: () => {} };
      try {
        await runMigrations(db, silentLog);
        await db.execute(sql`TRUNCATE TABLE request_log`);
        // 3 cloud rows with distinct msg ids + 3 follower rows sharing 'leader-1'.
        await db.execute(sql`
          INSERT INTO request_log
            (ts, protocol, route, backend, model, status_class, http_status,
             latency_ms, request_id, upstream_message_id)
          VALUES
            ('2026-05-17T10:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 100, 'req-1', 'msg-a'),
            ('2026-05-17T11:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 200, 'req-2', 'msg-b'),
            ('2026-05-17T12:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 300, 'req-3', 'msg-c'),
            ('2026-05-17T13:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 1000, 'req-4', 'leader-1'),
            ('2026-05-17T13:01:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 1000, 'req-5', 'leader-1'),
            ('2026-05-17T13:02:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 1000, 'req-6', 'leader-1')
        `);
        const result = (await db.execute(
          sql`SELECT request_count, spend_ms, distinct_generations
              FROM cloud_spend_daily`,
        )) as { rows: Array<Record<string, unknown>> };
        expect(result.rows.length).toBe(1);
        const row = result.rows[0];
        expect(Number(row.request_count)).toBe(6);
        expect(Number(row.spend_ms)).toBe(3600);
        // distinct_generations = COUNT(DISTINCT upstream_message_id) = {msg-a,
        // msg-b, msg-c, leader-1} = 4 — the 3 followers collapse with the leader.
        expect(Number(row.distinct_generations)).toBe(4);
      } finally {
        await pool.end();
      }
    });

    it('16. rows on separate UTC days produce separate view rows (Plan 08-08 Test 4)', async () => {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { sql } = await import('drizzle-orm');
      const { runMigrations } = await import('../../src/db/migrate.js');

      const url = process.env.ROUTER_DATABASE_URL;
      if (!url) throw new Error('PG_TESTS=1 requires ROUTER_DATABASE_URL');
      const pool = new Pool({ connectionString: url });
      const db = drizzle(pool);
      const silentLog = { info: () => {}, warn: () => {} };
      try {
        await runMigrations(db, silentLog);
        await db.execute(sql`TRUNCATE TABLE request_log`);
        await db.execute(sql`
          INSERT INTO request_log
            (ts, protocol, route, backend, model, status_class, http_status,
             latency_ms, request_id, upstream_message_id)
          VALUES
            ('2026-05-17T10:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 100, 'req-1', 'msg-a'),
            ('2026-05-18T10:00:00Z', 'openai', '/v1/chat/completions', 'ollama-cloud',
             'gpt-oss:120b-cloud', 'success', 200, 200, 'req-2', 'msg-b')
        `);
        const result = (await db.execute(
          sql`SELECT day::text AS day FROM cloud_spend_daily ORDER BY day DESC`,
        )) as { rows: Array<Record<string, unknown>> };
        expect(result.rows.length).toBe(2);
        expect(String(result.rows[0].day)).toMatch(/^2026-05-18/);
        expect(String(result.rows[1].day)).toMatch(/^2026-05-17/);
      } finally {
        await pool.end();
      }
    });

    it('17. re-running the migration is a no-op (CREATE OR REPLACE — Plan 08-08 Test 5)', async () => {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { sql } = await import('drizzle-orm');
      const { runMigrations } = await import('../../src/db/migrate.js');

      const url = process.env.ROUTER_DATABASE_URL;
      if (!url) throw new Error('PG_TESTS=1 requires ROUTER_DATABASE_URL');
      const pool = new Pool({ connectionString: url });
      const db = drizzle(pool);
      const silentLog = { info: () => {}, warn: () => {} };
      try {
        // First call applies the migration.
        await runMigrations(db, silentLog);
        // Second call is a no-op for the view (Drizzle's `__drizzle_migrations`
        // tracker also makes the runMigrations call itself a no-op).
        await expect(runMigrations(db, silentLog)).resolves.toBeUndefined();
        const result = (await db.execute(
          sql`SELECT to_regclass('public.cloud_spend_daily') IS NOT NULL AS exists`,
        )) as { rows: Array<{ exists: boolean }> };
        expect(result.rows[0].exists).toBe(true);
      } finally {
        await pool.end();
      }
    });
  },
);
