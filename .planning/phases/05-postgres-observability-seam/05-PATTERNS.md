# Phase 5: Postgres + Observability Seam — Pattern Map

**Mapped:** 2026-05-14
**Files analyzed:** 27 (19 new + 8 modified)
**Analogs found:** 25 / 27

This document maps every Phase 5 file (created or modified) to the closest existing analog in the `router/` tree and extracts the concrete code excerpts the planner should mirror. Two new files (`postgres/initdb/01-init.sql`, `router/drizzle.config.ts`) have no in-repo analog and fall back to RESEARCH.md illustrative shapes.

---

## File Classification

| File | New / Modified | Role | Data Flow | Closest Analog | Match Quality |
|------|----------------|------|-----------|----------------|---------------|
| `router/src/db/index.ts` | new | Pool + db handle factory | request-response (lazy pool) | `router/src/config/registry.ts` (`makeRegistryStore`) | role-match (factory + handle export) |
| `router/src/db/migrate.ts` | new | Boot-time effect (run-once) | one-shot transform | `router/src/index.ts` `main()` boot sequence | role-match (boot wiring with try/catch) |
| `router/src/db/schema/request_log.ts` | new | Drizzle pgTable declaration | schema declaration | `router/src/config/registry.ts` zod schema block | role-match (schema decl + type export) |
| `router/src/db/schema/usage_daily.ts` | new | Drizzle pgTable declaration | schema declaration | `router/src/config/registry.ts` zod schema block | role-match |
| `router/src/db/schema/index.ts` | new | Barrel re-export | n/a | `router/src/errors/envelope.ts` re-exports | exact (barrel pattern) |
| `router/src/db/bufferedWriter.ts` | new | In-process FIFO + interval flush + idempotent drain | event-driven (push) + batch (flush) | `router/src/backends/liveness.ts` (`makeLivenessScheduler`) + `router/src/concurrency/semaphore.ts` (idempotent release) | exact (interval + Map + idempotent stop) |
| `router/src/metrics/registry.ts` | new | prom-client Registry + metric defs (factory) | factory | `router/src/concurrency/semaphore.ts` (factory + class export) | role-match |
| `router/src/metrics/recordOutcome.ts` | new | Single-call-site lifecycle helper | event-driven (sseCleanup hook) | `router/src/concurrency/semaphore.ts` `safeRelease` closure pattern + `router/src/sse/heartbeat.ts` factory | role-match (closure factory + idempotency) |
| `router/src/middleware/agentId.ts` | new | Fastify preHandler hook | request-response | `router/src/auth/bearer.ts` (`makeBearerHook`) | exact (hook factory + module augmentation) |
| `router/db/migrations/0001_init.sql` | new | Generated SQL artifact | static asset | none (Drizzle Kit output) | no analog |
| `router/drizzle.config.ts` | new | Tool config | static config | `router/tsconfig.json` (config file at router/ root) | partial (location convention only) |
| `postgres/initdb/01-init.sql` | new | First-init SQL | first-init bootstrap | `bin/preflight-gpu.sh` (one-shot bootstrap pattern) | no analog (sql-level) |
| `bin/restore-drill.sh` | new | One-shot ops script | shell script | `bin/smoke-test-gpu.sh` + `bin/smoke-test-router.sh` | role-match (set -uo pipefail, FAILURES counter, pass/fail helpers) |
| `router/tests/unit/bufferedWriter.test.ts` | new | vitest unit | unit test | `router/tests/unit/semaphore.test.ts` + `router/tests/unit/liveness.test.ts` | exact (fake timers, idempotency, drain tests) |
| `router/tests/unit/metricsRegistry.test.ts` | new | vitest unit | unit test | `router/tests/unit/registry.test.ts` (zod schema unit) | role-match |
| `router/tests/integration/agentIdPreHandler.test.ts` | new | vitest integration via `app.inject` | request-response | `router/tests/integration/auth.test.ts` | exact (buildApp + inject) |
| `router/tests/integration/recordOutcome.test.ts` | new | vitest integration | event-driven | `router/tests/integration/auth.test.ts` + `router/tests/integration/chat-completions.nonstream.test.ts` | role-match |
| `router/tests/integration/usageDaily.test.ts` | new | vitest integration | batch / pg query | `router/tests/integration/readyz.test.ts` (fake injection) | role-match |
| `router/src/app.ts` | modified | Fastify build factory | composition | (itself — current shape is the analog) | exact (existing patterns to extend) |
| `router/src/index.ts` | modified | Boot entrypoint | composition | (itself) | exact |
| `router/src/auth/bearer.ts` | modified | onRequest hook + skip-list | request-response | (itself — one-line constant extension) | exact |
| `router/src/routes/v1/chat-completions.ts` | modified | Route handler | request-response | (itself — existing sseCleanup + finally) | exact |
| `router/src/routes/v1/messages.ts` | modified | Route handler | request-response | (itself — mirrors chat-completions) | exact |
| `router/src/routes/readyz.ts` | modified | Readiness aggregation | request-response | (itself) | exact (extend backend list with postgres probe) |
| `router/src/backends/liveness.ts` | modified | Probe scheduler | event-driven | (itself — same scheduler, new probe key) | exact |
| `compose.yml` | modified | Compose service definitions | config | (itself — `ollama:` block is the analog for `postgres:`) | exact |
| `bin/smoke-test-router.sh` | modified | E2E shell test | shell script | (itself — existing sections are the analog) | exact |

