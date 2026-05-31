# Phase 17: SessionStore + ContextProvider + SummaryProvider — Research

**Researched:** 2026-05-31
**Domain:** Provider interface design + Postgres-backed conversation persistence + context window management + summarization seam on a Fastify v5 LLM router
**Confidence:** HIGH (live codebase read; existing migration shape verified; gpt-tokenizer + drizzle-orm + pg pinned versions confirmed; 9 BLOCK pitfalls locked from PITFALLS.md / ROADMAP)

---

## Summary

Phase 17 ships three coupled abstractions — `SessionStore`, `ContextProvider`, `SummaryProvider` — that together give the router persistent multi-turn conversation capability without it ever owning retrieval logic or semantic memory. SessionStore writes turns to Postgres synchronously (different from request_log's async-buffered writer), ContextProvider trims the loaded history to fit `ctx_size`, and SummaryProvider is declared as a seam with a noop default. All three are activated by the optional `X-Session-ID` request header; absence keeps the router stateless and byte-identical to Phase 16.

**The work is entirely additive.** Zero existing routes change wire shape. The `request_log` schema is unchanged. The canonical translation layer is unchanged. The only structural mutation is one new migration (0006) creating two tables (`sessions`, `conversation_turns`), one new field group on `ModelEntrySchema` (`ctx_size`, `context_strategy`), one new preHandler that no-ops when `X-Session-ID` is absent, and three new route insertion points (one per chat-surface route).

**Primary recommendation:** Build SESS first (interface + schema + migration + Postgres impl + advisory lock), then CTXP (interface + sliding-window strategy + system-pin rule), then SUMP (interface + Noop + has_pending_tool_call guard), then wire all three into `/v1/chat/completions`, `/v1/responses`, `/v1/messages` in that order. The wire-up is a single shape repeated three times — bracket the existing `applyPreflight → adapter` core with `loadHistory` (before canonical build) and `appendTurn` (after success). Tool-pending turns block SummaryProvider via a flag on `sessions`.

---

<user_constraints>
## User Constraints

> No CONTEXT.md exists yet for Phase 17 (research runs before discuss-phase). The constraints below are extracted verbatim from the binding sources: ROADMAP.md Phase 17 section, REQUIREMENTS.md (SESS/CTXP/SUMP), STATE.md Architectural Frame Violations, and the orchestrator's objective brief.

### Locked Decisions (binding — research the THESE, not alternatives)

**From ROADMAP.md Phase 17 design constraints:**
1. `sessions.expires_at TIMESTAMPTZ NOT NULL` from day one — no unbounded retention path; default TTL 7 days (P4-01 BLOCK).
2. `pg_advisory_xact_lock(hashtext(session_id))` inside transaction wrapping turn append (P4-02 BLOCK).
3. `SessionStore.loadHistory()` requires `agent_id` as **mandatory positional parameter** — cross-agent leakage prevented at query layer (P4-03 BLOCK).
4. System messages are NEVER evictable by window management — ContextProvider preserves the system turn through every trim (P4-04 BLOCK).
5. `SummaryProvider.summarize()` is NEVER invoked when session has a pending tool call (P6-01 BLOCK) — `has_pending_tool_call` flag prevents summarization during tool round-trip.
6. Session persistence is **optional** — callers without `X-Session-ID` operate stateless with zero SessionStore involvement (SESS-06).
7. Session writes are **synchronous durable writes** (NOT async-buffered like request_log) — fail-open under 1s timeout with `persisted: false` flag (SESS-04).
8. **No FK from `conversation_turns` to `request_log`** — sessions independently deletable (P4-06 FLAG).
9. Migration journal: read `_journal.json` FIRST to assign migration number — next sequential is **0006** (P9-01 BLOCK, verified below).

**From the orchestrator brief (Phase 17 objective):**
- Per-model `ctx_size` integer + per-model `context_strategy` enum land in `ModelEntrySchema` (CTXP-04).
- Default `context_strategy: 'sliding-window'` when omitted on a model entry — preserves stateless behavior for existing entries (no SessionStore is ever invoked without `X-Session-ID`).
- Strategic frame (binding): "Memory Abstraction Layer, not Memory implementation" — router exposes seams; no retrieval logic, no semantic memory.

### Claude's Discretion

- **Default TTL value** — orchestrator says "default TTL 7 days"; CONTEXT.md will lock the exact env var name (proposed `SESSION_TTL_DAYS=7`).
- **Token estimation method** — Phase 12 already installs `gpt-tokenizer` and Phase 4 already ships `countTokens(canonical)` (verified at `router/src/translation/count-tokens.ts:148`). Use it. (Overrides PITFALLS P4-05's "chars/3" guidance — that recommendation predated `count-tokens.ts` being available.)
- **Table name conflict** — ROADMAP.md uses `session_turns`; REQUIREMENTS.md SESS-02 and STACK.md §4 use `conversation_turns`. **Recommend `conversation_turns`** (matches REQ doc + STACK research + research lineage). Surface for CONTEXT.md confirmation.
- **`replaceTurns` signature** — REQUIREMENTS.md SESS-01 lists it; v0.11.0 has no path that calls it (the only caller would be a real SummaryProvider, which is SUMP-FUT-01 / deferred). Ship the interface signature but the Postgres impl can throw `NotImplementedError` until v0.12 — or implement it now as `DELETE + INSERT` inside one transaction (low LOC). **Recommendation: implement now — adds ~20 LOC, makes the interface honest.**
- **Listsessions filter shape** — REQUIREMENTS.md SESS-01 says `listSessions(filter)`. **Recommendation: filter accepts `{ agent_id: string, tenant_id?, project_id?, limit?, cursor? }` — keep agent_id mandatory** (same anti-leak rule as loadHistory; P4-03 logic).
- **Session ID format** — REQUIREMENTS.md does not lock client-supplied vs server-generated. **Recommendation: BOTH — operator-supplied `X-Session-ID` accepted if it matches `/^[A-Za-z0-9._:-]{1,128}$/` (same regex as scoped IDs), otherwise server-generated ULID is returned in `X-Session-ID` response header.**

### Deferred Ideas (OUT OF SCOPE — ignore)

From REQUIREMENTS.md "Future Requirements":
- **SUMP-FUT-01**: Real `LlmSummaryProvider` implementation (model-based summarization).
- **SUMP-FUT-02**: `ContextProvider` `summarize-hook` strategy actively triggering SummaryProvider.
- **SESS-FUT-01**: Background cron deleting expired sessions (only `expires_at` column lands in 0006; no GC loop).
- **SESS-FUT-02**: Session export endpoint.
- **Architectural Frame Violations** (rejected on sight): no pgvector, no in-process retriever, no model-based default SummaryProvider, no tenant_id derived from bearer hash, no content classifier.

From ROADMAP Phase 18: RetrieverProvider + pre-completion hook + MCP client — all deferred to next phase.
</user_constraints>

<phase_requirements>
## Phase Requirements (13 total)

| ID | Description | Research Support |
|----|-------------|------------------|
| **SESS-01** | `SessionStore` TypeScript interface in `src/providers/session-store.ts` with `createSession`, `appendTurn`, `loadHistory`, `deleteSession`, `listSessions`, `replaceTurns`. | See §SessionStore Interface below — full TypeScript signatures with `Turn` shape, opts, return types, error classes. |
| **SESS-02** | `PostgresSessionStore` default; Drizzle migration creates `sessions` + `conversation_turns`; `sessions.expires_at TIMESTAMPTZ NOT NULL`. | See §Drizzle Schema + Migration SQL — verified next migration is 0006 per `_journal.json` (last entry idx 5 = `0005_request_log_scoped_ids`). |
| **SESS-03** | `loadHistory` requires `agent_id`; WHERE clause always includes it; cross-agent leakage prevented at query layer. | `agent_id` is mandatory positional param (NOT in opts). See interface signature. Integration test asserts empty array when agent_id mismatches. |
| **SESS-04** | `appendTurn` is **synchronous** durable write; returns after commit; fail-open under 1s timeout with `persisted: false` flag. | See §SessionStore Implementation — `Promise.race([insertPromise, timeoutPromise])` with 1000ms ceiling; bufferedWriter is explicitly NOT used. |
| **SESS-05** | `X-Session-ID` response header set on responses when session is active. | Set via `reply.header('X-Session-ID', sessionId)` in route handler BEFORE `reply.send()`. Both server-generated and client-echoed paths set the header. |
| **SESS-06** | Stateless when `X-Session-ID` absent — no `sessions`/`conversation_turns` rows written. | Route handler checks `req.sessionId` (set by preHandler); skips load/append entirely when undefined. Identical wire shape to pre-Phase-17. |
| **CTXP-01** | `ContextProvider` interface exported with `provideContext(history, system?, opts) → Turn[]` (project-vocab) — actual signature in §ContextProvider below. | Returns `{ messages: CanonicalMessage[], system?: string, dropped_count: number, estimated_tokens: number }`. |
| **CTXP-02** | Two default strategies: `truncate` and `sliding-window`. Model-aware via `ctx_size` from `models.yaml`. | Both strategies preserve system; default strategy when omitted = `sliding-window` (per orchestrator brief). |
| **CTXP-03** | System messages **always** preserved. | Implementation pulls `role:'system'` turns to `pinned[]` separately from `evictable[]`; trim only `evictable[]`. Unit test asserts index 0 is always system after trim. |
| **CTXP-04** | `ctx_size: integer` + `context_strategy: enum` on each `models.yaml` entry. | See §`models.yaml` Stanza — Zod schema widening + default values. |
| **SUMP-01** | `SummaryProvider` interface exported with `summarize(turns, opts) → { summary, replaced_turn_ids }`. | See §SummaryProvider Interface below. |
| **SUMP-02** | `NoopSummaryProvider` default returns `{ summary: '', replaced_turn_ids: [] }`. | Frame-03 violation rejected: no model-based default. Tests assert no model is ever called by Noop. |
| **SUMP-03** | `summarize()` NEVER invoked when session has pending tool call. | `has_pending_tool_call` column on `sessions` table; `appendTurn` sets/clears it based on turn shape; ContextProvider checks before any SUMP call. |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Session persistence (CRUD) | API/Backend (Postgres) | — | Sessions are server-side state by definition; clients hold only `session_id`. |
| Session-ID extraction from request | Frontend Server (Fastify preHandler) | — | Same pattern as `scopedIdsPreHandler` — header parse + validation + stamp on req. |
| Context window assembly | API/Backend (in-route logic) | — | Requires registry access (`ctx_size`), session history, and the incoming canonical request — all server-side. |
| Token counting for window trim | API/Backend (`countTokens()`) | — | Already implemented at `router/src/translation/count-tokens.ts`; reuse, do not reimplement. |
| Pending-tool-call detection | API/Backend (`sessions.has_pending_tool_call`) | — | Server tracks state; flag is updated atomically in the same transaction as `appendTurn`. |
| Summary generation | **External (downstream consumer)** | API/Backend (seam only) | NoopSummaryProvider returns empty by design; real implementations are downstream concern (Frame-03). |
| Cross-agent isolation | API/Backend (Postgres WHERE clause) | — | Single point of enforcement at query layer — same pattern as Phase 14's `request_log` agent_id column. |

---

## Standard Stack

**No new npm dependencies.** Everything Phase 17 needs is already in `router/package.json`.

### Core (already installed — verified via `router/package.json`)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | `^0.36.0` | `pgTable` schema + `db.transaction` + migration journal | Already locked stack; STACK.md §4 confirms 0.36→0.45 delta adds nothing required here. [CITED: STACK.md line 188] |
| `pg` | `^8.13.0` | Postgres client (transactions + advisory locks) | Already locked; `pg_advisory_xact_lock` is plain SQL — no client-side feature needed. [VERIFIED: router/package.json line 30] |
| `gpt-tokenizer` | `^3.0.0` | `countTokens(canonical)` for window math | Already installed in Phase 12 + Phase 4; `cl100k_base` encoder. Reuse — do not introduce per-model tokenizers (P4-05 over-engineering). [VERIFIED: router/src/translation/count-tokens.ts:28] |
| `ulid` | `^3.0.2` | Server-generated `session_id` when client omits | Already installed; monotonic factory provides ordering. [VERIFIED: router/package.json line 33] |
| `zod` | `^4.4.3` | Schema widening on `ModelEntrySchema` + new `SessionIdHeaderSchema` | Already locked; CTXP-04 needs two new optional fields on the entry. |

### Supporting (already installed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fastify` | `^5.8.5` | preHandler hook for session-id extraction | Mirror `scopedIdsPreHandler` pattern from Phase 14. |
| `pino` | `^10.3.1` | Structured logging of session attach/detach + persisted:false fallbacks | All session-lifecycle events log at `info` (attach/detach) or `warn` (fail-open). |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Postgres advisory lock | Valkey `SET NX PX 5000` distributed lock | Valkey lock is more familiar to the existing breaker/idempotency pattern, but adds a network hop on the hot path AND a second source-of-truth for "is this session being written?". PG advisory lock is local to the transaction — single round-trip, atomic with the INSERT. **Pick PG advisory lock.** (PITFALLS.md P4-02 lists Valkey as the alternative; single-host means PG is sufficient.) |
| Synchronous write | Reuse `bufferedWriter` (async-buffered) | bufferedWriter is fire-and-forget — session truth would be lost on crash before flush. **Pick sync write** (SESS-04 BLOCK; explicitly different pattern). See `router/src/db/bufferedWriter.ts` header comments. |
| `conversation_turns` table | `session_turns` table (ROADMAP wording) | ROADMAP says `session_turns` colloquially; REQUIREMENTS.md SESS-02 + STACK.md §4 both use `conversation_turns` (formal). **Pick `conversation_turns`** — surface in CONTEXT.md if user prefers the shorter name. |
| `gpt-tokenizer` (cl100k_base) | `tiktoken` / per-model tokenizers | cl100k_base over-estimates token count by ~10-20% on qwen2.5/llama3 vocabularies (PITFALLS P4-05), which produces a **conservative safety margin** — exactly what window math wants. Per-model tokenizers add complexity for no correctness gain. **Reuse `countTokens()` from `router/src/translation/count-tokens.ts:148`.** |

**Installation:**
```bash
# Nothing to install — zero new dependencies for Phase 17.
```

**Version verification (done at research time):**
- `drizzle-orm@0.36.0` — confirmed in `router/package.json:23` [VERIFIED: router/package.json]
- `pg@8.13.0` — confirmed in `router/package.json:30` [VERIFIED: router/package.json]
- `gpt-tokenizer@3.0.0` — confirmed in `router/package.json:26` AND imported at `router/src/translation/count-tokens.ts:28` [VERIFIED: codebase]
- `ulid@3.0.2` — confirmed in `router/package.json:33` [VERIFIED: router/package.json]

---

## Package Legitimacy Audit

> **Phase 17 installs zero new packages.** All capabilities are satisfied by the existing locked stack (verified via `router/package.json` read). No slopcheck run needed — there is nothing new to audit.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| *(none — zero new deps)* | — | — | — | — | — | — |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## SessionStore Interface — Full TypeScript Signatures

> Location: `router/src/providers/session-store.ts` (NEW file).

### `Turn` shape

```typescript
// router/src/providers/session-store.ts

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
  turn_id: string;                        // ULID, set on insert
  session_id: string;
  agent_id: string;                       // copied from session at insert time (denorm for FK-less queries)
  turn_index: number;                     // monotonic per session; gap-free under advisory lock
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Anthropic-canonical content blocks (text | image | tool_use | tool_result). */
  content: ContentBlock[];                // imported from translation/canonical.ts
  tool_calls?: ToolUseBlock[];            // present on assistant turns that emit tool calls (denorm of content)
  tool_call_id?: string;                  // present on tool turns (the call this is a result for)
  model?: string;                         // display name from registry (assistant turns only)
  tokens_in?: number;
  tokens_out?: number;
  ts: Date;                               // created_at; serial ordering tiebreak via turn_index
  metadata?: Record<string, unknown>;     // jsonb; arbitrary client-supplied
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
  /** SESS-04 fail-open: true if Postgres committed, false if 1s timeout elapsed and the turn was dropped. */
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
  agent_id: string;                       // MANDATORY — same rule as loadHistory
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
  /** Override the default TTL (env SESSION_TTL_DAYS). Use Infinity for "no expiry" — store as max valid TIMESTAMPTZ. */
  ttl_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  /**
   * Create a new session row. Returns the session_id (echo of input or
   * server-generated ULID). Idempotent: re-creating a session with the same
   * (session_id, agent_id) pair refreshes updated_at and expires_at; calling
   * with a different agent_id throws SessionAgentMismatchError.
   */
  createSession(input: CreateSessionInput): Promise<string>;

  /**
   * Append one turn synchronously. SESS-04: returns after Postgres commit OR
   * after a 1s timeout (whichever fires first). On timeout: result.persisted = false,
   * caller continues (fail-open). Internally:
   *   BEGIN;
   *     SELECT pg_advisory_xact_lock(hashtext($1::text));   -- P4-02 BLOCK
   *     INSERT INTO conversation_turns (...) VALUES (...);
   *     UPDATE sessions SET updated_at = now(),
   *                         has_pending_tool_call = $pending
   *           WHERE session_id = $1 AND agent_id = $2;
   *   COMMIT;
   *
   * Throws SessionNotFoundError if the session does not exist (or expired).
   * Throws SessionAgentMismatchError if agent_id does not match the session row.
   */
  appendTurn(
    session_id: string,
    agent_id: string,                     // P4-03 BLOCK: mandatory positional
    turn: Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index' | 'ts'>,
  ): Promise<AppendTurnResult>;

  /**
   * Load history for a session, scoped to agent_id (P4-03 BLOCK).
   * Returns [] when (session_id, agent_id) does not exist OR is expired —
   * NEVER throws on miss; the empty array is the cross-agent-leakage prevention contract.
   */
  loadHistory(
    session_id: string,
    agent_id: string,                     // P4-03 BLOCK: mandatory positional
    opts?: LoadHistoryOpts,
  ): Promise<Turn[]>;

  /**
   * Hard delete (session + all turns; ON DELETE CASCADE handles turns).
   * Scoped to agent_id. No-op (returns void) when session not found.
   */
  deleteSession(session_id: string, agent_id: string): Promise<void>;

  /** Cursor-paginated list scoped to agent_id (+ optional tenant/project filters). */
  listSessions(
    filter: ListSessionsFilter,
  ): Promise<{ sessions: SessionSummary[]; next_cursor?: string }>;

  /**
   * Atomic replace: delete all existing turns + insert new turns inside one
   * transaction (advisory-lock held throughout). Used by future SummaryProvider
   * compaction (SUMP-FUT-02); the v0.11.0 Noop never calls it. Implemented
   * now to keep the interface honest. Same agent_id rule.
   */
  replaceTurns(
    session_id: string,
    agent_id: string,
    turns: Array<Omit<Turn, 'turn_id' | 'session_id' | 'agent_id' | 'turn_index'>>,
  ): Promise<void>;
}
```

### Error Classes (NEW — `router/src/providers/session-errors.ts`)

```typescript
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found';
  readonly httpStatus = 404;
  constructor(public session_id: string) {
    super(`session ${session_id} not found or expired`);
  }
}

export class SessionExpiredError extends Error {
  readonly code = 'session_expired';
  readonly httpStatus = 410;
  constructor(public session_id: string, public expired_at: Date) {
    super(`session ${session_id} expired at ${expired_at.toISOString()}`);
  }
}

export class SessionAgentMismatchError extends Error {
  readonly code = 'session_agent_mismatch';
  readonly httpStatus = 403;
  constructor(public session_id: string) {
    super(`session ${session_id} belongs to a different agent`);
  }
}

export class InvalidSessionIdError extends Error {
  readonly code = 'invalid_session_id';
  readonly httpStatus = 400;
  constructor(public raw: string) {
    super(`X-Session-ID must match /^[A-Za-z0-9._:-]{1,128}$/`);
  }
}
```

**Error envelope mapping:** Extend `router/src/errors/envelope.ts` so all four classes route through the existing OpenAI / Anthropic centralized error handler (same pattern as `InvalidScopedIdError` + `InvalidAgentIdError` from Phase 14). [VERIFIED: scopedIds.ts:22 references `InvalidScopedIdError` in `errors/envelope.js`]

**Route policy for the centralized handler:**
- `SessionNotFoundError` and `SessionExpiredError` from `loadHistory` are **caught locally** and treated as "no history" — the route continues stateless. They are NOT raised as 4xx (the caller didn't ask for an error envelope; they sent a header and got an empty conversation). Log at `info` level.
- `SessionAgentMismatchError` from `loadHistory` is **also caught locally** — the same anti-leak contract returns `[]` rather than 403 (returning 403 would itself leak existence of the session_id). Log at `warn`.
- `InvalidSessionIdError` from the preHandler IS raised — bad header value is a caller bug and deserves 400. Same pattern as `InvalidScopedIdError`.

---

## Drizzle Schema + Migration SQL

### Next migration number — VERIFIED

```json
// router/db/migrations/meta/_journal.json — last entry:
{
  "idx": 5,
  "tag": "0005_request_log_scoped_ids",
  "when": 1780142072840
}
```

**Next migration number is `0006`.** [VERIFIED: router/db/migrations/meta/_journal.json line 44]

Filename: `router/db/migrations/0006_sessions.sql`
Drizzle schema: `router/src/db/schema/sessions.ts` (NEW)
Journal entry: append `{ "idx": 6, "version": "7", "when": <epoch_ms>, "tag": "0006_sessions", "breakpoints": true }`

> **P9-01 BLOCK:** The SQL file + Drizzle schema + `_journal.json` entry are an **indivisible tuple**. Drizzle's migrator silently skips entries that are not registered in the journal. The plan-phase agent must group these three writes into a single task; do NOT plan them across multiple plans. (Confirmed in MEMORY.md: "new migration needs SQL + schema + `_journal.json` entry as an indivisible tuple, else migrator silently skips".)

### Migration SQL (`0006_sessions.sql`)

```sql
-- Migration 0006: sessions + conversation_turns
--   (Phase 17 / v0.11.0 — SESS-02, SESS-03, P4-01 BLOCK, P4-06 FLAG).
--
-- Creates two tables: sessions (session-level state) and conversation_turns
-- (the actual messages). Schema decisions baked in here:
--
--   sessions.expires_at TIMESTAMPTZ NOT NULL    — P4-01 BLOCK
--   sessions.agent_id   TEXT NOT NULL           — P4-03 BLOCK (loadHistory scope key)
--   sessions.has_pending_tool_call BOOL NOT NULL DEFAULT false
--                                                — SUMP-03 BLOCK (P6-01 guard column)
--   conversation_turns has NO FK to request_log — P4-06 FLAG (sessions are
--                                                independently deletable)
--   conversation_turns.session_id → sessions.session_id ON DELETE CASCADE
--                                                — STACK.md §4 + REQ SESS-01
--                                                  (deleteSession cleans up turns)
--
-- Indexes:
--   conversation_turns: (session_id, turn_index)           — loadHistory primary path
--   conversation_turns: (session_id, ts)                   — ordering by wall-clock fallback
--   sessions:          (agent_id, expires_at)              — listSessions + GC scan
--   sessions:          (agent_id, updated_at DESC)         — recency-ordered listSessions
--
-- Idempotent: CREATE TABLE IF NOT EXISTS — re-running this migration is a no-op.

CREATE TABLE IF NOT EXISTS "sessions" (
  "session_id"            text PRIMARY KEY,
  "agent_id"              text NOT NULL,
  "tenant_id"             text,
  "project_id"            text,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"            timestamp with time zone NOT NULL,
  "has_pending_tool_call" boolean NOT NULL DEFAULT false,
  "turn_count"            integer NOT NULL DEFAULT 0,
  "metadata"              jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_agent_expires"
  ON "sessions" ("agent_id", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_agent_updated"
  ON "sessions" ("agent_id", "updated_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_turns" (
  "turn_id"      text PRIMARY KEY,
  "session_id"   text NOT NULL REFERENCES "sessions"("session_id") ON DELETE CASCADE,
  "agent_id"     text NOT NULL,
  "turn_index"   integer NOT NULL,
  "role"         text NOT NULL,
  "content"      jsonb NOT NULL,
  "tool_calls"   jsonb,
  "tool_call_id" text,
  "model"        text,
  "tokens_in"    integer,
  "tokens_out"   integer,
  "ts"           timestamp with time zone NOT NULL DEFAULT now(),
  "metadata"     jsonb,
  CONSTRAINT "conversation_turns_session_turn_idx_uq"
    UNIQUE ("session_id", "turn_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turns_session_index"
  ON "conversation_turns" ("session_id", "turn_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turns_session_ts"
  ON "conversation_turns" ("session_id", "ts");
--> statement-breakpoint

COMMENT ON COLUMN "sessions"."agent_id" IS
  'SESS-03 / P4-03 BLOCK: every loadHistory call must filter on agent_id to prevent cross-agent leakage.';
COMMENT ON COLUMN "sessions"."expires_at" IS
  'P4-01 BLOCK: TTL anchor. Default 7 days from created_at; configurable via SESSION_TTL_DAYS env. NEVER NULL.';
COMMENT ON COLUMN "sessions"."has_pending_tool_call" IS
  'SUMP-03 / P6-01 BLOCK: true when the last assistant turn emits tool_calls without matching tool turn(s). SummaryProvider MUST check this flag and skip summarization when true.';
COMMENT ON COLUMN "conversation_turns"."agent_id" IS
  'Denormalized from sessions.agent_id at insert time. Enables agent_id-filtered queries without joining sessions, AND survives if the FK CASCADE chain mutates.';
COMMENT ON TABLE "conversation_turns" IS
  'P4-06 FLAG: deliberately NO foreign key to request_log. Sessions must be independently deletable for compliance-driven erasure paths.';
```

### Drizzle Schema (`router/src/db/schema/sessions.ts`)

```typescript
// router/src/db/schema/sessions.ts — Drizzle schema for sessions + conversation_turns.
//
// Authoritative shape: 17-RESEARCH.md + REQUIREMENTS SESS-02.
// Migration 0006 creates these tables.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const sessions = pgTable(
  'sessions',
  {
    session_id: text('session_id').primaryKey(),
    agent_id: text('agent_id').notNull(),          // P4-03 BLOCK
    tenant_id: text('tenant_id'),
    project_id: text('project_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),  // P4-01 BLOCK
    has_pending_tool_call: boolean('has_pending_tool_call').notNull().default(false),  // SUMP-03 BLOCK
    turn_count: integer('turn_count').notNull().default(0),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    idxAgentExpires: index('idx_sessions_agent_expires').on(t.agent_id, t.expires_at),
    idxAgentUpdated: index('idx_sessions_agent_updated').on(t.agent_id, t.updated_at.desc()),
  }),
);

export const conversationTurns = pgTable(
  'conversation_turns',
  {
    turn_id: text('turn_id').primaryKey(),
    session_id: text('session_id').notNull().references(() => sessions.session_id, { onDelete: 'cascade' }),
    agent_id: text('agent_id').notNull(),
    turn_index: integer('turn_index').notNull(),
    role: text('role').notNull(),               // 'system' | 'user' | 'assistant' | 'tool'
    content: jsonb('content').notNull(),        // ContentBlock[] from canonical.ts
    tool_calls: jsonb('tool_calls'),
    tool_call_id: text('tool_call_id'),
    model: text('model'),
    tokens_in: integer('tokens_in'),
    tokens_out: integer('tokens_out'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    uqSessionTurnIdx: uniqueIndex('conversation_turns_session_turn_idx_uq').on(t.session_id, t.turn_index),
    idxSessionIndex: index('idx_turns_session_index').on(t.session_id, t.turn_index),
    idxSessionTs: index('idx_turns_session_ts').on(t.session_id, t.ts),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type ConversationTurnRow = typeof conversationTurns.$inferSelect;
export type ConversationTurnInsert = typeof conversationTurns.$inferInsert;
```

**Also update** `router/src/db/schema/index.ts` to re-export both new tables (mirrors existing pattern). [Reference: `router/src/db/schema/index.ts`]

### `pg_advisory_xact_lock` SQL Wrapper

The append-turn transaction MUST acquire the advisory lock **before** the SELECT-MAX(turn_index) read so two concurrent writers cannot compute the same `turn_index + 1`:

```typescript
// router/src/providers/postgres-session-store.ts — appendTurn implementation sketch

import { sql } from 'drizzle-orm';

async function appendTurnTx(db: NodePgDatabase, input: AppendTurnInput): Promise<AppendTurnResult> {
  return db.transaction(async (tx) => {
    // P4-02 BLOCK: acquire advisory lock keyed on session_id hash. The lock is
    // transaction-scoped (`xact_lock` not `pg_advisory_lock`) so it auto-releases
    // on COMMIT/ROLLBACK with no leak risk. hashtext maps the 1..128-char
    // session_id to int4 — collision risk is acceptable: a collision merely
    // serializes two unrelated sessions for one transaction, doesn't lose data.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.session_id}::text))`);

    // Now safe to read MAX(turn_index) — no other writer can interleave.
    const maxRows = await tx
      .select({ max: sql<number>`COALESCE(MAX(turn_index), 0)` })
      .from(conversationTurns)
      .where(eq(conversationTurns.session_id, input.session_id));
    const nextIndex = (maxRows[0]?.max ?? 0) + 1;

    // Validate session exists + agent_id matches inside the same tx (otherwise
    // a concurrent deleteSession + append could race).
    const sessRows = await tx.select().from(sessions)
      .where(and(
        eq(sessions.session_id, input.session_id),
        eq(sessions.agent_id, input.agent_id),
      ));
    if (sessRows.length === 0) {
      throw new SessionNotFoundError(input.session_id);
    }
    if (sessRows[0]!.expires_at < new Date()) {
      throw new SessionExpiredError(input.session_id, sessRows[0]!.expires_at);
    }

    const turn_id = ulid();
    await tx.insert(conversationTurns).values({
      turn_id,
      session_id: input.session_id,
      agent_id: input.agent_id,
      turn_index: nextIndex,
      role: input.role,
      content: input.content,
      tool_calls: input.tool_calls,
      tool_call_id: input.tool_call_id,
      model: input.model,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      metadata: input.metadata,
    });

    // SUMP-03: derive pending-tool-call flag. An assistant turn that emits
    // tool_calls (without a matching tool turn in the same append batch) sets
    // the flag true; a tool turn that matches the last pending assistant turn's
    // tool_call_id clears it.
    const newPending = computePendingToolCall(input.role, input.tool_calls, input.tool_call_id, sessRows[0]!.has_pending_tool_call);

    await tx.update(sessions)
      .set({
        updated_at: new Date(),
        turn_count: sessRows[0]!.turn_count + 1,
        has_pending_tool_call: newPending,
      })
      .where(and(
        eq(sessions.session_id, input.session_id),
        eq(sessions.agent_id, input.agent_id),  // defense-in-depth
      ));

    return { turn_id, turn_index: nextIndex, persisted: true };
  });
}

