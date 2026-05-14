# Phase 5: Postgres + Observability Seam — Research

**Researched:** 2026-05-14
**Domain:** PostgreSQL 17 + Drizzle ORM + buffered async write pipeline + prom-client + Fastify v5 preHandler + Compose healthchecks
**Confidence:** HIGH (stack pins verified vs current npm; prom-client/Drizzle/pg patterns confirmed from official docs; one surface ambiguity flagged below — Drizzle 0.36 pin vs. 0.45 current)

## Summary

Phase 5 grafts a **Postgres 17 instance** (one container, two logical databases on the internal `data` network) and a **prom-client `/metrics` surface** onto an already-streaming router. The single load-bearing invariant is **SC2**: pausing Postgres for 5s must NOT stall in-flight SSE streams. Every architectural choice in CONTEXT.md flows from that — bounded in-memory ring buffer, dual-trigger flush, drop-oldest on overflow, `pg.Pool` with explicit `connectionTimeoutMillis`, router boots even if Postgres is unreachable.

The CONTEXT.md decision set (D-A1..D-G3) is internally consistent and matches the standard 2026 Node-Postgres telemetry pattern, with **two reconciliation points the planner must call out explicitly**: (1) the Drizzle migrator at boot conflicts with D-B5's "non-blocking on boot" — migrate() must run with a connection timeout and a try/catch that DOESN'T crash on Postgres-unreachable, contradicting the widespread "crash if migrate fails" production advice; (2) prom-client metrics are process-singletons and double-register if `buildApp()` runs twice (vitest fixtures) — every metric needs a fresh `Registry()` per instance OR a `register.clear()` in test teardown.

**Primary recommendation:** Use the CLAUDE.md stack (drizzle-orm@^0.36 / pg@^8.13 / prom-client@^15 / postgres:17-alpine) as the locked baseline. Pin `connectionTimeoutMillis: 2000` on the Pool, `idleTimeoutMillis: 30000`, and a `flushing: boolean` re-entrancy lock on the BufferedWriter. Put the migrator in a try/catch that warns-and-continues on connection failure rather than crashing. Use `queueMicrotask()` for the deferred enqueue. Implement `/metrics` as a fresh `Registry()` instance created inside `buildApp()` so tests can build the app twice without "metric already registered" failures.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bootstrap SQL (CREATE USER, DATABASE, GRANT, pgcrypto) | Postgres entrypoint (initdb.d) | — | First-init-only; superuser scope. Drizzle has no business creating users. |
| Schema migrations (CREATE TABLE, INDEX, ALTER) | Router boot (`drizzle-orm/migrator`) | — | Versioned, idempotent, app-level. Source of truth = TS schema files. |
| Row inserts to `request_log` | Router (`bufferedWriter` in main Node process) | — | Buffered async; in-process FIFO; `pg.Pool` shared. Worker-thread is wrong (I/O-bound). |
| `usage_daily` aggregation refresh | Router (Node `setInterval` per UTC midnight — recommended) | Postgres `pg_cron` (alternative — needs image swap) | Simplest given single-host single-process; doesn't fight Drizzle migrator over extension management. |
| Metrics observation + scrape surface | Router (`prom-client` raw, custom route) | — | Co-located with `request_log` write so label/column drift is impossible (D-C6). |
| `X-Agent-Id` validation + log decoration | Router (Fastify preHandler — AFTER bearer onRequest) | — | preHandler runs after onRequest in Fastify v5 — auth must gate first; agent-id is post-auth metadata. |
| `/metrics` access control | Phase 5: loopback-only via `127.0.0.1:3000` binding. Phase 6: Traefik middleware returning 404 externally | — | Phase 5 has no external proxy; Phase 6 builds the firewall layer. CRITICAL follow-up. |
| `pg_dump` daily backup | Sidecar container (`alpine:3.20` + `postgresql17-client`) writing to `${HOST_DATA_ROOT}/postgres-backups/` | Host crontab (alternative — less portable) | Containerized + portable + pins client to server version. |
| Healthcheck per service | Each service's own `healthcheck:` block in compose.yml | — | OBS-05 unchanged for Phases 1–3 services; Phase 5 only adds postgres's. |
| Readiness aggregation (`/readyz`) | Router (`LivenessScheduler` — adds `postgres` probe) | — | D-G2: `/readyz` returns 200 iff backends AND postgres reachable. `/healthz` stays minimal. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | `^0.36` (CLAUDE.md locked) — current npm latest is `0.45.2` [VERIFIED: npm view drizzle-orm version, 2026-05-14] | TS-first schema + migrator runner. `migrate(db, { migrationsFolder })` is the boot-time entry point. | TS schema → SQL migrations → typed query builder. Lighter than Prisma (no codegen step). |
| `drizzle-kit` | `^0.27` (CLAUDE.md / D-B1) — current npm latest is `0.31.10` [VERIFIED: npm registry, 2026-05-14] | Dev-time CLI: `drizzle-kit generate` writes SQL files from TS schema. **Does NOT apply migrations** — `migrate()` does. | Two-step workflow: review SQL diff in git, then apply at boot. |
| `pg` | `^8.13` (CLAUDE.md) — current npm latest is `8.20.0` [VERIFIED: npm view pg version, 2026-05-14] | node-postgres driver. Provides `Pool` (the only thing the router uses). | Battle-tested, the underlying driver Drizzle's `node-postgres` dialect wraps. |
| `@types/pg` | `^8.13` (devDep) — current npm latest is `8.20.0` matching `pg` [VERIFIED: npm registry, 2026-05-14] | Type definitions for `pg`. | Required because `pg` ships JS-only. |
| `prom-client` | `^15.1.3` [VERIFIED: npm view prom-client version, 2026-05-14] — current latest published 2024-06-27 (stable; no v16 in pipeline) | Prometheus client: `Registry`, `Counter`, `Histogram`, `collectDefaultMetrics`. | Industry standard for Node Prometheus. Process-singleton default registry — see Pitfall: double-registration. |
| `postgres` (image) | `postgres:17-alpine` — current minor is **17.9-alpine3.23** [CITED: hub.docker.com/_/postgres, 2026-05-14] | PostgreSQL server. Alpine variant is smallest acceptable for production. | pgcrypto built in (no extension install needed beyond `CREATE EXTENSION`). |

### Supporting (already in router/package.json — no changes)
| Library | Why Mentioned Here |
|---------|--------------------|
| `fastify` `^5.8.5` | Phase 5 adds a preHandler hook (X-Agent-Id) and a `GET /metrics` route. preHandler runs **after** onRequest (where bearer-auth lives) — confirmed in Fastify v5 docs [CITED: fastify.dev/docs/v5.8.x/Reference/Hooks/]. |
| `pino` `^9.x` (via Fastify) | `req.log.child({ agent_id })` is the surface for the X-Agent-Id field. Existing redact config in `router/src/log/logger.ts` is unchanged — `agent_id` is NOT redacted (public identifier). |
| `zod` `^4.x` | Already used for body schemas; not used for X-Agent-Id (a single regex test is lighter than a one-field zod schema for a header). |
| `vitest` `^4.x` | Test runner. Critical: `vi.useFakeTimers()` + fresh `Registry()` per buildApp call to avoid leaked setInterval and double-registration. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `prom-client` raw | `fastify-metrics` | [VERIFIED] D-C1 rejects this: it auto-instruments routes, adding a `route` label with unbounded cardinality. We need per-protocol/per-backend/per-model labels, NOT per-route. |
| `prom-client` raw | OpenTelemetry SDK | TRACE-01 (distributed traces) is v2 backlog. Pulling in `@opentelemetry/*` for a single `/metrics` endpoint is premature. |
| Drizzle ORM | Prisma | Prisma's codegen + schema language adds friction for a service with one table (request_log) + one materialization (usage_daily). Drizzle's TS-native schema fits. |
| Drizzle ORM | `pg` directly with hand-written SQL migrations | Viable but loses the migrator's idempotent `__drizzle_migrations` tracking. Not worth the ~150 LOC saved. |
| In-memory FIFO buffer | Disk-spooled JSONL fallback | D-A1 rejects: single-host, single-user, manual maintenance acceptable; losing a few seconds of `request_log` on crash is acceptable. Disk spool doubles the failure surface. |
| `worker_threads` for writer | In-process writer (D-A5) | Writer is I/O-bound (Postgres roundtrip), not CPU-bound. Worker thread buys nothing and complicates Pool sharing. |
| `pg_cron` for usage_daily refresh | Node setInterval at UTC midnight | pg_cron requires an extension and a custom image build (`pgvector/pgvector:pg17` or roll-your-own). Node setInterval is one function call. |
| Sidecar pg-backup container | Host crontab calling `docker compose exec postgres pg_dump` | Sidecar keeps the operation containerized + portable to bare-Linux deploys; host crontab is OS-specific and breaks if Compose project name changes. |
| `prom-client.register` (default) | Fresh `new Registry()` per buildApp | Fresh registry per buildApp lets vitest spawn N apps without "metric already registered" errors. Cost: one extra reference passed around. Verdict: required for testability. |

**Installation:**
```bash
cd router
npm install drizzle-orm@^0.36 pg@^8.13 prom-client@^15
npm install --save-dev drizzle-kit@^0.27 @types/pg
```

