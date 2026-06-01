// router/src/providers/postgres-session-store.ts — synchronous Postgres-backed
// SessionStore (Phase 17 / v0.11.0 — SESS-01..04).
//
// Invariants encoded here (cross-referenced to 17-RESEARCH.md):
//
//   SESS-03 / P4-03 BLOCK  agent_id is a MANDATORY positional parameter on
//                          loadHistory + appendTurn + deleteSession + the
//                          listSessions filter. The WHERE clause unconditionally
//                          includes it; mismatched agent_id → [] on loadHistory
//                          (Pitfall 17-B), throws SessionAgentMismatchError on
//                          appendTurn (privileged-write boundary).
//
//   SESS-04                appendTurn is a SYNCHRONOUS durable write with a 1s
//                          timeout. Promise.race(insertTx, timeoutPromise). On
//                          timeout: persisted=false; caller proceeds stateless.
//                          Explicitly NOT bufferedWriter's fire-and-forget
//                          pattern — see db/bufferedWriter.ts header for the
//                          contrast. The session truth would be lost on crash
//                          before flush; SessionStore picks sync write so the
//                          turn either commits or fails-open observably.
//
//   P4-02 BLOCK            pg_advisory_xact_lock(hashtext(session_id)) INSIDE
//                          the transaction, BEFORE the SELECT MAX(turn_index).
//                          Lock-first-then-read prevents two concurrent
//                          appendTurn calls from computing the same
//                          turn_index+1. Verified by a 10-parallel race test.
//                          The advisory lock is transaction-scoped (`xact_lock`,
//                          not `pg_advisory_lock`) so it auto-releases on
//                          COMMIT/ROLLBACK with no leak risk. `hashtext` maps
//                          1..128-char session_id to int4 — collision risk is
//                          acceptable: a collision merely serializes two
//                          unrelated sessions for one transaction.
//
//   P4-01                  expires_at TIMESTAMPTZ NOT NULL. createSession
//                          computes Date.now()+TTL BEFORE the Drizzle insert
//                          (Pitfall 17-H — never rely on Postgres NOW()+interval
//                          inside Drizzle's value-builder; the JS-side compute
//                          guarantees the value is present at insert time).
//
//   Q6 (sliding TTL)       Every successful appendTurn refreshes
//                          sessions.expires_at = now() + defaultTtlSec inside
//                          the same tx. Active sessions stay alive; idle ones
//                          age out without operator intervention.
//
//   Pitfall 17-E           appendTurn fail-open emits a structured warn log
//                          ({ event: 'session_append_failed_open', ... }) so
//                          operators can correlate router_session_append_*
//                          counters when Plan 17-07 lands them.
//
//   SUMP-03                computePendingToolCall derives
//                          sessions.has_pending_tool_call from the current
//                          turn's role + tool_calls + tool_call_id. Conservative
//                          algorithm per RESEARCH §pending-tool-call note (line
//                          636) — over-conservative is safe because the v0.11.0
//                          Noop summarizer ignores the flag.
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ulid } from 'ulid';

import {
  conversationTurns,
  sessions,
  type SessionRow,
} from '../db/schema/index.js';
import type { ContentBlock, ToolUseBlock } from '../translation/canonical.js';
import {
  SessionAgentMismatchError,
  SessionExpiredError,
  SessionNotFoundError,
} from './session-errors.js';
import type {
  AppendTurnResult,
  CreateSessionInput,
  ListSessionsFilter,
  LoadHistoryOpts,
  SessionStore,
  SessionSummary,
  Turn,
} from './session-store.js';

/**
 * Default TTL for new sessions: 7 days.
 *
 * Q2 RESOLVED (CONTEXT.md). 7 days is the chat-history-comfort window —
 * agents that pause for a weekend pick up Monday morning without operators
 * touching anything; longer-lived "knowledge" lives in retrieval (out of
 * scope for v0.11.0). Override per-session via CreateSessionInput.ttl_seconds
 * or per-store via PostgresSessionStore constructor opts.
 */
