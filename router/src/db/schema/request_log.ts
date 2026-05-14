// router/src/db/schema/request_log.ts — Drizzle schema for the request_log table.
//
// Authoritative shape: 05-CONTEXT.md D-D1 (lines 87–108). One row per
// completed /v1/chat/completions or /v1/messages request after bearer auth.
// Coverage policy: D-D4 (skip /healthz, /readyz, /metrics, /v1/models,
// /v1/messages/count_tokens, and pre-auth 401s).
//
// Notes:
// - `id` uses pgcrypto's gen_random_uuid() — installed by
//   postgres/initdb/01-init.sql (D-B8).
// - `request_id` is the pino-generated req.id; NOT unique by design (rare
//   duplicates can land — see RESEARCH Pitfall 8).
// - Indexes: ts DESC (recency queries), (agent_id, ts DESC) covering index
//   for the "debug a runaway agent" use case (the literal use case in
//   PROJECT.md), and status_class for error filtering.
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(), // pgcrypto gen_random_uuid()
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    protocol: text('protocol').notNull(), // 'openai' | 'anthropic'
    route: text('route').notNull(), // '/v1/chat/completions' | '/v1/messages'
    backend: text('backend').notNull(), // 'ollama' | 'llamacpp' | future
    model: text('model').notNull(), // registry display name (NOT backend_model id)
    status_class: text('status_class').notNull(), // 'success' | 'client_error' | 'server_error' | 'disconnect'
    http_status: integer('http_status').notNull(), // 200/400/404/429/500/502/503/...
    tokens_in: integer('tokens_in'), // nullable — may not know on pre-adapter failures
    tokens_out: integer('tokens_out'), // nullable — partial on disconnect, full on success, NULL on pre-stream error
    ttft_ms: integer('ttft_ms'), // nullable — NULL for non-stream and pre-stream failures
    latency_ms: integer('latency_ms').notNull(), // always populated from perf.now() taken at preHandler
    error_code: text('error_code'), // nullable — taxonomy per D-D2
    error_message: text('error_message'), // nullable — truncated to 500 chars, bearer-redacted (D-D3)
    agent_id: text('agent_id'), // nullable — from X-Agent-Id header, validated regex (D-D5)
    request_id: text('request_id').notNull(), // pino req.id — joins with logs
    upstream_message_id: text('upstream_message_id'), // Anthropic msg_<ulid> for /v1/messages
  },
  (t) => ({
    // Baseline btree indexes per D-D1. Tune if/when volume warrants
    // (partitioning + retention is deferred to Phase 9).
    idxTsDesc: index('idx_request_log_ts_desc').on(t.ts.desc()),
    idxAgentTs: index('idx_request_log_agent_ts').on(t.agent_id, t.ts.desc()),
    idxStatusClass: index('idx_request_log_status_class').on(t.status_class),
  }),
);

// The type the BufferedWriter consumes when pushing a row.
export type RequestLogInsert = typeof requestLog.$inferInsert;