**Version verification:**
```bash
npm view drizzle-orm version      # current: 0.45.2 (CLAUDE.md pins 0.36 — 18-month stale)
npm view drizzle-kit version      # current: 0.31.10 (CLAUDE.md pins 0.27)
npm view pg version               # current: 8.20.0 (CLAUDE.md ^8.13 compatible — bumps within range)
npm view prom-client version      # current: 15.1.3 (CLAUDE.md ^15.x correct)
```

**[ASSUMED → confirm with user during plan-check]:** The CLAUDE.md pin to `drizzle-orm@^0.36` was set when Phase 5 stack was first scoped. Current latest is `0.45.2` — **18 months newer**. 1.0.0-rc.2 is on the `rc` dist-tag. The `migrate()` API signature and folder layout have NOT changed materially between 0.36 and 0.45 (still `import { migrate } from 'drizzle-orm/node-postgres/migrator'` per [CITED: orm.drizzle.team/docs/migrations, 2026-05-14]), so either pin is workable. Planner should ask: stick with the CLAUDE.md pin (`^0.36` — proven, tested in the wild), or upgrade to `^0.45` (active maintenance, newer query builder ergonomics). Recommend STICKING with `^0.36` to keep CLAUDE.md consistent — no Phase 5 feature requires post-0.36 capabilities.

## Architecture Patterns

### System Architecture Diagram

```
Request lifecycle (with Phase 5 additions in bold)

  HTTP request
       │
       ▼
  ┌─────────────┐
  │ onRequest   │ ← bearer-auth (existing); skip-list: /healthz, /readyz, /metrics
  └──────┬──────┘
         │ (bearer ok OR path in skip-list)
         ▼
  ┌─────────────┐
  │ preHandler  │ ← NEW: X-Agent-Id (validate regex / req.log.child / req.agentId)
  └──────┬──────┘
         │ (req._t0 set here for latency_ms)
         ▼
  ┌─────────────────────────────────────────┐
  │ Route handler                           │
  │ (chat-completions.ts | messages.ts)     │
  │                                         │
  │ stream branch:                          │
  │   reply.sse(canonicalToOpenAISse(...))  │
  │   on first chunk: capture msSinceStart  │
  │   sseCleanup: recordRequestOutcome(ctx) │ ← NEW (alongside existing safeRelease)
  │                                         │
  │ non-stream branch:                      │
  │   await adapter.chatCompletionsCan(...) │
  │   finally: recordRequestOutcome(ctx)    │ ← NEW
  └──────┬──────────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────┐
  │ recordRequestOutcome(ctx)   │ ← ONE helper, TWO effects:
  │                             │
  │  ├─→ prom-client observes   │   (metrics: 5 custom + Node defaults)
  │  │                          │
  │  └─→ bufferedWriter.push()  │   (queue row for async INSERT)
  └─────────────────────────────┘

  Background (out of request hot path):

  ┌─────────────────┐
  │ BufferedWriter  │ ← in-memory FIFO, cap=10k, drop-oldest on overflow
  │                 │
  │  setInterval(1s)│ ─┐
  │  push() at 200+ │ ─┴─→ flush() ─→ multi-row parameterized INSERT
  │                 │                  via Drizzle .values(rows) over pg.Pool
  │  flushing:bool  │      (re-entrancy lock — see Pitfall 1)
  └─────────────────┘
                            │ failure?
                            ▼
                  log warn { event: 'log_buffer_flush_error' }
                  rows STAY in buffer (D-A7) — next tick retries
                  buffer overflow → drop-oldest → counter++

  Scrape surface:

  GET /metrics  (skip-list, loopback only via 127.0.0.1:3000)
       │
       ▼
  prom-client Registry → text/plain; version=0.0.4
```

### Recommended Project Structure
```
router/
├── drizzle.config.ts                        # NEW — Drizzle Kit config
├── db/migrations/                           # NEW — generated SQL (committed)
│   └── 0001_init.sql
├── src/
│   ├── db/                                  # NEW module
│   │   ├── index.ts                         # Pool + drizzle db handle exports
│   │   ├── migrate.ts                       # boot-time migrator wrapper
│   │   ├── bufferedWriter.ts                # ring buffer + flush loop + SIGTERM drain
│   │   └── schema/
│   │       ├── index.ts                     # re-export of both tables
│   │       ├── request_log.ts               # Drizzle pgTable for request_log
│   │       └── usage_daily.ts               # Drizzle pgTable for usage_daily
│   ├── metrics/                             # NEW module
│   │   ├── registry.ts                      # prom-client Registry + 5 metric defs
│   │   └── recordOutcome.ts                 # recordRequestOutcome(ctx)
│   ├── middleware/                          # NEW module
│   │   └── agentId.ts                       # X-Agent-Id preHandler
│   ├── app.ts                               # MODIFIED — register preHandler + /metrics + onClose drain
│   ├── index.ts                             # MODIFIED — pool/migrator/bufferedWriter wiring
│   ├── auth/bearer.ts                       # MODIFIED — extend skip-list with /metrics
│   ├── routes/
│   │   ├── readyz.ts                        # MODIFIED — postgres pool probe
│   │   └── v1/{chat-completions,messages}.ts  # MODIFIED — recordRequestOutcome calls
│   └── backends/liveness.ts                 # MODIFIED — adds postgres probe key
postgres/
└── initdb/01-init.sql                       # NEW — CREATE USER, DATABASE, GRANT, EXTENSION pgcrypto
bin/
├── restore-drill.sh                         # NEW — pg_restore + sanity SELECT
└── smoke-test-router.sh                     # MODIFIED — extend with metrics + agent-id + pause-pg
```

### Pattern 1: Buffered Async Writer (load-bearing for SC2)

**What:** Bounded FIFO + setInterval(1s) + push-triggered flush at 200 rows + multi-row INSERT.
**When to use:** Anywhere the request hot path must emit telemetry without blocking on a slow downstream.

**Reference shape:**
```typescript
// router/src/db/bufferedWriter.ts (illustrative — planner refines)
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { requestLog } from './schema/request_log.js';

interface BufferedWriterOpts {
  db: NodePgDatabase;
  capacity?: number;          // D-A1 default: 10_000
  flushIntervalMs?: number;   // D-A2 default: 1_000
  flushAtRows?: number;       // D-A2 default: 200
  droppedCounter: { inc(): void };  // prom-client Counter (D-A1)
  logger: { warn: (...args: unknown[]) => void };
}

export function makeBufferedWriter(opts: BufferedWriterOpts) {
  const capacity = opts.capacity ?? 10_000;
  const flushIntervalMs = opts.flushIntervalMs ?? 1_000;
  const flushAtRows = opts.flushAtRows ?? 200;

  const buf: Array<typeof requestLog.$inferInsert> = [];
  let flushing = false;       // re-entrancy lock (see Pitfall 1)
  let stopped = false;

  const flush = async (): Promise<void> => {
    if (flushing || buf.length === 0 || stopped) return;
    flushing = true;
    const batch = buf.splice(0, Math.min(buf.length, 1000));   // cap batch size
    try {
      await opts.db.insert(requestLog).values(batch);          // single parameterized INSERT
    } catch (err) {
      opts.logger.warn({ event: 'log_buffer_flush_error', err, count: batch.length }, 'flush failed');
      buf.unshift(...batch);   // D-A7: rows STAY in buffer for next tick retry
                               // Beware: with capacity overflow this can cascade — see Pitfall 1
    } finally {
      flushing = false;
    }
  };

  const timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref?.();

  return {
    push(row: typeof requestLog.$inferInsert): void {
      if (stopped) return;
      if (buf.length >= capacity) {
        buf.shift();                       // drop oldest (D-A1)
        opts.droppedCounter.inc();
      }
      buf.push(row);
      if (buf.length >= flushAtRows) {
        queueMicrotask(() => { void flush(); });   // D-A2: microtask-deferred
      }
    },
    async drain(timeoutMs = 3000): Promise<void> {   // D-A4: best-effort 3s drain
      stopped = true;
      clearInterval(timer);
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      if (buf.length > 0) {
        opts.logger.warn(
          { event: 'log_buffer_shutdown_drop', buffered_at_shutdown: buf.length },
          'drain timeout — dropping buffered rows',
        );
      }
    },
    get size() { return buf.length; },   // for tests + /readyz diagnostics
  };
}
```

**Key invariants:**
- `flushing: boolean` re-entrancy lock prevents overlapping flushes when Postgres is slow.
- `queueMicrotask()` defers the push-triggered flush so the caller's stack returns first (D-A2 — microtask-deferred).
- `buf.unshift(...batch)` on flush failure preserves D-A7 (rows stay in buffer); the `flushing` lock guarantees this never races.
- `drain(3000)` raced via `Promise.race` against a `setTimeout` for the 3-second SIGTERM contract (D-A4).
- `timer.unref?.()` so the event loop doesn't stay alive solely for the writer.

### Pattern 2: `recordRequestOutcome` — single helper, both effects

**What:** One function called from both routes' sseCleanup + non-stream finally that (a) observes 5 prom-client metrics and (b) enqueues a `request_log` row. This is D-C6's single source of truth for label↔column consistency.

