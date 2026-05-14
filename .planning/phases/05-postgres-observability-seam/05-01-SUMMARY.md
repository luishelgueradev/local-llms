---
phase: 05-postgres-observability-seam
plan: 01
subsystem: database
tags: [postgres, drizzle, pg, buffered-writer, compose, foundation, sse, observability]

# Dependency graph
requires:
  - phase: 01-gpu-compose-foundation
    provides: HOST_DATA_ROOT bind-mount layout, `data` network (internal: true), POSTGRES_PASSWORD slot in .env
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: Fastify buildApp factory + BuildAppOpts injection seam, pino redaction config, /healthz unauth pattern
  - phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
    provides: BackendSemaphore idempotent-release pattern (mirrored by bufferedWriter.drain), LivenessScheduler (interval + stopped flag pattern mirrored by bufferedWriter)
provides:
  - postgres:17-alpine service on the internal `data` network (no host port; D-E1)
  - two logical databases — `router` (used now) and `openwebui` (reserved for Phase 6)
  - pgcrypto extension installed in `router` (D-B8) for `gen_random_uuid()`
  - Drizzle schema for `request_log` (D-D1) and `usage_daily` (CONTEXT specifics §usage_daily)
  - boot-time migrator wrapper with selective warn-and-continue on connection-class errors (RESEARCH Pitfall 4)
  - shared pg.Pool factory with connectionTimeoutMillis: 2_000 (RESEARCH Pitfall 3)
  - BufferedWriter (in-process FIFO + interval flush + idempotent drain) — load-bearing for SC2
  - REQUIRED `bufferedWriter` field on BuildAppOpts wired through every existing test fixture
  - onClose hook extended with 3 s drain race (D-A4)
affects: [05-02-recordOutcome-metrics-route-call-sites, 05-03-usage-daily-pg-dump, 05-04-smoke-test-readyz-postgres-probe, 06-traefik-open-webui, 07-prometheus-grafana]

# Tech tracking
tech-stack:
  added:
    - drizzle-orm@^0.36.0 (TS-first schema + boot-time migrator)
    - drizzle-kit@^0.27.0 (drizzle-kit generate at dev time)
    - pg@^8.13 (node-postgres driver; ^8.20 resolved)
    - "@types/pg@^8.13"
    - prom-client@^15.1.3 (declared here; first consumer in 05-02)
    - pino@^10 (already transitive via fastify; imported directly for the boot logger)
  patterns:
    - "Selective try/catch on the boot migrator: warn on ECONNREFUSED/ETIMEDOUT/ENOTFOUND/08* (Postgres class), throw on schema-class errors"
    - "Bounded FIFO + flushing-lock + drop-oldest + microtask-deferred flush + Promise.race drain (mirrors safeRelease idempotency)"
    - "Factory injection via BuildAppOpts (bufferedWriter joins livenessFactory + semaphoreFactory as the third optional/required dependency injected by tests)"
    - "Standalone pino instance built from the same loggerOpts Fastify will consume — keeps level + redact config in sync between boot-time and post-buildApp logging"
    - "Sentinel `_no_agent_` default for nullable-in-PK avoidance (RESEARCH Open Question Q3 resolution for usage_daily composite PK)"

key-files:
  created:
    - postgres/initdb/01-init.sql
    - router/drizzle.config.ts
    - router/src/db/index.ts
    - router/src/db/migrate.ts
    - router/src/db/bufferedWriter.ts
    - router/src/db/schema/index.ts
    - router/src/db/schema/request_log.ts
    - router/src/db/schema/usage_daily.ts
    - router/db/migrations/0000_init.sql
    - router/db/migrations/meta/0000_snapshot.json
    - router/db/migrations/meta/_journal.json
    - router/tests/fakes.ts
    - router/tests/unit/bufferedWriter.test.ts
  modified:
    - compose.yml
    - .env.example
    - router/package.json
    - router/package-lock.json
    - router/src/config/env.ts
    - router/src/app.ts
    - router/src/index.ts
    - all 13 integration test files under router/tests/integration/ (mechanical fixup — fake bufferedWriter through buildApp opts)

