// router/src/providers/session-store.ts — SessionStore provider interface
// (Phase 17 / v0.11.0 — SESS-01..04).
//
// STRATEGIC FRAME: this is the **Memory Abstraction Layer**, not a Memory
// implementation. The router exposes durable-write seams (SessionStore +
// ContextProvider + SummaryProvider); concrete retrieval / KB / RAG logic
// lives downstream as a consumer of these seams, NEVER inside the router.
// See project memory: project_retrieval_agnostic_principle.md.
//
// Invariants encoded in this file (cross-referenced to 17-RESEARCH.md):
//
//   SESS-01           Six-method interface (createSession / appendTurn /
//                     loadHistory / deleteSession / listSessions / replaceTurns).
//                     Frozen contract for Plans 17-04..17-06 to wire against.
//
//   SESS-03 / P4-03   `agent_id` is a MANDATORY positional parameter on
//                     appendTurn / loadHistory / deleteSession (NEVER in opts).
//                     listSessions filter `agent_id` is required. ListSessionsFilter.
//
//   SESS-04           appendTurn is a SYNCHRONOUS durable write with a 1s
//                     fail-open timeout — see PostgresSessionStore. The
//                     return type encodes the fail-open observability via
//                     AppendTurnResult.persisted.
//
//   Pitfall 17-B      loadHistory on miss/mismatch returns [] — NEVER throws.
//                     appendTurn on mismatch throws (privileged-write boundary).
//
// Type re-exports: ContentBlock and ToolUseBlock come from translation/canonical
// so this module's Turn shape is byte-compatible with the on-the-wire
// representation. tool_calls on a Turn is the denormalized ToolUseBlock[]
// extracted from `content` for fast SUMP-03 has_pending_tool_call derivation.
import type { ContentBlock, ToolUseBlock } from '../translation/canonical.js';

// ── Turn shape ────────────────────────────────────────────────────────────────

/**
 * One persisted message in a session. Maps 1:1 to a row in conversation_turns.
 *
 * `role` is the WIRE role from the upstream caller's body. The router projects
 * this into the canonical request at load time:
 *   - role='system'             → canonical.system string (joined)
 *   - role='user'|'assistant'   → canonical.messages entry (Anthropic-shape)
 *   - role='tool'               → canonical.messages with content[0].type='tool_result'
 *     (Anthropic style — tool_call_id maps to tool_use_id in canonical)
 *
 * `content` is stored as the canonical content-block array (jsonb) — NOT as raw
 * OpenAI string content. This keeps the wire-translation layer authoritative for
 * shape; loadHistory always returns canonical-ready blocks.
 */
export interface Turn {
  /** ULID, set on insert. */
  turn_id: string;
  session_id: string;
  /** Copied from session at insert time (denorm for FK-less queries). */
  agent_id: string;
  /** Monotonic per session; gap-free under advisory lock (P4-02 BLOCK). */
  turn_index: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Anthropic-canonical content blocks (text | image | tool_use | tool_result). */
  content: ContentBlock[];
  /** Present on assistant turns that emit tool calls (denorm of content). */
  tool_calls?: ToolUseBlock[];
  /** Present on tool turns (the call this is a result for). */
  tool_call_id?: string;
  /** Display name from registry (assistant turns only). */
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Created_at; serial ordering tiebreak via turn_index. */
  ts: Date;
  /** Jsonb; arbitrary client-supplied. */
  metadata?: Record<string, unknown>;
}

/** Subset returned by listSessions — no turn payloads, only session-level metadata. */
export interface SessionSummary {
  session_id: string;
  agent_id: string;
  tenant_id?: string;
  project_id?: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  turn_count: number;
  has_pending_tool_call: boolean;
}

/** Append-time options + the result discriminator. */
export interface AppendTurnResult {
  turn_id: string;
  turn_index: number;
  /**
   * SESS-04 fail-open: true if Postgres committed, false if 1s timeout elapsed
   * and the turn was dropped from the caller's perspective. The underlying
   * transaction may still complete in the background — the next loadHistory
   * will see it. The contract is bounded latency, not exactly-once persistence.
   */
  persisted: boolean;
}

/** loadHistory filter options. agent_id is positional, NOT in opts (P4-03 BLOCK). */
export interface LoadHistoryOpts {
  /** Cap turns returned; default: undefined (= all turns). */
  limit?: number;
  /** Return only turns at or after this turn_index (1-based inclusive). */
  since_index?: number;
  /** Return only turns strictly before this turn_index. */
  before_index?: number;
  /** Default true: ascending by turn_index. Set false for newest-first. */
  ascending?: boolean;
}