---

## Pattern Assignments

### `router/src/db/index.ts` (Pool + db handle factory)

**Analog:** `router/src/config/registry.ts` (`makeRegistryStore` factory) — same role: build a lazily-initialized handle + expose a typed accessor. Phase 5 file is even simpler (no swap/watch).

**Imports pattern** (registry.ts:1-5):

```typescript
import { readFileSync, watch as fsWatch, ... } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod/v4';
import { RegistryUnknownModelError } from '../errors/envelope.js';
```

Phase 5 equivalent (per RESEARCH.md Pattern 4, lines 380–397):

```typescript
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
```

**Factory pattern** (registry.ts:95–113 abridged):

```typescript
export function makeRegistryStore(initial: Registry): RegistryStore {
  let snapshot: Registry = initial;
  let createdAtSec = Math.floor(Date.now() / 1000);
  return {
    get(): Registry { return snapshot; },
    resolve(name: string): ModelEntry { /* ... */ },
    _swap(next: Registry): void { snapshot = next; createdAtSec = Math.floor(Date.now() / 1000); },
  };
}
```

Phase 5 equivalent — mirror the factory shape: `makePool(url) -> Pool`, `makeDb(pool) -> NodePgDatabase`. Critical knob from RESEARCH Pitfall 3: `connectionTimeoutMillis: 2_000` (NOT default `0`) to satisfy D-B5 non-blocking-on-boot.

---

### `router/src/db/migrate.ts` (boot-time migrator wrapper)

**Analog:** `router/src/index.ts` `main()` — the existing pattern for "do an effect once at boot, wrap in try/catch, log on failure, fall through".

**Boot try/catch shape** (index.ts:53–60):

```typescript
try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info({ port: env.PORT, registry_models: registry.get().models.length }, 'router listening');
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
```

**Selective-throw pattern** (matches RESEARCH Pitfall 4, lines 532–546):

```typescript
// Phase 5 migrate.ts — copy the structural pattern:
try {
  await migrate(db, { migrationsFolder: './db/migrations' });
  log.info({ event: 'migrate_ok' }, 'drizzle migrations applied');
} catch (err) {
  const code = (err as { code?: string }).code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' ||
      (typeof code === 'string' && code.startsWith('08'))) {
    log.warn({ err, event: 'migrate_postgres_unreachable' }, 'migrator: Postgres unreachable — booting without migrations');
  } else {
    throw err;   // schema-class error: fail loud, Compose restart-loops
  }
}
```

This contrasts with `index.ts:35–37`'s registry-watch `onError` which already shows the "log and continue" idiom for transient failures.

---

### `router/src/db/schema/request_log.ts` (Drizzle pgTable declaration)

**Analog:** `router/src/config/registry.ts:15–27` (the `ModelEntrySchema` zod block). Phase 5 mirrors this — a single schema declaration with column types, exported, with an inferred TS type. Drizzle's `pgTable` plays the same role as `z.object`.

**Schema declaration + type-export pattern** (registry.ts:15–27, 66):

```typescript
export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: LocalBackendEnum,
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).min(1),
  vram_budget_gb: z.number().positive(),
  // ...optional fields...
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
```

Phase 5 equivalent (CONTEXT D-D1 + RESEARCH Pattern 5):

```typescript
import { pgTable, uuid, timestamp, text, integer } from 'drizzle-orm/pg-core';

export const requestLog = pgTable('request_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  // ...full column list per D-D1...
});
export type RequestLogInsert = typeof requestLog.$inferInsert;
```

CONTEXT D-D1 (lines 87–108) is the authoritative column list — copy literally. Indexes: btree on `ts DESC`, `(agent_id, ts DESC)`, `status_class`.

---

### `router/src/db/schema/usage_daily.ts`

**Analog:** Same as request_log.ts above. CONTEXT specifics §"usage_daily shape (suggested; planner refines)" (lines 288–306) is the seed schema.

---

### `router/src/db/schema/index.ts` (barrel re-export)

**Analog:** `router/src/errors/envelope.ts:5–11`:

```typescript
export { BackendSaturatedError } from '../concurrency/semaphore.js';
import { BackendSaturatedError } from '../concurrency/semaphore.js';
export { InvalidImageUrlError, ImageFetchError } from '../translation/ollama-native-out.js';
import { InvalidImageUrlError, ImageFetchError } from '../translation/ollama-native-out.js';
```