```typescript
// router/src/metrics/recordOutcome.ts (illustrative)
export interface OutcomeContext {
  protocol: 'openai' | 'anthropic';
  route: string;                     // req.url top-level (query stripped)
  backend: string;
  model: string;                     // entry.name (registry display)
  statusClass: 'success' | 'client_error' | 'server_error' | 'disconnect';
  httpStatus: number;
  durationMs: number;
  ttftMs?: number;                   // null for non-stream
  tokensIn?: number;
  tokensOut?: number;
  errorCode?: string;                // from envelope.ts err.code (D-D2 taxonomy)
  errorMessage?: string;             // truncated + re-redacted (D-D3)
  agentId?: string;
  requestId: string;                 // pino req.id
  upstreamMessageId?: string;        // Anthropic only
  timestamp: Date;
}

export function makeRecordRequestOutcome(deps: {
  metrics: MetricsRegistry;          // prom-client Registry + 5 counters/histograms
  bufferedWriter: { push: (row: RequestLogInsert) => void };
}) {
  return function recordRequestOutcome(ctx: OutcomeContext): void {
    // (a) Metric observations
    const labels = { protocol: ctx.protocol, backend: ctx.backend, model: ctx.model };
    deps.metrics.requestsTotal.inc({ ...labels, status_class: ctx.statusClass });
    deps.metrics.requestDurationSeconds.observe(labels, ctx.durationMs / 1000);
    if (ctx.ttftMs !== undefined) {
      deps.metrics.ttftSeconds.observe(labels, ctx.ttftMs / 1000);
    }
    if (ctx.tokensIn !== undefined) {
      deps.metrics.tokensTotal.inc({ ...labels, direction: 'input' }, ctx.tokensIn);
    }
    if (ctx.tokensOut !== undefined) {
      deps.metrics.tokensTotal.inc({ ...labels, direction: 'output' }, ctx.tokensOut);
    }

    // (b) request_log enqueue (D-D6 field map)
    deps.bufferedWriter.push({
      ts: ctx.timestamp,
      protocol: ctx.protocol,
      route: ctx.route,
      backend: ctx.backend,
      model: ctx.model,
      status_class: ctx.statusClass,
      http_status: ctx.httpStatus,
      tokens_in: ctx.tokensIn ?? null,
      tokens_out: ctx.tokensOut ?? null,
      ttft_ms: ctx.ttftMs ?? null,
      latency_ms: Math.round(ctx.durationMs),
      error_code: ctx.errorCode ?? null,
      error_message: ctx.errorMessage ?? null,
      agent_id: ctx.agentId ?? null,
      request_id: ctx.requestId,
      upstream_message_id: ctx.upstreamMessageId ?? null,
    });
  };
}
```

**Why it matters:** D-C3 forbids `agent_id`/`request_id`/raw `http_status`/`error_message` as metric labels (cardinality blowup) but requires all of them in the `request_log` row. Co-locating both effects in one helper is the structural guarantee that the label set and column set stay synchronized as the surface evolves.

### Pattern 3: X-Agent-Id preHandler (post-bearer, pre-route)

```typescript
// router/src/middleware/agentId.ts (illustrative)
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
    _t0?: number;                  // perf.now() captured here for latency_ms
  }
}

const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export async function agentIdPreHandler(req: FastifyRequest, _reply: FastifyReply) {
  req._t0 = performance.now();      // earliest possible capture for SC2-bookkeeping

  const raw = req.headers['x-agent-id'];
  if (raw === undefined) return;     // D-D5: absent → agentId stays undefined → NULL column

  const value = Array.isArray(raw) ? raw[0] : raw;   // RFC 9110: duplicates may join with ',' — we take first
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    // D-D5: regex violation → 400 invalid_request (code: 'invalid_agent_id')
    const err: Error & { code?: string } = new Error('X-Agent-Id violates /^[A-Za-z0-9._:-]{1,128}$/');
    err.code = 'invalid_agent_id';
    throw err;                       // app.setErrorHandler routes to OpenAI or Anthropic envelope
  }

  req.agentId = value;
  req.log = req.log.child({ agent_id: value });   // pino propagates to all subsequent req.log.* calls
}
```