// Top-level wrapper with the 1s timeout (SESS-04).
async function appendTurn(...): Promise<AppendTurnResult> {
  const timeoutMs = 1000;
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<AppendTurnResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      // Fail-open per SESS-04: return synthetic result with persisted:false.
      // The actual tx may still complete in the background; that's acceptable —
      // the next loadHistory will see it. The danger is unbounded wait, not stale read.
      resolve({ turn_id: '', turn_index: -1, persisted: false });
    }, timeoutMs);
  });
  try {
    return await Promise.race([appendTurnTx(db, input), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}
```

> **Note on the pending-tool-call derivation:** the planner must define `computePendingToolCall()` precisely. Proposed contract: (a) `role='assistant'` + `tool_calls.length > 0` → set true; (b) `role='tool'` → set false UNLESS more than one assistant tool-call is outstanding (a multi-parallel-tool-call edge — flag stays true until ALL pending tool_call_ids are matched). The conservative fallback for the v0.11.0 noop summarizer: any unresolved assistant tool_calls in the last N turns → true. This is invoked NOWHERE during Phase 17 (Noop ignores it), so an over-conservative implementation is safe. Lock the exact algorithm in CONTEXT.md.

---

## ContextProvider Interface + Sliding-Window Strategy

> Location: `router/src/providers/context-provider.ts` (NEW file).

### Interface

```typescript
// router/src/providers/context-provider.ts
import type { CanonicalMessage } from '../translation/canonical.js';
import type { ModelEntry } from '../config/registry.js';
import type { Turn } from './session-store.js';

export type ContextStrategy = 'truncate' | 'sliding-window';

export interface ProvideContextOpts {
  /** Resolved registry entry — provides ctx_size + context_strategy. */
  entry: ModelEntry;
  /** Tokens reserved for the model's output. Default: max(512, entry.max_model_len * 0.10). */
  max_tokens_reserve?: number;
  /** Override the strategy declared on the entry. Default: entry.context_strategy ?? 'sliding-window'. */
  strategy?: ContextStrategy;
}

export interface ProvideContextResult {
  /** Canonical messages (user/assistant/tool only) ready to drop into CanonicalRequest.messages. */
  messages: CanonicalMessage[];
  /** System prompt joined from all role='system' turns + any system on the incoming request.
   *  Goes into CanonicalRequest.system (Anthropic-canonical puts system at top level). */
  system?: string;
  /** Count of turns evicted by the strategy (NOT including system turns — those are never evicted). */
  dropped_count: number;
  /** Token estimate of the returned context (via gpt-tokenizer cl100k_base — over-estimates qwen/llama by ~10-20%). */
  estimated_tokens: number;
  /** SUMP-03: surfaced from sessions.has_pending_tool_call for SummaryProvider gate. */
  has_pending_tool_call: boolean;
}

export interface ContextProvider {
  /**
   * Given session history (already loaded from SessionStore) + the incoming
   * request's messages + the model entry, return the trimmed canonical-ready
   * shape that fits ctx_size with a safety margin.
   *
   * CTXP-03 BLOCK: system messages are NEVER dropped. They are pulled out of
   * the turn stream and re-emitted as the canonical `system` field (joined
   * with newlines when multiple exist; the original order is preserved).
   *
   * The incoming request's messages are appended AFTER the history (history
   * is older; incoming is the new turn). The whole appended sequence is then
   * trimmed; system is always preserved.
   */
  provideContext(
    history: Turn[],
    incomingMessages: CanonicalMessage[],
    incomingSystem: string | undefined,
    opts: ProvideContextOpts,
  ): ProvideContextResult;
}
```

### Default `sliding-window` strategy (DEFAULT — per orchestrator brief)

```typescript
// Pseudocode for the sliding-window implementation:
export function slidingWindowContext(
  history: Turn[],
  incomingMessages: CanonicalMessage[],
  incomingSystem: string | undefined,
  opts: ProvideContextOpts,
): ProvideContextResult {
  const ctxSize = opts.entry.ctx_size ?? 8192;  // Falls back to a safe default if absent (CTXP-04 widening makes this required)
  const reserve = opts.max_tokens_reserve ?? Math.max(512, Math.floor(ctxSize * 0.10));
  const budget = ctxSize - reserve;

  // Split history into pinned (system) + evictable (user/assistant/tool).
  const pinnedSystem: string[] = [];
  const evictable: CanonicalMessage[] = [];
  for (const turn of history) {
    if (turn.role === 'system') {
      pinnedSystem.push(stringifyContent(turn.content));
    } else {
      evictable.push(turnToCanonicalMessage(turn));  // maps tool turns to tool_result blocks per canonical.ts
    }
  }
  if (incomingSystem) pinnedSystem.push(incomingSystem);

  // Append incoming messages to evictable (newest is last).
  evictable.push(...incomingMessages);

  // Build a probe canonical with the pinned system + all evictable.
  // Trim from the FRONT (oldest evictable) until tokens fit budget.
  const systemStr = pinnedSystem.length > 0 ? pinnedSystem.join('\n\n') : undefined;
  let droppedCount = 0;
  while (evictable.length > 0) {
    const probe: CanonicalRequest = {
      model: opts.entry.backend_model,
      ...(systemStr ? { system: systemStr } : {}),
      messages: evictable,
    };
    const tokens = countTokens(probe);
    if (tokens <= budget) {
      return {
        messages: evictable,
        system: systemStr,
        dropped_count: droppedCount,
        estimated_tokens: tokens,
        has_pending_tool_call: false,  // filled in by route handler from session row
      };
    }
    evictable.shift();   // drop oldest
    droppedCount++;
  }

  // Last resort: every evictable turn was dropped; return system + incoming only.
  return {
    messages: incomingMessages,
    system: systemStr,
    dropped_count: droppedCount,
    estimated_tokens: countTokens({ model: opts.entry.backend_model, ...(systemStr ? { system: systemStr } : {}), messages: incomingMessages }),
    has_pending_tool_call: false,
  };
}
```

### Token Estimation — Reuse existing `countTokens()`

```typescript
// Already exists at router/src/translation/count-tokens.ts:148
// Signature: countTokens(canonical: CanonicalRequest): number
// Encoder:   gpt-tokenizer/encoding/cl100k_base — verified import at line 28
import { countTokens } from '../translation/count-tokens.js';
```

**Why this is safe across heterogeneous backends:**
- `cl100k_base` over-estimates token count by ~10-20% on qwen2.5/llama3 vocabularies (PITFALLS P4-05 documents this). That's a **conservative safety margin** — the router never blows past `ctx_size` on the backend, even when the local tokenizer is different from cl100k_base.
- No per-model tokenizer dependency to maintain.
- Reuses the EXACT same module that `/v1/messages/count_tokens` (Anthropic surface) already calls — single source of truth for token math across the router.

[VERIFIED: `router/src/translation/count-tokens.ts:148` exports `countTokens(canonical: CanonicalRequest): number`]

### `truncate` strategy (also ships per CTXP-02)

Same shape as sliding-window but the eviction policy is "drop oldest non-system turn" rather than "drop until fit" (which is what sliding-window does — they end up nearly identical in this implementation). Difference: `truncate` keeps a hard cap on turn count (e.g., 100 turns) **in addition to** the token budget. The orchestrator brief defaults `sliding-window` so `truncate` is the secondary strategy operators opt into via models.yaml.

> **Recommendation:** Implement both behind the same `provideContext()` function with a `switch (opts.strategy)` dispatch. The sliding-window path is the hot path; truncate adds ~15 LOC for the turn-count cap branch.

### System Pin — exact rule

> **CTXP-03 BLOCK:** Index 0 of the returned `messages[]` MUST always be a system turn IF any system content exists (either from history or incoming).
>
> **Translation to canonical:** Our canonical does NOT permit `role: 'system'` inside `messages[]` (verified at `router/src/translation/canonical.ts:109` — enum is `['user', 'assistant']`). System lives at the top-level `CanonicalRequest.system: string`. So the "index 0 system" guarantee is satisfied at the **wire boundary** — the upstream model sees `system` as the first context. The CTXP-03 test must assert that `result.system` is populated whenever any system turn exists in history OR incoming, NOT assert `messages[0].role === 'system'` (which is structurally impossible in canonical).
>
> **Multiple system turns:** join with `'\n\n'` separator, original order preserved. CONTEXT.md should confirm this ordering choice — see Open Questions.

---

## SummaryProvider Interface + Noop Default

> Location: `router/src/providers/summary-provider.ts` (NEW file).

### Interface

```typescript
// router/src/providers/summary-provider.ts
import type { Turn } from './session-store.js';

export interface SummarizeOpts {
  /** The model entry of the session's primary chat model — provided so non-Noop
   *  implementations can decide which backend to use. Noop ignores it. */
  entry: ModelEntry;
  /** Token cap on the generated summary. Default: 512. */
  max_summary_tokens?: number;
  /** SUMP-03 BLOCK: caller MUST pass this flag from session.has_pending_tool_call.
   *  Implementations MUST return null when true. */
  has_pending_tool_call: boolean;
}

export interface SummarizeResult {
  /** The summary string. Empty string for the Noop. */
  summary: string;
  /** Which turns the summary replaces — used by ContextProvider's summarize-hook
   *  strategy (deferred to SUMP-FUT-02). Empty array for the Noop. */
  replaced_turn_ids: string[];
}

export interface SummaryProvider {
  summarize(turns: Turn[], opts: SummarizeOpts): Promise<SummarizeResult | null>;
}
```

### `NoopSummaryProvider` (DEFAULT — SUMP-02)

```typescript
export class NoopSummaryProvider implements SummaryProvider {
  /**
   * SUMP-02: never calls any model. Returns null to signal "no compaction performed".
   *
   * SUMP-03 BLOCK: even if a real SummaryProvider were swapped in, the v0.11.0
   * contract is that summarize() is never invoked when has_pending_tool_call is
   * true. This check belongs at the CALL SITE (in ContextProvider's summarize-hook
   * strategy, deferred to SUMP-FUT-02). The Noop honors it as defensive code.
   */
  async summarize(_turns: Turn[], opts: SummarizeOpts): Promise<SummarizeResult | null> {
    if (opts.has_pending_tool_call) {
      return null;  // SUMP-03 BLOCK guard
    }
    return { summary: '', replaced_turn_ids: [] };
  }
}
```

### `has_pending_tool_call` flag — where it lives + how it's set

**Location:** `sessions.has_pending_tool_call BOOL NOT NULL DEFAULT false` (added in migration 0006 — see schema above).

**Maintenance rule** (enforced inside `appendTurn` transaction):

| Turn being appended | Previous `has_pending_tool_call` | New `has_pending_tool_call` |
|---------------------|----------------------------------|------------------------------|
| `role='assistant'` + `tool_calls.length > 0` | any | **true** |
| `role='assistant'` + no tool_calls | any | **false** |
| `role='tool'` | true | true UNTIL all outstanding `tool_call_id`s are matched, then **false** |
| `role='user'` or `role='system'` | unchanged | unchanged |

**Implementation note:** the "outstanding tool_calls" check requires looking at the previous assistant turn's `tool_calls` array. Since v0.11.0's `SummaryProvider` is Noop, the consequence of an incorrect derivation is zero (Noop ignores the flag). The planner should ship a simple conservative algorithm (flag stays true until any tool turn is appended OR a non-tool, non-assistant-with-tools turn is appended) — and document it for the v0.12 work that ships a real SummaryProvider. The exact algorithm should be locked in CONTEXT.md.

> **Surfacing to ContextProvider:** When the route handler loads the session, it ALSO reads `sessions.has_pending_tool_call` (one extra column on the same SELECT — zero extra round-trip). It passes the value into `provideContext()` opts, which surfaces it on `ProvideContextResult.has_pending_tool_call`. Any future summarize-hook call reads it from there.

---

## Wire-Up at the Route Layer

Three routes need session integration: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`. The shape is identical across all three.

### Hook + preHandler design

Add a new preHandler `sessionIdPreHandler` registered in `app.ts` IMMEDIATELY AFTER `agentIdPreHandler` (because session attachment requires `req.agentId` to already be stamped):

```typescript
// router/src/middleware/sessionId.ts (NEW)
//
// Extracts the X-Session-ID header, validates regex, stamps req.sessionId.
// Does NOT load the session — that happens inside the route handler. This
// hook is the SAME PATTERN as scopedIdsPreHandler: stamp + validate, never
// touch I/O.
//
// MUST run AFTER agentIdPreHandler (agent_id is needed by SessionStore.loadHistory
// which the route handler calls).

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    /** X-Session-ID validated by sessionIdPreHandler. undefined when absent. */
    sessionId?: string;
  }
}

export async function sessionIdPreHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const raw = req.headers['x-session-id'];
  if (raw === undefined) return;  // SESS-06: stateless mode
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new InvalidSessionIdError(typeof value === 'string' ? value : '');
  }
  req.sessionId = value;
}
```

### Route handler integration (identical pattern across all 3 routes)

The insertion point is **after `applyPreflight` succeeds and AFTER `entry.backend` is stamped, but BEFORE the canonical is built**. This keeps the session lookup inside the policy-passed path (no point loading a session for a 403'd request) and gives the route handler a chance to apply ContextProvider to the result.

```typescript
// router/src/routes/v1/chat-completions.ts — diff sketch (sense, not literal LOC)
//
//   // ... existing applyPreflight, breakerState check, max_tokens cloud cap, etc.
//
//   const adapter: BackendAdapter = opts.makeAdapter(entry);
//
//   // ─── Phase 17 (SESS-01..06 + CTXP-01..04): session attach ─────────────────
//   // Phase-17-only block. Skipped entirely when req.sessionId is undefined.
//   let sessionAttached = false;
//   let sessionHadPendingToolCall = false;
//   let pinnedSystem: string | undefined;
//   let mergedMessages: ChatMessageSchema[];
//   if (req.sessionId && opts.sessionStore && req.agentId) {
//     try {
//       // SESS-01: ensure session exists (idempotent createSession echoes input id).
//       await opts.sessionStore.createSession({
//         session_id: req.sessionId,
//         agent_id: req.agentId,
//         tenant_id: req.tenantId,
//         project_id: req.projectId,
//       });
//
//       // SESS-03: agent_id mandatory positional.
//       const history = await opts.sessionStore.loadHistory(req.sessionId, req.agentId);
//
//       // Apply ContextProvider — preserves system, trims to ctx_size.
//       const ctxResult = opts.contextProvider.provideContext(
//         history,
//         /* incomingMessages= */ canonicalIncomingFrom(body.messages),
//         /* incomingSystem=   */ undefined, // OpenAI doesn't have top-level system; system is a role inside messages — already pulled out into history if persisted
//         { entry },
//       );
//       mergedMessages = canonicalToOpenAIMessages(ctxResult.messages);
//       pinnedSystem = ctxResult.system;
//       sessionHadPendingToolCall = ctxResult.has_pending_tool_call;
//       sessionAttached = true;
//
//       // SESS-05: stamp the response header NOW so even if streaming, the client sees it.
//       void reply.header('X-Session-ID', req.sessionId);
//     } catch (sessErr) {
//       // SessionNotFoundError / SessionExpiredError / SessionAgentMismatchError →
//       // log warn + proceed stateless (fail-open). NEVER 4xx the caller — the contract
//       // is "session header is best-effort augmentation".
//       req.log.warn({ err: sessErr, session_id: req.sessionId }, 'session attach failed; continuing stateless');
//       mergedMessages = body.messages;
//     }
//   } else {
//     mergedMessages = body.messages;
//   }
//
//   // ─── Build canonical with the post-context messages ───────────────────────
//   const canonical = openAIRequestToCanonical({
//     ...body,
//     model: entry.backend_model,
//     messages: mergedMessages,
//     // Inject pinned system into the canonical's top-level system field:
//     ...(pinnedSystem ? { system: pinnedSystem } : {}),
//   });
//
//   // ... existing capability gates + AbortController + semaphore + adapter call ...
//   // The adapter call produces `canonicalResult` (non-stream) or completes the SSE
//   // pipeline (stream). On SUCCESS we append the turn pair to the session:
//
//   // After successful adapter response (NON-STREAM path):
//   if (sessionAttached && req.sessionId && req.agentId && canonicalResult) {
//     // Append BOTH turns inside a single transaction batch. SESS-04 sync write with
//     // 1s timeout fail-open. Order matters: user first (turn_index N+1), assistant
//     // second (turn_index N+2). We use TWO appendTurn calls — the advisory lock
//     // serializes them per-session.
//     try {
//       await opts.sessionStore.appendTurn(req.sessionId, req.agentId, {
//         role: 'user',
//         content: canonicalizeUserMessage(body.messages),  // last user message in incoming
//       });
//       await opts.sessionStore.appendTurn(req.sessionId, req.agentId, {
//         role: 'assistant',
//         content: canonicalResult.content,
//         tool_calls: extractToolCalls(canonicalResult),
//         model: entry.name,
//         tokens_in: canonicalResult.usage.input_tokens,
//         tokens_out: canonicalResult.usage.output_tokens,
//       });
//     } catch (appendErr) {
//       // SESS-04 fail-open already happened inside appendTurn (persisted:false).
//       // Re-thrown errors here are truly exceptional — log warn but DO NOT fail the response.
//       req.log.warn({ err: appendErr, session_id: req.sessionId }, 'session append unexpected failure');
//     }
//   }
//
//   return reply.send(...);   // existing
```

### Stream path append (the harder case)

For SSE responses, `appendTurn` for the assistant turn must wait until the stream completes (we need `output_tokens` + assembled text from the canonical stream events). The cleanest place to do this is **inside the existing `sseCleanup` closure** that already fires on stream-done/aborted/error.

```typescript
// Inside the streaming branch's sseCleanup (chat-completions.ts:486-490 area, current code)
const followerSseCleanup = (final?: { tokensIn: number; tokensOut: number; error?: Error }): void => {
  // ... existing recordOutcome / heartbeat cleanup ...

  // ─── Phase 17: append turns AFTER stream completes (assistant text known) ───
  if (!final?.error && sessionAttached && req.sessionId && req.agentId) {
    // Fire-and-forget — but inside an IIFE so the closure can await without
    // blocking the stream cleanup. We do NOT block reply close on session persistence.
    // SESS-04 still gives us the 1s timeout fail-open inside appendTurn.
    void (async () => {
      try {
        await opts.sessionStore.appendTurn(req.sessionId!, req.agentId!, {
          role: 'user',
          content: canonicalizeUserMessage(body.messages),
        });
        await opts.sessionStore.appendTurn(req.sessionId!, req.agentId!, {
          role: 'assistant',
          content: assembleTextContent(streamedChunks),  // accumulated during the stream
          tool_calls: extractToolCallsFromStreamedChunks(streamedChunks),
          model: entry.name,
          tokens_in: final?.tokensIn,
          tokens_out: final?.tokensOut,
        });
      } catch (e) {
        req.log.warn({ err: e, session_id: req.sessionId }, 'session append after stream failed');
      }
    })();
  }
};
```

**Important**: For the stream path the response header `X-Session-ID` MUST be stamped BEFORE the SSE response begins (because once `reply.sse(...)` is called the headers seal — same constraint as the existing `X-Cost-Cents` discussion in Phase 16). Stamp it in the session-attach block above, BEFORE the stream branch checks. (Code already shows this — `reply.header('X-Session-ID', ...)` is called inside the attach block.) [VERIFIED: same pattern as `responses.ts:332` for `Retry-After`]

### Three-route summary

| Route | Existing entry pattern | Phase 17 changes |
|-------|------------------------|-------------------|
| `/v1/chat/completions` | `chat-completions.ts:156-208` `applyPreflight → resolvedBackend → adapter` | Insert session-attach block after `adapter = opts.makeAdapter(entry)` and before `openAIRequestToCanonical(...)`. Stream cleanup adds `appendTurn` x2 inside sseCleanup. Non-stream path appends after `canonicalResult` is assigned. |
| `/v1/responses` | `responses.ts:312-398` `applyPreflight → adapter → responsesToCanonical` | Same shape; insert session-attach between `adapter = ...` and `responsesToCanonical(body, entry.backend_model)`. ContextProvider's `messages` output is passed as a synthetic `input: messages[]` so `responsesToCanonical` projects them into the canonical correctly. |
| `/v1/messages` | `messages.ts:182-203` `applyPreflight → adapter → anthropicRequestToCanonical` | Same shape. Anthropic surface already has top-level `system: string` on the body — merge with `pinnedSystem` from ContextProvider (concat with `\n\n` separator). The body's `messages` array is replaced with the trimmed `ctxResult.messages`. |

### BuildAppOpts widening

```typescript
// router/src/app.ts — BuildAppOpts gains optional fields
export interface BuildAppOpts {
  // ... existing fields ...
  /** Phase 17 (SESS-01) — optional. When undefined, all session attach blocks no-op. */
  sessionStore?: SessionStore;
  /** Phase 17 (CTXP-01) — optional. When undefined, route handler skips ContextProvider and uses body.messages verbatim. */
  contextProvider?: ContextProvider;
  /** Phase 17 (SUMP-01) — optional. When undefined, falls back to NoopSummaryProvider. */
  summaryProvider?: SummaryProvider;
}
```

When all three opts are undefined (existing test fixtures), the routes behave byte-identical to Phase 16 — that's the SESS-06 / regression contract.

---

## `models.yaml` Stanza — `ctx_size` + `context_strategy`

### Zod schema widening on `ModelEntrySchema`

```typescript
// router/src/config/registry.ts — ModelEntrySchema additions (CTXP-04)
export const ModelEntrySchema = z.object({
  // ... all existing fields preserved ...

  // Phase 17 (v0.11.0 — CTXP-04): per-model context window + strategy.
  // Both default to safe values so existing models.yaml entries continue to load
  // without modification. When SessionStore is wired and ContextProvider is active,
  // these drive window trimming.
  ctx_size: z.number().int().positive().default(8192),
  context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window'),
});
```

**Default rationale:**
- `ctx_size: 8192` is the smallest `max_model_len` in the current `models.yaml` (verified: most entries use 8192; cloud models use 32768/65536). Operators bump per-entry.
- `context_strategy: 'sliding-window'` is the default per orchestrator brief and the more forgiving strategy.

### Commented stanza for `models.yaml` (operator-facing docs)

```yaml
# ─────────────────────────────────────────────────────────────────────────────
# CONTEXT WINDOW (Phase 17 — v0.11.0 — CTXP-04)
# ─────────────────────────────────────────────────────────────────────────────
#
# Two optional fields on each model entry tune the ContextProvider that ships
# with v0.11.0. When `X-Session-ID` is present on a request, the router loads
# the session's history and uses these fields to trim the message array so it
# fits the upstream model's context window.
#
#   ctx_size         integer (default 8192)
#                    The model's context window in tokens. Token counting uses
#                    gpt-tokenizer/cl100k_base which over-estimates qwen/llama
#                    vocabularies by ~10-20% — that's a deliberate safety margin.
#
#   context_strategy enum: "truncate" | "sliding-window"   (default sliding-window)
#                    truncate       — drop oldest non-system turns, hard turn cap.
#                    sliding-window — drop oldest non-system turns until tokens fit.
#                    System messages are NEVER evictable by either strategy
#                    (CTXP-03 BLOCK — preservation is a binding invariant).
#
# Sessions are opt-in: requests without X-Session-ID are stateless and these
# fields are unused. Default values preserve pre-Phase-17 behavior on every
# existing entry — no migration is required to keep existing routes working.
#
# Example:
#   - name: chat-local
#     ...
#     ctx_size: 8192
#     context_strategy: sliding-window     # default — can be omitted
#
#   - name: gpt-oss:120b-cloud
#     ...
#     ctx_size: 65536                      # cloud model has a larger window
#     context_strategy: sliding-window
# ─────────────────────────────────────────────────────────────────────────────
```

> **Plan recommendation:** ship this stanza as a docs-only comment block in `models.yaml` initially — DO NOT add the fields to every existing entry. The Zod defaults take care of that. Operators who want non-default values opt in per entry.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting | Per-model tokenizer dispatch (qwen.tokenizer, llama.tokenizer, gpt.tokenizer) | `countTokens()` from `router/src/translation/count-tokens.ts:148` | Already implemented; cl100k_base over-estimates → safety margin. Per-model dispatch is an unbounded maintenance liability. |
| Concurrent write race | Application-level mutex / Valkey distributed lock | `pg_advisory_xact_lock(hashtext(session_id))` inside the same tx as the INSERT | Single round-trip; auto-released on COMMIT/ROLLBACK; no second source of truth. Single-host constraint makes Postgres-native lock sufficient. |
| Session-ID generation | `crypto.randomUUID()` / `Math.random()`-based ID | `ulid()` from `ulid` package | Already installed; monotonic ordering helps debugging; identical pattern to `idempotency.ts` + `bufferedWriter.ts`. |
| Cross-agent isolation | Bearer→tenant_id mapping; row-level security | `WHERE agent_id = $1` on every query | Frame-06: tenant IDs are explicit headers; RLS is a Postgres-feature gap (works) but adds a runtime check that should be in code, not infra. Plus: same pattern as request_log's agent_id (Phase 5). |
| TTL enforcement | Postgres trigger that DELETEs on access | `expires_at TIMESTAMPTZ NOT NULL` + check on SELECT | GC is deferred to SESS-FUT-01 (cron). v0.11.0 enforces TTL at READ time: `loadHistory` returns `[]` when expired (same as session-not-found). |
| Async session writes | `bufferedWriter.push()` (fire-and-forget) | Sync `await db.transaction(...)` with 1s timeout | SESS-04 BLOCK: durability before response is the contract. bufferedWriter is explicitly for observability (loss-OK); session truth is not loss-OK. |
| Summarization logic | Calling a model to summarize old turns | `NoopSummaryProvider` returns `{ summary: '', replaced_turn_ids: [] }` | Frame-03 binding: router exposes the seam, the operator wires in their own impl downstream. |
| System-message order | Heuristics about "the most important system" | Concat all system turns in original order with `\n\n` | Deterministic; operators control the order by appending sessions in the order they want. Surface in CONTEXT.md to confirm. |

**Key insight:** Phase 17 is 80% reuse of existing primitives. The new code is mostly schema (table definitions + Zod widening) + glue (route insertion + preHandler). The single piece of net-new logic is the sliding-window trim loop.

---

## Runtime State Inventory

> Phase 17 is greenfield (new tables, new modules, new routes-of-attachment). No rename/refactor.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **None** — verified by grep: no existing `sessions` or `conversation_turns` table in any migration 0000-0005. The names are unused. | None |
| Live service config | **None** — no `models.yaml` entry currently has `ctx_size` or `context_strategy`; Zod defaults pick them up cleanly. | None |
| OS-registered state | **None** — no service unit, no Windows Task Scheduler, no pm2 entry references session storage. | None |
| Secrets/env vars | **One new env var:** `SESSION_TTL_DAYS` (default 7). Add to `EnvSchema` in `router/src/config/env.ts`; document in `.env.example`. | Add env var declaration + default; update DEPLOY.md. |
| Build artifacts | **None** — drizzle-kit's `_journal.json` is the only artifact-like file touched; treated as code (committed). | None — journal is committed alongside SQL. |

---

## Common Pitfalls

### Pitfall 17-A: Append-turn race despite advisory lock (the missed read)

**What goes wrong:** Developer writes `appendTurn` as: (1) SELECT MAX(turn_index), (2) advisory lock, (3) INSERT MAX+1. The lock is in the wrong position — between read and write — and two writers still race.

**Why it happens:** Locks-before-read feels redundant when you've never seen a Postgres race report.

**How to avoid:** Lock FIRST, THEN read MAX, THEN insert. The lock must wrap both the read and the write. The example code above is correct; the planner must ensure code review enforces the ordering. Add a unit test that runs 10 parallel `appendTurn` calls on the same session and asserts `turn_index` values are `[1..10]` with no gaps and no duplicates.

**Warning signs:** `turn_index` gaps in `conversation_turns`; UNIQUE constraint violations on `(session_id, turn_index)` in production logs.

---

### Pitfall 17-B: `agent_id` opt that turns into a 4xx

**What goes wrong:** `loadHistory(session_id, agent_id)` finds the session row but `agent_id` mismatches. Developer raises `SessionAgentMismatchError` → centralized handler → 403 response. The 403 itself **proves** the session_id exists for some other agent — information leakage.

**Why it happens:** "Throwing on error" is the Node idiom. But for anti-leakage paths, the empty-result is the contract.

**How to avoid:** `loadHistory` returns `[]` on `(session_id, agent_id)` mismatch — no error, no log at warn level, no 4xx. **Only** log at INFO with `session_attach_mismatch` event so a careful operator can spot misconfigured clients. `appendTurn`, by contrast, IS allowed to throw `SessionAgentMismatchError` — because by the time you call `appendTurn` you've already presumed the session is yours, and a mismatch is an integrity failure worth surfacing.

**Warning signs:** `403 session_agent_mismatch` envelope appearing in n8n logs; multiple agents trying to use the same `X-Session-ID`.

---

### Pitfall 17-C: System pin "preserves" by putting `role:'system'` into messages[0]

**What goes wrong:** ContextProvider returns `messages: [{ role: 'system', content: '...' }, { role: 'user', ... }]`. The canonical schema (`router/src/translation/canonical.ts:109`) rejects `role: 'system'` in messages — only `'user' | 'assistant'` are accepted. Zod throws; request fails.

**Why it happens:** Reading "system messages are pinned at index 0" literally without checking the canonical type.

**How to avoid:** System turns are aggregated into the canonical's top-level `system: string` field (NOT inside `messages[]`). The CTXP-03 test must assert `result.system` is populated when system turns exist, NOT `result.messages[0].role === 'system'`. The provideContext implementation above already does this. Add a unit test that loads a history with 3 system turns and asserts `result.system === 'sys1\n\nsys2\n\nsys3'` and `result.messages` contains no system entries.

**Warning signs:** Zod validation errors in route logs mentioning `messages.0.role` and `'system'`.

---

### Pitfall 17-D: SSE response header stamped after `reply.sse(...)`

**What goes wrong:** Developer puts `reply.header('X-Session-ID', ...)` after the stream branch's `reply.sse(...)` call. SSE headers are already sealed; the header silently doesn't ship.

**Why it happens:** Same root cause as Phase 16's `X-Cost-Cents` for streaming (mirrors `responses.ts:332` for `Retry-After`).

**How to avoid:** Stamp `X-Session-ID` IMMEDIATELY after a successful `createSession` / `loadHistory`, BEFORE any `reply.sse(...)` or `reply.send(...)` call in the route handler. The example wire-up above shows this ordering correctly. Add an integration test: streaming request with `X-Session-ID` asserts the response header contains the same `X-Session-ID` value.

**Warning signs:** Smoke test for SESS-05 passes on non-stream but fails on stream — header missing from SSE response headers.

---

### Pitfall 17-E: `appendTurn` sync timeout dropping turns silently

**What goes wrong:** Postgres is briefly slow (locked write, autovacuum); `appendTurn` times out at 1s, returns `persisted: false`. Route handler ignores the flag, response goes back to the caller. Caller's next request loads incomplete history; model gets confused. No alarm fires.

**Why it happens:** Fail-open is correct (SESS-04) but the visibility burden falls on logs + metrics — easy to miss if not instrumented.

**How to avoid:** When `appendTurn` returns `persisted: false`, the route handler MUST: (1) log at `warn` with `event: 'session_append_failed_open'` + `session_id` + `agent_id`, (2) emit a Prometheus counter `router_session_append_failed_total{reason="timeout"}` (bounded label only — NO `_id` per P8-03), (3) NOT fail the response. The counter MUST be added in the same plan as the wire-up so the operator-facing signal exists from day one.

**Warning signs:** `router_session_append_failed_total` increments without corresponding `session_append_failed_open` log lines (or vice versa); session history that doesn't include the previous turn.

---

### Pitfall 17-F: Stream-path `appendTurn` blocking SSE close

**What goes wrong:** Developer puts `await appendTurn(...)` in the synchronous path of `sseCleanup`. The SSE connection waits for Postgres before closing TCP; under Postgres-slow conditions, the client perceives the stream as hanging.

**Why it happens:** Async cleanup blocks are subtle. The natural place to put `appendTurn` is right after `controller.signal.aborted` check inside sseCleanup — but that's the synchronous path.

**How to avoid:** Wrap the stream-path `appendTurn` calls in `void (async () => { ... })()` — fire-and-forget at the closure boundary. The 1s timeout inside `appendTurn` already bounds the worst-case wallclock for the background work. Document this in the comment block above the IIFE so a future reader doesn't "tidy it up" to `await`. The non-stream path CAN `await` since `reply.send()` is not pending when the append happens.

**Warning signs:** SSE clients reporting "stream takes 2-3 seconds to close after final event"; correlation between Postgres latency and SSE close latency in dashboards.

---

### Pitfall 17-G: ContextProvider trimming the **incoming** message

**What goes wrong:** Sliding-window strategy trims from the front of the merged `evictable[]` array. Under extreme conditions (history + incoming both very long; `ctx_size` is small), the loop drops the incoming user message itself — the model receives only history, no current question.

**Why it happens:** The merged array treats incoming and history uniformly. A naive while-loop drops from index 0 until budget fits — and the incoming message ends up at the tail, fine, but with a different budget calculation a developer might rewrite the loop to "drop newest" and break this.

**How to avoid:** The incoming message(s) are PRIVILEGED — they MUST be in the returned `messages[]` always. Add an invariant assertion at the end of `provideContext`: `assert(incomingMessages.every(m => result.messages.includes(m)))`. If the assertion fails (history alone exceeds budget AFTER reserving for incoming), the trim algorithm has a bug.

**Warning signs:** Model responses that ignore the user's current question and respond to a previous turn; integration test where a long history + short ctx_size returns a result without the incoming message.

---

### Pitfall 17-H: `expires_at` set to literal `NULL` via JS undefined

**What goes wrong:** `createSession` is called without `ttl_seconds`; JS `undefined` propagates to the Drizzle insert; Drizzle sends `NULL` for `expires_at`; the `NOT NULL` constraint rejects the insert.

**Why it happens:** Defaults are easy to forget at the impl layer when the schema already says `NOT NULL`.

**How to avoid:** `createSession` MUST compute `expires_at = new Date(Date.now() + (ttl_seconds ?? DEFAULT_TTL_SEC) * 1000)` BEFORE calling Drizzle. Add a unit test that calls `createSession({ session_id: 'x', agent_id: 'a' })` (no ttl_seconds) and asserts the row's `expires_at` is exactly `DEFAULT_TTL_SEC` from now (±1s).

**Warning signs:** Postgres errors mentioning `null value in column "expires_at" violates not-null constraint`.

---

### Pitfall 17-I: `gpt-tokenizer` cold-start latency on first session

**What goes wrong:** `countTokens()` lazy-loads the cl100k_base encoding tables on first call. The first session-attached request takes ~200ms longer than subsequent ones because the encoder initializes inside the route handler.

**Why it happens:** `gpt-tokenizer/encoding/cl100k_base` is the recommended subpackage import (one-shot load), but the load only happens on first `encode()` call.

**How to avoid:** Call `countTokens({ model: 'warmup', messages: [{ role: 'user', content: [{ type: 'text', text: 'warmup' }] }] })` once during `buildApp` initialization (in `app.ts`, right after `registry.resolve` is wired up). Document the warmup as a Phase 17 boot step. Verified safe: same module already used in `/v1/messages/count_tokens` route (Phase 4) so the warmup at boot doesn't risk a different code path.

**Warning signs:** First request with `X-Session-ID` after process start has 200ms+ higher TTFT than steady-state requests; the `router_request_duration_seconds` histogram shows a tail spike right after restarts.

---

## Code Examples

### Example 1: SessionStore.loadHistory with agent_id scope

```typescript
// Source: design recommendation above (composite of P4-03 + REQ SESS-03)

// router/src/providers/postgres-session-store.ts
async function loadHistory(
  session_id: string,
  agent_id: string,
  opts: LoadHistoryOpts = {},
): Promise<Turn[]> {
  // SESS-03 / P4-03 BLOCK: agent_id is in the WHERE clause unconditionally.
  // A mismatched agent_id returns [] — never 403 (Pitfall 17-B).
  const rows = await db
    .select()
    .from(conversationTurns)
    .innerJoin(sessions, eq(sessions.session_id, conversationTurns.session_id))
    .where(and(
      eq(conversationTurns.session_id, session_id),
      eq(conversationTurns.agent_id, agent_id),    // P4-03 BLOCK
      gt(sessions.expires_at, new Date()),         // P4-01 implicit: expired sessions return []
      opts.since_index !== undefined ? gte(conversationTurns.turn_index, opts.since_index) : undefined,
      opts.before_index !== undefined ? lt(conversationTurns.turn_index, opts.before_index) : undefined,
    ))
    .orderBy(opts.ascending === false ? desc(conversationTurns.turn_index) : asc(conversationTurns.turn_index))
    .limit(opts.limit ?? 10000);
  return rows.map(rowToTurn);
}
```

### Example 2: ContextProvider sliding-window with system pin

See full implementation in §ContextProvider section above. The key invariants:
1. `pinnedSystem[]` is collected BEFORE `evictable[]` is sliced.
2. Trim loop pops from front of `evictable` (oldest non-system), never from `pinnedSystem`.
3. Returned `system` string is `pinnedSystem.join('\n\n')` (joined verbatim).
4. Returned `messages[]` contains zero `role: 'system'` entries — canonical-correct.

### Example 3: Migration journal entry shape

```json
// router/db/migrations/meta/_journal.json — APPEND THIS ENTRY (idx 6):
{
  "idx": 6,
  "version": "7",
  "when": <Date.now() at write time, milliseconds since epoch>,
  "tag": "0006_sessions",
  "breakpoints": true
}
```

Pair with the SQL file `router/db/migrations/0006_sessions.sql` AND the Drizzle schema `router/src/db/schema/sessions.ts` — three writes in ONE plan task per P9-01 BLOCK.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| In-memory session map (process-local) | Postgres-backed durable storage | v0.11.0 Phase 17 | Survives router restart; multi-process-safe (advisory lock); no extra deps. |
| Async-buffered write (request_log pattern) | Sync write with 1s timeout fail-open | v0.11.0 Phase 17 | Durability before response — session truth never lost on crash; bounded latency. |
| `chars / 3` token estimate (PITFALLS P4-05) | `gpt-tokenizer` cl100k_base via existing `countTokens()` | n/a — gpt-tokenizer was already installed in Phase 12 | More accurate; ~10-20% conservative on qwen/llama (safety margin). |
| Tool-call summarization unguarded | `has_pending_tool_call` flag on `sessions` table | v0.11.0 Phase 17 | Prevents LangMem-style state destruction (P6-01 / LangMem issue #126). |
| Cross-tenant session leakage at query layer | `agent_id` mandatory positional param on every read | v0.11.0 Phase 17 | Single point of enforcement; matches Phase 5 request_log.agent_id pattern. |

**Deprecated/outdated:**
- The `replaceTurns` operation listed in REQUIREMENTS.md SESS-01 has no caller in v0.11.0 (no real SummaryProvider ships). Implementation is recommended now (small LOC) so the interface stays honest, but the integration test scope is minimal.
- PITFALLS.md P4-05's "chars/3" recommendation is SUPERSEDED by gpt-tokenizer reuse — the more accurate measure was unavailable when PITFALLS was written (early v0.11.0); now it's in the codebase.

---

## Assumptions Log

> All claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this table to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Table name `conversation_turns` (REQ doc + STACK research) is preferred over ROADMAP's informal `session_turns`. | Standard Stack / Drizzle Schema | Low: rename is a 5-min sed. Surface in CONTEXT.md if user prefers shorter. |
| A2 | Default `SESSION_TTL_DAYS=7` for `sessions.expires_at`. | User Constraints / Drizzle Schema | Medium: a too-short TTL truncates n8n agent state; too-long fills Postgres. CONTEXT.md should confirm. |
| A3 | `replaceTurns` is implemented now (vs. throw NotImplementedError). | User Constraints / SessionStore Interface | Low: ~20 LOC; caller-free in v0.11.0. |
| A4 | `listSessions` filter shape uses mandatory `agent_id` + optional `tenant_id`/`project_id` + cursor pagination. | SessionStore Interface | Low: matches REQ + anti-leak rule. |
| A5 | `X-Session-ID` regex is `/^[A-Za-z0-9._:-]{1,128}$/` (identical to scoped-ID regex from Phase 14). | Wire-Up at Route Layer | Low: same shape as existing tenant/project regex; consistency wins. |
| A6 | Server generates ULID if client omits `X-Session-ID` AND opts in by setting some other signal — OR: header presence is the ONLY way to create a session. | Open Questions Q1 | Medium: changes the route contract. CONTEXT.md must lock. |
| A7 | Default `ctx_size: 8192` and `context_strategy: 'sliding-window'` for entries that omit the new fields. | models.yaml Stanza | Low: matches smallest existing `max_model_len`; defaults are sane. |
| A8 | `has_pending_tool_call` derivation: any assistant turn with unmatched `tool_calls` sets true; any tool turn with matching `tool_call_id` clears (conservative algorithm). | SummaryProvider | Low for v0.11.0 (Noop ignores), High for v0.12+ (real summarizer relies on accuracy). CONTEXT.md should ratify the exact rule. |
| A9 | Token estimation reuses `countTokens()` from `router/src/translation/count-tokens.ts:148` — overrides PITFALLS P4-05's "chars/3" guidance. | Standard Stack / ContextProvider | Low: more accurate; same module already used by `/v1/messages/count_tokens`. |
| A10 | Session attach failures (SessionNotFoundError, SessionExpiredError, SessionAgentMismatchError from loadHistory) are caught locally and route proceeds stateless — they NEVER bubble to 4xx. `appendTurn` errors are likewise caught (log warn, return response anyway). | Wire-Up at Route Layer | Medium: the "best-effort augmentation" contract is the design intent; a different choice (fail-closed) would be a different feature. CONTEXT.md should lock. |
| A11 | Multiple system turns are joined with `\n\n` separator in original (turn_index) order. | ContextProvider | Low: deterministic; operators control order. |
| A12 | Stream-path `appendTurn` is fire-and-forget via `void (async () => { ... })()` inside `sseCleanup`. | Wire-Up at Route Layer / Pitfall 17-F | Low: bounded by SESS-04's 1s timeout. |

---

## Open Questions

> Items to lock in CONTEXT.md before planning.

### Q1: `X-Session-ID` presence semantics

**What we know:** SESS-05 says "X-Session-ID response header is set on responses when a session is active." SESS-06 says "callers without `X-Session-ID` operate stateless." The bare reading is: header presence on REQUEST = stateful mode; header absence = stateless. Server never generates a session_id on the caller's behalf.

**What's unclear:** Some session-store designs (Anthropic's MessageBatches, OpenAI Assistants) let the **server** mint a session_id on first contact and surface it in the response header — caller then echoes on subsequent requests. This is a UX nicety for clients that don't want to generate IDs themselves.

**Recommendation:** **Header-required mode for v0.11.0.** Callers must supply `X-Session-ID` to opt into stateful behavior. Server does NOT mint session_ids autonomously. This matches REQUIREMENTS.md's verbiage and is the simpler contract. Surface in CONTEXT.md to confirm.

**RESOLVED (proposed default):** Header-required mode. Server mints only when client supplies an opaque sentinel like `X-Session-ID: auto` — defer this opt-in to v0.12.

---

### Q2: Default `SESSION_TTL_DAYS` value

**What we know:** Orchestrator brief says "default TTL 7 days." Nothing else binds it.

**What's unclear:** n8n agents may want longer-lived sessions (multi-day workflows); ad-hoc curl sessions want short. 7 days is the default; do we want it shorter (3 days) to be defensive, or longer (30 days) to accommodate agent workflows?

**Recommendation:** Ship `SESSION_TTL_DAYS=7` as the env default; operators can override per deployment. v0.12's SESS-FUT-01 cron will actually enforce the expiry (today, expired sessions return `[]` on read but rows aren't deleted).

**RESOLVED (proposed default):** `SESSION_TTL_DAYS=7`.

---

### Q3: Per-session TTL override path

**What we know:** `createSession({ ttl_seconds? })` exists in the interface signature.

**What's unclear:** Is there a request header that lets the caller set TTL per session? `X-Session-TTL-Seconds: 86400`? Or is per-session TTL purely a programmatic-API concern (operator setting via direct DB / future admin endpoint)?

**Recommendation:** **No header for v0.11.0.** Per-session TTL override is set only via `SessionStore.createSession()` directly. Header support is SESS-FUT scope.

**RESOLVED (proposed default):** No header — programmatic interface only.

---

### Q4: System turn ordering when multiple system turns exist

**What we know:** CTXP-03 says "System messages are always preserved." It does NOT specify ordering when multiple system turns appear.

**What's unclear:** If a session has system turn at index 1 ("You are a helpful assistant") and at index 50 ("Respond in Spanish"), and the user then attaches another system on the new request, what's the order? Original `turn_index` order? Most recent first? Incoming-first?

**Recommendation:** **Original `turn_index` order (ascending), joined with `\n\n`.** Incoming system (if any — note OpenAI/Anthropic surface differences here) is appended last. Deterministic; operators choose ordering by appending in the desired order.

**RESOLVED (proposed default):** turn_index ascending order; incoming system appended last; joined with `\n\n`.

---

### Q5: Session-store interaction with the existing `Idempotency-Key` multiplexer

**What we know:** The leader/follower idempotency pattern from Phase 8 caches the leader's response and replays to followers. If a follower hits a session-active request, does the follower also append turns? Or does only the leader?

**What's unclear:** If a leader and 3 followers all share `(Idempotency-Key, X-Session-ID, X-Agent-ID)`, do we get 4 user/assistant pairs in the session (incorrect) or just 1 (correct)?

**Recommendation:** **Leader-only writes to SessionStore.** Followers replay the response but do NOT call `appendTurn`. Easy to enforce: `if (idempotencyRole === 'follower') skip session append`. The session attach (createSession + loadHistory) can stay leader+follower or leader-only — leader-only is simpler. The leader's response carries the post-append `X-Session-ID` header which followers also surface (already happens via response cache).

**RESOLVED (proposed default):** Leader writes session; followers replay but do NOT mutate session state. Surface in CONTEXT.md.

---

### Q6: Behavior on `expires_at` BETWEEN load and append

**What we know:** `appendTurn` checks `expires_at` inside the transaction. A session that was valid at `loadHistory` time but expires before the response cycle finishes will fail the append.

**What's unclear:** Does this mean the response goes out but with `persisted: false`? Or do we extend `expires_at` on every successful response (sliding window)?

**Recommendation:** **Sliding-window TTL.** Every successful `appendTurn` updates `sessions.expires_at = now() + SESSION_TTL_DAYS days`. The session keeps refreshing as long as it's actively used. Cold sessions reach the TTL ceiling and expire (read returns `[]`).

**RESOLVED (proposed default):** Sliding-window TTL — `expires_at` refreshes on every successful append.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Postgres 17 | sessions + conversation_turns tables; advisory lock | ✓ | 17-alpine via Docker Compose | — |
| `drizzle-orm@0.36.0` | ORM + migration tooling | ✓ | 0.36.0 (pinned in router/package.json) | — |
| `pg@8.13.0` | Postgres driver + transactions | ✓ | 8.13.0 (pinned) | — |
| `gpt-tokenizer@3.0.0` | Token counting for ContextProvider | ✓ | 3.0.0 (pinned) — already imported by `count-tokens.ts:28` | — |
| `ulid@3.0.2` | Server-generated session_id + turn_id | ✓ | 3.0.2 (pinned) | — |
| `zod@4.4.3` | Schema widening on ModelEntrySchema | ✓ | 4.4.3 (pinned) | — |
| `drizzle-kit@0.27.0` | Migration generation | ✓ | 0.27.0 (devDep, pinned) | — |
| Valkey 8 | NOT used by Phase 17 (PG advisory lock chosen instead) | ✓ (already present) | n/a for Phase 17 | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

> Zero new dependencies for Phase 17 — entirely additive on the existing locked stack.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@4.1.6` (already installed) |
| Config file | `router/vitest.config.ts` (existing) |
| Quick run command | `cd router && npm test -- tests/providers/session-store.test.ts -x` |
| Full suite command | `cd router && npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| **SESS-01** | Interface exports + shape | unit | `npm test -- tests/providers/session-store.interface.test.ts -x` | ❌ Wave 0 |
| **SESS-02** | Migration 0006 creates tables; `expires_at` NOT NULL | integration (real PG) | `npm test -- tests/integration/migrations/0006-sessions.test.ts -x` | ❌ Wave 0 |
| **SESS-03** | `loadHistory` with mismatched `agent_id` returns `[]` (not 403) | integration (real PG) | `npm test -- tests/providers/postgres-session-store.test.ts -t "agent_id mismatch returns empty"` | ❌ Wave 0 |
| **SESS-04** | `appendTurn` 1s timeout fail-open returns `persisted: false` | integration (PG with artificial slow tx) | `npm test -- tests/providers/postgres-session-store.test.ts -t "1s timeout fail-open"` | ❌ Wave 0 |
| **SESS-05** | `X-Session-ID` response header on both stream + non-stream | integration | `npm test -- tests/routes/session-attach.integration.test.ts -t "X-Session-ID header"` | ❌ Wave 0 |
| **SESS-06** | No header → no rows written → response byte-identical to Phase 16 | integration + golden | `npm test -- tests/routes/session-attach.integration.test.ts -t "stateless without header"` | ❌ Wave 0 |
| **CTXP-01** | Interface + `provideContext` signature | unit | `npm test -- tests/providers/context-provider.test.ts -t "interface shape"` | ❌ Wave 0 |
| **CTXP-02** | Both strategies (sliding-window default + truncate opt-in) | unit | `npm test -- tests/providers/context-provider.test.ts -t "both strategies"` | ❌ Wave 0 |
| **CTXP-03** | System pin: 200-turn session w/ system at index 0 + small ctx_size returns system in `result.system` (NOT in `messages`) | unit | `npm test -- tests/providers/context-provider.test.ts -t "system always pinned"` | ❌ Wave 0 |
| **CTXP-04** | Zod widening accepts ctx_size + context_strategy; defaults applied | unit | `npm test -- tests/config/registry-ctx.test.ts -t "ctx_size default 8192"` | ❌ Wave 0 |
| **SUMP-01** | Interface exports + shape | unit | `npm test -- tests/providers/summary-provider.test.ts -t "interface shape"` | ❌ Wave 0 |
| **SUMP-02** | NoopSummaryProvider returns `{ summary: '', replaced_turn_ids: [] }`; never calls any model | unit | `npm test -- tests/providers/summary-provider.test.ts -t "Noop default"` | ❌ Wave 0 |
| **SUMP-03** | `has_pending_tool_call: true` causes `summarize` to return `null` | unit | `npm test -- tests/providers/summary-provider.test.ts -t "skips during pending tool call"` | ❌ Wave 0 |
| **P4-02 BLOCK** | 10 parallel `appendTurn` calls produce turn_index 1..10 with no gaps/dupes | integration (real PG) | `npm test -- tests/providers/postgres-session-store.test.ts -t "parallel append race"` | ❌ Wave 0 |
| **P4-04 BLOCK** | System turn at history[0] + small ctx_size → still present in result.system | unit | (covered by CTXP-03 test above) | — |
| **P6-01 BLOCK** | `appendTurn` of assistant w/ tool_calls sets `has_pending_tool_call=true`; subsequent `summarize` returns `null` | integration | `npm test -- tests/providers/summary-provider.integration.test.ts -t "pending tool call gate"` | ❌ Wave 0 |
| **P9-01 BLOCK** | Migration 0006 SQL + Drizzle schema + journal entry all present | unit (filesystem assertions) | `npm test -- tests/db/migration-journal.test.ts -t "0006 indivisible tuple"` | ❌ Wave 0 |
| **Integration: SC-1** | Same X-Session-ID twice → second response demonstrates awareness of first | integration | `npm test -- tests/routes/session-attach.integration.test.ts -t "history injected on second request"` | ❌ Wave 0 |
| **Integration: SC-2** | Cross-agent leak prevention | integration | `npm test -- tests/routes/session-attach.integration.test.ts -t "different agent_id returns empty"` | ❌ Wave 0 |
| **Integration: SC-3** | Long session + small ctx_size → no 400 from backend | integration | `npm test -- tests/routes/session-attach.integration.test.ts -t "ctx_size trim avoids backend 400"` | ❌ Wave 0 |
| **Integration: SC-4** | No X-Session-ID → no session rows + byte-identical response | integration + golden | `npm test -- tests/routes/session-attach.integration.test.ts -t "stateless mode no DB writes"` | ❌ Wave 0 |
| **Integration: SC-5** | X-Session-ID on response; NoopSummaryProvider never calls any model | integration | `npm test -- tests/routes/session-attach.integration.test.ts -t "header set and noop never models"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- tests/providers/ -x` (unit suite for session/context/summary)
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green + smoke test extension passes (see Phase 19 OBSV-01 PASS entries — Phase 17 lays the groundwork: `bin/smoke-test-router.sh` gains a SESSION section in the final plan)

### Wave 0 Gaps

- [ ] `router/tests/providers/session-store.interface.test.ts` — SESS-01 type-only assertion suite
- [ ] `router/tests/providers/postgres-session-store.test.ts` — SESS-02..SESS-04 + P4-02
- [ ] `router/tests/providers/context-provider.test.ts` — CTXP-01..04 + P4-04
- [ ] `router/tests/providers/summary-provider.test.ts` — SUMP-01..03 + P6-01
- [ ] `router/tests/routes/session-attach.integration.test.ts` — SESS-05, SESS-06, SC-1..5 across all 3 routes
- [ ] `router/tests/integration/migrations/0006-sessions.test.ts` — schema + indexes + NOT NULL constraint
- [ ] `router/tests/db/migration-journal.test.ts` — P9-01 indivisible-tuple grep gate (extending existing pattern)
- [ ] `router/tests/config/registry-ctx.test.ts` — CTXP-04 Zod widening + defaults

*(Test infrastructure framework exists — vitest is already installed and used throughout the codebase.)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Bearer token via existing `onRequest` hook (Phase 2). Session attach inherits — no new auth surface. |
| V3 Session Management | **yes** | This phase IS session management. Controls: agent_id-scoped queries; TTL enforced at read; guess-resistance via ULID + 128-char regex; X-Session-ID is opaque to caller (no claims encoded). |
| V4 Access Control | yes | Cross-agent isolation enforced at query layer (P4-03 BLOCK). Same model as request_log's agent_id (Phase 5). |
| V5 Input Validation | yes | X-Session-ID regex (`/^[A-Za-z0-9._:-]{1,128}$/`); ctx_size positive int; context_strategy enum; turn content shape validated via canonical Zod. |
| V6 Cryptography | no | No new crypto primitives. Session-IDs are random (ULID) but not authenticated — auth is via bearer token. |

### Known Threat Patterns for Fastify + Postgres + LLM Router

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-agent session enumeration (guessing session_id from another agent) | Information Disclosure | ULID (128 bits, ~340 undecillion combinations) + agent_id-scoped query returns `[]` on mismatch — no error envelope reveals existence. (Pitfall 17-B above.) |
| SQL injection via session_id | Tampering | Drizzle parameterized queries; `pg_advisory_xact_lock(hashtext($1::text))` uses explicit type cast — no raw SQL concatenation. |
| Prompt injection via persisted user content | Tampering | Out of scope for Phase 17 — user content is stored as-is; downstream Phase 18 hook framework handles content sanitization for retrieved context. Phase 17 is a passthrough of caller-supplied messages. |
| Session fixation (attacker plants X-Session-ID on victim) | Tampering | Mitigated by agent_id scoping: even if attacker plants a session_id, victim with a different `X-Agent-ID` sees `[]` (sees no history). Recommend documenting in README that bearer token + X-Agent-ID identify trust boundary. |
| TTL bypass | Authentication/Access | `expires_at TIMESTAMPTZ NOT NULL` + check at every `loadHistory` + `appendTurn`. CONTEXT.md should confirm sliding-window TTL (Q6). |
| Tool-call ID destruction during summarization | Tampering (data integrity) | `has_pending_tool_call` flag on sessions table; SummaryProvider contract requires checking it (P6-01 / SUMP-03 BLOCK). |
| Bearer-token-derived tenant_id implied by session_id | Spoofing | **Frame-06 binding violation rejected**: tenant_id is explicit X-Tenant-ID header; sessions inherit tenant_id from the request that created them, never from bearer hash. |

### Security Test Matrix

| Test | What it verifies | File |
|------|------------------|------|
| `loadHistory` with mismatched agent_id returns `[]` (no 403, no info leak) | P4-03 + Pitfall 17-B | `tests/providers/postgres-session-store.test.ts` |
| `appendTurn` with mismatched agent_id throws `SessionAgentMismatchError` (403) | Anti-leak boundary — append is privileged | same |
| Concurrent `appendTurn` on same session_id produces gap-free turn_index | P4-02 race | same |
| Expired session returns `[]` on read | P4-01 TTL | same |
| `X-Session-ID: <bad chars>` returns 400 + `invalid_session_id` envelope (per OpenAI/Anthropic surface) | InvalidSessionIdError raised | `tests/routes/session-attach.integration.test.ts` |
| `X-Session-ID` not in Prometheus labels | P8-03 cardinality (existing Phase 14 CI guard catches this) | covered by `scripts/check-prometheus-cardinality.ts` |

---

## Sources

### Primary (HIGH confidence)
- Live codebase read (HIGH):
  - `router/package.json` — version pins for drizzle-orm, pg, gpt-tokenizer, ulid, zod
  - `router/src/translation/canonical.ts:108` — CanonicalMessage role enum (`'user' | 'assistant'` only; system is top-level)
  - `router/src/translation/count-tokens.ts:148` — existing `countTokens(canonical)` signature + cl100k_base encoder import
  - `router/src/middleware/scopedIds.ts` — preHandler pattern for header-validated extraction (Phase 14 template for sessionIdPreHandler)
  - `router/src/middleware/agentId.ts` — req.agentId stamping + pino child enrichment pattern
  - `router/src/db/migrations/meta/_journal.json` — last migration is 0005 (idx 5), next is 0006
  - `router/db/migrations/0005_request_log_scoped_ids.sql` — migration SQL idiom (ADD COLUMN IF NOT EXISTS, COMMENT ON COLUMN, statement-breakpoint markers)
  - `router/src/db/schema/request_log.ts` — Drizzle schema idiom (pgTable + index helpers)
  - `router/src/config/registry.ts` — ModelEntrySchema and superRefine patterns (CTXP-04 widening target)
  - `router/models.yaml` — operator-facing YAML structure (target for the new ctx_size/context_strategy commented stanza)
  - `router/src/routes/v1/chat-completions.ts` — `applyPreflight → resolvedBackend → adapter` insertion point + sseCleanup closure structure
  - `router/src/routes/v1/responses.ts` — Phase 16 stream branch shape (mirror for sessionStore wiring)
  - `router/src/routes/v1/messages.ts` — Anthropic surface insertion point
  - `router/src/db/bufferedWriter.ts` — async-buffered pattern reference (for the "what we DON'T do" comparison)
- `.planning/REQUIREMENTS.md` (SESS-01..06, CTXP-01..04, SUMP-01..03) — binding requirement source
- `.planning/ROADMAP.md` (Phase 17 section) — design constraints + 9 BLOCK pitfalls + 5 success criteria
- `.planning/research/PITFALLS.md` (Section 4 + Section 6) — P4-01..06 + P6-01 verbatim

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` (sections 4, 5, 7) — integration-point sketches for SessionStore + ContextProvider + SummaryProvider
- `.planning/research/STACK.md` (section 4) — Drizzle schema pattern + table naming convention (`conversation_turns`)
- `.planning/research/FEATURES.md` (section 4) — SessionStore canonical interface shape
- `.planning/research/SUMMARY.md` — Phase 17 rationale + research flag annotations

### Tertiary (LOW confidence — none used as authoritative)
- (none — every claim here is grounded in either the live codebase or the binding REQ/ROADMAP/PITFALLS docs)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all version pins verified against `router/package.json`; gpt-tokenizer + drizzle-orm + pg + ulid + zod already installed and exercised by existing modules.
- Architecture: HIGH — three route insertion points are identical pattern; existing Phase 14 scopedIds middleware is the direct template for sessionIdPreHandler; advisory lock SQL is plain Postgres (no client-side dependency).
- Pitfalls: HIGH — 9 BLOCK pitfalls extracted verbatim from PITFALLS.md + ROADMAP.md; 9 net-new Phase 17-specific pitfalls (17-A through 17-I) documented from architectural analysis above.
- Wire-up: HIGH — three routes share identical applyPreflight → adapter scaffolding (verified across chat-completions.ts, responses.ts, messages.ts); insertion point is unambiguous.
- Open questions: 6 surfaced (header-required vs server-mint, TTL value, per-session TTL header, system ordering, idempotency interaction, sliding TTL). All have proposed defaults; CONTEXT.md should ratify.

**Research date:** 2026-05-31
**Valid until:** 2026-06-30 (30-day window; stack is stable, no fast-moving dependencies)