Phase 5 equivalent: `export { requestLog } from './request_log.js'; export { usageDaily } from './usage_daily.js';`.

---

### `router/src/db/bufferedWriter.ts` (in-process FIFO + interval flush + drain)

**Analog 1 (interval + Map factory):** `router/src/backends/liveness.ts:59–133` (`makeLivenessScheduler`).
**Analog 2 (idempotent release closure):** `router/src/concurrency/semaphore.ts:46–53` (`buildRelease`).

This is the highest-stakes Phase 5 file — combines both patterns.

**Factory + setInterval + stopped flag pattern** (liveness.ts:59–95):

```typescript
export function makeLivenessScheduler(opts: MakeLivenessSchedulerOpts): LivenessScheduler {
  const intervalMs = opts.intervalMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const timers = new Map<string, NodeJS.Timeout>();
  const cache = new Map<string, ProbeResult>();
  const inFlight = new Set<string>();      // A9 overlapping-probe guard
  let stopped = false;

  const runOne = async (url: string): Promise<void> => {
    if (stopped) return;
    if (inFlight.has(url)) return;
    inFlight.add(url);
    try {
      // ... do work ...
    } finally {
      inFlight.delete(url);
    }
  };
  // ...
}
```

Phase 5 bufferedWriter maps:
- `inFlight: Set` → `flushing: boolean` (RESEARCH Pitfall 1 — re-entrancy lock)
- `stopped: boolean` → identical (drain set true, push becomes no-op)
- `timers: Map` → single `timer: NodeJS.Timeout` for the 1s interval
- `cache: Map` → `buf: Array` ring buffer

**Stop pattern** (liveness.ts:121–127) — copy verbatim semantics:

```typescript
stop() {
  if (stopped) return;          // idempotent
  stopped = true;
  for (const [, timer] of timers) clearInterval(timer);
  timers.clear();
},
```

**timer.unref pattern** — note that liveness.ts does NOT unref (the scheduler IS the lifecycle); the bufferedWriter SHOULD unref per RESEARCH Pattern 1 line 226: `timer.unref?.();` so the event loop can exit on shutdown.

**Idempotent close closure pattern** (semaphore.ts:46–53) — same shape as `safeRelease`:

```typescript
const buildRelease = (): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    this.inFlight--;
    this.drain();
  };
};
```

Phase 5's `drain(timeoutMs)` borrows this idempotency: a `stopped` boolean flag + early return.

**Drain race pattern** (RESEARCH Pattern 1 lines 240–252) — `Promise.race([flush(), setTimeout(resolve, 3000)])` for the 3s SIGTERM contract (CONTEXT D-A4).

---

### `router/src/metrics/registry.ts` (prom-client Registry + metric defs)

**Analog:** `router/src/concurrency/semaphore.ts:29–37` (factory pattern with named-export class).

Phase 5 uses a factory function rather than a class (RESEARCH Pattern 5 — fresh Registry per `buildApp` so vitest can build N apps without "metric already registered" errors). RESEARCH lines 405–449 give the literal shape to copy:

```typescript
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export function makeMetricsRegistry() {
  const register = new Registry();
  collectDefaultMetrics({ register });   // attach defaults to OUR register, not global default

  const requestsTotal = new Counter({
    name: 'router_requests_total',
    help: '...',
    labelNames: ['protocol', 'backend', 'model', 'status_class'],
    registers: [register],
  });
  // 4 more metrics per CONTEXT D-C3...
  return { register, requestsTotal, requestDurationSeconds, ttftSeconds, tokensTotal, logBufferDroppedTotal };
}
```

Labels are CONTEXT D-C3 verbatim. Buckets are CONTEXT "Claude's discretion" section recommendations:
- `router_ttft_seconds`: `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`
- `router_request_duration_seconds`: `[0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]`

---

### `router/src/metrics/recordOutcome.ts` (single-call-site lifecycle helper)

**Analog 1 (factory returning a closure):** `router/src/sse/heartbeat.ts:58+` (`makeHeartbeat` returns a handle with `.stop()`).
**Analog 2 (idempotency pattern):** `router/src/routes/v1/chat-completions.ts:156–162` (`safeRelease`).

Phase 5's `recordRequestOutcome` is a function that ENQUEUES (does not await DB) — but it must be idempotent per RESEARCH Pitfall 8.

**safeRelease pattern from chat-completions.ts:156–162** — mirror exactly for `safeRecord`:

```typescript
let released = false;
let release: () => void = () => {};
const safeRelease = (): void => {
  if (released) return;
  released = true;
  release();
};
```

Phase 5 equivalent (per RESEARCH Pitfall 8, lines 572–578):

```typescript
let recorded = false;
const safeRecord = (ctx: OutcomeContext) => {
  if (recorded) return;
  recorded = true;
  recordRequestOutcome(ctx);
};
```