/** listSessions filter — agent_id mandatory for the same anti-leak reason. */
export interface ListSessionsFilter {
  /** MANDATORY — same P4-03 rule as loadHistory. */
  agent_id: string;
  tenant_id?: string;
  project_id?: string;
  /** Default 50. Hard cap 500. */
  limit?: number;
  /** Cursor = last seen session_id from previous page. */
  cursor?: string;
  /** Default false. When true, include sessions with expires_at < now(). */
  include_expired?: boolean;
}

/** Session creation metadata. */
export interface CreateSessionInput {
  /** Client-supplied session_id (regex /^[A-Za-z0-9._:-]{1,128}$/) or undefined → server generates ULID. */
  session_id?: string;
  agent_id: string;
  tenant_id?: string;
  project_id?: string;
  /** Override the default TTL (env SESSION_TTL_DAYS). Default 7 days. */
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
}

// ── SessionStore interface ────────────────────────────────────────────────────

export interface SessionStore {
  /**
   * Create a new session row. Returns the session_id (echo of input or
   * server-generated ULID).
   *
   * SESS-01. Idempotent: re-creating a session with the same (session_id,
   * agent_id) pair refreshes updated_at + expires_at; calling with a
   * different agent_id throws SessionAgentMismatchError. expires_at MUST be
   * computed BEFORE the underlying insert (Pitfall 17-H — never rely on
   * Postgres NOW() + interval inside Drizzle's value-builder).
   */
  createSession(input: CreateSessionInput): Promise<string>;

  /**
   * Append one turn synchronously.
   *
   * SESS-04 / P4-02 / P4-03 BLOCK. SYNC durable write with a 1s timeout
   * fail-open. `agent_id` is a MANDATORY positional parameter (P4-03 — the
   * privileged-write boundary). Internally:
   *
   *     BEGIN;
   *       SELECT pg_advisory_xact_lock(hashtext($1::text));   -- P4-02 BLOCK
   *       -- read MAX(turn_index), validate session+agent+expires_at
   *       INSERT INTO conversation_turns (...) VALUES (...);
   *       UPDATE sessions
   *          SET updated_at = now(),
   *              expires_at = now() + TTL,         -- sliding TTL (Q6)
   *              has_pending_tool_call = $pending,
   *              turn_count = turn_count + 1
   *        WHERE session_id = $1 AND agent_id = $2;
   *     COMMIT;
   *
   * Throws SessionNotFoundError if the session does not exist.
   * Throws SessionExpiredError if `expires_at < now()`.
   * Throws SessionAgentMismatchError if agent_id does not match the session row.
   *
   * On 1s timeout: resolves with `{ turn_id:'', turn_index:-1, persisted:false }`
   * — caller continues stateless (Pitfall 17-E).
   */
  appendTurn(
    session_id: string,
    agent_id: string,
    turn: Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index' | 'ts'>,
  ): Promise<AppendTurnResult>;

  /**
   * Load history for a session, scoped to agent_id.
   *
   * SESS-03 / P4-03 BLOCK. `agent_id` is a MANDATORY positional parameter.
   * Returns [] when (session_id, agent_id) does not exist OR is expired —
   * NEVER throws on miss; the empty array is the cross-agent-leakage
   * prevention contract (Pitfall 17-B). Throwing 403 would itself leak
   * existence of the session_id.
   */
  loadHistory(
    session_id: string,
    agent_id: string,
    opts?: LoadHistoryOpts,
  ): Promise<Turn[]>;

  /**
   * Hard delete (session + all turns; ON DELETE CASCADE handles turns).
   *
   * Scoped to agent_id. No-op (returns void) when session not found or
   * agent_id mismatches.
   */
  deleteSession(session_id: string, agent_id: string): Promise<void>;

  /**
   * Cursor-paginated list scoped to agent_id (+ optional tenant/project filters).
   *
   * `agent_id` MANDATORY in filter (same P4-03 anti-leak rule).
   */
  listSessions(
    filter: ListSessionsFilter,
  ): Promise<{ sessions: SessionSummary[]; next_cursor?: string }>;

  /**
   * Atomic replace: delete all existing turns + insert new turns inside one
   * transaction (advisory-lock held throughout).
   *
   * Used by future SummaryProvider compaction (SUMP-FUT-02); the v0.11.0
   * Noop never calls it. Implemented now to keep the interface honest. Same
   * agent_id rule as appendTurn (throws SessionAgentMismatchError on mismatch).
   */
  replaceTurns(
    session_id: string,
    agent_id: string,
    turns: Array<Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index'>>,
  ): Promise<void>;
}