**Hook ordering [VERIFIED: fastify.dev/docs/v5.8.x/Reference/Hooks/]:**
- `onRequest` runs first → bearer-auth gates here
- `preHandler` runs AFTER body parsing + zod validation → agent-id enrichment lives here
- App-level hooks run BEFORE route-level hooks of the same type
- Pino `req.log.child({...})` reassignment on the request object — Fastify v5 supports this; subsequent `req.log.*` calls within the same request DO carry the agent_id field. (The `req.log` slot is a writable property in Fastify v5's request decorator.)

**ReDoS analysis:** `/^[A-Za-z0-9._:-]{1,128}$/` has no nested quantifiers, no alternation that overlaps with itself, and is anchored at both ends. Safe — no ReDoS hazard.

### Pattern 4: Postgres pool with non-blocking timeouts

```typescript
// router/src/db/index.ts (illustrative)
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export function makePool(url: string) {
  return new Pool({
    connectionString: url,
    max: 8,                        // D-B4
    idleTimeoutMillis: 30_000,     // D-B4
    connectionTimeoutMillis: 2_000,  // NOT 0 (default) — D-B5 non-blocking requires this
    // Optional belt-and-suspenders for SC2 — server-side query timeout for SELECT 1 probes
    // statement_timeout configured per-query on the /readyz probe path, NOT globally
    // (a 1s global statement_timeout would break a slow INSERT of 200 rows under load).
  });
}

export const makeDb = (pool: Pool) => drizzle(pool);
```

**Critical:** `connectionTimeoutMillis: 0` (the default) means `pool.connect()` hangs FOREVER if Postgres is unreachable [CITED: node-postgres.com/apis/pool, 2026-05-14]. D-B5's "router boots even if Postgres unreachable" REQUIRES a finite value. Recommend 2000ms — long enough for a slow first connection on cold start, short enough that a flush attempt against a paused Postgres bounces in <2s.

### Pattern 5: prom-client with fresh Registry per buildApp

```typescript
// router/src/metrics/registry.ts (illustrative)
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export function makeMetricsRegistry() {
  const register = new Registry();
  collectDefaultMetrics({ register });   // Node defaults attach to THIS register only

  const requestsTotal = new Counter({
    name: 'router_requests_total',
    help: 'Total number of model requests by protocol/backend/model/status_class',
    labelNames: ['protocol', 'backend', 'model', 'status_class'],
    registers: [register],
  });

  const requestDurationSeconds = new Histogram({
    name: 'router_request_duration_seconds',
    help: 'End-to-end request latency (s)',
    labelNames: ['protocol', 'backend', 'model'],
    // CONTEXT.md suggested buckets — defaults [0.005..10] are too short for LLM completions
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });

  const ttftSeconds = new Histogram({
    name: 'router_ttft_seconds',
    help: 'Time to first token (s) — observed at first SSE chunk',
    labelNames: ['protocol', 'backend', 'model'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const tokensTotal = new Counter({
    name: 'router_tokens_total',
    help: 'Total tokens by direction',
    labelNames: ['protocol', 'backend', 'model', 'direction'],
    registers: [register],
  });

  const logBufferDroppedTotal = new Counter({
    name: 'router_log_buffer_dropped_total',
    help: 'Rows dropped by the bufferedWriter due to overflow (drop-oldest)',
    registers: [register],
  });

  return { register, requestsTotal, requestDurationSeconds, ttftSeconds, tokensTotal, logBufferDroppedTotal };
}
```

**Why this shape:**
- Fresh `new Registry()` per `buildApp()` call → vitest can build N apps in sequence without "metric already registered" errors [CITED: github.com/siimon/prom-client/issues/439].
- `collectDefaultMetrics({ register })` attaches Node defaults to OUR registry, NOT the global default. Without `{ register }`, `collectDefaultMetrics` would target `prom-client`'s singleton default registry and double-register on second buildApp.
- Every Counter/Histogram passes `registers: [register]` so they're isolated to this app instance.

### Pattern 6: `/metrics` route — bearer-skip-list extension

```typescript
// In auth/bearer.ts — change one line:
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

// In app.ts — register the route:
app.get('/metrics', async (_req, reply) => {
  void reply.type(metrics.register.contentType);   // 'text/plain; version=0.0.4; charset=utf-8'
  return metrics.register.metrics();
});
```

### Anti-Patterns to Avoid

- **Globally setting `statement_timeout` on the Pool.** A short global timeout breaks the slowest legitimate INSERT (200 rows under contention). Set timeouts per query if needed (`SELECT 1` on /readyz probe gets a 1s timeout via `await client.query({ text: 'SELECT 1', statement_timeout: 1000 })` or by wrapping in `Promise.race`).
- **Calling `flush()` synchronously from `push()` at the 200-row boundary.** Even if flush is async, calling it without a microtask defer means the caller's stack stays on the heap until the await resolves. `queueMicrotask(() => void flush())` returns to the caller immediately.
- **Forgetting `flushing: boolean`.** Without the re-entrancy lock, a slow flush + 1s interval = overlapping flushes that splice the same batch twice and corrupt the buffer order. **Critical — not in CONTEXT.md as a discrete decision; planner must wire it.**
- **`prom-client` without a custom Registry.** Using the default `register` makes the second `buildApp()` call in tests throw "metric already registered". Always `new Registry()` per build.
- **`pool.connect()` with default `connectionTimeoutMillis: 0`.** Hangs forever on Postgres-unreachable. Violates D-B5 silently.
- **`drizzle.migrate()` without a try/catch on the boot path.** Standard production advice [CITED: dev.to/whoffagents/drizzle-orm-migrations-in-production-zero-downtime-schema-changes] is "crash if migrate fails — don't run on a broken schema". This DIRECTLY CONTRADICTS D-B5. Resolution: catch the connection error specifically (`ECONNREFUSED`, `ETIMEDOUT`) and warn-and-continue; let schema errors (syntax, conflict) still crash. See "Reconciliation point 1" below.
- **Logging `req.body` on error in chat-completions/messages.** Pitfall 12 — bodies may contain the bearer or apiKey. Stays unchanged from Phase 2.
- **Returning `/metrics` body via `reply.send(...)` without setting Content-Type.** prom-client emits the OpenMetrics text format; without `text/plain; version=0.0.4; charset=utf-8` Prometheus scrapers refuse the parse.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Postgres migrations + tracking | Custom SQL file runner with a `_migrations` table | `drizzle-orm/migrator` `migrate()` | Built-in `drizzle.__drizzle_migrations` table + idempotency. |
| TS schema → SQL diff | Hand-edited SQL files | `drizzle-kit generate` | Type errors in schema = compile error; SQL is review-ready output. |
| Prometheus text format encoding | Hand-written `lines.push(\`${name}{l="v"} ${value}\`)` | `prom-client` Histogram/Counter + `register.metrics()` | Histogram quantiles + `_bucket` cumulative encoding + `_sum`/`_count` are non-trivial; the lib gets them right. |
| Buffered async writer | Per-row INSERT with `setImmediate()` | The pattern above (bounded FIFO + dual-trigger + multi-row INSERT) | Per-row hits Postgres per request; batched multi-row INSERT is 50-100× faster on a single connection. |
| Bearer-token comparison | `if (a === b)` | Existing `timingSafeEqual` in `auth/bearer.ts` | Phase 2 already solved this. Don't introduce new auth paths. |
| Histogram buckets | Defaults `[0.005..10]` | Custom buckets per the table above | Default prom-client buckets max out at 10s; long completions easily exceed 60s. CONTEXT.md's planner-discretion bucket suggestions are correct [VERIFIED: github.com/siimon/prom-client README]. |
| Pool reachability check on /readyz | `await pool.query('SELECT 1')` raw | Wrap in `Promise.race` with 1s timeout | Default behavior is to queue forever if all 8 slots are in use. /readyz must answer within ~2s. |

**Key insight:** Every "Don't Hand-Roll" entry above has been a P0 outage somewhere in production Node systems. The team paying for `drizzle-orm` + `prom-client` is the team that already paid for these bugs.

## Runtime State Inventory

> Phase 5 introduces NEW runtime state — this inventory documents what will exist after the phase, NOT what gets renamed. (Not a refactor phase, but the categories are useful for downstream operations.)

| Category | Items | Action |
|----------|-------|--------|
| Stored data (Postgres) | `router.request_log` table; `router.usage_daily` table; `drizzle.__drizzle_migrations` tracking; `openwebui` DB exists but empty | Created by `01-init.sql` (DB-level) + Drizzle migrator (table-level). Backups via daily pg_dump. |
| Live service config | `postgres` container env (`POSTGRES_PASSWORD`, `POSTGRES_DB=router` recommended for first-init); `pg-backup` sidecar (if Compose-discretion path A chosen) | Lives in compose.yml + .env. NOT in any UI. |
| OS-registered state | None — Phase 5 is Compose-managed only. No Windows Task Scheduler entries, no systemd units. | — |
| Secrets / env vars | `POSTGRES_PASSWORD` (already in .env.example since Phase 1); `ROUTER_DATABASE_URL` + `OPENWEBUI_DATABASE_URL` (derived in compose.yml from POSTGRES_PASSWORD — not separate secrets) | Existing .env contract. **Code reads `ROUTER_DATABASE_URL` by exact name — don't rename.** |
| Build artifacts / installed packages | `router/db/migrations/0001_init.sql` (and onward) committed to git; `node_modules/drizzle-orm`, `node_modules/pg`, `node_modules/prom-client` after `npm install` | New deps lock. CI must run `npm ci` to pick them up. |

## Common Pitfalls

### Pitfall 1: Overlapping flushes corrupt the buffer
**What goes wrong:** `setInterval(1s)` fires while a previous `flush()` is still awaiting a slow Postgres response. The new flush splices the buffer's head while the old flush is mid-INSERT — same rows attempted twice, or rows missed.
**Why it happens:** `setInterval` doesn't await; `flush()` is `async`. Without a guard, JS schedules both.
**How to avoid:** A `flushing: boolean` re-entrancy lock guarded by the SAME single-threaded event loop. Set true at flush entry, false in finally. NOT in CONTEXT.md — planner must wire it. Code shape in Pattern 1 above.
**Warning signs:** Duplicate `request_log` rows (same `request_id` twice); or rows in the buffer that never flush after a Postgres slowness episode.

### Pitfall 2: prom-client double-registration in tests
**What goes wrong:** `vitest run` calls `buildApp()` twice. Second call throws `Error: A metric with the name process_cpu_user_seconds_total has already been registered.`
**Why it happens:** `collectDefaultMetrics()` and `new Counter()` without an explicit `registers:` array target `prom-client`'s singleton default registry. Singletons survive across tests.
**How to avoid:** Always `new Registry()` per buildApp. Always pass `registers: [register]` to every Counter/Histogram. Always pass `{ register }` to `collectDefaultMetrics`. See Pattern 5.
**Warning signs:** Tests fail intermittently when run in a specific order; first test passes, second one throws.
**Source:** [CITED: github.com/siimon/prom-client/issues/439 + #196 + #334, 2026-05-14]

### Pitfall 3: `pool.connect()` hangs forever
**What goes wrong:** Postgres is down. Router boots. First flush attempt calls `pool.connect()`. Hangs indefinitely. Buffer never drains. Eventually overflows (drop-oldest kicks in continuously). The 1s `setInterval` flushes pile up — each new tick spawns a NEW hung connect (because `flushing` was never set true since the await never resolved). Process eventually OOMs.
**Why it happens:** `connectionTimeoutMillis: 0` is the default and means "wait forever" [CITED: node-postgres.com/apis/pool, 2026-05-14].
**How to avoid:** Always set `connectionTimeoutMillis: 2000` (or similar finite value) on the Pool. With the re-entrancy lock from Pitfall 1, a hung flush still blocks new flush attempts but at least doesn't multiply them.
**Warning signs:** `request_log_dropped_total` counter rises monotonically while Postgres is down, and `pg_isready` from the host returns "no response". After Postgres recovers, rows do NOT start landing.

### Pitfall 4: Drizzle migrate on boot vs. D-B5 non-blocking
**What goes wrong:** Standard advice is "crash if migrate fails — don't run on a broken schema" [CITED: dev.to/whoffagents/drizzle-orm-migrations-in-production-zero-downtime-schema-changes, 2026-05-14]. But D-B5 says the router boots even if Postgres is unreachable. These contradict on the boot path.
**Why it happens:** "Migrate fails" has two distinct causes: (a) can't reach Postgres (transient, recoverable) vs. (b) schema syntax/conflict error (permanent, unrecoverable). The standard advice conflates them.
**How to avoid:** Catch ONLY connection-class errors and warn-and-continue; let schema-class errors crash. Code shape:
```typescript
try {
  await migrate(db, { migrationsFolder: './db/migrations' });
} catch (err) {
  const code = (err as { code?: string }).code;
  // pg connection-error codes: ECONNREFUSED, ETIMEDOUT, ENOTFOUND
  // pg "server" connection errors: 08000, 08001, 08003, 08006, 08007, 08P01
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || (typeof code === 'string' && code.startsWith('08'))) {
    log.warn({ err, event: 'migrate_postgres_unreachable' }, 'migrator: Postgres unreachable — booting without migrations');
    // /readyz will report not_ready until postgres probe transitions to alive
  } else {
    throw err;   // schema syntax/conflict — fail loud, Compose restart-loops
  }
}
```
**Warning signs:** Router starts, logs `migrate_postgres_unreachable`, `/readyz` returns 503. After Postgres comes up, the next migrate attempt (manual restart? or planner adds a retry?) succeeds. **Open question:** does the migrator retry automatically once Postgres is reachable, or does the operator have to restart the router? CONTEXT.md doesn't decide — planner must.

### Pitfall 5: pg.Pool exhaustion under load
**What goes wrong:** `max: 8` connections; concurrent bufferedWriter flush + `/readyz` probe + future `usage_daily` query. Under burst load (10+ concurrent agents), all 8 are taken; subsequent `pool.connect()` calls queue.
**Why it happens:** D-B4 sets max=8. With `connectionTimeoutMillis: 2000`, queued callers wait up to 2s then error — and the queued callers are the flush path.
**How to avoid:** Two complementary actions: (1) batch flush size cap of ~200 rows means flush completes fast enough that any one connection turns over quickly; (2) the `flushing: boolean` lock from Pitfall 1 means at most ONE connection is held by the writer at a time. Verify under load by running smoke test SC2 (5s postgres pause) and watching `pool.idleCount` + `pool.waitingCount` via decorator on /readyz.
**Warning signs:** `/readyz` latency rises into the seconds during heavy flush periods; flush failures spike in a narrow time window.

### Pitfall 6: First-init scripts don't re-run
**What goes wrong:** Operator adds `02-grants.sql` to `postgres/initdb/` after Postgres has already been initialized. Container restart: new script does NOT execute.
**Why it happens:** `/docker-entrypoint-initdb.d/` is first-init-only when `PGDATA` is empty [CITED: hub.docker.com/_/postgres, 2026-05-14]. Documented but routinely forgotten.
**How to avoid:** Treat init scripts as IMMUTABLE after first deploy. Schema evolution goes through Drizzle migrations. If init script changes are truly needed: `docker compose down -v` (data loss!) → restore from pg_dump → up. Document this in README's Phase 5 section and at the top of `01-init.sql`.
**Warning signs:** `psql -U app -d router -c "\du"` shows old grants; new SQL not applied; operator confused why.

### Pitfall 7: Bind-mount uid mismatch on `postgres-data/`
**What goes wrong:** `${HOST_DATA_ROOT}/postgres-data` doesn't exist on first up. Postgres tries to init, fails with `chmod /var/lib/postgresql/data: Operation not permitted`. Or it exists but is owned by host uid 1000, and postgres (uid 70 on alpine [CITED: hub.docker.com/_/postgres, but uid varies — see "Important Note"], more commonly uid 999 on debian) can't write.
**Why it happens:** Bind mounts inherit host filesystem ownership. The Alpine postgres image's `postgres` user has a documented uid that doesn't auto-chown.
**How to avoid:** `bin/bootstrap-host.sh` (Phase 1 pattern) should `mkdir -p ${HOST_DATA_ROOT}/postgres-data && chown 70:70 ${HOST_DATA_ROOT}/postgres-data` BEFORE first `docker compose up postgres`. On WSL2, the uid story is even messier — recommend using `bind-mount + chown` rather than named volume so backup-portability works (consistent with Phase 1's bind-mount discipline).
**Warning signs:** `docker compose up postgres` exits with `initdb: error: could not create directory ".../base"`; `ls -ln ${HOST_DATA_ROOT}/postgres-data` shows ownership 1000:1000 instead of 70:70 or 999:999.
**[ASSUMED — planner must verify]:** The exact uid postgres:17-alpine runs as. The official image docs note Alpine variants "may have UID 70" but I haven't verified this against postgres:17-alpine specifically. Plan tasks should `docker run --rm postgres:17-alpine id postgres` to nail down the answer before writing the bootstrap script.

### Pitfall 8: `recordRequestOutcome` called twice
**What goes wrong:** `sseCleanup` runs twice in rare error paths (the safeRelease pattern from Phase 3 was designed for this). A duplicate `recordRequestOutcome` call enqueues two rows with the same `request_id`, double-counts the metric, and inflates `tokens_out` totals.
**Why it happens:** Same root cause as Phase 3's idempotent semaphore release — cleanup hooks can fire from multiple paths (stream end + onClose + error handler).
**How to avoid:** Make `recordRequestOutcome` idempotent the same way safeRelease is: a `recorded: boolean` closure captured per request. The route file's existing `safeRelease` pattern is the template:
```typescript
let recorded = false;
const safeRecord = (ctx: OutcomeContext) => {
  if (recorded) return;
  recorded = true;
  recordRequestOutcome(ctx);
};
```
**Warning signs:** Duplicate `request_id`s in `request_log` (the `request_id` column is `NOT NULL` per D-D1 but is NOT unique — so duplicates land silently); metric counts don't match row counts in `request_log`.

### Pitfall 9: Pino child logger reassignment vs. Fastify v5 invariants
**What goes wrong:** `req.log = req.log.child({ agent_id })` in the preHandler works, but if a deeper plugin (e.g., a request-context plugin in Phase 6+) also reassigns `req.log` it may drop the agent_id.
**Why it happens:** Fastify v5's `req.log` is a writable property; the last writer wins.
**How to avoid:** Document the preHandler as the LAST place `req.log` is reassigned. Add a CI grep test: `grep -rn "req.log = " router/src/ | wc -l` must equal 1 (the agentId preHandler) — same gate Phase 2 established for other safety-critical patterns.
**Warning signs:** `agent_id` field appears on some log lines from a request and not others.

### Pitfall 10: `/metrics` exposes process info — is anything sensitive?
**What goes wrong:** Worry that `collectDefaultMetrics` exposes prompts or tokens via process metadata.
**Why it doesn't:** Node default metrics are: `process_cpu_user_seconds_total`, `process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds`, `nodejs_heap_size_total_bytes`, `nodejs_active_handles`, `nodejs_gc_duration_seconds`, etc. Pure process telemetry — no request bodies, no user-supplied data. Safe to expose.
**Confirmation source:** [VERIFIED: github.com/siimon/prom-client README "Default metrics"]

### Pitfall 11 — Pitfall 12 reminder + Phase 6 follow-up: bearer in logs / `/metrics` external exposure
**What goes wrong:** Phase 5 puts `/metrics` on the public skip-list — fine on `127.0.0.1:3000`. Phase 6 introduces Traefik and removes the localhost binding. If Phase 6 forgets to firewall `/metrics`, the endpoint becomes publicly readable. Prompts and tokens aren't there, but **operational telemetry** (request rates per backend, error rates by model) is reconnaissance data for an attacker.
**Why it happens:** D-C5 explicitly says "Phase 5 is pre-Traefik so router binds 127.0.0.1:3000 — unauth on loopback is safe. Phase 6 CRITICAL follow-up: Traefik MUST add a matcher/middleware that returns 404 for external `/metrics` requests."
**How to avoid:** **This is a Phase 5 deliverable**: a Phase 6 planning note that flags the follow-up. CONTEXT.md already has it; the planner must mirror it into the Phase 5 RESEARCH / PLAN handoff so it doesn't get lost. Add a TODO comment in `router/src/auth/bearer.ts` next to the skip-list extension referencing Phase 6.
**Verify loopback binding now:** `compose.yml` line 224 confirms `127.0.0.1:3000:3000` for `router` service (and `127.0.0.1:3000:3000` for `router-dev` at line 264). Phase 5 inherits this binding — no host port change in this phase. [VERIFIED: /home/luis/proyectos/local-llms/compose.yml lines 222-224]

### Pitfall 12: `error_message` truncation + redaction
**What goes wrong:** A raw error message gets written to `request_log.error_message`. Some upstream library (undici, openai-sdk) included the bearer token or apiKey in the error string for "debug helpfulness". Now it's in the database forever.
**Why it happens:** pino's `redact` config covers the LOG record, not the DB column. D-D3 says re-apply a regex strip for `Bearer\s+\S+`, `Authorization:\s+\S+`, `apiKey['"]?\s*[:=]\s*['"]?\S+` before writing.
**How to avoid:** A `truncateAndRedact(msg: string, max=500): string` helper called inside `recordRequestOutcome` BEFORE pushing the row. Regex pattern is non-trivial — test it with known-bad strings. Planner's discretion on the exact regex; CONTEXT.md gives the seed patterns.
**Warning signs:** `SELECT error_message FROM request_log WHERE error_message ~ '[Bb]earer'` returns rows.

## Code Examples

### Compose snippet — postgres service + sidecar backup + router updates
```yaml
# compose.yml — APPEND to existing services block
  postgres:
    image: postgres:17-alpine
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-postgres
    restart: unless-stopped
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      # NOT POSTGRES_DB — the initdb.d script creates both DBs explicitly.
      - POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C
    networks:
      - data           # internal:true — no host port (D-E1)
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/postgres-data:/var/lib/postgresql/data
      - ./postgres/initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d router -h 127.0.0.1 || exit 1"]
      interval: 10s
      timeout: 3s
      start_period: 30s
      retries: 5

  # Optional sidecar (Claude's-discretion D-F2 path A)
  pg-backup:
    image: postgres:17-alpine    # same image — pg_dump version must match server
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-pg-backup
    restart: unless-stopped
    networks: [data]
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups:/backups
    environment:
      - PGPASSWORD=${POSTGRES_PASSWORD}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        while true; do
          STAMP=$$(date -u +%Y-%m-%dT%H)
          pg_dump -h postgres -U app -d router --format=custom -f /backups/router-$$STAMP.dump || \
            echo "[pg-backup] dump failed at $$STAMP"
          # retain last 7 days
          find /backups -name "router-*.dump" -mtime +7 -delete
          sleep 86400
        done
    depends_on:
      postgres:
        condition: service_healthy
        required: false
```

### router service — add to existing block
```yaml
  router:
    # ...existing fields...
    environment:
      # ...existing env...
      - ROUTER_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/router
      - OPENWEBUI_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui
    networks:
      - app
      - backend
      - data           # NEW — Phase 5 attaches router to data network
    depends_on:
      ollama:
        condition: service_healthy
        required: false
      llamacpp:
        condition: service_healthy
        required: false
      postgres:
        condition: service_healthy
        required: false    # D-E4 — router boots without postgres (D-B5)
```

### `postgres/initdb/01-init.sql`
```sql
-- Runs ONCE on first init (when PGDATA is empty). Documented gotcha — see Pitfall 6.
-- After Phase 5 ships, schema evolution is Drizzle's job; this file must NOT be re-edited
-- to add tables. Editing this file post-deploy has NO effect without `docker compose down -v`.

CREATE USER app WITH PASSWORD :'postgres_password' LOGIN;
CREATE DATABASE router OWNER app;
CREATE DATABASE openwebui OWNER app;

\connect router
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- D-B8: gen_random_uuid()
GRANT ALL ON SCHEMA public TO app;

\connect openwebui
GRANT ALL ON SCHEMA public TO app;
-- Open WebUI manages its own schema (Phase 6); Phase 5 only creates the empty DB.
```

**Note:** `:'postgres_password'` is a psql variable; the entrypoint script may or may not honor it. Safer pattern: use `POSTGRES_PASSWORD` env directly + omit `CREATE USER` (the entrypoint creates the default user from env vars) OR write the password literal in via a templated entrypoint script. Planner must pick a concrete approach.

### Drizzle config + schema
```typescript
// router/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './db/migrations',
  dbCredentials: { url: process.env.ROUTER_DATABASE_URL! },
  // verbose: true,    // useful in dev
  // strict: true,
});
```

```typescript
// router/src/db/schema/request_log.ts
import { pgTable, uuid, timestamp, text, integer, index } from 'drizzle-orm/pg-core';