The factory shape (RESEARCH Pattern 2, lines 291–331) shows `makeRecordRequestOutcome(deps) -> (ctx) -> void` — TWO effects co-located: (a) prom-client observations on the 5 metrics; (b) `bufferedWriter.push(row)` with D-D6's field-source map.

---

### `router/src/middleware/agentId.ts` (Fastify preHandler hook)

**Analog:** `router/src/auth/bearer.ts:8–57` (`makeBearerHook`) — EXACT pattern match. Both are hook factories that return a closure conforming to Fastify hook signature; both use module augmentation (declare module 'fastify') to extend FastifyRequest.

**Hook factory pattern** (bearer.ts:8–17):

```typescript
export function makeBearerHook(expectedToken: string) {
  if (!expectedToken || expectedToken.length < 8) {
    throw new Error('makeBearerHook: expectedToken must be at least 8 characters');
  }
  // ... precomputed buffers ...

  return async function bearerOnRequest(req: FastifyRequest, _reply: FastifyReply) {
    const path = (req.url.split('?')[0] ?? '/');
    if (PUBLIC_PATHS.has(path)) return;
    // ... validate ...
    if (!ok) throw new BearerAuthError('Invalid bearer token');
  };
}
```

**Skip-list / early-return pattern** — same shape Phase 5 uses (header absent → `req.agentId = undefined`, return early).

**Module augmentation pattern** (app.ts:28–34) — Phase 5 mirrors this so `req.agentId` and `req._t0` typecheck without `as any`:

```typescript
declare module 'fastify' {
  interface FastifyInstance {
    liveness: LivenessScheduler;
    semaphores: { get(backend: string): BackendSemaphore };
  }
}
```

Phase 5 equivalent (per RESEARCH Pattern 3, lines 341–346):

```typescript
declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
    _t0?: number;
  }
}
```

**Throw-to-envelope pattern** — bearer.ts:33–35 throws `BearerAuthError` and lets `app.setErrorHandler` map to envelope. Phase 5 hook similarly throws a typed error on regex violation; planner adds an `InvalidAgentIdError` class to `envelope.ts` with `code: 'invalid_agent_id'` mapped to HTTP 400 (same shape as `CapabilityNotSupportedError`, envelope.ts:47–59).

**Regex / RFC 9110 array-header pattern** — see RESEARCH Pattern 3 lines 348–366 for the exact regex `^[A-Za-z0-9._:-]{1,128}$` and the `Array.isArray(raw) ? raw[0] : raw` first-value-wins handling.

---

### `router/db/migrations/0001_init.sql` (Drizzle Kit output)

**No analog.** This file is generated by `drizzle-kit generate` — the planner runs the CLI; the SQL is reviewed and committed. CONTEXT D-B1 + D-B7 are the contract.

---

### `router/drizzle.config.ts` (Drizzle Kit config)

**Partial analog:** `router/tsconfig.json` for the at-router-root location convention. The contents are tool-config (RESEARCH Pattern §"Drizzle config hint" / CONTEXT specifics lines 333–343 are literal):

```typescript
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './db/migrations',
  dbCredentials: { url: process.env.ROUTER_DATABASE_URL! },
});
```

---

### `postgres/initdb/01-init.sql` (first-init bootstrap SQL)

**No in-repo SQL analog.** RESEARCH Pitfall 6 + CONTEXT D-B3 / D-B8 give the contract: `CREATE USER app`, `CREATE DATABASE router`, `CREATE DATABASE openwebui`, `GRANT ALL` on both, `CREATE EXTENSION IF NOT EXISTS pgcrypto`. Treat as immutable after first deploy (RESEARCH Pitfall 6). Header comment must document this (mirrors the discipline of `bin/preflight-gpu.sh` header docs).

---

### `bin/restore-drill.sh` (one-shot ops script)

**Analog:** `bin/smoke-test-router.sh:1–107` for the script header + repo-root resolution + failure-counter shape.

**Header / set / counter pattern** (smoke-test-router.sh:35–107):

```bash
#!/usr/bin/env bash
# bin/restore-drill.sh — restore drill for local-llms Phase 5
# ... header comment matching smoke-test-router.sh's header discipline ...

set -uo pipefail

# Locate repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

FAILURES=0
fail() { echo "[restore-drill] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[restore-drill] PASS: $*"; }
```

**Env-var resolution pattern** (smoke-test-router.sh:86–97) — extract a single `.env` variable without sourcing the whole file:

```bash
if [[ -z "${POSTGRES_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  POSTGRES_PASSWORD=$(
    grep -E '^POSTGRES_PASSWORD=' "${REPO_ROOT}/.env" \
      | tail -1 | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
```

CONTEXT specifics lines 287 calls for a header comment documenting the unbounded-retention deferral.

---

### `router/tests/unit/bufferedWriter.test.ts`

**Analog 1:** `router/tests/unit/liveness.test.ts:1–110` — fake-timers + interval scheduler tests.
**Analog 2:** `router/tests/unit/semaphore.test.ts:14–100` — idempotency-focused unit tests with numbered cases.

