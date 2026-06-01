/**
 * Phase 17 / v0.11.0 — P9-01 BLOCK + SESS-02. Wave 0 scaffold (Plan 17-01).
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
 * Wave 0 = it.todo only. Plan 17-02 ships the SQL + schema + journal entry
 * atomically; this test goes green at that point.
 *
 * Secondary contract — single grep gate at the bottom asserts the
 * `router/src/providers/` namespace contains no `bufferedWriter` import,
 * defending the SESS-04 sync-write contract (RESEARCH §postgres-session-store
 * cited in PATTERNS line 663).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

// Resolve paths relative to router/ root — one level deeper than
// `tests/migration0005.test.ts`, so `__dirname` climbs two levels.
const ROUTER_ROOT = path.resolve(__dirname, '../..');
const SQL_PATH = path.join(ROUTER_ROOT, 'db/migrations/0006_sessions.sql');
const JOURNAL_PATH = path.join(ROUTER_ROOT, 'db/migrations/meta/_journal.json');
const SCHEMA_PATH = path.join(ROUTER_ROOT, 'src/db/schema/sessions.ts');
const SCHEMA_INDEX_PATH = path.join(ROUTER_ROOT, 'src/db/schema/index.ts');
const PROVIDERS_DIR = path.join(ROUTER_ROOT, 'src/providers');

// Wave-0 sentinel: keep these constants reachable so Plan 17-02 can flip
// it.todo → real assertions without import-order churn.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _waveZeroPaths = {
  existsSync,
  readFileSync,
  ROUTER_ROOT,
  SQL_PATH,
  JOURNAL_PATH,
  SCHEMA_PATH,
  SCHEMA_INDEX_PATH,
  PROVIDERS_DIR,
};

describe('Migration 0006 atomic tuple integrity (P9-01 BLOCK)', () => {
  it.todo('Test 1: SQL file 0006_sessions.sql exists');
  it.todo('Test 1: SQL contains CREATE TABLE IF NOT EXISTS "sessions"');
  it.todo('Test 1: SQL contains CREATE TABLE IF NOT EXISTS "conversation_turns"');
  it.todo('Test 1: SQL contains expires_at TIMESTAMPTZ NOT NULL');
  it.todo('Test 1: SQL contains has_pending_tool_call boolean NOT NULL DEFAULT false');
  it.todo('Test 1: SQL contains REFERENCES "sessions"("session_id") ON DELETE CASCADE');
  it.todo('Test 1: SQL contains UNIQUE constraint on (session_id, turn_index)');
  it.todo('Test 1: SQL uses --> statement-breakpoint between every DDL');
  it.todo('Test 2: _journal.json has exactly 7 entries');
  it.todo('Test 2: _journal.json idx=6 entry has tag "0006_sessions" + version "7" + breakpoints true');
  it.todo('Test 2: _journal.json entries idx 0..5 are unchanged');
  it.todo('Test 3: Drizzle schema sessions.ts exports sessions pgTable handle');
  it.todo('Test 3: Drizzle schema sessions.ts exports conversationTurns pgTable handle');
  it.todo('Test 3: sessions.expires_at column declared notNull()');
  it.todo('Test 3: sessions.has_pending_tool_call column declared boolean notNull default false');
  it.todo('Test 4: db/schema/index.ts barrel re-exports sessions + conversationTurns');
  it.todo('Grep gate: router/src/providers/ contains no import from db/bufferedWriter (SESS-04 sync-write contract)');
});
