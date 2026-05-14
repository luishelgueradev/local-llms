# Phase 5: Postgres + Observability Seam - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-14
**Phase:** 5 — Postgres + Observability Seam
**Areas discussed:** Buffered async write pipeline, DB access layer + migrations, Prometheus metrics surface, request_log shape + X-Agent-Id wiring

---

## Buffered async write pipeline

### Q1: When Postgres is unreachable (5s pause, restart, network blip), what's the durability policy for queued request_log rows?

| Option | Description | Selected |
|--------|-------------|----------|
| In-memory only, drop-oldest on overflow | Bounded ring buffer in Node heap (e.g. 10,000 rows). When full, drop oldest rows + emit a Prometheus counter `request_log_dropped_total`. Simple, zero infra, acceptable loss-on-crash given single-user/single-host scope. Matches CLAUDE.md's 'mantenimiento manual aceptable' constraint. | ✓ |
| In-memory + on-disk JSONL spool fallback | Buffer in memory; when Postgres is down for >N seconds, append unflushed batches to a JSONL spool file under HOST_DATA_ROOT/router-spool/. Replay on Postgres recovery, then truncate. Survives router crash AND Postgres downtime, costs ~50 LOC + one bind mount + a replay path. | |
| In-memory only, drop-newest on overflow | Same buffer cap but drop newest rows once full (preserve old history). Counter-intuitive for an observability log — you'd usually want recent rows over stale ones during an incident. Listed for completeness. | |

**User's choice:** In-memory only, drop-oldest on overflow (Recommended).

### Q2: Flush trigger — when does the background writer fire an INSERT batch?

| Option | Description | Selected |
|--------|-------------|----------|
| Both: every 1s OR 200 rows, whichever first | setInterval(1000) fires a flush; an enqueue that crosses N=200 rows also fires immediately. Matches SC2's "1–2 s or N rows". Caps worst-case insert size AND caps latency between request-end and visible row in DB. | ✓ |
| Time-only: every 2s | setInterval(2000) is the sole flush trigger. Simpler. Worst-case insert size = throughput × 2s; at ~50 req/s that's 100 rows, fine. But a burst of 5,000 requests in 1s would all hit at the next tick — single huge multi-VALUES INSERT. | |
| Size-only: when buffer reaches 500 | No timer; flush only when buffer hits 500 rows. Rows could sit idle for hours under low load. Bad for usage_daily freshness; not recommended. | |

**User's choice:** Both: every 1s OR 200 rows (Recommended).

### Q3: Insert mechanism for the flushed batch — how does the writer push 1–200 rows into request_log?

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-row parameterized INSERT | Single `INSERT INTO request_log (...) VALUES ($1,$2,...), ($N+1,...), ...` per flush. Works with any pg client (raw pg, postgres.js, Drizzle). Parameterized → no SQL injection. Postgres handles 200-row multi-VALUES easily. | ✓ |
| pg COPY FROM STDIN | Streaming COPY protocol — fastest path for bulk insert in Postgres (10x faster at 10K+ rows). Overkill at 200-row batches and ties us to the raw `pg` driver. | |
| Per-row INSERT inside a transaction | Loop 200 inserts inside BEGIN/COMMIT. Simplest code. Slowest path (200 round-trips even with pipelining). | |

**User's choice:** Multi-row parameterized INSERT (Recommended).

### Q4: SIGTERM / graceful-shutdown behavior — what happens to the in-memory buffer?

| Option | Description | Selected |
|--------|-------------|----------|
| Best-effort flush within N seconds, then exit | Fastify `onClose` hook triggers a final flush with a hard timeout (e.g. 3s). If Postgres is unreachable, log a warn line and exit anyway. | ✓ |
| Flush-and-block until buffer empty (no timeout) | Refuse to exit until the buffer is drained. Risk: if Postgres is genuinely down, docker compose down hangs for stop_grace_period then SIGKILL anyway. | |
| Skip flush, log dropped count, exit immediately | On SIGTERM just log `dropped_on_shutdown=N` and exit. Loses the last 0–1s of rows on every restart. | |