**Fake-timers boilerplate** (liveness.test.ts:43–51):

```typescript
describe('makeLivenessScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  // ...
});
```

**Idempotency test pattern** (semaphore.test.ts:79–91):

```typescript
it('6. release() is idempotent - double call does not corrupt inFlight', async () => {
  const sem = new BackendSemaphore('ollama', 2, 30_000);
  const r1 = await sem.acquire();
  await sem.acquire();
  r1(); r1();   // second call must be a no-op
  expect(sem.stats().inFlight).toBe(1);
});
```

Phase 5 tests:
- 1s flush interval (advance timers, assert insert mock called once with batched rows)
- 200-row push-triggered flush (queueMicrotask defer)
- drop-oldest at capacity 10_000 + counter increment
- drain() races against 3s timeout (drain returns; remaining rows logged)
- D-A7 flush-error: rows STAY in buffer; counter NOT incremented
- Re-entrancy lock prevents overlapping flushes (RESEARCH Pitfall 1)

---

### `router/tests/unit/metricsRegistry.test.ts`

**Analog:** `router/tests/unit/registry.test.ts:1–50` — schema-shape unit tests (Phase 5 equivalent: assert metric names, labels, default Node metrics present, fresh registry per call).

Key tests:
- `makeMetricsRegistry()` called twice must NOT throw "metric already registered" (RESEARCH Pitfall 2)
- All 5 custom metrics present with the documented labels and bucket boundaries
- `collectDefaultMetrics({ register })` attaches to OUR register, NOT global

---

### `router/tests/integration/agentIdPreHandler.test.ts`

**Analog:** `router/tests/integration/auth.test.ts:1–89` — buildApp + `app.inject({ headers: {...} })` driven assertions. Phase 5 mirrors EXACTLY this shape.

**Build-and-inject pattern** (auth.test.ts:21–33, 36–44):

```typescript
beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'router-auth-it-'));
  writeFileSync(join(tmpDir, 'models.yaml'), YAML);
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({ registry, bearerToken: TOKEN, loggerOpts: false as never });
});
afterEach(async () => { await app.close(); rmSync(tmpDir, { recursive: true, force: true }); });

it('GET /healthz returns 200 with NO Authorization header', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
});
```

Phase 5 cases:
- absent X-Agent-Id → 200, `agentId` undefined on req (probe via a test route or log capture)
- valid X-Agent-Id → 200, `req.agentId === value`, pino child carries `agent_id`
- regex violation → 400 with `code: 'invalid_agent_id'`
- duplicate header (array) → first value wins (RFC 9110)
- ReDoS / 129-char string → 400

---

### `router/tests/integration/recordOutcome.test.ts`

**Analog 1:** `router/tests/integration/auth.test.ts` (buildApp inject).
**Analog 2:** `router/tests/integration/chat-completions.nonstream.test.ts` (route-driven assertion against `app.inject` with body).

Phase 5 must inject a fake `bufferedWriter` (per RESEARCH Pattern 5 — fresh registry per buildApp). The pattern of injecting fakes via buildApp opts is established in `readyz.test.ts:49–63` (`livenessFactory`) and `app.ts:51` (the existing factory injection seams).

**Fake-injection pattern from readyz.test.ts:49–63:**

```typescript
function makeFakeScheduler(results: Map<string, ProbeResult | undefined>): LivenessScheduler {
  return {
    get: (url: string) => results.get(url),
    urls: () => Array.from(results.keys()),
    start: () => {}, stop: () => {}, refresh: async () => {},
  };
}
```

Phase 5: introduce `bufferedWriterFactory?` and `metricsFactory?` opts on `BuildAppOpts`, mirroring `livenessFactory` (app.ts:51) and `semaphoreFactory` (app.ts:58). Tests inject a fake with `push: vi.fn()`.

---

### `router/tests/integration/usageDaily.test.ts`

**Analog:** `router/tests/integration/readyz.test.ts` (full app + injection). Phase 5 needs either a real Postgres (testcontainers) or a fake `db` handle — planner-discretion. Recommend gating with `PG_TESTS=1` env (consistent with `hotreload.test.ts` env-gating pattern in the integration suite).

---

## Modifications to Existing Files

### `router/src/app.ts` — register preHandler + /metrics + onClose drain

**Existing hook registration** (app.ts:87, 202–206):

```typescript
app.addHook('onRequest', makeBearerHook(opts.bearerToken));
// ...
app.addHook('onClose', async () => {
  liveness.stop();
  probeAdapters.clear();
  semaphoreMap.clear();
});
```

Phase 5 additions (mirror exactly):

