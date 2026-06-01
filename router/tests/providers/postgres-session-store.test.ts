/**
 * Phase 17 / v0.11.0 — SESS-02..SESS-04 + P4-02 BLOCK + P4-01 + Pitfall 17-B/17-H.
 * Wave 0 scaffold (Plan 17-01).
 *
 * Integration tests against a real Postgres fixture (Drizzle migrator + pg Pool —
 * mirrors `router/tests/integration/cloud-spend-daily.test.ts` setup). Every case
 * is `it.todo` until Plan 17-03 / Plan 17-04 lands `PostgresSessionStore`.
 *
 * The `SessionStore` import is intentional — it fails with "Cannot find module"
 * until `src/providers/session-store.ts` exists (Wave-0 signal).
 */
import { describe, it } from 'vitest';
import type { SessionStore } from '../../src/providers/session-store.js';

// Wave-0 import gate — the type is read here only to keep the missing-module
// error surface explicit; flipped to real fixture wiring in Plan 17-04.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SessionStoreShape = SessionStore;

// Wave-0 runtime sentinel: forces vitest module resolution so the missing
// module error surfaces at `npx vitest run`. Drop in Plan 17-04.
await import('../../src/providers/session-store.js');

describe('PostgresSessionStore — SESS-02..04 + P4-02 BLOCK', () => {
  it.todo('SESS-02: Drizzle insert + select round-trip on conversation_turns');
  it.todo('SESS-02: expires_at NOT NULL rejects null insert');
  it.todo('SESS-03: agent_id mismatch returns empty');
  it.todo('SESS-03: loadHistory with matching agent_id returns rows');
  it.todo('SESS-04: 1s timeout fail-open returns persisted:false');
  it.todo('SESS-04: happy-path commit returns persisted:true with turn_index');
  it.todo('P4-02 BLOCK: 10 parallel append calls produce turn_index [1..10] no gaps no dupes');
  it.todo('P4-01: expired session returns [] on loadHistory');
  it.todo('Pitfall 17-B: appendTurn with mismatched agent_id throws SessionAgentMismatchError');
  it.todo('Pitfall 17-H: createSession without ttl_seconds computes expires_at = DEFAULT_TTL_SEC from now (±1s)');
  it.todo('Sliding TTL (Q6): successful appendTurn refreshes sessions.expires_at to now+TTL');
  it.todo('Idempotency leader/follower (Q5): follower replay skips appendTurn — only leader writes');
});