key-decisions:
  - "Approach A for postgres bootstrap: POSTGRES_USER=app + POSTGRES_DB=router in compose env (entrypoint creates app role + router DB for free); 01-init.sql only creates openwebui DB and installs pgcrypto into router. No password literals in git."
  - "Drizzle config uses an explicit schema-file array (`['./src/db/schema/request_log.ts', './src/db/schema/usage_daily.ts']`) to bypass drizzle-kit's esbuild-register CJS shim mis-resolving the `.js`-extension barrel under NodeNext module resolution."
  - "BufferedWriter default capacity 10_000 (D-A1 planner discretion); MAX_BATCH_ROWS=1_000 single-statement cap to stay well below Postgres's 65_535 parameter limit (RESEARCH A9)."
  - "Boot-time pino logger constructed standalone from loggerOpts so makeBufferedWriter + runMigrations have a working logger BEFORE buildApp returns. The eventual app.log inherits the same configuration via Fastify's internal pino instantiation."
  - "droppedCounter is a STUB ({inc: () => {}}) at boot; Plan 05-02 wires the real metrics.logBufferDroppedTotal Counter."
  - "Pool released via `await pool.end()` in closeGracefully after `app.close()` — belt-and-suspenders so the process exits cleanly even on networks where idleTimeoutMillis hasn't elapsed."

patterns-established:
  - "Pattern A — Idempotent close closure: BufferedWriter.drain mirrors semaphore.ts safeRelease + heartbeat.ts stop — `stopped` flag + early return on re-entry"
  - "Pattern B — Factory injection via BuildAppOpts: every Phase 5+ dependency (bufferedWriter, metrics in 05-02) flows through BuildAppOpts so vitest fixtures inject fakes without touching the production wiring"
  - "Pattern C — Selective error reconciliation: runMigrations distinguishes connection-class (warn-and-continue) from schema-class (throw) errors per RESEARCH Pitfall 4 — the canonical resolution to the D-B5 vs. 'crash if migrate fails' contradiction"

requirements-completed: [DATA-01, DATA-02, DATA-03, DATA-04, OBS-05]

# Metrics
duration: 32min
completed: 2026-05-14
---

# Phase 5 Plan 01: Postgres Foundation + BufferedWriter Summary

**postgres:17-alpine on the internal data network with two logical databases, Drizzle 0.36 schema + generated migrations, and a load-bearing in-process bufferedWriter (re-entrancy locked, drop-oldest at 10_000, 3 s drain race) wired through BuildAppOpts to every test fixture.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-05-14T17:32:00Z (wave 1 spawn)
- **Completed:** 2026-05-14T18:04:00Z
- **Tasks:** 3 (all `type=auto` + `tdd=true`)
- **Files modified / created:** 24 (5 new under postgres/ + router/src/db/, 13 integration test fixtures updated, 6 misc)

## Accomplishments

- `docker compose config` validates with a pinned `postgres:17-alpine` service on the internal `data` network — no host port, no `:latest`, pg_isready healthcheck (10 s interval, 30 s start_period).
- Both `router` and `openwebui` databases get created on first init via `postgres/initdb/01-init.sql` (Approach A — compose entrypoint creates the app role + router DB; the SQL file only creates openwebui + installs pgcrypto into router).
- Drizzle Kit generates `router/db/migrations/0000_init.sql` containing both tables + all three baseline btree indexes (`ts DESC`, `(agent_id, ts DESC)`, `status_class`).
- Router's boot sequence now reads: `loadEnv → makePool → makeDb → runMigrations → makeBufferedWriter → buildApp → listen`. Postgres-unreachable at boot logs a single `migrate_postgres_unreachable` warn and falls through to `app.listen` (D-B5 + Pitfall 4 reconciliation, ready for /readyz wiring in 05-04).
- BufferedWriter encodes every D-A invariant + RESEARCH Pitfalls 1/3/5/8: flushing-lock, drop-oldest at 10_000, queueMicrotask-deferred 200-row flush, D-A7 retry-on-failure, 3 s drain race, idempotent post-drain push no-op.
- Unit suite (`router/tests/unit/bufferedWriter.test.ts`) covers all 7 named contracts; passes deterministically under `vi.useFakeTimers()`.
- Full `npm test`: 36 files, 423 passed + 2 skipped (was 416 passed before Plan 05-01; +7 new bufferedWriter tests). No regressions in Phase 2/3/4 suites — the BuildAppOpts widening was absorbed by the new `makeFakeBufferedWriter()` fixture (mechanical fixup mirroring the historical semaphoreFactory injection).

## Task Commits

Each task was committed atomically:

1. **Task 1 — Compose postgres service + initdb + router env/network wiring** — `09ea7f5` (feat)
2. **Task 2 — Drizzle schema + pool factory + migrator wrapper + generated 0000_init.sql** — `8e77093` (feat)
3. **Task 3 — BufferedWriter** (TDD):
   - RED: `80da473` (test) — 7 failing unit cases against the (not-yet-existing) `bufferedWriter.ts`
   - GREEN: `f6a2d33` (feat) — implementation passes all 7 cases
   - REFACTOR/wire-up: `e11f259` (feat) — BuildAppOpts gains bufferedWriter, onClose extended with drain(3_000), boot order in index.ts, fakes.ts + 13 integration fixtures updated

## Files Created/Modified

### Compose + bootstrap

- `compose.yml` — postgres service block (image `postgres:17-alpine`, data network only, pg_isready healthcheck, bind-mounted postgres-data + initdb dir); router and router-dev services gain `ROUTER_DATABASE_URL` / `OPENWEBUI_DATABASE_URL` env, `data` network, and `depends_on: postgres { required: false }`
- `postgres/initdb/01-init.sql` (NEW) — Approach A: create openwebui DB owned by app, install pgcrypto into router, grant on openwebui.public. Header documents the immutability warning (RESEARCH Pitfall 6).
- `.env.example` — single-line comment noting POSTGRES_PASSWORD seeds both databases (no new variable)

### Drizzle layer

- `router/drizzle.config.ts` (NEW) — Drizzle Kit config with explicit schema-file array
- `router/src/db/index.ts` (NEW) — `makePool` with the mandatory `connectionTimeoutMillis: 2_000` (RESEARCH Pitfall 3); `makeDb` returns a typed NodePgDatabase
- `router/src/db/migrate.ts` (NEW) — `runMigrations(db, log)` with selective try/catch (D-B5 + Pitfall 4)
- `router/src/db/schema/request_log.ts` (NEW) — D-D1 column set + 3 indexes; `RequestLogInsert` type export consumed by the BufferedWriter
- `router/src/db/schema/usage_daily.ts` (NEW) — composite PK with `_no_agent_` sentinel default (RESEARCH Open Question Q3)
- `router/src/db/schema/index.ts` (NEW) — barrel re-export
- `router/db/migrations/0000_init.sql` (NEW, generated) — both `CREATE TABLE` statements + 3 `CREATE INDEX`
- `router/db/migrations/meta/_journal.json` + `0000_snapshot.json` (NEW, generated)

### BufferedWriter

- `router/src/db/bufferedWriter.ts` (NEW) — in-process FIFO with all D-A invariants
- `router/tests/unit/bufferedWriter.test.ts` (NEW) — 7 named cases

### Boot + wiring

- `router/src/config/env.ts` — `ROUTER_DATABASE_URL: z.string().url()` added (no default)
- `router/src/app.ts` — `BuildAppOpts.bufferedWriter` REQUIRED; onClose hook extended with `await opts.bufferedWriter.drain(3_000)`
- `router/src/index.ts` — Phase 5 boot sequence (pool → migrate → bufferedWriter → buildApp); pool.end() on graceful close

### Test fixtures (mechanical)

- `router/tests/fakes.ts` (NEW) — `makeFakeBufferedWriter()` shared fake
- 13 integration test files under `router/tests/integration/` — added the import + the field in every buildApp opts object

### Dependencies

- `router/package.json` — added `drizzle-orm@^0.36.0`, `pg@^8.13.0`, `prom-client@^15.1.3` (deps); `drizzle-kit@^0.27.0`, `@types/pg@^8.13.0` (devDeps). Resolved versions: drizzle-orm 0.36.4, drizzle-kit 0.27.2, pg 8.20.0, prom-client 15.1.3, @types/pg 8.20.0.
- `router/package-lock.json` — deterministic lockfile committed

## Decisions Made

