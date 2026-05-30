// router/tests/migration0005.test.ts
//
// Atomic tuple integrity check for migration 0005.
// Phase 14 (v0.11.0 — POL-04, D-23): SQL file + Drizzle schema + journal entry
// must all be present in one commit or the Drizzle migrator silently skips 0005
// (project memory: project_drizzle_migration_journal.md).
//
// This test asserts:
//   1. SQL file exists with three ADD COLUMN IF NOT EXISTS statements
//   2. _journal.json has idx=5, tag=0005_request_log_scoped_ids, 6 total entries
//   3. Drizzle schema exports tenant_id, project_id, workload_class text columns
//
// [Rule 3 deviation: test path moved from src/db/__tests__/ to tests/ to match
//  vitest.config.ts include pattern `tests/**/*.test.ts`]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve paths relative to router/ root so tests work from any cwd
const ROUTER_ROOT = path.resolve(__dirname, '..');
const SQL_PATH = path.join(
  ROUTER_ROOT,
  'db/migrations/0005_request_log_scoped_ids.sql',
);
const JOURNAL_PATH = path.join(
  ROUTER_ROOT,
  'db/migrations/meta/_journal.json',
);
const SCHEMA_PATH = path.join(
  ROUTER_ROOT,
  'src/db/schema/request_log.ts',
);

describe('Migration 0005 atomic tuple integrity', () => {
  it('Test 1: SQL file exists', () => {
    expect(existsSync(SQL_PATH)).toBe(true);
  });

  it('Test 1: SQL contains ADD COLUMN IF NOT EXISTS "tenant_id"', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "tenant_id"/);
  });

  it('Test 1: SQL contains ADD COLUMN IF NOT EXISTS "project_id"', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "project_id"/);
  });

  it('Test 1: SQL contains ADD COLUMN IF NOT EXISTS "workload_class"', () => {
    const sql = readFileSync(SQL_PATH, 'utf-8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "workload_class"/);
  });

  it('Test 2: _journal.json has exactly 6 entries', () => {
    const raw = readFileSync(JOURNAL_PATH, 'utf-8');
    const journal = JSON.parse(raw) as { entries: unknown[] };
    expect(journal.entries).toHaveLength(6);
  });

  it('Test 2: _journal.json has idx=5 entry with correct tag', () => {
    const raw = readFileSync(JOURNAL_PATH, 'utf-8');
    const journal = JSON.parse(raw) as {
      entries: Array<{ idx: number; tag: string; version: string; breakpoints: boolean }>;
    };
    const entry5 = journal.entries.find((e) => e.idx === 5);
    expect(entry5).toBeDefined();
    expect(entry5?.tag).toBe('0005_request_log_scoped_ids');
    expect(entry5?.breakpoints).toBe(true);
    expect(entry5?.version).toBe('7');
  });

  it('Test 2: _journal.json prior entries idx 0..4 are unchanged', () => {
    const raw = readFileSync(JOURNAL_PATH, 'utf-8');
    const journal = JSON.parse(raw) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const expectedTags = [
      '0000_init',
      '0001_cloud_spend_daily',
      '0002_request_log_idempotency_key',
      '0003_request_log_cost_cents',
      '0004_cost_per_agent_daily',
    ];
    expectedTags.forEach((tag, idx) => {
      expect(journal.entries[idx]).toBeDefined();
      expect(journal.entries[idx].idx).toBe(idx);
      expect(journal.entries[idx].tag).toBe(tag);
    });
  });

  it('Test 3: Drizzle schema exports tenant_id text column', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    expect(schema).toMatch(/tenant_id:\s*text\('tenant_id'\)/);
  });

  it('Test 3: Drizzle schema exports project_id text column', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    expect(schema).toMatch(/project_id:\s*text\('project_id'\)/);
  });

  it('Test 3: Drizzle schema exports workload_class text column', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    expect(schema).toMatch(/workload_class:\s*text\('workload_class'\)/);
  });
});