export const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * Default 1s timeout for appendTurn fail-open (SESS-04). The 1s ceiling is the
 * SLA the route handler relies on to bound worst-case latency; agents block on
 * the durable write before continuing.
 */
const DEFAULT_APPEND_TIMEOUT_MS = 1000;

/** Minimal pino-compatible logger surface. Tests inject vi.fn()-backed mocks. */
export interface PostgresSessionStoreLogger {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** Constructor options. */
export interface PostgresSessionStoreOpts {
  /** Override the 7-day default. */
  defaultTtlSec?: number;
  /** Override the 1s default fail-open timeout. */
  appendTimeoutMs?: number;
  logger?: PostgresSessionStoreLogger;
}

/**
 * Pending-tool-call derivation per RESEARCH §pending-tool-call note (line 636).
 *
 * Algorithm (conservative — the v0.11.0 Noop summarizer ignores this flag, so
 * over-conservative is safe):
 *
 *   - role='assistant' with tool_calls.length > 0  → set TRUE
 *     (the assistant has emitted tool calls that have not yet been resolved)
 *   - role='assistant' with no tool_calls          → set FALSE
 *     (this assistant turn closes any prior pending tool calls — the model
 *     chose to answer directly without further tool invocations)
 *   - role='tool'                                  → set FALSE
 *     (a tool result arrived; conservative algorithm assumes it resolves the
 *     pending state. The multi-parallel-tool-call edge — where multiple tool
 *     turns must arrive before pending clears — is intentionally collapsed:
 *     the flag is a hint, not a contract, and the next assistant turn will
 *     reset it correctly. Future SummaryProvider revisions can tighten this
 *     once the multi-call audit trail is needed.)
 *   - role='system' or role='user'                 → return prev unchanged
 *     (only assistant/tool turns mutate the flag)
 */
function computePendingToolCall(
  role: Turn['role'],
  tool_calls: ToolUseBlock[] | undefined,
  _tool_call_id: string | undefined,
  prev: boolean,
): boolean {
  if (role === 'assistant') {
    return (tool_calls?.length ?? 0) > 0;
  }
  if (role === 'tool') {
    return false;
  }
  return prev;
}

/**
 * Postgres-backed SessionStore. Wraps a `NodePgDatabase` Drizzle handle.
 *
 * Construction is cheap (no pool side effects); the first DB hit is the
 * first call to a SessionStore method. Tests typically construct one per
 * `describe` block and share it across `it()` calls — see
 * tests/providers/postgres-session-store.test.ts.
 */
export class PostgresSessionStore implements SessionStore {
  private readonly defaultTtlSec: number;
  private readonly appendTimeoutMs: number;
  private readonly logger: PostgresSessionStoreLogger;

  constructor(
    private readonly db: NodePgDatabase,
    opts: PostgresSessionStoreOpts = {},
  ) {
    this.defaultTtlSec = opts.defaultTtlSec ?? DEFAULT_TTL_SEC;
    this.appendTimeoutMs = opts.appendTimeoutMs ?? DEFAULT_APPEND_TIMEOUT_MS;
    this.logger = opts.logger ?? { warn: () => {} };
  }

  // ── createSession ────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<string> {
    // Pitfall 17-H: compute expires_at on the JS side BEFORE the insert. The
    // Drizzle value-builder otherwise has no way to express `NOW() + interval
    // '7 days'` portably; the JS-side compute also makes the test assertion
    // (`expires_at - Date.now() ≈ TTL_MS`) deterministic.
    const ttlSec = input.ttl_seconds ?? this.defaultTtlSec;
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const session_id = input.session_id ?? ulid();