1. **Approach A bootstrap (vs. Approach B with .sh envsub).** `POSTGRES_USER=app` + `POSTGRES_DB=router` in compose env lets the official entrypoint create the role + DB with the password embedded only in the runtime env. `01-init.sql` stays pure SQL — no `.sh` wrapper, no password literals in git. Documented in the SQL file header.
2. **Drizzle 0.36 pin held** per CLAUDE.md (RESEARCH A1). Did NOT upgrade to ^0.45 — CLAUDE.md is the contract for this milestone.
3. **drizzle-kit configuration uses an explicit schema-file array** rather than a single barrel file. The barrel `index.ts` uses NodeNext-compliant `.js` import extensions; drizzle-kit's bundled esbuild-register CJS shim cannot resolve those at config-read time. The array form sidesteps the issue without touching the barrel (which the application runtime + TypeScript both want to keep).
4. **Migration filename `0000_init.sql` not `0001_init.sql`.** Drizzle Kit's numbering starts at 0000 for the first migration; the plan's files_modified list said `0001_init.sql` (off-by-one). The drizzle migrator reads the `tag` field from `_journal.json`, not the filename, so this is behaviorally identical. Documented in the Task 2 commit message.
5. **Boot-time pino logger.** `pino(loggerOpts as LoggerOptions)` is constructed BEFORE `buildApp()` so `runMigrations` and `makeBufferedWriter` have a working logger. Fastify reads the SAME `loggerOpts` internally, so the eventual `app.log` shares level + redact config.
6. **Pool released in closeGracefully** via `await pool.end()` AFTER `app.close()`. The onClose hook drains the bufferedWriter; the pool close happens in main()'s shutdown handler as belt-and-suspenders so the process exits cleanly on networks where idleTimeoutMillis hasn't yet expired.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] drizzle-kit esbuild target rejection on `es2023`**
- **Found during:** Task 2 (`npx drizzle-kit generate`)
- **Issue:** drizzle-kit bundles esbuild 0.18/0.19 which does not accept `--target=es2023` (a flag it forwards from the project's tsconfig). `npx drizzle-kit generate` exits with "Invalid target 'es2023' in '--target=es2023'" before reading any schema files.
- **Fix:** Temporarily swap `tsconfig.json` to `target: "es2022" / lib: ["es2022"]` during the generate step only, then restore the original `es2023` tsconfig. Wrapped in a single shell block so the project tsconfig is never left modified.
- **Verification:** `drizzle-kit generate` succeeds and produces `0000_init.sql`; tests + `tsc --noEmit` continue to use the project's canonical `es2023` target.
- **Committed in:** `8e77093` (Task 2 commit)

**2. [Rule 1 - Bug] drizzle-kit cannot resolve `.js`-extension imports in the barrel**
- **Found during:** Task 2 (`npx drizzle-kit generate` after the target fix above)
- **Issue:** drizzle-kit reads `schema: './src/db/schema/index.ts'` via esbuild-register's CJS shim. The barrel re-exports use `from './request_log.js'` (NodeNext-mandated for the application runtime + TS compiler); esbuild-register's CJS resolution does NOT honor TypeScript's `.js` → `.ts` mapping, so `Cannot find module './request_log.js'` aborts the generate.
- **Fix:** Changed `drizzle.config.ts` from `schema: './src/db/schema/index.ts'` to `schema: ['./src/db/schema/request_log.ts', './src/db/schema/usage_daily.ts']` — drizzle-kit accepts an array of explicit files. Barrel `index.ts` keeps the canonical `.js`-extension imports for the application runtime. No source change required.
- **Verification:** `drizzle-kit generate` produces the expected SQL with both tables + indexes; barrel remains importable by `bufferedWriter.ts` and tests under NodeNext.
- **Committed in:** `8e77093` (Task 2 commit)

**3. [Rule 2 - Missing Critical] BuildAppOpts widening breaks 13 existing integration test fixtures**
- **Found during:** Task 3 wire-up (after extending BuildAppOpts)
- **Issue:** Adding `bufferedWriter: BufferedWriter` as REQUIRED on `BuildAppOpts` makes every existing buildApp call site type-error: "Property 'bufferedWriter' is missing". This is the cascading fixup the plan flagged as "mechanical".
- **Fix:** Created `router/tests/fakes.ts` with a `makeFakeBufferedWriter()` factory (push no-op, drain resolves immediately, size always 0). Added the import + field to every integration test fixture (13 files, 24 distinct buildApp call sites).
- **Verification:** `cd router && npx tsc --noEmit` exits 0; `npm test` passes 36/36 files, 423/423 tests (was 416 before).
- **Committed in:** `e11f259` (Task 3 wire-up)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 bug, 1 missing-critical)
**Impact on plan:** All three were tooling friction inside Task 2 + the cascading fixup the plan flagged inside Task 3. No scope creep, no architectural changes.

## Issues Encountered