**User's choice:** Best-effort flush within 3s, then exit (Recommended).

---

## DB access layer + migrations

### Q1: Which DB client does the router import?

| Option | Description | Selected |
|--------|-------------|----------|
| Drizzle ORM on top of `pg` | Drizzle ORM 0.36 + `pg` 8.13 driver. TS-first schema declaration, inferred row types, multi-row INSERT works out of the box. Matches CLAUDE.md recommendation. Migrations via `drizzle-kit generate` → SQL files applied at boot. | ✓ |
| postgres.js (Porsager/postgres) | Lighter (~50kb), tagged-template syntax, built-in multi-row INSERT via array. No ORM layer. Less type-safety but the schema is small enough. | |
| Raw node-postgres (`pg`) only | Minimum dependency surface. Hand-roll multi-row INSERT VALUES placeholders + migrations runner. Most boilerplate. | |

**User's choice:** Drizzle ORM + pg (Recommended).

### Q2: How are migrations applied at startup?

| Option | Description | Selected |
|--------|-------------|----------|
| Router applies migrations on boot via drizzle-orm's migrator | Inside src/index.ts (before app.listen): `await migrate(db, { migrationsFolder: './db/migrations' })`. Single-binary deploy, no separate service, idempotent (Drizzle tracks applied migrations). | ✓ |
| Separate `router-migrate` one-shot Compose service | Mirror Phase 1's gpu-preflight pattern. Pros: clearer ops surface, router image never carries drizzle-kit. Cons: extra service, extra Compose complexity. | |
| Migrations baked into postgres-init `docker-entrypoint-initdb.d/` | Runs ONCE on first DB init only. Wrong tool for iterative schema evolution. Used only for bootstrap (CREATE DATABASE/CREATE USER). | |

**User's choice:** Boot-time drizzle-orm migrator (Recommended). Bootstrap SQL (CREATE DATABASE router/openwebui + app user) lives in docker-entrypoint-initdb.d/.

### Q3: Connection pool sizing and reconnect policy?

| Option | Description | Selected |
|--------|-------------|----------|
| Single shared pool, max=8, idle 30s, no reconnect retry on boot | The flush-writer reuses the same pool. On boot, Postgres unreachable: log the error, BUT continue starting Fastify anyway. The buffered-write pipeline's drop-oldest behavior is the resilience mechanism. | ✓ |
| Single pool, max=4, reconnect-with-backoff on boot until healthy | Smaller pool. Boot blocks on Postgres reachable with exponential backoff. Pros: fail-loud. Cons: router can't start without Postgres — violates Pitfall 12 spirit. | |
| Two pools: write (max=2) + read (max=4) | Separate writer from reader. Pros: writes can't starve reads. Cons: 2x connection cost, overkill for single-user. | |

**User's choice:** Single shared pool max=8 (Recommended).

### Q4: Where does DATABASE_URL come from and how does it differ from the Open WebUI DB URL?

| Option | Description | Selected |
|--------|-------------|----------|
| Single env var POSTGRES_PASSWORD; URLs constructed in compose.yml | One password, two DBs, one app user. The `app` user gets GRANT ALL on both DBs via init script. Phase 6 reads OPENWEBUI_DATABASE_URL. | ✓ |
| Separate passwords per DB (router_pw + openwebui_pw) | Stronger isolation — a router compromise can't read OWUI chats. Costs: two more env vars, two more init SQL statements. | |
| Plain DATABASE_URL pasted into .env directly | Simplest but couples password into the URL, and Phase 6 needs a SECOND URL anyway. | |

**User's choice:** Single POSTGRES_PASSWORD with compose-constructed URLs (Recommended).

---

## Prometheus metrics surface

### Q1: Which Prometheus client library does the router use?

