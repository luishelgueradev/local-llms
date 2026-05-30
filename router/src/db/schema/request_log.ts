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
import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
    // Phase 8 Plan 07 (ROUTE-12 / D-D5) + 08-REVIEW CR-01 fix:
    // Idempotency-Key header value, when present + valid per
    // `/^[A-Za-z0-9._:-]{1,256}$/`. Nullable: the header is OPTIONAL and the
    // vast majority of requests do not carry one. Populated for BOTH leader
    // and follower request_log rows by the multiplexer wiring in chat-completions /
    // messages / embeddings — operators filter on this column when verifying
    // dedup (smoke-test-cloud.sh / smoke-test-router.sh / README "verify dedup").
    idempotency_key: text('idempotency_key'),
    // Phase 13 (v0.10.0 — COST-01): per-request cost in cents. NUMERIC(10,4) so we
    // can represent sub-cent costs (e.g. 100 tokens at $0.10/1M = 0.001 cents).
    // Drizzle's numeric() maps to `string | null` in TypeScript — never `number` —
    // to preserve the exact decimal representation across the SQL/JS boundary.
    // NULL when entry.pricing is undefined (typically local backends); computed
    // from (tokens_in × input_per_1m + tokens_out × output_per_1m) / 10_000 when
    // pricing is declared. computeCostCents() in src/cost/computeCostCents.ts is
    // the single source of the formula.
    cost_cents: numeric('cost_cents', { precision: 10, scale: 4 }),
    // Phase 14 (v0.11.0 — POL-04): scoped-ID columns from X-Tenant-ID /
    // X-Project-ID headers. Validated regex (shared with X-Agent-Id per D-15):
    // /^[A-Za-z0-9._:-]{1,128}$/. Invalid → 400 (D-16); missing → NULL (D-17).
    tenant_id: text('tenant_id'),
    project_id: text('project_id'),
    // Phase 14 (v0.11.0 — POL-03): X-Workload-Class — opaque metadata (Frame-04).
    // Regex /^[A-Za-z0-9._-]{1,64}$/, lowercased. Invalid → silent NULL (D-12).
    // No routing impact, no content classification, no fixed enum (D-11).
    workload_class: text('workload_class'),
  },
  (t) => ({
    // Baseline btree indexes per D-D1. Tune if/when volume warrants
    // (partitioning + retention is deferred to Phase 9).
    idxTsDesc: index('idx_request_log_ts_desc').on(t.ts.desc()),
    idxAgentTs: index('idx_request_log_agent_ts').on(t.agent_id, t.ts.desc()),
    idxStatusClass: index('idx_request_log_status_class').on(t.status_class),
    // 08-REVIEW CR-01: partial index on idempotency_key for the verify-dedup
    // query path. Partial (WHERE idempotency_key IS NOT NULL) keeps the index
    // small — only the small minority of requests with the header populate it.
    idxIdempotencyKey: index('idx_request_log_idempotency_key')
      .on(t.idempotency_key)
      .where(sql`${t.idempotency_key} IS NOT NULL`),
  }),
);

// The type the BufferedWriter consumes when pushing a row.
export type RequestLogInsert = typeof requestLog.$inferInsert;