    return this.db.transaction(async (tx) => {
      // Look up the row first — idempotent re-creation refreshes expires_at,
      // and a different agent_id is a SessionAgentMismatchError.
      const existing = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, session_id));
      const row = existing[0];
      if (row) {
        if (row.agent_id !== input.agent_id) {
          throw new SessionAgentMismatchError(session_id);
        }
        await tx
          .update(sessions)
          .set({ updated_at: new Date(), expires_at: expiresAt })
          .where(eq(sessions.session_id, session_id));
        return session_id;
      }
      await tx.insert(sessions).values({
        session_id,
        agent_id: input.agent_id,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        expires_at: expiresAt,
        metadata: input.metadata,
      });
      return session_id;
    });
  }

  // ── appendTurn (sync write with 1s fail-open — SESS-04) ──────────────────

  async appendTurn(
    session_id: string,
    agent_id: string,
    turn: Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index' | 'ts'>,
  ): Promise<AppendTurnResult> {
    // Wrap the transactional insert in Promise.race against a 1s timeout.
    // The timeout RESOLVES (does not reject) with persisted:false so the
    // caller can branch on the flag instead of catching an exception. The
    // underlying tx may still complete in the background — that's acceptable;
    // the next loadHistory will see it. The danger is unbounded wait, not
    // stale read.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<AppendTurnResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        // Pitfall 17-E: structured fail-open log. Plan 17-07 will wire the
        // router_session_append_failed_total{reason="timeout"} counter.
        // TODO(17-07): increment router_session_append_failed_total{reason="timeout"}
        this.logger.warn({
          event: 'session_append_failed_open',
          session_id,
          agent_id,
          reason: 'timeout',
          timeout_ms: this.appendTimeoutMs,
        });
        resolve({ turn_id: '', turn_index: -1, persisted: false });
      }, this.appendTimeoutMs);
    });

    try {
      return await Promise.race([
        this.appendTurnTx(session_id, agent_id, turn),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Inner transactional implementation of appendTurn.
   *
   * P4-02 BLOCK: the FIRST statement inside the transaction is
   * `SELECT pg_advisory_xact_lock(hashtext($1::text))`. The lock is acquired
   * BEFORE the SELECT MAX(turn_index), guaranteeing that two concurrent
   * writers on the same session_id serialize (the second blocks until the
   * first commits, then computes MAX correctly).
   */
  private async appendTurnTx(
    session_id: string,
    agent_id: string,
    turn: Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index' | 'ts'>,
  ): Promise<AppendTurnResult> {
    return this.db.transaction(async (tx) => {
      // P4-02 BLOCK: lock-first-then-read. Explicit ::text cast keeps the
      // parameterized query safe under any Postgres type-inference edge.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session_id}::text))`);

      // Validate session existence + agent_id + expires_at inside the lock.
      const sessRows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, session_id));
      const sessRow = sessRows[0];
      if (!sessRow) {
        throw new SessionNotFoundError(session_id);
      }
      if (sessRow.agent_id !== agent_id) {
        // Privileged-write boundary (Pitfall 17-B contrast): appendTurn DOES
        // throw on mismatch. The caller already presumed ownership; refusing
        // them with 403 is correct and does not leak.
        throw new SessionAgentMismatchError(session_id);
      }
      if (sessRow.expires_at.getTime() < Date.now()) {
        throw new SessionExpiredError(session_id, sessRow.expires_at);
      }

      // Read MAX(turn_index) under the lock so the next index is gap-free.
      const maxRows = await tx
        .select({ max: sql<number>`COALESCE(MAX(${conversationTurns.turn_index}), 0)` })
        .from(conversationTurns)
        .where(eq(conversationTurns.session_id, session_id));
      const nextIndex = Number(maxRows[0]?.max ?? 0) + 1;

      const turn_id = ulid();
      await tx.insert(conversationTurns).values({
        turn_id,
        session_id,
        agent_id,
        turn_index: nextIndex,
        role: turn.role,
        content: turn.content,
        tool_calls: turn.tool_calls,
        tool_call_id: turn.tool_call_id,
        model: turn.model,
        tokens_in: turn.tokens_in,
        tokens_out: turn.tokens_out,
        metadata: turn.metadata,
      });

      // SUMP-03: derive pending-tool-call flag.
      const newPending = computePendingToolCall(
        turn.role,
        turn.tool_calls,
        turn.tool_call_id,
        sessRow.has_pending_tool_call,
      );

      // Q6 (sliding TTL): refresh expires_at on every successful append.
      const newExpiresAt = new Date(Date.now() + this.defaultTtlSec * 1000);

      await tx
        .update(sessions)
        .set({
          updated_at: new Date(),
          expires_at: newExpiresAt,
          has_pending_tool_call: newPending,
          turn_count: sessRow.turn_count + 1,
        })
        .where(
          and(
            eq(sessions.session_id, session_id),
            eq(sessions.agent_id, agent_id), // defense-in-depth — already validated above
          ),
        );

      return { turn_id, turn_index: nextIndex, persisted: true };
    });
  }

  // ── loadHistory (Pitfall 17-B: NEVER throws; returns [] on miss/mismatch) ─

  async loadHistory(
    session_id: string,
    agent_id: string,
    opts?: LoadHistoryOpts,
  ): Promise<Turn[]> {
    try {
      // First verify the session exists, belongs to agent_id, and is unexpired.
      // We do this with a single query that joins through both validation
      // predicates so a miss/mismatch/expired session yields [] cleanly.
      const sessRows = await this.db
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, session_id));
      const sessRow = sessRows[0];
      if (!sessRow) {
        return [];
      }
      if (sessRow.agent_id !== agent_id) {
        // Pitfall 17-B: log warn (one-line attach-mismatch signal) but return
        // []. Returning 403 would itself confirm the session exists.
        this.logger.warn({
          event: 'session_attach_mismatch',
          session_id,
          agent_id_caller: agent_id,
        });
        return [];
      }
      if (sessRow.expires_at.getTime() < Date.now()) {
        return [];
      }

      // Build the conversation_turns query — agent_id filter is REDUNDANT
      // here (we already validated above) but kept as defense-in-depth so
      // any future code path that calls loadHistory without the session-row
      // pre-check still enforces P4-03.
      const ascending = opts?.ascending ?? true;
      const limit = opts?.limit;

      const conditions = [
        eq(conversationTurns.session_id, session_id),
        eq(conversationTurns.agent_id, agent_id),
      ];
      if (opts?.since_index !== undefined) {
        conditions.push(gt(conversationTurns.turn_index, opts.since_index - 1));
      }
      if (opts?.before_index !== undefined) {
        conditions.push(lt(conversationTurns.turn_index, opts.before_index));
      }

      const orderBy = ascending
        ? asc(conversationTurns.turn_index)
        : desc(conversationTurns.turn_index);

      const baseQuery = this.db
        .select()
        .from(conversationTurns)
        .where(and(...conditions))
        .orderBy(orderBy);

      const rows = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;

      return rows.map((r) => this.rowToTurn(r));
    } catch (err) {
      // Pitfall 17-B: NEVER throw from loadHistory. Any error is logged and
      // collapses to []; the route falls back to stateless.
      this.logger.warn({
        event: 'session_load_history_failed_open',
        session_id,
        agent_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── deleteSession (scoped to agent_id; no-op on miss) ────────────────────

  async deleteSession(session_id: string, agent_id: string): Promise<void> {
    // ON DELETE CASCADE on conversation_turns.session_id handles the turns.
    await this.db
      .delete(sessions)
      .where(and(eq(sessions.session_id, session_id), eq(sessions.agent_id, agent_id)));
  }

  // ── listSessions ─────────────────────────────────────────────────────────

  async listSessions(
    filter: ListSessionsFilter,
  ): Promise<{ sessions: SessionSummary[]; next_cursor?: string }> {
    const limit = Math.min(filter.limit ?? 50, 500);
    const conditions = [eq(sessions.agent_id, filter.agent_id)];
    if (filter.tenant_id !== undefined) {
      conditions.push(eq(sessions.tenant_id, filter.tenant_id));
    }
    if (filter.project_id !== undefined) {
      conditions.push(eq(sessions.project_id, filter.project_id));
    }
    if (!filter.include_expired) {
      conditions.push(gt(sessions.expires_at, new Date()));
    }
    if (filter.cursor !== undefined) {
      // Cursor pagination: ORDER BY session_id DESC; ULIDs are lexicographically
      // ordered by creation time, so `session_id < cursor` yields the next
      // older page. The recency-by-updated_at ordering used by the index is
      // an optimization that doesn't survive cursor pagination correctly
      // (updated_at can move), so we use session_id ordering for the cursor
      // path while preserving updated_at DESC for the first page.
      conditions.push(lt(sessions.session_id, filter.cursor));
    }

    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(
        filter.cursor !== undefined ? desc(sessions.session_id) : desc(sessions.updated_at),
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      sessions: page.map((r) => this.rowToSummary(r)),
      next_cursor: hasMore ? page[page.length - 1]?.session_id : undefined,
    };
  }

  // ── replaceTurns (atomic delete + insert under advisory lock) ────────────

  async replaceTurns(
    session_id: string,
    agent_id: string,
    turns: Array<Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index'>>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Same lock-first-then-read invariant as appendTurn (P4-02 BLOCK).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session_id}::text))`);

      const sessRows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.session_id, session_id));
      const sessRow = sessRows[0];
      if (!sessRow) {
        throw new SessionNotFoundError(session_id);
      }
      if (sessRow.agent_id !== agent_id) {
        throw new SessionAgentMismatchError(session_id);
      }

      await tx
        .delete(conversationTurns)
        .where(eq(conversationTurns.session_id, session_id));

      let nextIndex = 1;
      for (const t of turns) {
        await tx.insert(conversationTurns).values({
          turn_id: ulid(),
          session_id,
          agent_id,
          turn_index: nextIndex,
          role: t.role,
          content: t.content,
          tool_calls: t.tool_calls,
          tool_call_id: t.tool_call_id,
          model: t.model,
          tokens_in: t.tokens_in,
          tokens_out: t.tokens_out,
          ts: t.ts,
          metadata: t.metadata,
        });
        nextIndex += 1;
      }

      // Sliding TTL + bookkeeping.
      const newExpiresAt = new Date(Date.now() + this.defaultTtlSec * 1000);
      await tx
        .update(sessions)
        .set({
          updated_at: new Date(),
          expires_at: newExpiresAt,
          turn_count: turns.length,
          // has_pending_tool_call is recomputed by walking the replacement
          // turns under the same conservative algorithm.
          has_pending_tool_call: turns.reduce<boolean>(
            (prev, t) => computePendingToolCall(t.role, t.tool_calls, t.tool_call_id, prev),
            false,
          ),
        })
        .where(eq(sessions.session_id, session_id));
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private rowToTurn(r: {
    turn_id: string;
    session_id: string;
    agent_id: string;
    turn_index: number;
    role: string;
    content: unknown;
    tool_calls: unknown;
    tool_call_id: string | null;
    model: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    ts: Date;
    metadata: unknown;
  }): Turn {
    return {
      turn_id: r.turn_id,
      session_id: r.session_id,
      agent_id: r.agent_id,
      turn_index: r.turn_index,
      role: r.role as Turn['role'],
      content: r.content as ContentBlock[],
      tool_calls: (r.tool_calls as ToolUseBlock[] | null) ?? undefined,
      tool_call_id: r.tool_call_id ?? undefined,
      model: r.model ?? undefined,
      tokens_in: r.tokens_in ?? undefined,
      tokens_out: r.tokens_out ?? undefined,
      ts: r.ts,
      metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
    };
  }

  private rowToSummary(r: SessionRow): SessionSummary {
    return {
      session_id: r.session_id,
      agent_id: r.agent_id,
      tenant_id: r.tenant_id ?? undefined,
      project_id: r.project_id ?? undefined,
      created_at: r.created_at,
      updated_at: r.updated_at,
      expires_at: r.expires_at,
      turn_count: r.turn_count,
      has_pending_tool_call: r.has_pending_tool_call,
    };
  }
}
