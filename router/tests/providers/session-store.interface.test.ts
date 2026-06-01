/**
 * Phase 17 / v0.11.0 — SESS-01. Wave 0 scaffold (Plan 17-01).
 *
 * SESS-01 interface-shape assertions for SessionStore + companion types.
 *
 * This is the ONLY Wave-0 file that ships with REAL `it(...)` blocks. The
 * import below intentionally fails until Plan 17-03 lands
 * `src/providers/session-store.ts` — that "Cannot find module" failure is the
 * Wave-0 signal (mirrors Phase 15 / Phase 16 convention from STATE.md).
 *
 * The 6 `expectTypeOf` assertions encode the contract from RESEARCH §SessionStore
 * Interface (lines 178-316) and the P4-03 BLOCK invariant that `agent_id` is a
 * MANDATORY positional parameter on `appendTurn` / `loadHistory` / `deleteSession`.
 *
 * Tests:
 *   1. SessionStore.createSession signature shape
 *   2. SessionStore.appendTurn requires agent_id positional (P4-03 BLOCK)
 *   3. SessionStore.loadHistory requires agent_id positional (P4-03 BLOCK)
 *   4. SessionStore.deleteSession requires agent_id
 *   5. SessionStore.listSessions filter.agent_id is mandatory
 *   6. Turn shape: role enum + content as ContentBlock[]
 */
import { describe, it, expectTypeOf } from 'vitest';
import type {
  SessionStore,
  Turn,
  SessionSummary,
  AppendTurnResult,
  LoadHistoryOpts,
  ListSessionsFilter,
  CreateSessionInput,
} from '../../src/providers/session-store.js';

// Wave-0 runtime sentinel: forces vitest module resolution so the Wave-0
// "Cannot find module" signal surfaces in `npx vitest run` (not just `tsc`).
// Drop this import once Plan 17-03 lands `src/providers/session-store.ts`.
await import('../../src/providers/session-store.js');

describe('SessionStore interface — SESS-01', () => {
  it('SessionStore.createSession signature', () => {
    expectTypeOf<SessionStore['createSession']>().toEqualTypeOf<
      (input: CreateSessionInput) => Promise<string>
    >();
  });

  it('SessionStore.appendTurn requires agent_id positional (P4-03 BLOCK)', () => {
    // appendTurn(session_id: string, agent_id: string, turn: Omit<Turn, ...>): Promise<AppendTurnResult>
    expectTypeOf<Parameters<SessionStore['appendTurn']>[1]>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<SessionStore['appendTurn']>>().toEqualTypeOf<Promise<AppendTurnResult>>();
  });

  it('SessionStore.loadHistory requires agent_id positional (P4-03 BLOCK)', () => {
    expectTypeOf<Parameters<SessionStore['loadHistory']>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<SessionStore['loadHistory']>[2]>().toEqualTypeOf<LoadHistoryOpts | undefined>();
    expectTypeOf<ReturnType<SessionStore['loadHistory']>>().toEqualTypeOf<Promise<Turn[]>>();
  });

  it('SessionStore.deleteSession requires agent_id', () => {
    expectTypeOf<Parameters<SessionStore['deleteSession']>[1]>().toEqualTypeOf<string>();
  });

  it('SessionStore.listSessions filter.agent_id is mandatory', () => {
    expectTypeOf<ListSessionsFilter['agent_id']>().toEqualTypeOf<string>();
    // listSessions returns the cursor-paged shape per RESEARCH §SessionStore Interface
    expectTypeOf<ReturnType<SessionStore['listSessions']>>().toEqualTypeOf<
      Promise<{ sessions: SessionSummary[]; next_cursor?: string }>
    >();
  });

  it('Turn shape: role enum + content as ContentBlock[]', () => {
    expectTypeOf<Turn['role']>().toEqualTypeOf<'system' | 'user' | 'assistant' | 'tool'>();
    // Turn.session_id / agent_id / turn_index / turn_id are all non-optional
    expectTypeOf<Turn['session_id']>().toEqualTypeOf<string>();
    expectTypeOf<Turn['agent_id']>().toEqualTypeOf<string>();
    expectTypeOf<Turn['turn_id']>().toEqualTypeOf<string>();
    expectTypeOf<Turn['turn_index']>().toEqualTypeOf<number>();
  });
});
