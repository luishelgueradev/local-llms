// router/src/db/schema/sessions.ts — Drizzle schema for sessions + conversation_turns.
//
// Authoritative shape: 17-RESEARCH.md §"Drizzle Schema" (lines 469-536) +
// REQUIREMENTS SESS-02. Migration 0006 creates these tables; this module
// mirrors that DDL exactly.
//
// Invariants this schema encodes (all must round-trip 1:1 with 0006_sessions.sql):
//   - sessions.agent_id NOT NULL                  — P4-03 BLOCK
//   - sessions.expires_at NOT NULL                — P4-01 BLOCK
//   - sessions.has_pending_tool_call NOT NULL     — SUMP-03 / P6-01 BLOCK
//   - conversation_turns.session_id ON DELETE CASCADE
//   - UNIQUE (session_id, turn_index) on conversation_turns
//   - NO foreign key from conversation_turns to request_log (P4-06 FLAG)
//
// Type re-exports include BOTH $inferSelect and $inferInsert because
// loadHistory returns selected rows while appendTurn consumes the insert shape
// (RESEARCH §"Drizzle Schema" line 535).
//
// IMPORTANT (P9-01 BLOCK): this file lives in an indivisible tuple with
// router/db/migrations/0006_sessions.sql and the idx=6 entry in
// router/db/migrations/meta/_journal.json. Drizzle's migrator silently skips
// journal entries not registered — all three writes MUST land in one commit
// (project memory: project_drizzle_migration_journal.md).
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
    agent_id: text('agent_id').notNull(), // P4-03 BLOCK
    tenant_id: text('tenant_id'),
    project_id: text('project_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(), // P4-01 BLOCK
    has_pending_tool_call: boolean('has_pending_tool_call').notNull().default(false), // SUMP-03 BLOCK
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
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.session_id, { onDelete: 'cascade' }),
    agent_id: text('agent_id').notNull(),
    turn_index: integer('turn_index').notNull(),
    role: text('role').notNull(), // 'system' | 'user' | 'assistant' | 'tool'
    content: jsonb('content').notNull(), // ContentBlock[] from canonical.ts
    tool_calls: jsonb('tool_calls'),
    tool_call_id: text('tool_call_id'),
    model: text('model'),
    tokens_in: integer('tokens_in'),
    tokens_out: integer('tokens_out'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    uqSessionTurnIdx: uniqueIndex('conversation_turns_session_turn_idx_uq').on(
      t.session_id,
      t.turn_index,
    ),
    idxSessionIndex: index('idx_turns_session_index').on(t.session_id, t.turn_index),
    idxSessionTs: index('idx_turns_session_ts').on(t.session_id, t.ts),
  }),
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type ConversationTurnRow = typeof conversationTurns.$inferSelect;
export type ConversationTurnInsert = typeof conversationTurns.$inferInsert;