```typescript
// AFTER the bearer onRequest hook, BEFORE registerHealthz:
app.addHook('preHandler', agentIdPreHandler);

// Extend the existing onClose hook (add ONE line):
app.addHook('onClose', async () => {
  liveness.stop();
  probeAdapters.clear();
  semaphoreMap.clear();
  await opts.bufferedWriter.drain(3_000);   // D-A4 3s drain race
});

// In the Routes section, after registerReadyz(...):
app.get('/metrics', async (_req, reply) => {
  void reply.type(opts.metrics.register.contentType);
  return opts.metrics.register.metrics();
});
```

Extend `BuildAppOpts` mirroring the existing `livenessFactory` / `semaphoreFactory` (app.ts:51, 58) so vitest can inject fakes:

```typescript
export interface BuildAppOpts {
  // ... existing fields ...
  bufferedWriter: { push(row: RequestLogInsert): void; drain(ms: number): Promise<void>; };
  metrics: ReturnType<typeof makeMetricsRegistry>;
  agentIdPreHandler?: preHandlerAsyncHookHandler;  // optional override for tests
}
```

### `router/src/index.ts` — pool/migrator/bufferedWriter wiring

**Existing boot sequence** (index.ts:6–15):

```typescript
async function main(): Promise<void> {
  const env = loadEnv();
  const loggerOpts = makeLoggerOptions({ level: env.LOG_LEVEL, isDev: env.NODE_ENV !== 'production' });
  const initialRegistry = loadRegistryFromFile(env.MODELS_YAML_PATH);
  const registry = makeRegistryStore(initialRegistry);
  const app = await buildApp({ registry, bearerToken: env.ROUTER_BEARER_TOKEN, loggerOpts });
  // ...
}
```

Phase 5 insertion (BEFORE buildApp call) — order matters per CONTEXT D-B5:

```typescript
const pool = makePool(env.ROUTER_DATABASE_URL);
const db = makeDb(pool);
await runMigrations(db, app.log);   // try/catch warn-and-continue on ECONNREFUSED (Pitfall 4)
const metrics = makeMetricsRegistry();
const bufferedWriter = makeBufferedWriter({ db, droppedCounter: metrics.logBufferDroppedTotal, logger: app.log });

const app = await buildApp({ registry, bearerToken: env.ROUTER_BEARER_TOKEN, loggerOpts, bufferedWriter, metrics });
```

Env var contract: add `ROUTER_DATABASE_URL` to `EnvSchema` in `config/env.ts:3–10` mirroring the existing `OLLAMA_URL` slot.

### `router/src/auth/bearer.ts` — extend skip-list with /metrics

**Existing constant** (bearer.ts:6):

```typescript
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);
```

Phase 5 change — one literal:

```typescript
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);
// TODO Phase 6: Traefik MUST add a middleware returning 404 for external /metrics requests
// (CONTEXT.md D-C5, deferred ideas, RESEARCH Pitfall 11). Currently safe because router
// binds 127.0.0.1:3000 (compose.yml line 224). Phase 6 removes that binding.
```

### `router/src/routes/v1/chat-completions.ts` + `messages.ts` — recordRequestOutcome calls

**Existing sseCleanup** (chat-completions.ts:201–205):

```typescript
const sseCleanup = (): void => {
  heartbeat.stop();
  req.raw.socket?.off('close', onClose);
  safeRelease();
};
```

Phase 5 addition — INSIDE sseCleanup AND in the non-stream finally, BOTH routes. Mirrors the safeRelease idempotency pattern (Pitfall 8):

```typescript
const safeRecord = makeSafeRecord();   // factored once at top of handler
const sseCleanup = (): void => {
  heartbeat.stop();
  req.raw.socket?.off('close', onClose);
  safeRelease();
  safeRecord({
    protocol: 'openai',
    route: req.url,
    backend: entry.backend,
    model: entry.name,
    statusClass: deriveStatusClass(reply.statusCode, controller.signal.aborted),
    httpStatus: reply.statusCode,
    durationMs: performance.now() - (req._t0 ?? performance.now()),
    ttftMs: heartbeat.msSinceStart,
    tokensIn, tokensOut, // aggregated from canonical events
    agentId: req.agentId,
    requestId: req.id,
    timestamp: new Date(),
  });
};
```

The non-stream `finally` block (chat-completions.ts:260–265) gets the same safeRecord call with `ttftMs: undefined`. Both routes need `req._t0` captured in the agentId preHandler.

Apply identically to messages.ts:234–256 (the existing sseCleanup) with `protocol: 'anthropic'` and `upstreamMessageId: canonical._upstream_message_id`.

### `router/src/routes/readyz.ts` — postgres pool probe

**Existing aggregation** (readyz.ts:32–66) iterates `distinctUrls` from the registry. Phase 5 extends:

```typescript
// AFTER the backends-map block, BEFORE the allAlive computation:
const pgProbe = liveness.get('postgres://pool');   // new probe key — see liveness.ts change below
const allAlive = backends.length > 0 && backends.every((b) => b.status === 'alive')
                  && pgProbe?.status === 'alive';
reply.code(allAlive ? 200 : 503);

return {
  status: allAlive ? 'ready' : 'not_ready',
  checked_at: new Date(now).toISOString(),
  backends,
  postgres: pgProbe ? { status: pgProbe.status, last_probe_at: pgProbe.lastProbeAt, latency_ms: pgProbe.latencyMs } : { status: 'down', error: 'never probed' },
};
```

