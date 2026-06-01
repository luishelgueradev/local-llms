/**
 * Phase 17 / v0.11.0 — P9-01 BLOCK + SESS-02. Plan 17-02 (flipped from Wave 0).
 *
 * Atomic-tuple integrity gate for migration 0006 — direct sibling of
 * `tests/migration0005.test.ts` (PATTERNS lines 635-657). The Drizzle
 * migrator silently skips entries missing from `_journal.json`, so the
 * SQL file + Drizzle schema + journal entry MUST land as one git commit.
 *
 * Path-resolution depth note: this file lives in `tests/db/`, which is one
 * level deeper than `tests/migration0005.test.ts` — `__dirname` resolution
 * uses `path.resolve(__dirname, '../..')` (NOT `'..'`) for ROUTER_ROOT.
 *
 * Secondary contract — single grep gate at the bottom asserts the
 * `router/src/providers/` namespace contains no `bufferedWriter` import,
 * defending the SESS-04 sync-write contract (RESEARCH §postgres-session-store
 * cited in PATTERNS line 663). The check tolerates the directory not yet
 * existing (Plan 17-03/17-04 lands it) by short-circuiting on existsSync.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve paths relative to router/ root — one level deeper than
// `tests/migration0005.test.ts`, so `__dirname` climbs two levels.
const ROUTER_ROOT = path.resolve(__dirname, '../..');
const SQL_PATH = path.join(ROUTER_ROOT, 'db/migrations/0006_sessions.sql');
const JOURNAL_PATH = path.join(ROUTER_ROOT, 'db/migrations/meta/_journal.json');
const SCHEMA_PATH = path.join(ROUTER_ROOT, 'src/db/schema/sessions.ts');
const SCHEMA_INDEX_PATH = path.join(ROUTER_ROOT, 'src/db/schema/index.ts');
const PROVIDERS_DIR = path.join(ROUTER_ROOT, 'src/providers');

// Snapshot of entries[0..5] from the pre-0006 _journal.json — Test 2 asserts
// these are unchanged byte-for-byte after the 0006 append (P9-01 BLOCK: prior
// entries are immutable once landed).
const EXPECTED_PRIOR_ENTRIES = [
  { idx: 0, version: '7', when: 1778780539390, tag: '0000_init', breakpoints: true },
  { idx: 1, version: '7', when: 1779358800000, tag: '0001_cloud_spend_daily', breakpoints: true },
  {
    idx: 2,
    version: '7',
    when: 1779487200000,
    tag: '0002_request_log_idempotency_key',
    breakpoints: true,
  },
  {
    idx: 3,
    version: '7',
    when: 1779609600000,
    tag: '0003_request_log_cost_cents',
    breakpoints: true,
  },
  {
    idx: 4,
    version: '7',
    when: 1779696000000,
    tag: '0004_cost_per_agent_daily',
    breakpoints: true,
  },
  {
    idx: 5,
    version: '7',
    when: 1780142072840,
    tag: '0005_request_log_scoped_ids',
    breakpoints: true,
  },
];

describe('Migration 0006 atomic tuple integrity (P9-01 BLOCK)', () => {
  it('Test 1: SQL file 0006_sessions.sql exists', () => {
    expect(existsSync(SQL_PATH)).toBe(true);
  });

  it('Test 1: SQL contains CREATE TABLE IF NOT EXISTS "sessions"', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "sessions"/);
  });

  it('Test 1: SQL contains CREATE TABLE IF NOT EXISTS "conversation_turns"', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "conversation_turns"/);
  });

  it('Test 1: SQL contains expires_at TIMESTAMPTZ NOT NULL', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/"expires_at"\s+timestamp with time zone NOT NULL/);
  });

  it('Test 1: SQL contains has_pending_tool_call boolean NOT NULL DEFAULT false', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/"has_pending_tool_call"\s+boolean NOT NULL DEFAULT false/);
  });

  it('Test 1: SQL contains REFERENCES "sessions"("session_id") ON DELETE CASCADE', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/REFERENCES\s+"sessions"\("session_id"\)\s+ON DELETE CASCADE/);
  });

  it('Test 1: SQL contains UNIQUE constraint on (session_id, turn_index)', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    // CONSTRAINT name + UNIQUE clause may span two lines — use [\s\S]* for tolerance.
    expect(sql).toMatch(
      /CONSTRAINT\s+"conversation_turns_session_turn_idx_uq"[\s\S]*UNIQUE\s*\(\s*"session_id",\s*"turn_index"\s*\)/,
    );
  });

  it('Test 1: SQL uses --> statement-breakpoint between every DDL', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    const markers = sql.match(/-->\s*statement-breakpoint/g) ?? [];
    // 5 minimum: between (sessions table + idx_sessions_agent_expires + idx_sessions_agent_updated)
    // and conversation_turns and its two indexes. Trailing COMMENT block has no breakpoint
    // (matches 0005 precedent — markers between statements only, not after the last).
    expect(markers.length).toBeGreaterThanOrEqual(5);
  });

  it('Test 2: _journal.json has exactly 7 entries', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as { entries: unknown[] };
    expect(journal.entries).toHaveLength(7);
  });

  it('Test 2: _journal.json idx=6 entry has tag "0006_sessions" + version "7" + breakpoints true', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    const entry = journal.entries[6];
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(6);
    expect(entry.tag).toBe('0006_sessions');
    expect(entry.version).toBe('7');
    expect(entry.breakpoints).toBe(true);
    expect(typeof entry.when).toBe('number');
    // `when` must be a 10-13 digit ms-since-epoch value strictly greater than
    // idx=5's `when` (1780142072840) so the migrator preserves monotonic ordering.
    expect(entry.when).toBeGreaterThan(1780142072840);
  });

  it('Test 2: _journal.json entries idx 0..5 are unchanged', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as {
      entries: Array<Record<string, unknown>>;
    };
    for (let i = 0; i < EXPECTED_PRIOR_ENTRIES.length; i++) {
      expect(journal.entries[i]).toEqual(EXPECTED_PRIOR_ENTRIES[i]);
    }
  });

  it('Test 3: Drizzle schema sessions.ts exports sessions pgTable handle', async () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
    const mod = await import('../../src/db/schema/sessions.js');
    expect(mod.sessions).toBeDefined();
    // Drizzle pgTable handles expose the SQL name via the `[Symbol.for('drizzle:Name')]`
    // symbol; presence of the column object is a cheaper structural check.
    expect((mod.sessions as unknown as Record<string, unknown>).session_id).toBeDefined();
  });

  it('Test 3: Drizzle schema sessions.ts exports conversationTurns pgTable handle', async () => {
    const mod = await import('../../src/db/schema/sessions.js');
    expect(mod.conversationTurns).toBeDefined();
    expect((mod.conversationTurns as unknown as Record<string, unknown>).turn_id).toBeDefined();
  });

  it('Test 3: sessions.expires_at column declared notNull()', async () => {
    const mod = await import('../../src/db/schema/sessions.js');
    // Drizzle pg-core columns expose `.notNull` as a boolean on the column instance.
    const col = (mod.sessions as unknown as Record<string, unknown>).expires_at as {
      notNull?: boolean;
    };
    expect(col.notNull).toBe(true);
  });

  it('Test 3: sessions.has_pending_tool_call column declared boolean notNull default false', async () => {
    const mod = await import('../../src/db/schema/sessions.js');
    const col = (mod.sessions as unknown as Record<string, unknown>).has_pending_tool_call as {
      notNull?: boolean;
      default?: unknown;
      columnType?: string;
      dataType?: string;
    };
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(false);
    // Boolean column — Drizzle's `.dataType` is 'boolean' for boolean() columns.
    expect(col.dataType).toBe('boolean');
  });

  it('Test 4: db/schema/index.ts barrel re-exports sessions + conversationTurns', () => {
    const idx = readFileSync(SCHEMA_INDEX_PATH, 'utf-8');
    expect(idx).toMatch(/from\s+['"]\.\/sessions\.js['"]/);
    expect(idx).toMatch(/sessions/);
    expect(idx).toMatch(/conversationTurns/);
  });

  it('Test 4: db/schema/index.ts re-export keeps prior requestLog + usageDaily lines unchanged', () => {
    const idx = readFileSync(SCHEMA_INDEX_PATH, 'utf-8');
    expect(idx).toMatch(/from\s+['"]\.\/request_log\.js['"]/);
    expect(idx).toMatch(/from\s+['"]\.\/usage_daily\.js['"]/);
  });

  it('Grep gate: router/src/providers/ contains no import from db/bufferedWriter (SESS-04 sync-write contract)', () => {
    // Defense-in-depth: SessionStore writes are synchronous (RESEARCH §postgres-session-store).
    // No file under src/providers/ may import bufferedWriter. This test passes trivially when
    // src/providers/ does not yet exist (Plans 17-03/17-04 land it); the grep stays green when
    // the directory is populated provided no consumer pulls in bufferedWriter.
    if (!existsSync(PROVIDERS_DIR)) {
      // Directory not yet present — gate is vacuously satisfied.
      expect(true).toBe(true);
      return;
    }
    const stdout = execSync(
      `grep -rE "from .*bufferedWriter" "${PROVIDERS_DIR}" 2>/dev/null || true`,
      { encoding: 'utf-8' },
    );
    expect(stdout.trim()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 18 / v0.11.0 — RETR-04 (migration 0007 atomic tuple integrity).
// Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-07 lands the impl.
//
// Identical structure to the Phase 17 0006 block above — the Drizzle migrator
// silently skips entries missing from `_journal.json`, so the SQL file
// (0007_request_log_hook_log.sql) + Drizzle schema (request_log.ts widening)
// + journal entry (idx=7) MUST land as one atomic git commit.
//
// EXTENSION (Plan 18-01): this scaffold appends idx=7 assertions ONLY. The
// prior idx 0..6 assertions stay byte-for-byte intact — Plan 17-02's
// EXPECTED_PRIOR_ENTRIES table is the immutable baseline.
// ─────────────────────────────────────────────────────────────────────────────

describe('Migration 0007 atomic tuple integrity (P9-01 BLOCK)', () => {
  it.todo('Test 1: SQL file 0007_request_log_hook_log.sql exists');
  it.todo('Test 1: SQL contains ALTER TABLE "request_log" ADD COLUMN "hook_log" JSONB NULL');
  it.todo('Test 1: SQL contains COMMENT ON COLUMN "request_log"."hook_log" with Phase 18 + RETR-04 marker');
  it.todo('Test 1: SQL contains NO CREATE INDEX (write-heavy column per design)');
  it.todo('Test 2: _journal.json has exactly 8 entries (was 7 after Phase 17)');
  it.todo('Test 2: _journal.json idx=7 entry has tag "0007_request_log_hook_log" + version "7" + breakpoints true');
  it.todo('Test 2: _journal.json entries idx 0..6 are unchanged');
  it.todo('Test 3: Drizzle schema request_log.ts contains hook_log: jsonb("hook_log")');
  it.todo('Test 3: db/schema/index.ts barrel re-export still exports requestLog (unchanged)');
  it.todo('Test 4: indivisible tuple — SQL + Drizzle schema + _journal.json all reference 0007 (3-of-3 grep gate)');
});