export const requestLog = pgTable('request_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  protocol: text('protocol').notNull(),
  route: text('route').notNull(),
  backend: text('backend').notNull(),
  model: text('model').notNull(),
  status_class: text('status_class').notNull(),
  http_status: integer('http_status').notNull(),
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  ttft_ms: integer('ttft_ms'),
  latency_ms: integer('latency_ms').notNull(),
  error_code: text('error_code'),
  error_message: text('error_message'),
  agent_id: text('agent_id'),
  request_id: text('request_id').notNull(),
  upstream_message_id: text('upstream_message_id'),
}, (t) => ({
  idxTsDesc: index('idx_request_log_ts_desc').on(t.ts.desc()),
  idxAgentTs: index('idx_request_log_agent_ts').on(t.agent_id, t.ts.desc()),
  idxStatusClass: index('idx_request_log_status_class').on(t.status_class),
}));
```

### Migrator + boot wiring
```typescript
// router/src/db/migrate.ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';

export async function runMigrations(db: NodePgDatabase, log: Logger): Promise<void> {
  try {
    await migrate(db, { migrationsFolder: './db/migrations' });
    log.info({ event: 'migrate_done' }, 'migrations applied');
  } catch (err) {
    const code = (err as { code?: string }).code;
    const isConnectionError =
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      (typeof code === 'string' && code.startsWith('08'));
    if (isConnectionError) {
      log.warn({ err, event: 'migrate_postgres_unreachable' }, 'migrator: Postgres unreachable — booting without migrations');
      // /readyz will report not_ready until the postgres probe transitions to alive.
      // Operator can manually restart the router OR planner can add a retry hook.
      return;
    }
    throw err;   // schema syntax/conflict — fail loud
  }
}
```

### Restore drill script skeleton
```bash
#!/usr/bin/env bash
# bin/restore-drill.sh — DESTRUCTIVE: drops + recreates the `router` database from a pg_dump file.
# Usage: bin/restore-drill.sh <dump-filename>
#   e.g. bin/restore-drill.sh router-2026-05-14T12.dump
#
# Reads .env for POSTGRES_PASSWORD. Expects the dump under HOST_DATA_ROOT/postgres-backups/.
# Runs entirely via `docker compose exec postgres ...` — no host-side psql/pg_restore needed.