| Option | Description | Selected |
|--------|-------------|----------|
| prom-client (raw) registered on a custom route | prom-client@^15.x. Define histograms/counters explicitly in src/metrics/registry.ts. Includes default Node process metrics via collectDefaultMetrics(). Full control over names + labels. | ✓ |
| fastify-metrics plugin | Auto-registers /metrics AND auto-instruments every route with timing histograms keyed by `route` label. Loses control over exact metric names which becomes a problem for SC4. | |
| OpenTelemetry SDK with Prometheus exporter | Massive dependency surface. TRACE-01 is explicitly v2 backlog — don't pull in early. | |

**User's choice:** prom-client raw (Recommended).

### Q2: What's the canonical metric set + label dimensions?

| Option | Description | Selected |
|--------|-------------|----------|
| Compact set, low cardinality | 5 metrics: router_requests_total, router_request_duration_seconds, router_ttft_seconds, router_tokens_total, router_log_buffer_dropped_total. Labels: protocol/backend/model/status_class/direction. Forbidden: agent_id, request_id, status_code. ~300 series per metric. | ✓ |
| Verbose set with status_code, route, agent_id | Add labels like route, status_code, agent_id. agent_id is unbounded (1 series per agent) — series explosion risk. | |
| Minimal: counter + duration only | Ships fastest. SC4 specifically calls out ttft and per-backend counters. | |

**User's choice:** Compact 5-metric set (Recommended).

### Q3: Where does /metrics live in the auth + port topology?

| Option | Description | Selected |
|--------|-------------|----------|
| Same port 3000, public skip-list extended | /metrics on Fastify port 3000. Skip-list `[/healthz, /readyz]` becomes `[/healthz, /readyz, /metrics]`. Pre-Traefik: bound to 127.0.0.1 only. Phase 6 MUST add matcher blocking external /metrics. | ✓ |
| Separate metrics port (e.g. 9464) on a different network | Bind a second http server on app network only. Cleaner separation but two server.listen calls + more port plumbing. | |
| Same port 3000, but require bearer on /metrics | Zero unauth surface. Violates SC4. | |

**User's choice:** Same port 3000 with extended skip-list (Recommended). Phase 6 follow-up flagged.

### Q4: Instrumentation point — WHERE in the route lifecycle do we record metric updates?

| Option | Description | Selected |
|--------|-------------|----------|
| Same single helper that writes request_log, called at request end | ONE function recordRequestOutcome(ctx) called from chat-completions.ts AND messages.ts (sseCleanup + non-stream finally). Inc/observe metrics + enqueue request_log row in one place. Single source of truth — no drift between metric labels and log columns. | ✓ |
| Fastify onResponse hook (auto-instrument every route) | Hook fires per-reply but for SSE streams reply.send() happens once at start. TTFT and final token counts UNAVAILABLE in onResponse. | |
| Separate calls scattered through the route file | Brittle — easy to forget a branch, causes drift. | |

**User's choice:** Single recordRequestOutcome helper (Recommended).

---

## request_log shape + X-Agent-Id wiring

### Q1: What does the `error` column hold?

| Option | Description | Selected |
|--------|-------------|----------|
| Two columns: error_code (TEXT NULL) + error_message (TEXT NULL) | On success, both NULL. On failure, error_code = envelope `code`, error_message = short string (~500 chars; bearer-redacted). Easy to query (WHERE error_code = 'backend_saturated'). | ✓ |
| Single error JSONB column | NULL on success; {"code","message","http_status"} on failure. Slightly harder to query without `->>`. | |
| Single error TEXT column | Just error_message. Loses queryable error_code dimension. | |

**User's choice:** Two columns: error_code + error_message (Recommended).

### Q2: Which request lifecycle outcomes produce a row in request_log?

| Option | Description | Selected |
|--------|-------------|----------|
| All authenticated /v1 requests, even failed-before-adapter | Row written for: success, BackendSaturatedError, CapabilityNotSupportedError, RegistryUnknownModelError, upstream 5xx/timeout, client-disconnect. NOT for: 401 (pre-route), /healthz, /readyz, /metrics, /v1/models, /v1/messages/count_tokens. | ✓ |
| Only successful inference requests | Row only when adapter actually streamed/returned tokens. Clean usage_daily but SC2 says 'every request' — most readers expect failures too. | |
| Every reply that leaves the router, including 401/404/meta-routes | Universal coverage. 401-bombing inflates the table; metrics polling pollutes usage_daily. | |

