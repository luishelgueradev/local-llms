# Phase 5: Postgres + Observability Seam - Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Now that the request path is dual-protocol (OpenAI + Anthropic, Phases 2–4) and streaming-correct, **capture every request without ever blocking the stream, and expose enough scraping surface to debug a runaway agent.**

**Surface delivered:**
- **`postgres:17-alpine`** as a Compose service on the `data: internal: true` network only (no host port). Two logical databases on one instance: `router` (populated this phase) and `openwebui` (created empty, populated by Phase 6's Open WebUI). Shared `app` user with `GRANT ALL` on both DBs.
- **`router` schema**: `request_log` (one row per completed `/v1` model request) + `usage_daily` (aggregation derived from `request_log`).
- **Buffered async write pipeline** — load-bearing for SC2. In-memory bounded queue + dual-trigger flush (every 1s OR 200 rows, whichever first) + multi-row parameterized INSERT. Drop-oldest on overflow + `request_log_dropped_total` counter. Best-effort drain on SIGTERM (3s timeout). Pausing Postgres for 5s demonstrably does NOT stall in-flight SSE streams.
- **`pg_dump` cron + tested restore drill** — daily dump under `${HOST_DATA_ROOT}/postgres-backups/`, restore script in `bin/restore-drill.sh`, both documented in README (DATA-05).
- **`GET /metrics`** on the router (port 3000, unauth, bearer-skip-list extended) — Prometheus format with five custom metrics + Node process defaults. Low-cardinality labels only. Phase 6 will firewall it externally via Traefik.
- **Real `healthcheck:` on every service** (OBS-05) — `pg_isready` for postgres; existing healthchecks on ollama / llamacpp / router stay unchanged.
- **`X-Agent-Id` header** — optional, validated, surfaced into pino child logger (every line) and `request_log.agent_id` column (ROUTE-09).

**Hard architectural moves:**
- New module `router/src/db/` with Drizzle schema (`schema/request_log.ts`, `schema/usage_daily.ts`), Drizzle migrator runner, `pg` Pool wrapper, and the buffered-writer (`bufferedWriter.ts`). Bootstrap SQL (CREATE DATABASE/CREATE USER/GRANT) lives in `postgres/initdb/` and runs via Postgres's stock `docker-entrypoint-initdb.d/` mechanism.
- New module `router/src/metrics/` — `prom-client` Registry + `recordRequestOutcome(ctx)` helper invoked from both route files (chat-completions.ts + messages.ts) at the same lifecycle hook points (sseCleanup for streams, finally for non-stream). This single helper does TWO things: enqueue the `request_log` row AND update the prom-client observations — guarantees label/column drift cannot happen.
- New preHandler hook in `router/src/app.ts` for `X-Agent-Id`: read header, validate regex, attach to `req.agentId`, and `req.log = req.log.child({ agent_id })` so every pino line from that request carries the field.
- Router boot-time wiring in `src/index.ts`: build the pool, run `drizzle-orm` migrator, construct `BufferedWriter`, register prom-client default metrics, then `buildApp({ ..., bufferedWriter, agentIdPreHandler })` and `app.listen`.

**Explicitly out of Phase 5** (each lives in its own phase per ROADMAP.md):
- **Traefik + TLS + Open WebUI** → Phase 6. Phase 5's `/metrics` is loopback-only until Traefik gates external access (a CRITICAL Phase 6 follow-up — see Deferred Ideas).
- **vLLM `/metrics` + llama.cpp `/metrics` scrape + GPU exporter + Grafana dashboard** → Phase 7 (OBS-02, OBS-03, OBS-04). Phase 5 stands up the router's own `/metrics`; the Prometheus server itself, scrape configs, and dashboards land in Phase 7.
- **Server-side rate limit (Valkey) + `Idempotency-Key` + `X-Model-Backend` header + `max_tokens` cap + `cloud_spend_daily`** → Phase 8 (DATA-06, ROUTE-10, ROUTE-11, ROUTE-12, CLOUD-04, CLOUD-05).
- **`bin/gc-models.sh`, off-host backup destination, disk-usage alert, bearer-token rotation doc** → Phase 9.
- **Postgres partitioning, request_log retention/TTL, index-tuning beyond the baseline btrees** — left to be added when the table actually grows. Not in Phase 5.
- **Open WebUI's own schema, RAG / pgvector** — Phase 6 (and beyond) own everything inside the `openwebui` DB. Phase 5 only creates the empty DB and `app` user.

</domain>

<decisions>
## Implementation Decisions

### Buffered async write pipeline (SC2 anchor — non-blocking writes)

- **D-A1:** **In-memory bounded ring buffer, drop-oldest on overflow.** Implementation: a simple FIFO array with `max=10_000` rows (Claude's discretion on cap; document in code). When `push()` would exceed cap, shift the oldest row out and increment `request_log_dropped_total` (a labelless prom-client counter). No disk spool, no JSONL fallback. Rationale: single-host, single-user, mantenimiento manual aceptable; losing the last few seconds of `request_log` rows on a router crash is acceptable, blocking SSE on a Postgres pause is NOT.
- **D-A2:** **Dual-trigger flush: every 1s OR 200 rows, whichever first.** `setInterval(1000)` triggers a flush; `push()` that crosses 200 rows also fires immediately (microtask-deferred so the caller's stack returns first). Matches SC2's "1–2 s or N rows" language. Caps worst-case insert size at 200 rows.
- **D-A3:** **Multi-row parameterized INSERT per flush.** `INSERT INTO request_log (col1, col2, ...) VALUES ($1,$2,...), ($N+1, $N+2, ...), ...` — one statement per batch through the `pg` driver via Drizzle's `db.insert(requestLog).values(rows)`. Parameterized (no string interpolation). NOT COPY FROM STDIN (overkill at 200 rows). NOT per-row inside a transaction.
- **D-A4:** **Best-effort drain on SIGTERM with 3s hard timeout.** Hooked into Fastify's `onClose` (same hook that stops the liveness scheduler + clears semaphoreMap). Final `await bufferedWriter.flush()` race against `setTimeout(reject, 3000)`. If the race rejects: log a warn line with `{ event: 'log_buffer_shutdown_drop', buffered_at_shutdown: N }` and exit anyway. Compose's default stop_grace_period is 10s, so 3s fits comfortably.
- **D-A5:** **Writer is in-process, not a worker_thread.** A single `BufferedWriter` instance lives in the main Node process; no `worker_threads` indirection. Reason: the writer is I/O-bound (Postgres round-trip), not CPU-bound; spawning a worker buys nothing and complicates pool sharing.
- **D-A6:** **One shared buffer across all backends.** Not one buffer per backend. The `backend` column is just data; partitioning the queue by backend buys no isolation (they all hit the same `pg` Pool) and triples the bookkeeping. Single FIFO is correct.
- **D-A7:** **Postgres-down behavior.** Flush attempt fails → log a warn (`event: 'log_buffer_flush_error'`) with the error code → rows STAY in the buffer (do not requeue, do not drop on flush failure). Next `setInterval` tick retries. If buffer is full while Postgres is down, drop-oldest kicks in (D-A1) and the counter increments. No exponential backoff at the writer level (Pool retry is the connection-level mechanism).

### DB access layer + migrations

- **D-B1:** **Drizzle ORM 0.36 on top of `pg` 8.13.** Schema declared in TypeScript at `router/src/db/schema/*.ts`. Drizzle Kit (`drizzle-kit@^0.27`) generates SQL migration files at dev time (`drizzle-kit generate`) committed to `router/db/migrations/*.sql`. Picks up CLAUDE.md's recommendation.
- **D-B2:** **Migrations apply at router boot.** In `src/index.ts`, BEFORE `app.listen`: `await migrate(db, { migrationsFolder: './db/migrations' })`. Idempotent (Drizzle tracks applied migrations in `drizzle.__drizzle_migrations` table). Single-binary deploy; no separate `router-migrate` Compose service. If the migrator throws on a non-recoverable error (schema conflict, syntax error), router exits non-zero — Compose restart-loops, which is the correct fail-loud behavior for a schema-evolution bug.
- **D-B3:** **Bootstrap SQL via Postgres's stock `docker-entrypoint-initdb.d/`.** A directory `postgres/initdb/01-init.sql` (mounted into the postgres container at `/docker-entrypoint-initdb.d/01-init.sql`) runs ONCE on first DB init only — it creates the `app` user, both `router` and `openwebui` databases, and grants. The `request_log` / `usage_daily` schema does NOT live here (that's Drizzle's job, D-B2) — only superuser-needed bootstrap belongs here.
- **D-B4:** **Single shared `pg.Pool({ max: 8, idleTimeoutMillis: 30000 })`.** Reused by the bufferedWriter flush path AND by any usage_daily queries. No reader/writer split.
- **D-B5:** **Non-blocking on boot — Postgres unreachable does NOT prevent router startup.** The pool is created lazily-connecting; the first failed query logs a warn but Fastify still listens. The buffered writer continues queuing; rows flush when Postgres recovers. Rationale: the request path must never depend on Postgres (Pitfall 12 spirit). `/readyz` reflects postgres-pool reachability — see D-D1.
- **D-B6:** **`DATABASE_URL` env contract.** Single `POSTGRES_PASSWORD` in `.env` (already declared in `.env.example`). `compose.yml` constructs two env vars passed to consumers:
  - `ROUTER_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/router` → passed to `router` service.
  - `OPENWEBUI_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui` → reserved variable, declared now even though no consumer reads it until Phase 6.
- **D-B7:** **DB schema file colocation.** `router/src/db/schema/request_log.ts`, `router/src/db/schema/usage_daily.ts`, `router/src/db/schema/index.ts` re-exporting both. Migration output: `router/db/migrations/0001_init.sql` etc. (sibling to `router/src/`, not inside it — same convention Drizzle Kit defaults to).
- **D-B8:** **`gen_random_uuid()` for the request_log primary key.** Requires the `pgcrypto` extension (built into Postgres 17) — add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` to `postgres/initdb/01-init.sql`. Drizzle column: `id: uuid('id').primaryKey().defaultRandom()`.

### Prometheus metrics surface (OBS-01)

- **D-C1:** **`prom-client@^15.x` (raw), custom `/metrics` route.** Not `fastify-metrics` (its auto-route-instrumentation introduces a `route` label which we don't want; we want per-protocol/per-backend/per-model labels). Not OpenTelemetry SDK (TRACE-01 is v2 backlog; pulling in OTel now is premature).
- **D-C2:** **Default Node process metrics via `collectDefaultMetrics({ register })`** — event-loop lag, GC duration, RSS, fd count, etc. Free, zero-cardinality.
- **D-C3:** **Canonical metric set — five custom metrics, low-cardinality labels only:**
  | Metric | Type | Labels | Notes |
  |---|---|---|---|
  | `router_requests_total` | Counter | `protocol`, `backend`, `model`, `status_class` | `status_class` = one of `success` \| `client_error` \| `server_error` \| `disconnect` |
  | `router_request_duration_seconds` | Histogram | `protocol`, `backend`, `model` | End-to-end latency; bucket boundaries planner-discretion |
  | `router_ttft_seconds` | Histogram | `protocol`, `backend`, `model` | Time-to-first-token; observed at first stream byte (heartbeat.msSinceStart at sse.start) |
  | `router_tokens_total` | Counter | `protocol`, `backend`, `model`, `direction` | `direction` ∈ {`input`, `output`} |
  | `router_log_buffer_dropped_total` | Counter | (none) | Increments per row dropped by D-A1's drop-oldest |

  **Forbidden labels (cardinality discipline):** `agent_id`, `request_id`, raw `status_code` (HTTP), `error_message`. These live in `request_log` rows where unbounded cardinality is fine; they do NOT belong on metrics labels.
- **D-C4:** **`status_class` derivation table** (used by both the metrics observation AND the `request_log.error_code` population):
  - HTTP 2xx → `success`
  - HTTP 4xx → `client_error` (including `400 model_capability_mismatch`, `404 model_not_found`, `429 backend_saturated`)
  - HTTP 5xx → `server_error`
  - Client-disconnect mid-stream → `disconnect`
- **D-C5:** **`/metrics` on port 3000, bearer-skip-list extended.** The existing public skip-list `[/healthz, /readyz]` becomes `[/healthz, /readyz, /metrics]`. Implementation: extend the existing array in `router/src/auth/bearer.ts`. Phase 5 is pre-Traefik so router binds `127.0.0.1:3000` — unauth on loopback is safe. **Phase 6 CRITICAL follow-up:** Traefik MUST add a matcher/middleware that returns 404 for external `/metrics` requests so the Prometheus surface stays internal — flagged in deferred.
- **D-C6:** **Single `recordRequestOutcome(ctx)` helper writes both metrics observations AND the request_log row.** Lives at `router/src/metrics/recordOutcome.ts`. Called from `chat-completions.ts` sseCleanup + non-stream finally AND `messages.ts` sseCleanup + non-stream finally. Signature: `recordRequestOutcome({ protocol, backend, model, statusClass, durationMs, ttftMs?, tokensIn?, tokensOut?, errorCode?, errorMessage?, agentId?, requestId, timestamp })`. Internally it (a) calls `prom-client` observe/inc on the five metrics with the appropriate labels, AND (b) enqueues a `request_log` row via `bufferedWriter.push(...)`. This colocation guarantees label/column consistency.
- **D-C7:** **Per-route ad-hoc fastify hooks are NOT used to record metrics.** No `onResponse` handler — it fires too early for streams (after `reply.send()` initial headers, NOT after stream end). The single helper is the only call site.

### request_log shape + X-Agent-Id wiring

- **D-D1:** **`request_log` schema** (Drizzle types in `router/src/db/schema/request_log.ts`):
  ```ts
  export const requestLog = pgTable('request_log', {
    id: uuid('id').primaryKey().defaultRandom(),                 // pgcrypto gen_random_uuid()
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    protocol: text('protocol').notNull(),                        // 'openai' | 'anthropic'
    route: text('route').notNull(),                              // '/v1/chat/completions' | '/v1/messages'
    backend: text('backend').notNull(),                          // 'ollama' | 'llamacpp' | (Phase 7/8 add more)
    model: text('model').notNull(),                              // registry name (display), NOT backend_model id
    status_class: text('status_class').notNull(),                // 'success' | 'client_error' | 'server_error' | 'disconnect'
    http_status: integer('http_status').notNull(),               // raw HTTP status (200/400/404/429/500/502/503/...)
    tokens_in: integer('tokens_in'),                             // nullable — may not know on pre-adapter failures
    tokens_out: integer('tokens_out'),                           // nullable — partial on disconnect, full on success, NULL on pre-stream error
    ttft_ms: integer('ttft_ms'),                                 // nullable — NULL on non-stream and pre-stream failures
    latency_ms: integer('latency_ms').notNull(),                 // always populated from perf.now() taken at preHandler
    error_code: text('error_code'),                              // nullable — taxonomy: see D-D2
    error_message: text('error_message'),                        // nullable — truncated to 500 chars, bearer-redacted
    agent_id: text('agent_id'),                                  // nullable — from X-Agent-Id header, validated regex, NULL if absent
    request_id: text('request_id').notNull(),                    // pino req.id — joins with logs
    upstream_message_id: text('upstream_message_id'),            // nullable — Anthropic msg_<ulid> for /v1/messages
  });
  ```
  Indexes (initial baseline; tune if/when volume warrants):
  - btree on `ts DESC` (default for time-range queries by recency)
  - btree on `(agent_id, ts DESC)` covering index (debug a runaway agent — the literal use case in PROJECT.md)
  - btree on `status_class` (filter for errors)
- **D-D2:** **`error_code` taxonomy** (Postgres TEXT, free-form but pulled from a closed set in code):
  - `model_capability_mismatch` — VISION-02 path / `tools` mismatch
  - `unknown_model` — RegistryUnknownModelError (404)
  - `backend_saturated` — BackendSaturatedError (429)
  - `invalid_request` — zod parse / role-alternation / stop_sequences-too-many / bad headers
  - `upstream_5xx` — adapter received non-2xx from Ollama / llama.cpp
  - `upstream_timeout` — adapter call timed out (covers undici / fetch network errors too)
  - `client_disconnect` — req.raw.socket close fired mid-stream
  - `internal_error` — anything else (shouldn't happen; surfaced for triage)
- **D-D3:** **`error_message`** is truncated to 500 chars max and passed through pino's redaction config (defense-in-depth — pino's `redact` paths cover the log record, not the database column, so we re-apply a regex strip for `Bearer\s+\S+`, `Authorization:\s+\S+`, and `apiKey['"]?\s*[:=]\s*['"]?\S+` before writing).
- **D-D4:** **Coverage policy — which request outcomes get a row in `request_log`:**
  - **WRITE row:** all post-auth `/v1/chat/completions` + `/v1/messages` outcomes including success (stream + non-stream), `BackendSaturatedError`, `CapabilityNotSupportedError`, `RegistryUnknownModelError`, upstream 5xx / timeout, client-disconnect mid-stream.
  - **SKIP row:** bearer-auth failures (401 — pre-route, would let an attacker bloat the table); `/healthz`, `/readyz`, `/metrics` (meta-routes); `/v1/models` (meta-route, no inference); `/v1/messages/count_tokens` (pure CPU, no backend call, doesn't match the "agent inference work" semantic).
- **D-D5:** **X-Agent-Id header — optional, validated, NULL fallback, pino-child injection via preHandler.**
  - Validation regex: `/^[A-Za-z0-9._:-]{1,128}$/`
  - Header present + matches regex → `req.agentId = headerValue`; `req.log = req.log.child({ agent_id: headerValue })`
  - Header present + violates regex → reject with `400 invalid_request_error` (`code: 'invalid_agent_id'`)
  - Header absent → `req.agentId = undefined`; no log-child decoration; `request_log.agent_id` is NULL
  - preHandler hook is registered AFTER bearer-auth hook (auth gates the request first; agent-id is a post-auth metadata enrichment)
- **D-D6:** **`recordRequestOutcome(ctx)` field-source map** (single source of truth for metric labels AND log columns):
  - `protocol` ← derived from `req.url.startsWith('/v1/messages') ? 'anthropic' : 'openai'`
  - `route` ← `req.url` (top-level path; query string stripped)
  - `backend` ← `entry.backend` (from registry.resolve)
  - `model` ← `entry.name` (registry display name, NOT backend_model)
  - `status_class` ← derived via D-C4 table from `http_status`
  - `http_status` ← `reply.statusCode` (Fastify's final status)
  - `tokens_in` / `tokens_out` ← from canonical stream events (`message_delta.usage.output_tokens` end-of-stream OR non-stream usage block) — see D-D7
  - `ttft_ms` ← `heartbeat.msSinceStart` captured at first SSE chunk (stream only); NULL for non-stream
  - `latency_ms` ← `perf.now() - req._t0` (req._t0 set in preHandler immediately after bearer-auth)
  - `error_code` / `error_message` ← from the typed error thrown (envelope.ts has `err.code` for known types; fallback `'internal_error'`)
  - `agent_id` ← `req.agentId` (see D-D5)
  - `request_id` ← `req.id` (Fastify-generated default; pino uses it)
  - `upstream_message_id` ← Anthropic-only; the `msg_<ulid>` generated in Plan 04-03's canonical builder (`canonical._upstream_message_id`)
- **D-D7:** **Token counting in `recordRequestOutcome` for the stream case.** The route's sseCleanup runs after the iterator completes/aborts. The iterator already aggregates `usage` via the canonical stream's `message_delta.usage` event (Phase 4 plumbed this). The route file passes the aggregated `{ tokensIn, tokensOut }` into recordRequestOutcome. On client-disconnect, tokens_out is the partial count observed so far.

### Compose / networking placement of Postgres

- **D-E1:** **Postgres on the `data` network only (`internal: true`).** Router joins all four networks (unchanged from Phase 1 design). Postgres has NO host port published — `data` is internal=true which blocks both inbound from the host AND outbound from Postgres (which is correct: Postgres has no reason to call out).
- **D-E2:** **Postgres healthcheck:** `pg_isready -U app -d router -h 127.0.0.1` (runs inside the container — talks to local socket via TCP). `interval: 10s`, `timeout: 3s`, `start_period: 30s`, `retries: 5`. Mirrors the pattern used by ollama/llamacpp healthchecks.
- **D-E3:** **Postgres data volume:** bind mount `${HOST_DATA_ROOT}/postgres-data:/var/lib/postgresql/data` (D-02 layout — sibling to models-gguf/, models-hf/, and the new `postgres-backups/` from D-F2). Bind mount NOT named volume for backup-portability (same rationale as Phase 1).
- **D-E4:** **Router service `depends_on`** gains `postgres: { condition: service_healthy, required: false }` — `required: false` (Compose >= 2.20.2) means router can boot without Postgres (matches D-B5 non-blocking-on-boot).

### Healthchecks across services (OBS-05)

- **D-G1:** **Existing healthchecks are unchanged.** ollama (`ollama list`), llamacpp (`curl /health`), router (`node -e fetch /healthz`), gpu-preflight (one-shot, no healthcheck needed). Phase 5 just adds postgres's healthcheck (D-E2). SC5's "real healthchecks (not just process-up)" is already satisfied for Phases 1–3 services; Phase 5 simply preserves that quality bar for postgres.
- **D-G2:** **Router's `/readyz` extended to include postgres-pool reachability.** Currently `/readyz` checks per-backend liveness (Plan 03-03). Phase 5 adds a postgres ping (`SELECT 1` via the pool with a 1s timeout) — `/readyz` returns 200 only when backends AND postgres are reachable. `/healthz` stays unauth-and-cheap (no DB ping). Implementation: `LivenessScheduler` adds a `postgres` probe alongside the backend probes; the bearer skip-list keeps `/readyz` unauth.
- **D-G3:** **`/healthz` stays minimal.** Process-up + Fastify-listening. No registry check, no DB check. Pitfall 12 spirit: `/healthz` is what Compose / load balancers hit at high frequency; making it pull from anything stateful is an anti-pattern. The registry/postgres state is what `/readyz` is for.

### Claude's Discretion

These are deliberately left to the planner / executor to decide during plan-phase, based on what makes the implementation cleanest:

- **Exact buffer cap.** D-A1 suggests 10,000 rows; planner can tune if profiling suggests otherwise. Document the choice in the plan.
- **Histogram bucket boundaries** for `router_request_duration_seconds` and `router_ttft_seconds`. Sensible defaults: ttft `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds; total duration `[0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]` seconds. Planner verifies these match the latency profile observed in Phase 2/3/4 smoke tests.
- **`usage_daily` refresh mechanism.** Not deeply discussed. Three options, planner picks: (a) `pg_cron` extension (requires extension install) running a daily INSERT/UPSERT into `usage_daily`, (b) Node-side `setInterval` (or `node-cron`) in the router running the same SQL once per UTC midnight, (c) materialized view with manual `REFRESH MATERIALIZED VIEW` on read. Recommendation: (b) is simplest given the router is single-host single-process; (a) requires building/pinning a `pgvector/pgvector:pg17`-or-extension-flavored image. Planner picks and documents.
- **`pg_dump` cron mechanism.** Not deeply discussed. Three options, planner picks: (a) a small sidecar Compose service (`alpine:3.20` + `postgresql17-client` + busybox cron) running `pg_dump --format=custom` daily, (b) host crontab calling `docker compose exec postgres pg_dump`, (c) `pg_cron` job using Postgres's `COPY ... TO PROGRAM`. Recommendation: (a) — keeps the operation containerized + portable; pins postgres17-client to match the server version. Dump file naming: `router-YYYY-MM-DDTHH.dump`. Retention: keep last 7 days (cron tail rm; documented in Phase 9 ops hardening).
- **Restore drill script.** `bin/restore-drill.sh` — drops the `router` db, creates it fresh, `pg_restore --dbname=router router-YYYY-MM-DD.dump`, runs a sanity SELECT against `request_log`. Document the procedure in README's Phase 5 section.
- **`status_class` for partial-success cases.** D-C4 covers the common four; planner decides edge cases (e.g., upstream returns 200 but no tokens — likely `success` with tokens_out=0).
- **`error_message` redaction regex.** D-D3 mentions defense-in-depth on bearer/apikey patterns. Planner picks the exact regex; pino's existing redact paths handle the log surface, so the column is a belt-and-suspenders move.
- **Drizzle Kit config file location.** `router/drizzle.config.ts` is the convention; planner confirms.
- **Whether the buffered-writer push enqueue is sync vs `process.nextTick` deferred.** D-A2 says microtask-deferred so the caller stack returns first; planner verifies this doesn't break the SSE-stream-end flow (sseCleanup is already a callback; enqueue is the last thing it does).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/05-postgres-observability-seam/05-CONTEXT.md` — this file (locked decisions D-A1..D-G3)
- `.planning/phases/05-postgres-observability-seam/05-DISCUSSION-LOG.md` — discussion audit trail (humans only; not consumed by agents)
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-CONTEXT.md` — Phase 4 locked decisions: canonical translation layer (D-A1..A4), `recordRequestOutcome`'s field sources (protocol, model, tokens, ttft come from the canonical pipeline established here)
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-CONTEXT.md` — Phase 3 locked decisions: registry.resolve(model) returns `entry` with `backend`/`name`/`backend_model` fields; semaphore + safeRelease idempotency pattern (Phase 5's recordRequestOutcome runs alongside safeRelease in sseCleanup); `/readyz` per-backend liveness pattern (Phase 5 extends with postgres probe — D-G2)
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-CONTEXT.md` — Phase 2 locked decisions: pino redaction config (Phase 5 inherits; agent_id field is NEW and goes into the pino child); heartbeat.msSinceStart pattern (TTFT source); error envelope shape (Phase 5's recordRequestOutcome uses envelope.code as error_code)
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — Phase 1 locked decisions: HOST_DATA_ROOT path contract (Phase 5 mounts postgres-data + postgres-backups under it); networks D-13 (Phase 5 attaches postgres to `data: internal: true`); `.env` contract (POSTGRES_PASSWORD already declared)

### Project-level
- `.planning/PROJECT.md` — Core Value (single endpoint, multi-protocol), Constraints (single-host, single-user, mantenimiento manual aceptable — informs D-A1 drop-oldest acceptable + D-A4 3s drain timeout); Key Decisions row "Alcance plataforma completa (incluye Open WebUI + Redis + Postgres + Traefik)" — Phase 5 lands the Postgres half.
- `.planning/REQUIREMENTS.md` — v1 requirement IDs this phase covers: **DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, OBS-01, OBS-05, ROUTE-09** (8 requirements).
- `.planning/ROADMAP.md` §"Phase 5: Postgres + Observability Seam" — Goal + 5 Success Criteria (verification anchor: postgres:17-alpine with two DBs; non-blocking buffered writes; pg_dump cron + restore drill; /metrics unauth-but-only-this-surface; healthy via real healthchecks + X-Agent-Id surfaced).
- `.planning/STATE.md` — accumulated context; standing anti-patterns (no `compress` on streaming routes — Phase 5 doesn't touch this); Phase 5 listed as "not started"; reminder that bearer-skip-list is the public surface boundary.
- `CLAUDE.md` — full stack spec including:
  - §"Supporting Libraries — Router" — `drizzle-orm@^0.36` + `pg@^8.13` recommendation (D-B1); `prom-client` not explicitly listed but inferred from `@fastify/metrics` row's "alternative" framing.
  - §"Core Technologies — Platform Services" — `postgres:17-alpine` pin (D-E1); shared Postgres server with Open WebUI in its own database (D-B6 reserves the URL).
  - §"What NOT to Use" — `redis:latest` (relevant to Phase 8's Valkey); `compress` middleware on streaming (Phase 5 never enables it on `/v1/*`); pinned tags (postgres:17-alpine, not :latest).

### Research (READ BEFORE PLANNING — though research flag is NO for Phase 5)
- `.planning/research/SUMMARY.md` §"Phase 5: Postgres + structured logging + observability seam" (lines 182–185) — phase rationale + recommended deliverables; explicitly notes "buffered async writes — must never block the request path" + "Pitfall 12 (`/healthz` stays unauthenticated)".
- `.planning/research/PITFALLS.md` Pitfall 12 — Bearer token leaks into logs; healthcheck endpoints must not require auth (otherwise the token ends up in `docker inspect`). Phase 5's `/metrics` joins `/healthz` and `/readyz` in the public skip-list (D-C5).
- `.planning/research/SUMMARY.md` line 253 — "Phase 5 (Postgres): standard `pg_dump` cron + restore drill; Drizzle migrations." (confirms D-B1 + D-F2 planner-discretion path).
- `.planning/research/ARCHITECTURE.md` §3 (data flow) — recordRequestOutcome lives at the same end-of-request hook that Phase 2/3/4 already populate (sseCleanup + non-stream finally).

### Existing router code (read before editing)
- `router/src/app.ts` — Fastify build factory; Phase 5 adds: agent-id preHandler hook, bufferedWriter shutdown hook, /metrics route registration, postgres-pool decorator if needed by /readyz.
- `router/src/index.ts` — entrypoint; Phase 5 adds: pool construction, Drizzle migrator call, bufferedWriter construction, prom-client default metrics registration, pass bufferedWriter into buildApp().
- `router/src/auth/bearer.ts` — public skip-list `[/healthz, /readyz]` → `[/healthz, /readyz, /metrics]` (D-C5).
- `router/src/log/logger.ts` — pino redaction config (UNCHANGED in Phase 5; agent_id is NOT a redacted field — it's a public identifier).
- `router/src/routes/v1/chat-completions.ts` — adds `recordRequestOutcome(ctx)` calls in sseCleanup and non-stream finally branches; same for messages.ts. Existing safeRelease + heartbeat plumbing unchanged.
- `router/src/routes/v1/messages.ts` — same as above.
- `router/src/routes/v1/count-tokens.ts` — no row written (D-D4 skip list); no metrics observation other than the default Node process metrics.
- `router/src/routes/healthz.ts` — unchanged.
- `router/src/routes/readyz.ts` — extended with postgres-pool probe (D-G2).
- `router/src/sse/heartbeat.ts` — TTFT source (`heartbeat.msSinceStart` captured at first stream byte).
- `router/src/concurrency/semaphore.ts` — unchanged; recordRequestOutcome runs alongside safeRelease in sseCleanup.
- `router/src/backends/liveness.ts` — extended with postgres probe (D-G2).
- `router/src/errors/envelope.ts` — `err.code` field is the source of `request_log.error_code` (D-D2 taxonomy).
- `router/package.json` — Phase 5 adds: `drizzle-orm@^0.36`, `pg@^8.13`, `@types/pg`, `drizzle-kit@^0.27` (devDep), `prom-client@^15.x`.

### New files Phase 5 introduces
- `router/src/db/index.ts` — Pool + Drizzle db handle export.
- `router/src/db/migrate.ts` — boot-time migrator wrapper.
- `router/src/db/schema/request_log.ts` — Drizzle schema (D-D1).
- `router/src/db/schema/usage_daily.ts` — Drizzle schema (TBD shape, planner-discretion).
- `router/src/db/schema/index.ts` — re-export.
- `router/src/db/bufferedWriter.ts` — the in-memory ring buffer + flush loop + SIGTERM drain.
- `router/src/metrics/registry.ts` — prom-client Registry + the five metric definitions.
- `router/src/metrics/recordOutcome.ts` — `recordRequestOutcome(ctx)` helper.
- `router/src/middleware/agentId.ts` — preHandler hook for X-Agent-Id.
- `router/db/migrations/0001_init.sql` (and onwards) — generated SQL.
- `router/drizzle.config.ts` — Drizzle Kit config.
- `postgres/initdb/01-init.sql` — bootstrap SQL (CREATE USER app, CREATE DATABASE router/openwebui, GRANT, CREATE EXTENSION pgcrypto).
- `bin/restore-drill.sh` — pg_restore + sanity SELECT.
- `bin/smoke-test-router.sh` — extend with a `/metrics` probe + `X-Agent-Id` round-trip + `request_log` row-count assertion + the SC2 "pause-postgres-5s-streams-keep-running" scenario.

### External docs (verify still current at planning time)
- Drizzle ORM migrator — `https://orm.drizzle.team/docs/migrations` (the `migrate()` function signature + folder layout).
- Drizzle Kit — `https://orm.drizzle.team/docs/kit-overview` (drizzle-kit generate + push commands; version pin advice).
- `prom-client` — `https://github.com/siimon/prom-client` (Registry API, Histogram/Counter, collectDefaultMetrics).
- Postgres `docker-entrypoint-initdb.d/` — `https://hub.docker.com/_/postgres` ("Initialization scripts" section).
- `pg_isready` reference — `https://www.postgresql.org/docs/current/app-pg-isready.html` (return codes; -h 127.0.0.1 for in-container TCP).
- Fastify hooks ordering — `https://fastify.dev/docs/v5.8.x/Reference/Hooks/` (onRequest vs preHandler; the agent-id hook is preHandler so it runs AFTER bearer-auth's onRequest).
- pino child-logger — `https://getpino.io/#/docs/child-loggers` (req.log.child({ agent_id }) pattern).
- pgcrypto extension — `https://www.postgresql.org/docs/current/pgcrypto.html` (`gen_random_uuid()` source).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`router/src/sse/heartbeat.ts`** — already exposes `msSinceStart` and `bytesSinceStart`; Phase 5 captures `msSinceStart` at first stream byte for `ttft_ms`. No changes to the heartbeat module.
- **`router/src/log/logger.ts`** — pino redaction is already wired for `authorization`/`cookie`/`apiKey`. Phase 5 adds `agent_id` as a structured field — explicitly NOT redacted (it's a public identifier).
- **`router/src/concurrency/semaphore.ts`** — `safeRelease` idempotency pattern. recordRequestOutcome runs alongside safeRelease in sseCleanup; both are idempotent so ordering between them is loose.
- **`router/src/auth/bearer.ts`** — onRequest hook + skip-list pattern. Phase 5 extends the skip-list array.
- **`router/src/backends/liveness.ts`** — scheduler-driven per-backend probes. Phase 5 adds a postgres probe to the same scheduler (separate probe key, same scheduler instance).
- **`router/src/errors/envelope.ts`** — `mapToHttpStatus` + typed error classes. Phase 5 reads `err.code` for `request_log.error_code` taxonomy alignment.
- **`bin/smoke-test-router.sh`** — Phase 5 appends a new section: `X-Agent-Id` round-trip, /metrics probe, request_log row-count assertion, 5s-postgres-pause-no-stall scenario.

### Established Patterns
- **End-of-request hook = sseCleanup OR non-stream finally** (Phase 2/3/4 pattern). Phase 5 lands `recordRequestOutcome` here in both routes — same call site, same arguments.
- **Single helper, two routes** (mirrors the Phase 4 canonical translator pattern). One source of truth for both metrics labels AND log columns — drift is impossible by construction.
- **Public skip-list extension** (`/metrics` joins `/healthz` + `/readyz`) — Phase 1/2 already established the pattern; Phase 5 just adds an entry.
- **Compose service depends_on with `required: false`** (Compose >= 2.20.2) — Phase 3 introduced this for `ollama`/`llamacpp` from router; Phase 5 uses the same pattern for `postgres` from router.
- **Bind-mount under HOST_DATA_ROOT** (Phase 1 D-02 layout) — Phase 5 adds `postgres-data/` and `postgres-backups/` as siblings of `models-gguf/` and `models-hf/`.
- **`internal: true` for the `data` network** — already declared in Phase 1 compose.yml. Phase 5 attaches postgres without changing the network spec.

### Integration Points
- **`router/src/app.ts`** — register: agent-id preHandler hook, /metrics route, /readyz postgres-probe extension. onClose hook gains the bufferedWriter drain step (3s timeout).
- **`router/src/index.ts`** — boot-time wiring: construct Pool → run migrator → construct BufferedWriter → call `buildApp({ ..., bufferedWriter, pool })` → `app.listen`.
- **`router/src/routes/v1/chat-completions.ts`** — add `recordRequestOutcome(ctx)` in sseCleanup + non-stream finally. Existing safeRelease/heartbeat plumbing untouched.
- **`router/src/routes/v1/messages.ts`** — same as above.
- **`router/src/auth/bearer.ts`** — public skip-list extended to `[/healthz, /readyz, /metrics]`.
- **`router/src/backends/liveness.ts`** — new probe key `postgres` alongside the existing backend probes.
- **`compose.yml`** — new `postgres` service (image: `postgres:17-alpine`, networks: [data], healthcheck: pg_isready, volume: HOST_DATA_ROOT/postgres-data → /var/lib/postgresql/data, initdb mount); new optional `pg-backup` sidecar (per Claude's-discretion D-F2). Router gains `data` network membership (currently joins app + backend — extending to add data — actually router was already designed to be on all four networks per PROJECT.md), `postgres` depends_on with `required: false`, `ROUTER_DATABASE_URL` env, `OPENWEBUI_DATABASE_URL` env (declared but unused until Phase 6).
- **`.env.example`** — `POSTGRES_PASSWORD` already declared (Phase 5 reserved slot) — keep as-is; add a comment that the password seeds BOTH `router` and `openwebui` databases.
- **`router/package.json`** — add `drizzle-orm`, `pg`, `prom-client` to deps; `drizzle-kit`, `@types/pg` to devDeps.
- **`README.md`** — Phase 5 operational section: pg_dump + restore drill commands, `X-Agent-Id` usage in agent code, sample `/metrics` curl, sample `request_log` queries.

</code_context>

<specifics>
## Specific Ideas

- **request_log retention starts unbounded.** No DELETE policy in Phase 5. If/when the table grows past comfort (~100M rows or ~50 GB), Phase 9 (operations hardening) can add a partition-by-month + drop-old-partitions cron. Document the deferral in `bin/restore-drill.sh`'s header comment.
- **usage_daily shape (suggested; planner refines):**
  ```ts
  export const usageDaily = pgTable('usage_daily', {
    day: date('day').notNull(),                       // UTC
    protocol: text('protocol').notNull(),
    backend: text('backend').notNull(),
    model: text('model').notNull(),
    agent_id: text('agent_id'),                       // NULL groups "no-agent-id requests"
    request_count: integer('request_count').notNull(),
    success_count: integer('success_count').notNull(),
    error_count: integer('error_count').notNull(),
    tokens_in_sum: bigint('tokens_in_sum', { mode: 'number' }).notNull(),
    tokens_out_sum: bigint('tokens_out_sum', { mode: 'number' }).notNull(),
    p50_ttft_ms: integer('p50_ttft_ms'),
    p95_ttft_ms: integer('p95_ttft_ms'),
    p50_latency_ms: integer('p50_latency_ms').notNull(),
    p95_latency_ms: integer('p95_latency_ms').notNull(),
  }, (t) => ({ pk: primaryKey({ columns: [t.day, t.protocol, t.backend, t.model, t.agent_id] }) }));
  ```
  Refresh once per UTC midnight (Claude's discretion: pg_cron vs Node setInterval). Idempotent UPSERT keyed on (day, protocol, backend, model, agent_id).
- **README curl for `/metrics`:**
  ```bash
  # /metrics is unauth on loopback (Phase 5). Phase 6 (Traefik) blocks external access.
  curl http://127.0.0.1:3000/metrics
  ```
- **README curl for agent-id round-trip:**
  ```bash
  curl -N -H "Authorization: Bearer $LOCAL_LLMS_BEARER" \
       -H "X-Agent-Id: claude-code:luis@desktop" \
       -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"hi"}],"stream":true}' \
       http://127.0.0.1:3000/v1/chat/completions

  # Then verify the row:
  docker compose exec postgres psql -U app -d router \
    -c "SELECT id, agent_id, tokens_out, ttft_ms FROM request_log ORDER BY ts DESC LIMIT 1;"
  ```
- **5s-postgres-pause smoke test:**
  ```bash
  # Pause postgres mid-generation, then verify the SSE stream completed and the row eventually landed.
  ( sleep 1 && docker compose pause postgres && sleep 5 && docker compose unpause postgres ) &
  curl -N -H "Authorization: Bearer $LOCAL_LLMS_BEARER" \
       -d '{"model":"qwen2.5-7b-instruct-q4km","messages":[{"role":"user","content":"count to 50 slowly"}],"stream":true,"max_tokens":300}' \
       http://127.0.0.1:3000/v1/chat/completions
  # Expected: stream completes without stall; row visible in request_log within ~10s of unpause.
  ```
- **Drizzle config hint:**
  ```ts
  // router/drizzle.config.ts
  import { defineConfig } from 'drizzle-kit';
  export default defineConfig({
    dialect: 'postgresql',
    schema: './src/db/schema/index.ts',
    out: './db/migrations',
    dbCredentials: { url: process.env.ROUTER_DATABASE_URL! },
  });
  ```

</specifics>

<deferred>
## Deferred Ideas

- **Phase 6 critical follow-up — Traefik MUST block external `/metrics`.** Phase 5 puts `/metrics` on the public-skip-list (unauth) on `127.0.0.1:3000`. Phase 6 introduces TLS via Traefik and removes the host-port binding — at that point Prometheus scrapes via the internal `app` or `data` network only, and Traefik MUST add a matcher returning 404 for external `/metrics` requests (or a `path-blacklist` middleware on the public entrypoint). Without this, the metrics endpoint becomes publicly readable. Flagged here so it doesn't get lost in Phase 6 planning.
- **vLLM + llama.cpp + GPU exporter scrape configs + Grafana dashboard** — Phase 7 (OBS-02, OBS-03, OBS-04).
- **Prometheus server itself + scrape configs.** Phase 5 only exposes `/metrics`; standing up Prometheus + Alertmanager + storage is Phase 7's job per the roadmap.
- **`X-Model-Backend` response header** (ROUTE-10) — Phase 8.
- **Server-side rate limit via Valkey** (ROUTE-11) — Phase 8.
- **`Idempotency-Key` header** (ROUTE-12) — Phase 8. When implemented, the request_log will gain an `idempotency_key` column.
- **Cloud spend metric** (`cloud_spend_daily`, CLOUD-05) — Phase 8.
- **`bin/gc-models.sh`** + off-host backup + disk-usage alert + bearer-token rotation procedure — Phase 9 (OPS-01..04).
- **request_log partitioning + retention TTL** — Phase 9 or later, when actual volume warrants. Phase 5 ships unbounded with baseline btrees only.
- **OpenTelemetry distributed traces** (TRACE-01) — v2 backlog. Don't pull in `@opentelemetry/*` packages now.
- **Loki log aggregation** (LOG-01) — v2 backlog. Pino logs go to stdout → `docker compose logs` until then.
- **Alertmanager wired to Prometheus** (ALERT-01) — v2 backlog (Phase 7's Grafana provides ad-hoc alert exploration).
- **Per-request USD cost estimation** (COST-01) — v2 backlog. The `cloud_spend_daily` Phase 8 metric covers the cloud-side rough $-tracking; per-request USD would need a price-list table and is bigger than Phase 5.
- **Soft tool-capability gating with metric.** Phase 4 D-C3 keeps tool-capability gating SOFT (warn + pass through). Phase 5 could add `router_tool_capability_warnings_total` counter to track how often this fires — useful signal but not in scope here. Note for Phase 7+ planning.
- **`/metrics` cardinality alerts** — Phase 7 (when Grafana lands) can add a meta-metric `router_metrics_cardinality_estimate` to alert if some future code accidentally adds a high-cardinality label.

</deferred>

---

*Phase: 5-Postgres + Observability Seam*
*Context gathered: 2026-05-14*