set -uo pipefail
DUMP_FILE="${1:?usage: $0 <dump-filename>}"
# ...source .env, sanity-check the dump exists, confirm with prompt unless --yes...

# Step 1: terminate active connections to the router DB
docker compose exec -T postgres psql -U postgres -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = 'router' AND pid <> pg_backend_pid();"

# Step 2: drop + recreate
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS router;"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE router OWNER app;"
docker compose exec -T postgres psql -U app -d router -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# Step 3: pg_restore from the mounted dump
docker compose exec -T postgres pg_restore --dbname=router --username=app /backups/"$DUMP_FILE"

# Step 4: sanity SELECT — exit non-zero if request_log is missing OR empty AND dump claims rows
ROWS=$(docker compose exec -T postgres psql -U app -d router -tAc "SELECT COUNT(*) FROM request_log")
echo "Restore drill: request_log row count = $ROWS"
[[ "$ROWS" =~ ^[0-9]+$ ]] || { echo "FAIL: count not numeric"; exit 1; }
echo "PASS — restore drill completed without error."
```

## State of the Art (2026)

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Redis singleton for app metadata | Postgres + Drizzle | 2023+ | Schema-first ergonomics from TS; ACID for `request_log`. |
| `fastify-metrics` auto-instrumentation | `prom-client` raw + manual instrumentation | Always when low-cardinality labels matter | `route` label is unbounded; `protocol/backend/model` is bounded. |
| `worker_threads` for I/O offload | In-process async with event-loop bookkeeping | Node 18+ | Worker_threads are for CPU offload; I/O work belongs in the main loop. |
| `pg_cron` for periodic jobs | Node setInterval (single-host) or external scheduler (multi-host) | When the app is the only postgres consumer | pg_cron extension adds image/build complexity for a function setInterval handles. |
| `postgres:15-alpine` | `postgres:17-alpine` | 2024-2025 | Per-row UPSERT performance + parallel index build. Phase 5 stays on 17 (CLAUDE.md). |
| `redis:7-alpine` for everything | `valkey/valkey:8-alpine` | License-compatibility 2024 onward | Valkey lands in Phase 8; not Phase 5's concern. |

**Deprecated/outdated:**
- prom-client default histogram buckets `[0.005..10]` — way too short for LLM completions. Override.
- Drizzle `drizzle-kit push` — fine for dev, NEVER for prod (no migration files). Use `generate` + `migrate` pair.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `drizzle-orm@^0.36` (CLAUDE.md pin) is still functionally sufficient — current latest is 0.45.2, no Phase 5 feature requires post-0.36 capabilities. | Standard Stack | Low. If wrong, planner upgrades to ^0.45 and updates CLAUDE.md alongside. Both versions support `migrate()` identically. |
| A2 | postgres:17-alpine runs postgres as uid 70 — but the docker library lists 999 in some contexts and the variant-specific uid for 17-alpine isn't pinned in the docs I read. | Pitfall 7 | Medium. Wrong uid in bootstrap chown means postgres can't write data dir on first up. **Mitigation:** plan tasks must `docker run --rm postgres:17-alpine id postgres` to nail down the answer before writing the bootstrap script. |
| A3 | Fastify v5's `req.log` reassignment in a preHandler propagates the new child logger to all subsequent `req.log.*` calls in the same request. | Pattern 3 | Medium. If propagation is broken, the `agent_id` field appears on some log lines but not others, and `request_log.agent_id` is correct but log correlation is broken. **Mitigation:** integration test that asserts `agent_id` appears on a heartbeat log line + an error log line + the final stream-done log line. |
| A4 | `connectionTimeoutMillis: 2000` is a reasonable value for the Pool on a healthy local Postgres. | Pattern 4 | Low. On a cold first-connection during a routed agent burst, 2s might briefly bounce. Operator can raise to 5s if observed. |
| A5 | `pg_dump --format=custom` produced by postgres:17-alpine's `pg_dump` is restorable by `pg_restore` from the same image version. | Code Examples / Restore drill | Low. Same-version pg_dump/pg_restore is the canonical pairing. Cross-version restore is the gotcha (out of scope for Phase 5 — Phase 9 may worry about it). |
| A6 | The CONTEXT-suggested histogram buckets (ttft `[0.05..10]s`, duration `[0.1..300]s`) cover the observed latency profile from Phases 2/3/4 smoke tests. | Pattern 5 | Low. Bucket boundaries can be tweaked without breaking the wire format; Prometheus queries continue to work. Wrong buckets just degrade quantile fidelity in one part of the distribution. |
| A7 | The user/operator runs the postgres bind-mount on a non-WSL2-Docker-Desktop filesystem (i.e., the host has stable POSIX uid semantics). | Pitfall 7 | Medium on WSL2. Docker Desktop on WSL2 has known uid-projection quirks. **Mitigation:** Pitfall 7 in this RESEARCH already calls out the bootstrap script must explicitly chown. |
| A8 | `recordRequestOutcome` called twice (Pitfall 8) creates two `request_log` rows with the same `request_id` — confirmed because D-D1's `request_id` column has no UNIQUE constraint. | Pitfall 8 | Low — by construction once `safeRecord` idempotency wrapper is added. Without the wrapper, the duplicate-row symptom is visible in `request_log` queries. |
| A9 | Multi-row INSERT via Drizzle's `.values(rows)` (where rows is an array) compiles to a single parameterized statement `INSERT INTO ... VALUES ($1,..), ($K+1,..), ...`. | Pattern 1 | Verified — this is documented Drizzle behavior in [CITED: orm.drizzle.team/docs/insert], but parameter count limits (PostgreSQL max ~65535 params per statement) constrain batch size. With ~17 columns and 200 rows = 3400 params — well under the limit. |
| A10 | Phase 5 NEVER calls `recordRequestOutcome` from a request that hits a pre-auth or skip-listed path. D-D4 codifies this. | Pattern 2 | Low — explicit in CONTEXT. Defensive: the helper should still tolerate being called for any URL (defaulting agent_id and tokens_* to null) so a future code path that wires it from `/v1/models` doesn't crash. |

**Risk that NEEDS user confirmation before plan:**
- **A1:** stick with `drizzle-orm@^0.36` (CLAUDE.md) or upgrade to `^0.45` (current)? Recommendation: stick with ^0.36 — CLAUDE.md is the contract.
- **A2:** Operator should verify `docker run --rm postgres:17-alpine id postgres` output before plan finalization. Cheap check, high cost if wrong.

## Open Questions

1. **Does the migrator retry automatically after Postgres recovers, or does the operator restart the router?**
   - What we know: D-B5 says router boots without postgres; D-B2 says migrate runs once at boot. The two are consistent only if the operator restarts the router after postgres comes up.
   - What's unclear: Is there a "retry migration on next /readyz transition to alive" hook?
   - Recommendation: Plan a periodic retry (e.g., every 60s while the postgres probe is down, attempt `migrate()` again). OR explicitly document "operator restarts router after postgres recovery" in the README and accept the manual step.

2. **`status_class` for upstream 200 + zero tokens out (model returned empty response).**
   - What we know: CONTEXT D-C4 covers 2xx → `success`, but zero tokens is a degenerate success.
   - What's unclear: Does this go in `success` (literally what HTTP says) or a new `degraded` class?
   - Recommendation: Keep `success`. The `tokens_out=0` row is itself the signal. Adding a class for it is over-engineering.

3. **`usage_daily` PK includes `agent_id` which is nullable. Does Postgres treat NULL as distinct in a composite PK?**
   - What we know: SUMMARY ¶244-245 specifies `primaryKey({ columns: [day, protocol, backend, model, agent_id] })`. Postgres treats NULL as NOT EQUAL even to itself in unique constraints — meaning two rows with `agent_id=NULL` and otherwise-identical PK columns would coexist as DUPLICATES, breaking the UPSERT idempotency.
   - What's unclear: Is the planner aware of this and planning a `COALESCE(agent_id, '')` strategy?
   - Recommendation: Use `COALESCE(agent_id, '_no_agent_')` in the aggregation INSERT/UPSERT, OR use a partial unique index, OR make `agent_id` NOT NULL with `''` default. Document the choice in PLAN.

4. **`status_class` for `BackendSaturatedError` (HTTP 429) — `client_error` per D-C4, but it's a server-saturation condition.**
   - What we know: D-C4 says 4xx → `client_error`. 429 is 4xx.
   - What's unclear: Operator monitoring `client_error` rate to detect bad agent behavior may be confused by 429s spiking when the BACKEND is overwhelmed.
   - Recommendation: Add `status_class` value `saturation` for 429, OR keep 4xx → `client_error` and rely on `error_code='backend_saturated'` for the discriminator. Plan picks; recommend the latter (simpler).

5. **Should `tokens_total` counter increment by `tokens_in + tokens_out` (one observation per request) or by direction (two observations per request)?**
   - What we know: D-C3 says label `direction ∈ {input, output}` — so two observations per request.
   - What's unclear: Some teams prefer one counter with no direction label for top-line "total token throughput" PromQL. Either works; the labelled version supports both queries via `sum by (direction)`.
   - Recommendation: Two observations, one per direction. PromQL can still do `sum(rate(router_tokens_total[5m]))` for the no-label aggregate.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker Compose v2 | `postgres` + `pg-backup` services + `required: false` in depends_on | ✓ (Phase 1 verified) | per Phase 1 | — |
| Postgres image pull access | `docker compose pull postgres` | ✓ (Docker Hub) | postgres:17-alpine | — |
| Node 22 LTS | drizzle-orm, pg, prom-client | ✓ (router image already on node:22-bookworm-slim) | per Phase 2 | — |
| `pg_isready` binary inside postgres container | healthcheck | ✓ (bundled in official image) | — | — |
| `pg_dump` / `pg_restore` binary | pg-backup sidecar + bin/restore-drill.sh | ✓ (postgres:17-alpine bundles them) | matches server 17.x | — |
| `psql` for restore drill | bin/restore-drill.sh | ✓ (`docker compose exec postgres psql ...` — no host-side install needed) | — | — |
| WSL2 with stable bind-mount semantics | `${HOST_DATA_ROOT}/postgres-data` | Likely ✓ (Phase 1 already uses bind mounts for `models-gguf`) | — | — |
| `prom-client` peer deps | npm install in router | ✓ (pure JS, no native deps) | 15.1.3 | — |

**Missing dependencies with no fallback:** None — all Phase 5 dependencies are images or npm packages already accessible.

**Missing dependencies with fallback:** None for v1 scope.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@^4.x` (already in router/package.json) |
| Config file | `router/vitest.config.ts` (existing) |
| Quick run command | `npm run test:unit` (router/) — fast unit tests only |
| Full suite command | `npm test` (router/) — unit + integration |
| Smoke harness | `bash bin/smoke-test-router.sh` — extended in Phase 5 with metrics + agent-id + pause-pg scenarios |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DATA-01 | `postgres:17-alpine` runs in Compose; two DBs (`router`, `openwebui`) exist | integration / smoke | `docker compose ps postgres` (healthy) + `docker compose exec postgres psql -U app -l \| grep -E '\bdb_(router\|openwebui)\b'` | ❌ Wave 0 — Compose service + bootstrap SQL + smoke section |
| DATA-02 | request_log populated via buffered async; flush every 1s OR 200 rows; never blocks request path | unit + smoke | Unit: `vitest run tests/unit/bufferedWriter.test.ts` (covers re-entrancy + drop-oldest + drain timeout). Smoke: `bash bin/smoke-test-router.sh --pause-pg-scenario` | ❌ Wave 0 — bufferedWriter tests + smoke section |
| DATA-03 | each request_log row has backend, protocol, model, tokens_in, tokens_out, latency_ms, ttft_ms, error, agent_id, ts | integration | `vitest run tests/integration/recordOutcome.test.ts` (round-trip: route handler → bufferedWriter → mock pg.Pool capture → assert row shape) | ❌ Wave 0 |
| DATA-04 | `usage_daily` table populated from `request_log` via daily refresh | integration | `vitest run tests/integration/usageDaily.test.ts` (insert N rows into request_log with mocked clock; call refresh fn; assert UPSERT idempotency on the (day, protocol, backend, model, agent_id) PK) | ❌ Wave 0 |
| DATA-05 | `pg_dump` cron runs daily; tested restore drill reads identical data | smoke | `bash bin/restore-drill.sh router-YYYY-MM-DDTHH.dump` — exits 0; sanity SELECT count matches pre-dump count | ❌ Wave 0 — bin/restore-drill.sh + README section |
| OBS-01 | `GET /metrics` exposes Prometheus-format request rate, TTFT, latency, per-backend counters | unit + smoke | Unit: `vitest run tests/unit/metricsRegistry.test.ts` (assert 5 custom metrics + Node defaults present in `register.metrics()` output). Smoke: `curl http://127.0.0.1:3000/metrics \| grep -E 'router_(requests_total\|ttft_seconds\|request_duration_seconds\|tokens_total\|log_buffer_dropped_total)' \| wc -l` ≥ 5 | ❌ Wave 0 |
| OBS-05 | `docker compose ps` shows healthy state for EVERY service via REAL healthchecks (not process-up) | smoke | `docker compose ps --format '{{.Name}} {{.Health}}' \| grep -v 'healthy'` returns ONLY rows for services with no healthcheck (gpu-preflight one-shot) | ❌ Wave 0 — smoke section + postgres healthcheck added |
| ROUTE-09 | `X-Agent-Id` request header is surfaced into structured logs AND `request_log.agent_id` column | unit + smoke | Unit: `vitest run tests/integration/agentIdPreHandler.test.ts` (header → req.agentId, regex violation → 400, absent → null). Smoke: `curl -H 'X-Agent-Id: claude-code:luis' ... && psql 'SELECT agent_id FROM request_log ORDER BY ts DESC LIMIT 1'` returns `'claude-code:luis'` | ❌ Wave 0 |