- **drizzle-kit toolchain friction** — covered above as Deviations 1 + 2.
- **Test-fixture injection script bug (caught + recovered).** A Python helper that walks `buildApp({...})` and injects the new field tracked braces incorrectly inside template literals containing `${...}`, mis-injecting into `concurrency.test.ts` and `messages.stream.test.ts`. Reverted those two files with `git checkout`, then injected manually via targeted Edit calls. No commits were polluted (this happened before staging). Other 11 files were correctly handled by the script.
- **No infrastructure smoke run.** Per the plan's `<verify>` block, `docker compose up postgres router` exercises the integration end-to-end. This was NOT run inside the worktree — Docker access from the agent is not guaranteed, and Plan 05-04 owns the end-to-end smoke test slice. All deterministic checks (`docker compose config`, `tsc --noEmit`, `npm test`, grep gates) pass.

## User Setup Required

None — the postgres service uses the existing `POSTGRES_PASSWORD` slot in `.env.example` (already declared in Phase 1). When the operator first runs `docker compose up postgres router`, Compose creates the bind-mount directory under `${HOST_DATA_ROOT}/postgres-data` automatically. If the WSL2 / native-Linux uid mismatch (RESEARCH Pitfall 7) bites on first up, Plan 05-04's smoke test slice documents the resolution.

## Next Phase Readiness

### Open hand-offs

- **Plan 05-02** replaces `droppedCounterStub` in `index.ts` (currently `{ inc: () => {} }`) with the real `metrics.logBufferDroppedTotal` prom-client Counter. The wiring point is a single line; the BufferedWriter contract (`droppedCounter.inc()`) already matches prom-client's API.
- **Plan 05-02** is also the consumer of `RequestLogInsert` (already exported from the schema barrel) — the route-side `recordRequestOutcome` helper will produce instances of this type and call `bufferedWriter.push(...)`.
- **Plan 05-04** owns:
  - `/readyz` postgres-pool probe + the SC2 "pause-postgres-5s-streams-keep-running" smoke test.
  - The first-time-up uid resolution doc for `${HOST_DATA_ROOT}/postgres-data` (RESEARCH Pitfall 7), if it bites.
  - The end-to-end verification of the migrate-ok / migrate-postgres-unreachable log line.

### Phase 5 SC mapping anchored

- **SC1** — Delivered end-to-end here: both DBs exist, request_log + usage_daily tables created via Drizzle migrator, pgcrypto installed.
- **SC2** — Foundation delivered: bufferedWriter contract enforced by 7 deterministic unit tests; end-to-end "pause-postgres-5s, streams keep flowing" lands in 05-04.
- **SC5** — Postgres pg_isready healthcheck added; existing ollama / llamacpp / router healthchecks unchanged per D-G1.

### TDD gate compliance

Task 3 followed the full RED → GREEN → REFACTOR cycle with distinct commits:
- RED: `80da473` (`test(05-01): add failing bufferedWriter unit suite — 7 cases for D-A1..D-A7 + Pitfalls 1/3/5/8`)
- GREEN: `f6a2d33` (`feat(05-01): bufferedWriter — in-process FIFO + interval flush + idempotent drain`)
- REFACTOR / wire-up: `e11f259` (`feat(05-01): wire bufferedWriter into BuildAppOpts + boot order + onClose drain`)

Tasks 1 and 2 were `type=auto + tdd=true` but are infrastructure-shaped — no test-first cycle applied; verification gates are the Docker / type-check / SQL artifact checks documented above.

## Self-Check: PASSED

Files verified to exist on disk:
- postgres/initdb/01-init.sql: FOUND
- router/drizzle.config.ts: FOUND
- router/src/db/index.ts: FOUND
- router/src/db/migrate.ts: FOUND
- router/src/db/bufferedWriter.ts: FOUND
- router/src/db/schema/index.ts: FOUND
- router/src/db/schema/request_log.ts: FOUND
- router/src/db/schema/usage_daily.ts: FOUND
- router/db/migrations/0000_init.sql: FOUND
- router/tests/fakes.ts: FOUND
- router/tests/unit/bufferedWriter.test.ts: FOUND

Commits verified in `git log`:
- 09ea7f5: FOUND (Task 1)
- 8e77093: FOUND (Task 2)
- 80da473: FOUND (Task 3 RED)
- f6a2d33: FOUND (Task 3 GREEN)
- e11f259: FOUND (Task 3 wire-up)

---
*Phase: 05-postgres-observability-seam*
*Completed: 2026-05-14*
