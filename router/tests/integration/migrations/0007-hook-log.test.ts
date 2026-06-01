/**
 * Phase 18 / v0.11.0 — RETR-04 (migration 0007: request_log.hook_log JSONB).
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-07 lands the impl.
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
 * authoritative wording for Plan 18-07's flip.
 */
import { describe, it } from 'vitest';

describe('Migration 0007: request_log.hook_log JSONB column', () => {
  it.todo('request_log.hook_log column exists with data_type=jsonb');
  it.todo('request_log.hook_log is NULLABLE (is_nullable=YES)');
  it.todo('COMMENT ON COLUMN request_log.hook_log mentions Phase 18 + RETR-04 + HookLogEntry shape');
  it.todo('no index on hook_log (write-heavy column per design)');
  it.todo('inserting JSON array of HookLogEntry objects round-trips through SELECT');
  it.todo('NULL value selects back as NULL (no default array)');
  it.todo('Drizzle schema request_log.hook_log declared as jsonb (verified via $inferSelect type)');
});