### Success Criteria → Distinguishing Signal Map

| SC | Distinguishing Signal | Detection |
|----|----------------------|-----------|
| SC1: dual DBs + request_log + usage_daily | `psql -U app -d postgres -c '\l'` lists `router` AND `openwebui`. `psql -U app -d router -c '\dt'` lists `request_log` AND `usage_daily`. | smoke section asserts both. |
| SC2: non-blocking buffered writes | A 5s `docker compose pause postgres` mid-stream does NOT cause the SSE deltas to pause; deltas continue arriving < 1s apart throughout the pause. After unpause, rows land in `request_log` within ~10s. | smoke pause-pg scenario; capture timestamps of curl byte arrival + Postgres rowcount before/after. |
| SC3: pg_dump cron + restore drill | Cron-equivalent runs daily (sidecar log shows hourly stamp + once-per-day rotation), dump file present at expected path. `bin/restore-drill.sh` exits 0 + row counts match pre-dump. | smoke checks file presence; restore-drill script asserts internally. |
| SC4: /metrics unauth + only-this-surface | `curl -i http://127.0.0.1:3000/metrics` returns 200 with `Content-Type: text/plain; version=0.0.4`. `curl -i http://127.0.0.1:3000/v1/chat/completions -d ...` WITHOUT bearer returns 401. | smoke section: two curls, two assertions. |
| SC5: healthchecks + X-Agent-Id round-trip | All services healthy in `docker compose ps`. A request with `X-Agent-Id: claude-code:luis` produces a pino log line containing `"agent_id":"claude-code:luis"` AND a `request_log` row with `agent_id='claude-code:luis'`. | smoke section: docker compose ps grep + curl + psql + grep. |

