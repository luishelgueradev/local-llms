/**
 * Phase 17 / v0.11.0 — SESS-01 (Plan 17-01 scaffolded; Plan 17-03 flipped).
 *
 * SESS-01 interface-shape assertions for SessionStore + companion types, plus
 * Plan 17-03's 4 error-class unit tests (`InvalidSessionIdError`,
 * `SessionNotFoundError`, `SessionExpiredError`, `SessionAgentMismatchError`).
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
 *   7-10. SessionStore error classes — code, httpStatus, envelope mapping
 *         (Pitfall 17-B: only InvalidSessionIdError reaches the wire envelope).
 */
import { describe, expect, it, expectTypeOf } from 'vitest';
import type {
  SessionStore,
  Turn,
  SessionSummary,
  AppendTurnResult,
  LoadHistoryOpts,
  ListSessionsFilter,
  CreateSessionInput,
} from '../../src/providers/session-store.js';
import {
  InvalidSessionIdError,
  SessionAgentMismatchError,
  SessionExpiredError,
  SessionNotFoundError,
} from '../../src/providers/session-errors.js';
import {
  mapToHttpStatus,
  toAnthropicErrorEnvelope,
  toOpenAIErrorEnvelope,
} from '../../src/errors/envelope.js';

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

describe('Session error classes — Plan 17-03', () => {
  it('InvalidSessionIdError code + httpStatus + envelope mapping', () => {
    const err = new InvalidSessionIdError('bad value');
    expect(err.code).toBe('invalid_session_id');
    expect(err.httpStatus).toBe(400);
    expect(err.name).toBe('InvalidSessionIdError');
    // Bubbles through the centralized envelope mapper (the ONLY one of the four
    // that does — Pitfall 17-B route policy).
    expect(mapToHttpStatus(err)).toBe(400);
    const openai = toOpenAIErrorEnvelope(err);
    expect(openai).toEqual({
      error: {
        message: expect.stringContaining('X-Session-ID'),
        type: 'invalid_request_error',
        code: 'invalid_session_id',
        param: 'X-Session-ID',
      },
    });
    const anthropic = toAnthropicErrorEnvelope(err);
    expect(anthropic).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringContaining('X-Session-ID') },
    });
  });

  it('SessionNotFoundError httpStatus 404 (defense-in-depth — routes catch locally)', () => {
    const err = new SessionNotFoundError('sess-x');
    expect(err.code).toBe('session_not_found');
    expect(err.httpStatus).toBe(404);
    expect(err.name).toBe('SessionNotFoundError');
    expect(mapToHttpStatus(err)).toBe(404);
    // Does NOT appear in the OpenAI envelope branch — falls through to the
    // default internal_error handler. Pitfall 17-B: routes catch locally so
    // this NEVER reaches the wire.
    const openai = toOpenAIErrorEnvelope(err);
    expect(openai).toMatchObject({ error: { type: 'internal_error' } });
  });

  it('SessionExpiredError httpStatus 410 (defense-in-depth — routes catch locally)', () => {
    const err = new SessionExpiredError('sess-x', new Date('2025-01-01T00:00:00Z'));
    expect(err.code).toBe('session_expired');
    expect(err.httpStatus).toBe(410);
    expect(err.name).toBe('SessionExpiredError');
    expect(mapToHttpStatus(err)).toBe(410);
    const openai = toOpenAIErrorEnvelope(err);
    expect(openai).toMatchObject({ error: { type: 'internal_error' } });
  });

  it('SessionAgentMismatchError httpStatus 403 (bubbles from appendTurn only)', () => {
    const err = new SessionAgentMismatchError('sess-x');
    expect(err.code).toBe('session_agent_mismatch');
    expect(err.httpStatus).toBe(403);
    expect(err.name).toBe('SessionAgentMismatchError');
    expect(mapToHttpStatus(err)).toBe(403);
    // Mismatch from loadHistory is caught locally; from appendTurn it
    // bubbles — but at the envelope layer it still falls through to the
    // default internal_error mapping (the route handler decides whether to
    // re-throw to the envelope or swallow).
    const openai = toOpenAIErrorEnvelope(err);
    expect(openai).toMatchObject({ error: { type: 'internal_error' } });
  });
});
