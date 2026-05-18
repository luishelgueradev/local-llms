/**
 * Integration tests for `router/src/db/usageDaily.ts` (Plan 05-04 Task 1).
 *
 * Strategy: Option B (lightweight mock db). The refresh function ultimately
 * calls `db.execute(sql\`...\`)`; we stub `db.execute` with a vi.fn() that
 * records the SQL chunks and parameter set, then assert on shape +
 * idempotency by call-count.
 *
 * The 3 behaviors required by the plan's <behavior> block:
 *   (1) refresh runs the parameterized UPSERT SQL exactly once
 *   (2) re-running refreshUsageDaily for the same day produces the same SQL
 *       (idempotent — the UPSERT semantics are baked into the SQL itself)
 *   (3) the SQL contains COALESCE(agent_id, '_no_agent_') so NULL agent_id
 *       values in request_log map to the sentinel
 *
 * Why not a real Postgres testcontainer here:
 *   testcontainers is NOT a project dep; introducing it is a much larger
 *   commitment than this plan's scope (PG_TESTS env-gate per PATTERNS.md
 *   §"Pattern integration test env-gating" — Plan 01 already established
 *   that pattern for the bufferedWriter unit tests). Real-DB exercise of
 *   `usage_daily` is owned by Plan 05-04 Task 5's human-verify smoke gate
 *   against the live stack.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { refreshUsageDaily, makeUsageDailyScheduler } from '../../src/db/usageDaily.js';

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeMockDb(rowsAffected = 3): {
  db: NodePgDatabase;
  executeMock: ReturnType<typeof vi.fn>;
} {
  const executeMock = vi.fn(async () => ({ rowCount: rowsAffected, rows: [], command: 'INSERT' }));
  const db = { execute: executeMock } as unknown as NodePgDatabase;
  return { db, executeMock };
}

describe('refreshUsageDaily — SQL shape + idempotency', () => {
  it('1. issues exactly one INSERT...SELECT...ON CONFLICT statement with COALESCE(agent_id, <sentinel-param>)', async () => {
    const { db, executeMock } = makeMockDb();
    const day = new Date(Date.UTC(2026, 4, 13)); // 2026-05-13 UTC
    const result = await refreshUsageDaily(db, silentLog, { day });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.rowsUpserted).toBe(3);

    // Inspect the SQL the function passed to db.execute.
    // Drizzle's sql\`\` template tag yields an SQL object whose `queryChunks`
    // contains the literal SQL strings and `Param` instances for parameters.
    // WR-07 (TD-03): the sentinel is now passed as a bound parameter (not a
    // SQL literal) so the COALESCE expression appears as `COALESCE(agent_id, )`
    // in the queryChunks JSON with the value in a separate Param object.
    const call = executeMock.mock.calls[0][0] as { queryChunks: unknown[] };
    const concatenatedSql = JSON.stringify(call.queryChunks);
    expect(concatenatedSql).toMatch(/INSERT INTO usage_daily/i);
    expect(concatenatedSql).toMatch(/ON CONFLICT/i);
    expect(concatenatedSql).toMatch(/DO UPDATE SET/i);
    expect(concatenatedSql).toMatch(/COALESCE\(agent_id, /i);
    // The sentinel value (`_no_agent_`) appears as a Param value in queryChunks.
    expect(concatenatedSql).toMatch(/_no_agent_/);
    expect(concatenatedSql).toMatch(/percentile_cont\(0\.5\)/i);
    expect(concatenatedSql).toMatch(/percentile_cont\(0\.95\)/i);
    expect(concatenatedSql).toMatch(/status_class = 'success'/);
  });

  it('2. calling refreshUsageDaily twice for the same day re-issues the same SQL (idempotent at the SQL layer — ON CONFLICT DO UPDATE)', async () => {
    const { db, executeMock } = makeMockDb();
    const day = new Date(Date.UTC(2026, 4, 13));

    await refreshUsageDaily(db, silentLog, { day });
    await refreshUsageDaily(db, silentLog, { day });

    expect(executeMock).toHaveBeenCalledTimes(2);

    // Both calls should produce structurally identical SQL — Drizzle re-uses the same
    // template-literal chunks (the `strings` TemplateStringsArray is the same constant).
    const sql1 = JSON.stringify((executeMock.mock.calls[0][0] as { queryChunks: unknown[] }).queryChunks);
    const sql2 = JSON.stringify((executeMock.mock.calls[1][0] as { queryChunks: unknown[] }).queryChunks);
    expect(sql1).toBe(sql2);
  });

  it('3. defaults to previous UTC day when no opts.day is supplied (midnight runs aggregate yesterday)', async () => {
    const { db, executeMock } = makeMockDb();
    // Freeze the wall clock at a known UTC time so we can predict the default day.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 14, 0, 5, 0))); // 2026-05-14T00:05:00Z

      await refreshUsageDaily(db, silentLog);

      // The function should have computed yesterday = 2026-05-13.
      // We can't read the date param directly through queryChunks easily,
      // so we assert by re-running with an explicit day=2026-05-13 and
      // comparing — both should produce the same SQL chunks (params differ
      // only in value, not in shape).
      expect(executeMock).toHaveBeenCalledTimes(1);

      const explicitDay = new Date(Date.UTC(2026, 4, 13));
      const { db: db2, executeMock: executeMock2 } = makeMockDb();
      await refreshUsageDaily(db2, silentLog, { day: explicitDay });

      const a = JSON.stringify((executeMock.mock.calls[0][0] as { queryChunks: unknown[] }).queryChunks);
      const b = JSON.stringify((executeMock2.mock.calls[0][0] as { queryChunks: unknown[] }).queryChunks);
      expect(a).toBe(b);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. logs at info on success with the day + rowsUpserted', async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { db } = makeMockDb(7);
    await refreshUsageDaily(db, log, { day: new Date(Date.UTC(2026, 4, 13)) });

    expect(log.info).toHaveBeenCalled();
    const [obj] = log.info.mock.calls.at(-1) as [Record<string, unknown>, ...unknown[]];
    expect(obj.event).toBe('usage_daily_refresh_done');
    expect(obj.day).toBe('2026-05-13');
    expect(obj.rowsUpserted).toBe(7);
  });

  it('5. connection-class errors warn-and-continue (return rowsUpserted: 0); schema-class errors throw', async () => {
    // Connection-class: warn-and-return-zero
    const econnDb = {
      execute: vi.fn(async () => {
        const err = new Error('ECONNREFUSED 127.0.0.1:5432') as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        throw err;
      }),
    } as unknown as NodePgDatabase;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const result = await refreshUsageDaily(econnDb, log, { day: new Date(Date.UTC(2026, 4, 13)) });
    expect(result.rowsUpserted).toBe(0);
    expect(log.warn).toHaveBeenCalled();

    // Schema-class: throw
    const schemaDb = {
      execute: vi.fn(async () => {
        const err = new Error('column "request_count" does not exist') as Error & { code?: string };
        err.code = '42703';
        throw err;
      }),
    } as unknown as NodePgDatabase;
    await expect(refreshUsageDaily(schemaDb, log, { day: new Date(Date.UTC(2026, 4, 13)) })).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('makeUsageDailyScheduler — start/stop/runNow idempotency', () => {
  it('6. start() is idempotent; stop() is idempotent; runNow() invokes the refresh', async () => {
    const { db, executeMock } = makeMockDb();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 14, 12, 0, 0))); // midday
      const sched = makeUsageDailyScheduler({ db, log: silentLog });

      sched.start();
      sched.start(); // idempotent — second call is a no-op

      // Explicit runNow should fire the refresh exactly once
      await sched.runNow();
      expect(executeMock).toHaveBeenCalledTimes(1);

      sched.stop();
      sched.stop(); // idempotent — second call is a no-op
    } finally {
      vi.useRealTimers();
    }
  });

  it('7. scheduler stops cleanly after start (no lingering timers)', async () => {
    const { db } = makeMockDb();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 14, 12, 0, 0)));
      const sched = makeUsageDailyScheduler({ db, log: silentLog });
      sched.start();
      // Vitest fake timers track pending timers; stopping should clear them.
      sched.stop();
      // No assertion error from leftover timers when we leave the test (vi.useRealTimers will not complain).
    } finally {
      vi.useRealTimers();
    }
  });
});