### Sampling Rate
- **Per task commit:** `npm run test:unit` (router/) — should run in < 10s
- **Per wave merge:** `npm test` (router/) — unit + integration with msw mocks, < 30s
- **Phase gate:** `bash bin/smoke-test-router.sh` end-to-end (requires `docker compose up` running) + manual `bin/restore-drill.sh` invocation

### Wave 0 Gaps
- [ ] `router/tests/unit/bufferedWriter.test.ts` — re-entrancy + drop-oldest + drain timeout
- [ ] `router/tests/unit/metricsRegistry.test.ts` — 5 custom metrics + Node defaults
- [ ] `router/tests/integration/agentIdPreHandler.test.ts` — header validation + log-child propagation
- [ ] `router/tests/integration/recordOutcome.test.ts` — route → bufferedWriter round-trip with mock Pool
- [ ] `router/tests/integration/usageDaily.test.ts` — refresh idempotency
- [ ] Extension of `bin/smoke-test-router.sh` — Phase 5 section (5 new scenarios)
- [ ] `bin/restore-drill.sh` — new file
- [ ] Test fixture: a mock `pg.Pool` that captures `.query()` calls for assertion (lightweight; planner picks library)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Existing bearer-token (Phase 2 `auth/bearer.ts`); Phase 5 extends skip-list with /metrics on loopback — no new auth surface. |
| V3 Session Management | no | Stateless API; no sessions. |
| V4 Access Control | yes (loopback as the access boundary) | `/metrics` is unauth ONLY because `127.0.0.1:3000` binding restricts to loopback. Phase 6 introduces external TLS termination AND must firewall `/metrics`. |
| V5 Input Validation | yes | zod for body validation (existing); regex for X-Agent-Id (Phase 5 — Pattern 3 ReDoS-safe). |
| V6 Cryptography | yes | bearer comparison uses `timingSafeEqual` (existing); Postgres password rests in `.env` with documented `chmod 600`. |
| V7 Error Handling & Logging | yes | error_message column re-redacts bearer/apiKey (D-D3); pino redact unchanged. |
| V8 Data Protection | partial | request_log persists prompts-relevant metadata (tokens, model, agent_id) but NOT the prompt body or response content. Phase 9 may add retention/TTL. |
| V10 Malicious Code | no | No remote code load. |
| V14 Configuration | yes | Docker secrets via env; no secrets in compose.yml literal; `data` network is `internal: true`. |

### Known Threat Patterns for {Node + Fastify + Postgres + prom-client}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via parameterized INSERT | Tampering | Drizzle `.values(rows)` emits parameterized SQL — never string interpolation. **Verify in code review:** every INSERT uses `.values()`, not raw template strings. |
| Bearer token leak via `request_log.error_message` | Information Disclosure | D-D3 mandates regex strip BEFORE writing; this RESEARCH Pitfall 12 codifies it. |
| `/metrics` exposed externally (post-Phase 6) | Information Disclosure | Phase 6 Traefik middleware returns 404 for external `/metrics`. **Phase 5 deliverable: flag this as a Phase 6 CRITICAL follow-up.** |
| Pool exhaustion DoS via concurrent flush + probe | Denial of Service | `flushing: boolean` lock (Pitfall 1) + `connectionTimeoutMillis: 2000` bounds connection wait. |
| Postgres-down cascading failure stalling SSE | Denial of Service (self-inflicted) | The entire D-A1..D-A7 design. SC2 smoke test is the regression gate. |
| Unbounded `request_log` growth | Resource exhaustion (eventual) | Out of Phase 5 scope per CONTEXT — Phase 9 adds partitioning. Document the deferral in the schema file comment. |
| X-Agent-Id ReDoS via maliciously long header | DoS | Regex `/^[A-Za-z0-9._:-]{1,128}$/` is anchored + bounded — no nested quantifiers — ReDoS-safe. |
| Bind-mount path traversal via crafted HOST_DATA_ROOT | Tampering | `${HOST_DATA_ROOT}` is an operator-controlled env, not user input. Out of attacker scope on a single-user host. |
| pgcrypto extension creation requires superuser | Privilege escalation | `01-init.sql` runs as `postgres` superuser (entrypoint-time only); the `app` role does NOT have CREATE EXTENSION privilege. |

## Sources

### Primary (HIGH confidence)
- `/home/luis/proyectos/local-llms/.planning/phases/05-postgres-observability-seam/05-CONTEXT.md` — locked decisions D-A1..D-G3
- `/home/luis/proyectos/local-llms/.planning/REQUIREMENTS.md` — DATA-01..05, OBS-01, OBS-05, ROUTE-09 IDs + phase mapping
- `/home/luis/proyectos/local-llms/.planning/ROADMAP.md` lines 118-129 — Phase 5 goal + 5 Success Criteria
- `/home/luis/proyectos/local-llms/CLAUDE.md` — Recommended Stack + What NOT to Use + Version Compatibility
- `/home/luis/proyectos/local-llms/compose.yml` — current Compose state; confirms loopback binding at `127.0.0.1:3000`
- `/home/luis/proyectos/local-llms/router/src/{app.ts,index.ts,auth/bearer.ts,errors/envelope.ts,sse/heartbeat.ts,backends/liveness.ts,routes/readyz.ts,routes/v1/chat-completions.ts,routes/v1/messages.ts,log/logger.ts}` — code surface to modify
- [Drizzle migrations docs](https://orm.drizzle.team/docs/migrations) — `migrate()` signature, folder layout, generate vs migrate distinction — verified 2026-05-14
- [Drizzle Kit overview](https://orm.drizzle.team/docs/kit-overview) — generate/migrate/push/pull command semantics
- [prom-client README](https://github.com/siimon/prom-client) — Registry, Counter, Histogram, collectDefaultMetrics, register.contentType
- [Postgres official Docker Hub](https://hub.docker.com/_/postgres) — `/docker-entrypoint-initdb.d/` first-init-only semantics; POSTGRES_INITDB_ARGS; Alpine variant uid notes; current minor 17.9
- [node-postgres Pool API](https://node-postgres.com/apis/pool) — `connectionTimeoutMillis` default 0; idleTimeoutMillis; statement_timeout vs connectionTimeoutMillis
- [Fastify v5 Hooks reference](https://fastify.dev/docs/v5.8.x/Reference/Hooks/) — onRequest vs preHandler order, app-level vs route-level
- npm registry (verified 2026-05-14): drizzle-orm `0.45.2`, drizzle-kit `0.31.10`, pg `8.20.0`, prom-client `15.1.3`
- `/home/luis/proyectos/local-llms/.planning/research/PITFALLS.md` — Pitfall 12 (Bearer leaks / healthcheck unauth)

### Secondary (MEDIUM confidence)
- [GitHub: prom-client issue #439 — process_cpu_user_seconds_total already registered](https://github.com/siimon/prom-client/issues/439) — verified test-isolation hazard + Registry.clear() workaround
- [GitHub: prom-client issue #196 — Hot Module Reload double-register](https://github.com/siimon/prom-client/issues/196) — same root cause
- [dev.to: Drizzle ORM Migrations in Production — Zero-Downtime](https://dev.to/whoffagents/drizzle-orm-migrations-in-production-zero-downtime-schema-changes-e71) — "crash if migrate fails" standard advice (which CONFLICTS with D-B5 — resolved in Pitfall 4)
- [Povilas Versockas — Tracking request duration with Prometheus](https://povilasv.me/prometheus-tracking-request-duration/) — SLO-based histogram bucket design
- [Last9 — Histogram Buckets in Prometheus Made Simple](https://last9.io/blog/histogram-buckets-in-prometheus/) — bucket tuning rationale

### Tertiary (LOW confidence — flag for verification)
- Alpine postgres uid: docs say "uid 70" in some places, "uid 999" in others. **Mitigation A2 in Assumptions Log:** plan tasks must run `docker run --rm postgres:17-alpine id postgres` to confirm.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version verified via npm view + cross-referenced against CLAUDE.md
- Architecture: HIGH — patterns mirror existing Phase 2/3/4 conventions (single-helper-two-routes, idempotent cleanup, public skip-list)
- Pitfalls: HIGH — every entry has a documented source URL or a verified codebase pattern reference
- Drizzle 0.36 specifics: MEDIUM — CLAUDE.md pin is 18 months old; latest (0.45) has identical `migrate()` API per current docs, but I couldn't verify 0.36-specific edge cases vs. 0.45 without installing both. Recommend planner adds an integration test that exercises a fresh `migrate()` on an empty DB.
- Bind-mount uid (Pitfall 7 / A2): LOW — needs operator confirmation

**Research date:** 2026-05-14
**Valid until:** 2026-06-13 (30 days — Drizzle, prom-client, postgres image are stable; npm and Docker Hub state could move)
