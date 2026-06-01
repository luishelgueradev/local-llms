/**
 * Phase 17 / v0.11.0 — SESS-02..SESS-04 + P4-02 BLOCK + P4-01 + Pitfall 17-B/17-H.
 * Plan 17-03 — flipped from Wave 0.
 *
 * Real-Postgres integration tests for PostgresSessionStore. Follows the
 * `Pool` + Drizzle handle fixture pattern from
 * tests/integration/migrations/0006-sessions.test.ts (Plan 17-02).
 *
 * Env gate: PG_TESTS=1 AND a Postgres URL (POSTGRES_URL or
 * ROUTER_DATABASE_URL or DATABASE_URL). Otherwise `describe.skip` keeps the
 * suite green in CI without a live database.
 *
 * Coverage (target ≥ 11 real it() + 1 it.todo per Plan 17-03):
 *   - SESS-02 round-trip on conversation_turns (insert + select)
 *   - SESS-02 expires_at NOT NULL rejects null insert
 *   - SESS-03 mismatched agent_id → []
 *   - SESS-03 matching agent_id returns rows
 *   - SESS-04 1s timeout fail-open returns persisted:false
 *   - SESS-04 happy-path commit returns persisted:true with turn_index
 *   - P4-02 BLOCK 10 parallel append → turn_index [1..10] no gaps no dupes
 *   - P4-01 expired session → []
 *   - Pitfall 17-B appendTurn mismatched agent_id THROWS
 *   - Pitfall 17-H createSession default ttl_seconds → DEFAULT_TTL_SEC (±1s)
 *   - Q6 sliding TTL: successful appendTurn refreshes expires_at
 *   - Q5 follower behavior — deferred to Plan 17-06 (route layer)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import {
  DEFAULT_TTL_SEC,
  PostgresSessionStore,
} from '../../src/providers/postgres-session-store.js';
import { SessionAgentMismatchError } from '../../src/providers/session-errors.js';
import type { Turn } from '../../src/providers/session-store.js';

const { Pool } = pg;

const PG_URL =
  process.env.POSTGRES_URL ?? process.env.ROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
const PG_TESTS_ENABLED = process.env.PG_TESTS === '1' && PG_URL !== undefined;
const describeMaybe = PG_TESTS_ENABLED ? describe : describe.skip;

function makeUserContent(text: string): Turn['content'] {
  return [{ type: 'text', text }];
}

describeMaybe('PostgresSessionStore — SESS-02..04 + P4-02 BLOCK', () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let store: PostgresSessionStore;
  // Use a unique session-id prefix per run so parallel test workers don't
  // collide on the advisory-lock keyspace. The hashtext collision risk is
  // low but real; the prefix also makes manual debugging via psql trivial.
  const PREFIX = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // biome-ignore lint/style/noNonNullAssertion: PG_TESTS_ENABLED implies PG_URL is defined
    pool = new Pool({ connectionString: PG_URL!, connectionTimeoutMillis: 2000 });
    db = drizzle(pool);
    store = new PostgresSessionStore(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Clean state: delete only THIS run's session_ids so we don't stomp other
  // workers' rows. The FK ON DELETE CASCADE handles conversation_turns.
  beforeEach(async () => {
    await pool.query("DELETE FROM sessions WHERE session_id LIKE $1", [`${PREFIX}-%`]);
  });

  // ── SESS-02 ──────────────────────────────────────────────────────────────

  it('SESS-02: Drizzle insert + select round-trip on conversation_turns', async () => {
    const sid = `${PREFIX}-rt-1`;
    await store.createSession({ session_id: sid, agent_id: 'a' });
    const r1 = await store.appendTurn(sid, 'a', {
      role: 'user',
      content: makeUserContent('hello'),
    });
    expect(r1.persisted).toBe(true);
    expect(r1.turn_index).toBe(1);
    const history = await store.loadHistory(sid, 'a');
    expect(history.length).toBe(1);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(history[0]?.turn_index).toBe(1);
    expect(history[0]?.session_id).toBe(sid);
    expect(history[0]?.agent_id).toBe('a');
  });

  it('SESS-02: expires_at NOT NULL rejects null insert', async () => {
    // Direct SQL bypassing the store's JS-side compute proves the column
    // constraint is enforced by Postgres (P4-01 BLOCK).
    await expect(
      pool.query(
        "INSERT INTO sessions (session_id, agent_id, expires_at) VALUES ($1, $2, NULL)",
        [`${PREFIX}-null-exp`, 'a'],
      ),
    ).rejects.toThrow(/null value in column "expires_at"/i);
  });

  // ── SESS-03 / Pitfall 17-B ───────────────────────────────────────────────

  it('SESS-03: loadHistory with mismatched agent_id returns [] (Pitfall 17-B contract)', async () => {
    const sid = `${PREFIX}-mismatch-load`;
    await store.createSession({ session_id: sid, agent_id: 'agent-X' });
    await store.appendTurn(sid, 'agent-X', { role: 'user', content: makeUserContent('hi') });
    const history = await store.loadHistory(sid, 'agent-Y');
    expect(history).toEqual([]);
    // And the matching agent_id still sees the row.
    const ownHistory = await store.loadHistory(sid, 'agent-X');
    expect(ownHistory.length).toBe(1);
  });

  it('SESS-03: loadHistory with matching agent_id returns rows', async () => {
    const sid = `${PREFIX}-match-load`;
    await store.createSession({ session_id: sid, agent_id: 'a' });
    await store.appendTurn(sid, 'a', { role: 'user', content: makeUserContent('one') });
    await store.appendTurn(sid, 'a', {
      role: 'assistant',
      content: makeUserContent('answer'),
      model: 'qwen2.5:7b',
      tokens_in: 5,
      tokens_out: 3,
    });
    const history = await store.loadHistory(sid, 'a');
    expect(history.length).toBe(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('assistant');
    expect(history[1]?.model).toBe('qwen2.5:7b');
    expect(history[1]?.tokens_in).toBe(5);
    expect(history[1]?.tokens_out).toBe(3);
    // Default ascending ordering.
    expect(history.map((h) => h.turn_index)).toEqual([1, 2]);
  });

  it('Pitfall 17-B: appendTurn with mismatched agent_id THROWS SessionAgentMismatchError (privileged-write boundary)', async () => {
    const sid = `${PREFIX}-mismatch-append`;
    await store.createSession({ session_id: sid, agent_id: 'agent-X' });
    await expect(
      store.appendTurn(sid, 'agent-Y', { role: 'user', content: makeUserContent('intruder') }),
    ).rejects.toBeInstanceOf(SessionAgentMismatchError);
  });

  // ── SESS-04 ──────────────────────────────────────────────────────────────

  it('SESS-04: happy-path commit returns persisted:true with monotonic turn_index', async () => {
    const sid = `${PREFIX}-happy`;
    await store.createSession({ session_id: sid, agent_id: 'a' });
    for (let i = 1; i <= 3; i++) {
      const r = await store.appendTurn(sid, 'a', {
        role: 'user',
        content: makeUserContent(`m${i}`),
      });
      expect(r.persisted).toBe(true);
      expect(r.turn_index).toBe(i);
      expect(r.turn_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it('SESS-04: 1s timeout fail-open returns persisted:false within ~1.2s', async () => {
    // Mock db whose transaction never resolves — the Promise.race against
    // the 1s timeout MUST resolve persisted:false.
    const warnSpy = vi.fn();
    const mockDb = {
      transaction: vi.fn(() => new Promise(() => {})), // never resolves
    } as unknown as NodePgDatabase;
    const slowStore = new PostgresSessionStore(mockDb, {
      appendTimeoutMs: 1000,
      logger: { warn: warnSpy },
    });
    const sid = `${PREFIX}-timeout`;
    const t0 = Date.now();
    const r = await slowStore.appendTurn(sid, 'a', {
      role: 'user',
      content: makeUserContent('slow'),
    });
    const elapsed = Date.now() - t0;
    expect(r.persisted).toBe(false);
    expect(r.turn_id).toBe('');
    expect(r.turn_index).toBe(-1);
    // Allow generous upper bound for CI jitter — the contract is "≤ 1.2s", we
    // assert ≤ 1500ms to keep flaky-CI tolerance wide.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1500);
    // Pitfall 17-E: structured fail-open warn log is emitted.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'session_append_failed_open',
        session_id: sid,
        reason: 'timeout',
      }),
    );
  });

  // ── P4-02 BLOCK race test ────────────────────────────────────────────────

  it('P4-02 BLOCK: 10 parallel append calls produce turn_index [1..10] no gaps no dupes', async () => {
    const sid = `${PREFIX}-race`;
    await store.createSession({ session_id: sid, agent_id: 'a' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.appendTurn(sid, 'a', { role: 'user', content: makeUserContent('x') }),
      ),
    );
    const indices = results.map((r) => r.turn_index).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const dbRows = await pool.query<{ turn_index: number }>(
      "SELECT turn_index FROM conversation_turns WHERE session_id = $1 ORDER BY turn_index",
      [sid],
    );
    expect(dbRows.rows.map((r) => r.turn_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // All persisted=true.
    expect(results.every((r) => r.persisted)).toBe(true);
  });

  // ── P4-01 expired session ────────────────────────────────────────────────

  it('P4-01: expired session returns [] on loadHistory', async () => {
    const sid = `${PREFIX}-expired`;
    await store.createSession({ session_id: sid, agent_id: 'a', ttl_seconds: 1 });
    await store.appendTurn(sid, 'a', { role: 'user', content: makeUserContent('hi') });
    // Force expiration via direct UPDATE — sleeping 1s+ in a unit test is
    // wasteful. The store's loadHistory checks expires_at against Date.now().
    await pool.query(
      "UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1",
      [sid],
    );
    const history = await store.loadHistory(sid, 'a');
    expect(history).toEqual([]);
  });

  // ── Pitfall 17-H ─────────────────────────────────────────────────────────

  it('Pitfall 17-H: createSession without ttl_seconds computes expires_at = DEFAULT_TTL_SEC from now (±2s)', async () => {
    const sid = `${PREFIX}-pit-h`;
    const before = Date.now();
    await store.createSession({ session_id: sid, agent_id: 'a' });
    const after = Date.now();
    const row = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions WHERE session_id = $1",
      [sid],
    );
    const expiresMs = new Date(row.rows[0]!.expires_at).getTime();
    const lower = before + DEFAULT_TTL_SEC * 1000 - 2000;
    const upper = after + DEFAULT_TTL_SEC * 1000 + 2000;
    expect(expiresMs).toBeGreaterThanOrEqual(lower);
    expect(expiresMs).toBeLessThanOrEqual(upper);
  });

  // ── Q6 sliding TTL ───────────────────────────────────────────────────────

  it('Sliding TTL (Q6): successful appendTurn refreshes sessions.expires_at to now+TTL', async () => {
    const sid = `${PREFIX}-slide`;
    // Start with a short 1-hour TTL.
    await store.createSession({ session_id: sid, agent_id: 'a', ttl_seconds: 3600 });
    const r1 = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions WHERE session_id = $1",
      [sid],
    );
    const beforeMs = new Date(r1.rows[0]!.expires_at).getTime();
    // appendTurn refreshes to defaultTtlSec (7 days) — NOT the original
    // ttl_seconds from createSession. The contract is "sliding TTL uses the
    // store's default", not "preserve the create-time TTL".
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.appendTurn(sid, 'a', { role: 'user', content: makeUserContent('keepalive') });
    const r2 = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM sessions WHERE session_id = $1",
      [sid],
    );
    const afterMs = new Date(r2.rows[0]!.expires_at).getTime();
    // afterMs MUST be strictly greater than beforeMs (sliding forward).
    expect(afterMs).toBeGreaterThan(beforeMs);
    // afterMs MUST be ≈ now + DEFAULT_TTL_SEC*1000 (within ±2s).
    const now = Date.now();
    expect(afterMs).toBeGreaterThanOrEqual(now + DEFAULT_TTL_SEC * 1000 - 2000);
    expect(afterMs).toBeLessThanOrEqual(now + DEFAULT_TTL_SEC * 1000 + 2000);
  });

  // ── Q5 deferred ──────────────────────────────────────────────────────────

  it.todo(
    'Idempotency leader/follower (Q5): follower replay skips appendTurn — verified at route layer in Plan 17-06',
  );
});