**User's choice:** All authenticated /v1 requests including failures (Recommended).

### Q3: X-Agent-Id header semantics — required? Validated? Where does it land?

| Option | Description | Selected |
|--------|-------------|----------|
| Optional; loose validation; NULL fallback; pino child via preHandler | Optional header. Validation: `/^[A-Za-z0-9._:-]{1,128}$/` — reject only if present AND malformed. Missing → agent_id NULL. preHandler hook attaches req.agentId AND creates child logger via req.log.child({ agent_id }). | ✓ |
| Required on all model endpoints; reject 400 if missing | Force agents to identify. Cleaner data — no NULLs. Cons: breaks every existing curl test + the SDK doesn't send X-Agent-Id by default. | |
| Optional; no validation; raw string used as-is | Minimum code. Cons: pino log injection risk; no length cap. | |

**User's choice:** Optional + loose validation + NULL fallback + pino child via preHandler (Recommended).

### Q4: Schema specifics for tokens_in / tokens_out / ttft_ms / latency_ms / timestamp on partial outcomes:

| Option | Description | Selected |
|--------|-------------|----------|
| INT NULLable for tokens + ttft; INT NOT NULL for latency; TIMESTAMPTZ for ts | tokens_in/out/ttft_ms nullable, latency_ms NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now() in UTC. Plus UUID id (DEFAULT gen_random_uuid()) for cross-referencing pino req.id and Anthropic msg_<ulid>. | ✓ |
| All numeric columns NOT NULL with 0 fallback | Cannot distinguish 'truly zero output tokens' from 'we never got that far'. | |
| Single JSONB usage column | All four numeric columns folded into JSONB usage_metadata. Slower aggregation queries with casts everywhere. | |

**User's choice:** Nullable INT tokens/ttft, NOT NULL latency, TIMESTAMPTZ, UUID id (Recommended).

---

## Claude's Discretion

The user explicitly elected "Finish — ready for context" after the four areas above, leaving these to planner-discretion (locked in CONTEXT.md `<decisions>` § Claude's Discretion):

- Exact buffer cap (10,000 rows default; tune via profiling)
- Histogram bucket boundaries for request_duration and ttft
- usage_daily refresh mechanism (pg_cron vs Node setInterval vs materialized view) — held back as a fifth gray area but not promoted to a discussion
- pg_dump cron mechanism (sidecar vs host crontab vs pg_cron) — held back as a fifth gray area but not promoted to a discussion
- bin/restore-drill.sh exact shape
- status_class edge cases (partial-success interpretation)
- error_message redaction regex (defense-in-depth on top of pino redact)
- Drizzle Kit config file location (router/drizzle.config.ts convention)
- Whether the buffered-writer push enqueue is sync vs microtask-deferred

## Deferred Ideas

Captured in CONTEXT.md `<deferred>`:

- Phase 6 critical follow-up — Traefik MUST block external `/metrics` (CRITICAL — flagged in canonical_refs too)
- vLLM + llama.cpp + GPU exporter scrape configs + Grafana dashboard → Phase 7
- Prometheus server itself + scrape configs → Phase 7
- X-Model-Backend response header → Phase 8
- Server-side rate limit via Valkey → Phase 8
- Idempotency-Key header → Phase 8 (request_log will gain idempotency_key column)
- Cloud spend metric → Phase 8
- bin/gc-models.sh + off-host backup + disk-usage alert + token rotation → Phase 9
- request_log partitioning + retention TTL → Phase 9+
- OpenTelemetry traces → v2 backlog
- Loki log aggregation → v2 backlog
- Alertmanager → v2 backlog
- Per-request USD cost estimation → v2 backlog
- Soft tool-capability gating metric → Phase 7+
- /metrics cardinality alerts → Phase 7 (when Grafana lands)