### `router/src/backends/liveness.ts` — add postgres probe key

The scheduler is already generic (`probe(url, signal)` per liveness.ts:54). Phase 5 reuses it without modifying internals. In `app.ts` boot:

```typescript
// In app.ts after liveness.start(distinctUrls), ALSO register:
const pgProbe = async (_url: string, _signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
  const t0 = performance.now();
  try {
    await Promise.race([
      opts.pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg-probe-timeout')), 1_000)),
    ]);
    return { ok: true, latencyMs: performance.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: performance.now() - t0, error: (err as Error).message };
  }
};
// Then either (a) wire a separate scheduler for pg, or (b) extend schedulerOpts.probe to dispatch by URL prefix.
// Recommend (b) — single scheduler, one probe function that branches on url === 'postgres://pool'.
```

This is the only Phase 5 file where the existing module needs a small structural extension; planner decides between options (a) and (b).

### `compose.yml` — postgres service + optional pg-backup + router updates

**Analog for the new postgres service:** the existing `ollama` service block (compose.yml:88–161) — same shape: pinned image tag, `container_name`, `restart: unless-stopped`, networks list, volumes (bind mount + initdb mount), healthcheck with CMD-SHELL + interval/timeout/start_period/retries, no host port published.

**Existing healthcheck pattern** (compose.yml:145–156):

```yaml
healthcheck:
  test: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || exit 1"]
  interval: 10s
  timeout: 3s
  start_period: 30s
  retries: 5
```

Phase 5 postgres healthcheck (CONTEXT D-E2):

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U app -d router -h 127.0.0.1 || exit 1"]
  interval: 10s
  timeout: 3s
  start_period: 30s
  retries: 5
```

**Existing depends_on with `required: false`** (compose.yml:241–247):

```yaml
depends_on:
  ollama:
    condition: service_healthy
    required: false      # Compose >= 2.20.2
