// router/src/db/schema/usage_daily.ts — Drizzle schema for the per-day usage rollup.
//
// Shape per CONTEXT specifics §"usage_daily suggested shape" (lines 288–306).
//
// agent_id sentinel:
//   05-RESEARCH.md Open Question Q3 (lines 855–859) flagged that a nullable
//   text() column inside a composite primary key causes Postgres UPSERT
//   semantics to misbehave — NULL is "distinct from NULL" in unique
//   constraints, so two rows differing only by NULL in agent_id are NOT
//   treated as duplicates, breaking idempotent rollups. Resolution: declare
//   agent_id NOT NULL with a sentinel default ('_no_agent_') so the
//   composite PK is unambiguous AND the "no agent" group still aggregates
//   into a single row. Sentinel chosen to be obviously synthetic vs. any
//   real agent identifier (X-Agent-Id regex /^[A-Za-z0-9._:-]{1,128}$/
//   would match it, but underscores at both ends signal intent).
//
// The actual UPSERT logic + cron lands in Plan 05-03; this file is the
// declarative half only.
import { bigint, date, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const usageDaily = pgTable(
  'usage_daily',
  {
    day: date('day').notNull(), // UTC date
    protocol: text('protocol').notNull(),
    backend: text('backend').notNull(),
    model: text('model').notNull(),
    // Sentinel-default so the composite PK below treats "no agent" as a
    // single bucket. RESEARCH Open Question Q3.
    agent_id: text('agent_id').notNull().default('_no_agent_'),
    request_count: integer('request_count').notNull(),
    success_count: integer('success_count').notNull(),
    error_count: integer('error_count').notNull(),
    tokens_in_sum: bigint('tokens_in_sum', { mode: 'number' }).notNull(),
    tokens_out_sum: bigint('tokens_out_sum', { mode: 'number' }).notNull(),
    p50_ttft_ms: integer('p50_ttft_ms'), // nullable — only populated when at least one streamed row exists
    p95_ttft_ms: integer('p95_ttft_ms'), // nullable — same as above
    p50_latency_ms: integer('p50_latency_ms').notNull(),
    p95_latency_ms: integer('p95_latency_ms').notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.day, t.protocol, t.backend, t.model, t.agent_id],
    }),
  }),
);

export type UsageDailyInsert = typeof usageDaily.$inferInsert;