```

Phase 5 adds postgres entry under the router's `depends_on` with the SAME `required: false` pattern — mirrors CONTEXT D-E4.

**Router env additions** — append to compose.yml router `environment:` block (around line 216–221):

```yaml
- ROUTER_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/router
- OPENWEBUI_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui
```

Networks: add `data` to router's networks list (currently `app` + `backend` only at compose.yml:225–227).

**Full postgres service + sidecar shape** is given in RESEARCH lines 608–660 — copy literally; image is `postgres:17-alpine` (CLAUDE.md pin).

### `bin/smoke-test-router.sh` — append Phase 5 section

**Analog:** the existing SC4 / SC1 / SC2 sections (smoke-test-router.sh:143–195) — same `pass`/`fail` discipline, same `curl -fsS ... | python3 -c '...'` chain pattern.

**Existing assertion shape** (lines 145–153):

```bash
echo "[smoke-test-router] SC4 (auth half): /healthz unauth + 401 on /v1/* missing bearer..."
HEALTHZ_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${ROUTER_URL}/healthz" || true)
[[ "${HEALTHZ_CODE}" == "200" ]] && pass "GET /healthz unauth -> 200" || fail "GET /healthz unauth -> ${HEALTHZ_CODE} (expected 200)"
```

Phase 5 new scenarios (CONTEXT specifics + code_context line 260):
1. `GET /metrics` unauth returns 200 + has `router_requests_total` line (no bearer)
2. X-Agent-Id round-trip: request with `X-Agent-Id: claude-code:luis@desktop`, then `psql -c "SELECT agent_id FROM request_log ORDER BY ts DESC LIMIT 1"` matches
3. SC2 pause-postgres-5s-stream-keeps-running (CONTEXT specifics lines 324–332 is literal)
4. request_log row-count assertion after N completed requests
5. /readyz returns 503 when postgres paused, 200 within ~5s after unpause

### `.env.example` — comment about POSTGRES_PASSWORD

The existing slot at line ~33–37 (already declared in Phase 1). Phase 5 adds a comment that POSTGRES_PASSWORD seeds BOTH router and openwebui DBs — see CONTEXT D-B6. No new variable.

### `router/package.json` — add deps

Existing pattern at package.json:21–32 (dependencies block) — alphabetically sorted with caret ranges. Add:
- `dependencies`: `drizzle-orm@^0.36`, `pg@^8.13`, `prom-client@^15`
- `devDependencies`: `drizzle-kit@^0.27`, `@types/pg@^8.13`

Run `npm install` per RESEARCH lines 64–68; commit `package-lock.json`.

### `README.md` — Phase 5 operational section

No close analog in-repo (README is the analog of itself). Use CONTEXT specifics lines 308–323 as the literal seed: pg_dump cmd, restore drill cmd, X-Agent-Id curl, `/metrics` curl, sample `request_log` queries.

---

## Shared Patterns

### Shared Pattern A — Idempotent close closure

**Source:** `router/src/concurrency/semaphore.ts:46–53` (`buildRelease`), `router/src/routes/v1/chat-completions.ts:156–162` (`safeRelease`), `router/src/sse/heartbeat.ts:58+` (`.stop()` idempotent).

**Apply to:**
- `bufferedWriter.drain()` — re-call must be no-op
- `recordRequestOutcome` wrapped as `safeRecord` (Pitfall 8)
- pg pool close on app.onClose

**Pattern verbatim:**

```typescript
let done = false;
const safeX = (): void => {
  if (done) return;
  done = true;
  doX();
};
```

### Shared Pattern B — Factory injection via BuildAppOpts

**Source:** `router/src/app.ts:36–67` — `livenessFactory`, `semaphoreFactory`, `makeAdapter`, `semaphores` are all overridable for tests.

**Apply to:** every new Phase 5 dependency — pass `bufferedWriter` and `metrics` (or factories) through `BuildAppOpts` so vitest fixtures inject fakes without touching the production wiring. Pattern verbatim from app.ts:51–66.

### Shared Pattern C — Module augmentation for request decorations

**Source:** `router/src/app.ts:28–34` (FastifyInstance augmentation for `liveness`, `semaphores`).

**Apply to:** `router/src/middleware/agentId.ts` for `FastifyRequest` (add `agentId?: string`, `_t0?: number`).

### Shared Pattern D — Pino redaction + bearer-token discipline

**Source:** `router/src/log/logger.ts:10–24` — `redact: { paths: [...], censor: '[REDACTED]' }`.

**Apply to:** Phase 5 must NOT add a redacted field for `agent_id` (CONTEXT D-D5: it's a PUBLIC identifier). But the bufferedWriter's `error_message` field MUST be re-redacted via a regex strip (CONTEXT D-D3 / RESEARCH Pitfall 12) before write — pino's redact doesn't cover DB writes.

### Shared Pattern E — Typed error class + envelope mapping

**Source:** `router/src/errors/envelope.ts:47–59` (`CapabilityNotSupportedError`) — class with `readonly code: string`, `instanceof` check in `mapToHttpStatus`, branch in both `toOpenAIErrorEnvelope` + `toAnthropicErrorEnvelope`.

**Apply to:** Phase 5 adds `InvalidAgentIdError` for the regex-violation case. Same shape as `CapabilityNotSupportedError`, maps to 400 + `invalid_request_error` + `code: 'invalid_agent_id'` on both wire surfaces.

### Shared Pattern F — Public skip-list extension

**Source:** `router/src/auth/bearer.ts:6` — `PUBLIC_PATHS: ReadonlySet<string>`.

**Apply to:** add `/metrics` to the set (one literal edit). This is the third public path; the test in `auth.test.ts:36–52` already proves the skip-list pattern works — Phase 5 adds matching cases for `/metrics`.

### Shared Pattern G — set -uo pipefail + FAILURES counter shell idiom

**Source:** `bin/smoke-test-router.sh:35`, `bin/smoke-test-gpu.sh`, `bin/preflight-gpu.sh:45`.

**Apply to:** `bin/restore-drill.sh` and the Phase 5 appended sections of `bin/smoke-test-router.sh`. Use `set -uo pipefail` (NOT `set -e` — per `preflight-gpu.sh:44–45` rationale: run all checks, track failures via counter).

---

## No Analog Found

| File | Role | Why no analog |
|------|------|---------------|
| `router/db/migrations/0001_init.sql` | Generated SQL artifact | Drizzle Kit output — produced by CLI from the TS schema. Planner runs `drizzle-kit generate`; the SQL is reviewed + committed. |
| `postgres/initdb/01-init.sql` | First-init bootstrap SQL | No `.sql` files exist in the repo today. CONTEXT D-B3 + D-B8 + RESEARCH Pitfall 6 are the contract. |

For both, RESEARCH.md provides illustrative shapes; the planner writes them by following the cited CONTEXT decisions verbatim.

---

## Metadata

**Analog search scope:** `router/src/`, `router/tests/`, `bin/`, `compose.yml`, `router/package.json`, `router/tsconfig.json`, `.env.example`.

**Files scanned:** 27 router source files + 32 router test files + 5 shell scripts + 4 root config files.

**Pattern extraction date:** 2026-05-14.

**Cross-reference anchors used:**
- CONTEXT D-A1..D-G3 (locked decisions)
- RESEARCH §"Architecture Patterns" (Patterns 1–6) and §"Common Pitfalls" (Pitfalls 1–12)
- CLAUDE.md Recommended Stack pins (drizzle-orm@^0.36, pg@^8.13, prom-client@^15, postgres:17-alpine, fastify@^5.8.5)
