---
phase: 17
plan: 07
subsystem: providers/composition + observability + docs + state-wrap
tags: [phase-shipped, production-composition, pitfall-17e, smoke-session, deploy-docs, readme-docs, q5-follower, idempotency-seam, sess-01, sess-02, sess-03, sess-04, sess-05, sess-06, ctxp-01, ctxp-02, ctxp-03, ctxp-04, sump-01, sump-02, sump-03]
requires:
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-06-SUMMARY.md
  - router/src/providers/postgres-session-store.ts
  - router/src/providers/context-provider.ts
  - router/src/providers/summary-provider.ts
  - router/src/middleware/sessionId.ts
  - router/src/routes/v1/helpers/session-attach.ts
provides:
  - "Production composition root: `router/src/index.ts` constructs `PostgresSessionStore` from the live Drizzle `db` handle (Pitfall 17-A — single pg.Pool reused) + `DefaultContextProvider` (stateless singleton) + `NoopSummaryProvider` and threads all three through `buildApp({ ... })`."
  - "Pitfall 17-E observability: new Prometheus Counter `router_session_append_failed_total{reason}` with bounded `reason` label (timeout | error); force-initialized via `.labels(...).inc(0)` so both series appear in `/metrics` on cold boot. POL-06 cardinality invariant preserved (no `_id` labels)."
  - "PostgresSessionStore counter wiring: 1s-timeout fail-open site (warn log + `inc({reason:'timeout'})`) and new `appendTurnTxWithCounter` wrapper that catches non-business throws (excludes the 3 business errors) and `inc({reason:'error'})` before re-throwing."
  - "Smoke test SESSION section: `bin/smoke-test-router.sh` lines 2290–2410 — 6 PASS gates between RESS and final-summary banner. Uses canonical `pass`/`fail` helpers (no inline echo)."
  - "DEPLOY.md operator docs: `SESSION_TTL_DAYS` env, `ctx_size`/`context_strategy` per-entry fields, hot-edit recipe, `X-Session-ID` lifecycle, Prometheus signal, verification matrix."
  - "README.md consumer docs: `X-Session-ID` how-it-works, 2-turn curl example, mandatory `X-Agent-Id` pairing, stateless default, strategic-frame citation."
  - "BuildAppOpts.idempotency? test seam (NEW): production wiring never passes it; the existing valkey-driven multiplexer construction is unchanged for prod. Tests inject a hand-rolled multiplexer to deterministically exercise the follower replay path."
  - "Q5 follower gate test FLIPPED: the Wave-0 / 17-06-deferred it.todo is now a real `it()` that asserts `appendCalls.length === 0` AND `spy.calls.length === 0` for the follower path — end-to-end binding of the 6-site `idempotencyRole !== 'follower'` source guard."
  - "Pre-existing `tests/fakes.ts:184` TS2345 cleaned up via type-predicate filter (Rule-1 hygiene) — Phase 17 ends with `tsc --noEmit` exit 0."
  - "Phase 17 SHIPPED: 4/6 phases of v0.11.0 milestone complete + 30/48 requirements (POL × 6 + MCPS × 6 + RESS × 5 + SESS × 6 + CTXP × 4 + SUMP × 3)."
affects:
  - 18-PLAN.md (Phase 18 — MCP Client + RetrieverProvider + Pre-Completion Hook) — depends on Phase 15 + Phase 17; both now SHIPPED. Phase 18 is unblocked.
  - Operator action: live tunnel rebuild via `docker compose up -d --build --force-recreate router` (tracked in deferred-items.md and STATE.md Active Todos).
tech-stack:
  added: []
  patterns:
    - "Production composition root threads 3 Phase 17 providers through buildApp — same shape as the Phase 14/15/16 composition wires (registry/bufferedWriter/metrics/valkey/pool/cloudApiKey/env-Pick). Single env var (`SESSION_TTL_DAYS`) gates per-session TTL; all other knobs live in models.yaml per-entry (`ctx_size`, `context_strategy`)."
    - "Pitfall 17-E counter: prom-client's `Counter.inc(labels, 0)` is a no-op (does NOT register the child series). The canonical idiom to make the series appear in `/metrics` on cold boot is `.labels({...}).inc(0)` — applied here for both timeout + error reasons so operators always see the series exist even with zero events. Pattern reusable for any future fail-open counter."
    - "BuildAppOpts test seam pattern: production wiring never passes `opts.idempotency`; the internal `if (!idempotency && opts.valkey)` branch is the canonical signal. Tests opt-in by injecting a hand-rolled multiplexer. Mirrors the existing `breakerNow` / `rateLimitNow` clock-injection seam shape from Plan 08-04 / 08-06."
key-files:
  created:
    - .planning/phases/17-sessionstore-contextprovider-summaryprovider/deferred-items.md
  modified:
    - router/src/index.ts (+20 LOC — provider construction + threading through buildApp)
    - router/src/metrics/registry.ts (+30 LOC — new Counter declaration + force-init)
    - router/src/providers/postgres-session-store.ts (+45 / -2 LOC — counter wiring at 2 sites)
    - router/src/app.ts (+18 LOC — BuildAppOpts.idempotency? test seam + bypass logic)
    - router/tests/fakes.ts (+7 / -3 LOC — type-predicate filter narrowing)
    - router/tests/routes/session-attach.integration.test.ts (+100 / -8 LOC — Q5 follower flipped)
    - bin/smoke-test-router.sh (+150 LOC — Phase 17 SESSION section)
    - DEPLOY.md (+95 LOC — Sessions + ContextProvider section)
    - README.md (+57 LOC — Sessions / X-Session-ID consumer section)
    - .planning/STATE.md (Phase 17 SHIPPED — 4/6 phases + 30/48 requirements)
    - .planning/ROADMAP.md (Phase 17 marked complete + 7/7 plans + ✅ 2026-06-01)
    - .planning/REQUIREMENTS.md (footer timestamp + coverage breakdown)
key-decisions:
  - "Force-init the new counter via `.labels({...}).inc(0)` not `inc(labels, 0)`. The latter is a no-op in prom-client (verified at module load — the child counter never gets created, so the series doesn't appear in `/metrics` until the first real increment). The lazy-create idiom via `.labels(...)` is the only way to pre-warm both reason values so smoke gate 5 ('Prometheus counter present in /metrics on cold boot') passes deterministically. W5 mitigation from the plan-checker (2026-05-31)."
  - "`appendTurnTxWithCounter` is a thin wrapper around the original `appendTurnTx` that explicitly EXCLUDES the 3 business error classes (`SessionNotFoundError`, `SessionExpiredError`, `SessionAgentMismatchError`) from the `{reason:'error'}` increment. Rationale: business errors are caller bugs / expired sessions / cross-tenant mismatches that the route handler maps to structured HTTP responses — they are NOT fail-open events. Operators care about the counter as a 'DB is unhealthy' signal; conflating it with cross-tenant mismatches would dilute the alerting value. The 4th business error (`InvalidSessionIdError`) is thrown by the preHandler BEFORE the route reaches appendTurn, so it never gets here."
  - "`BuildAppOpts.idempotency?` is a TEST seam, not a production hot-swap. Production wiring NEVER passes it; the existing `opts.valkey`-driven construction in `buildApp` is the canonical production path. This seam exists solely so the Q5 follower gate test can inject a deterministic multiplexer that returns `role:'follower'` on `acquire()` without spinning up a full Valkey-backed pub/sub fixture. The valkey-mock pattern from `tests/routes/idempotency-integration.test.ts` works for the wire-protocol tests but is unnecessary overhead for the simple leader/follower discriminator check the Q5 test needs."
  - "`tests/fakes.ts:184` Rule-1 cleanup: narrow the filter callback with a type predicate `(b: { type?: string; text?: string }): b is { type: 'text'; text: string }` so map sees the text-block shape. Plan 17-06's SUMMARY documented this as pre-existing and flagged Plan 17-07 as the natural cleanup boundary. Done here as a finish-line hygiene step — Phase 17 ends with zero `tsc --noEmit` diagnostics across the entire router source tree."
  - "Sentinel-echo smoke check uses a Spanish multi-segment sentinel `jorgüez-42-omega` because (a) it can't possibly appear in pre-training data, (b) the umlaut + hyphen segments resist trivial tokenization, and (c) the soft-WARN PASS path (instead of FAIL) is appropriate because small local models like qwen2.5:7b may rephrase rather than echo. The structural injection is verified separately by integration tests under `tests/routes/session-attach.integration.test.ts` SC-1 family (9 cases) — the smoke is a real-world sanity gate, not a unit assertion. W6 mitigation from the plan-checker (2026-05-31)."
requirements-completed: [SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06, CTXP-01, CTXP-02, CTXP-03, CTXP-04, SUMP-01, SUMP-02, SUMP-03]
duration: ~15m
completed: 2026-06-01T04:10:00Z
tasks_completed: 3
files_created: 1
files_modified: 12
---

# Phase 17 Plan 17-07: Production Composition + Pitfall 17-E Counter + Smoke + Docs + Wrap-up — Summary

**One-liner:** Phase 17 SHIPPED — `router/src/index.ts` now constructs `PostgresSessionStore` + `DefaultContextProvider` + `NoopSummaryProvider` from `env.SESSION_TTL_DAYS` and threads them through `buildApp`; new Prometheus Counter `router_session_append_failed_total{reason}` ships with force-init for both label combos so it appears in `/metrics` on cold boot; smoke section ships 6 PASS gates; DEPLOY/README documented; the Wave-0 Q5 follower gate it.todo is flipped to a real `it()` via a new `BuildAppOpts.idempotency?` test seam — Phase 17's 13 requirements (SESS × 6 + CTXP × 4 + SUMP × 3) are closed at provider + route + production composition layers.

## Performance

- **Duration:** ~15 minutes (3 tasks, fully autonomous; no checkpoints)
- **Started:** 2026-06-01T03:54:42Z
- **Completed:** 2026-06-01T04:10:00Z (approx)
- **Tasks:** 3 (Task 1 production wire + counter, Task 2 smoke + docs + Q5 seam + flip, Task 3 STATE/ROADMAP/REQUIREMENTS wrap-up)
- **Files created:** 1 (`deferred-items.md`)
- **Files modified:** 12 (router source + tests + docs + state)

## Task Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Production composition + Pitfall 17-E counter + tsc cleanup | `22609aa` (feat) |
| 2 | Smoke SESSION section + DEPLOY/README + Q5 follower test + idempotency seam | `a99c7dc` (feat) |
| 3 | STATE/ROADMAP/REQUIREMENTS wrap-up + SUMMARY + deferred-items + final commit | (pending — this commit) |

## Files

| File | Created/Modified | LOC delta |
|------|------------------|-----------|
| `router/src/index.ts` | Modified | +20 / -0 |
| `router/src/metrics/registry.ts` | Modified | +30 / -0 |
| `router/src/providers/postgres-session-store.ts` | Modified | +45 / -2 |
| `router/src/app.ts` | Modified | +18 / -2 |
| `router/tests/fakes.ts` | Modified | +7 / -3 |
| `router/tests/routes/session-attach.integration.test.ts` | Modified | +100 / -8 |
| `bin/smoke-test-router.sh` | Modified | +150 / -1 |
| `DEPLOY.md` | Modified | +95 / -0 |
| `README.md` | Modified | +57 / -0 |
| `.planning/STATE.md` | Modified | (frontmatter + lead + status + progress + decisions + todos + last-session) |
| `.planning/ROADMAP.md` | Modified | (Phase 17 [x] + Plans 7/7 + 17-07 entry + Progress row Complete) |
| `.planning/REQUIREMENTS.md` | Modified | (Coverage breakdown + footer timestamp) |
| `.planning/phases/17-sessionstore-contextprovider-summaryprovider/deferred-items.md` | Created | +57 |

Total: 12 modified + 1 created; +579 / -16.

## router/src/index.ts diff snippet (the 3-provider composition + buildApp call)

```ts
// Phase 17 (v0.11.0 — SESS-01 / CTXP-01 / SUMP-02): production-wired providers.
import { PostgresSessionStore } from './providers/postgres-session-store.js';
import { DefaultContextProvider } from './providers/context-provider.js';
import { NoopSummaryProvider } from './providers/summary-provider.js';

// ... existing pool / db / valkey / metrics setup ...

const registry = makeRegistryStore(initialRegistry);

// Phase 17 (v0.11.0 — SESS-01 / CTXP-01 / SUMP-02): production-wired providers.
// PostgresSessionStore consumes the same Drizzle `db` handle already used by
// request_log + bufferedWriter (Pitfall 17-A: single pg.Pool — never construct
// a second handle). DefaultContextProvider is stateless so we use the exported
// singleton; NoopSummaryProvider is the Frame-03 default (never calls a model).
// metricsRegistry threads the Pitfall 17-E counter so fail-open events show up
// in `/metrics` as `router_session_append_failed_total{reason}`.
const sessionStore = new PostgresSessionStore(db, {
  defaultTtlSec: env.SESSION_TTL_DAYS * 86400,
  appendTimeoutMs: 1000,
  logger: bootLog,
  metricsRegistry: metrics,
});
const contextProvider = DefaultContextProvider;
const summaryProvider = new NoopSummaryProvider();
bootLog.info(
  { defaultTtlDays: env.SESSION_TTL_DAYS },
  'Phase 17 providers initialized — sessionStore + contextProvider (DefaultSlidingWindow) + summaryProvider (Noop)',
);

const app = await buildApp({
  registry,
  bearerToken: env.ROUTER_BEARER_TOKEN,
  loggerOpts,
  bufferedWriter,
  metrics,
  usageDailyScheduler,
  pool,
  valkey,
  sessionStore,
  contextProvider,
  summaryProvider,
  // ... existing opts ...
});
```

## routerSessionAppendFailedTotal counter declaration

`router/src/metrics/registry.ts`:
- Line 152–157: Counter declaration with `labelNames: ['reason'] as const` (POL-06 — no `_id` label).
- Line 165–166: force-init via `.labels({ reason: 'timeout' }).inc(0)` + `.labels({ reason: 'error' }).inc(0)` (W5 mitigation).
- Line 181: exported from the registry shape.

## PostgresSessionStore counter wiring locations

`router/src/providers/postgres-session-store.ts`:
- **Site 1 (timeout):** line 250 — inside the `setTimeout` callback in `appendTurn`'s `Promise.race`, after the warn log + before `resolve({persisted:false})`: `this.metricsRegistry?.routerSessionAppendFailedTotal.inc({ reason: 'timeout' })`.
- **Site 2 (error):** line 296 — inside the new `appendTurnTxWithCounter` wrapper's `catch` block, AFTER the 3-business-error guard + BEFORE re-throwing: `this.metricsRegistry?.routerSessionAppendFailedTotal.inc({ reason: 'error' })`.

Both increments are guarded by optional chaining so test fixtures without metrics (the `makeFakeSessionStore` path doesn't apply — only the real `PostgresSessionStore`) silently skip the counter; production wiring always passes `metricsRegistry`.

## Smoke section: 6 PASS gates + live tunnel status

| Gate | Description | Verifies |
|------|-------------|----------|
| 1 | `SESS-05: X-Session-ID response header present on non-stream` | Pitfall 17-D + SESS-05 |
| 2 | `SC-1: second turn references the sentinel from turn 1` (soft-WARN PASS if model rephrases) | SC-1 history injection end-to-end |
| 3 | `invalid_session_id: 400 returned for bad X-Session-ID` | SESS-05 regex enforcement |
| 4 | `SC-4: stateless mode returns Phase-16-shaped response` | SESS-06 byte-identical contract |
| 5 | `router_session_append_failed_total present in /metrics` | Pitfall 17-E observability |
| 6 | `POL-06: router_session_append_failed_total has bounded labels only (no _id)` | Cardinality invariant |

**Live tunnel status:** PENDING operator rebuild. The currently-deployed router behind https://local-llms.luishelguera.dev is the post-Phase-16 image; Phase 17's production composition (PostgresSessionStore + DefaultContextProvider + NoopSummaryProvider + new counter) is NOT yet in the running container. Operator action: `docker compose up -d --build --force-recreate router`. After rebuild, `bash bin/smoke-test-router.sh --profile prod` should print all 6 PASS gates. Tracked in `.planning/phases/17-sessionstore-contextprovider-summaryprovider/deferred-items.md` and STATE.md Active Todos.

## DEPLOY.md + README.md byte ranges of new content

| File | Inserted at | Section | LOC |
|------|-------------|---------|-----|
| `DEPLOY.md` | After Phase 15 MCP verification block (line 573), before Backups | `## Sessions + ContextProvider (Phase 17 — v0.11.0)` | 95 |
| `README.md` | After `## Policy & multi-tenant context (v0.11.0)` (line 389), before `## Operacion` | `## Sessions / X-Session-ID (v0.11.0)` | 57 |

Both sections include cross-references back to each other (README → DEPLOY for operator config; DEPLOY → integration tests).

## STATE.md / ROADMAP.md / REQUIREMENTS.md change summary

| File | Key changes |
|------|-------------|
| `.planning/STATE.md` | Frontmatter: `completed_phases: 4` (was 3), `percent: 67` (was 52). Body lead replaced — Phase 17 SHIPPED with `22609aa` + `a99c7dc` commits cited. Status → `Phase 17 SHIPPED (Plans 17-01 through 17-07). Phase 18 — MCP Client + RetrieverProvider + Pre-Completion Hook — is next.` Progress bar: `███████░░░ 67%`. Phase 17 entry: `██████████ — SHIPPED 2026-06-01 (7/7 plans...)`. Active Decisions: new top entry for Plan 17-07 (one paragraph mirroring the 16-04 wrap-up verbosity). Active Todos: removed `/gsd:plan-phase 17`, added `/gsd:plan-phase 18`; updated the Phase 16 rebuild todo to a Phase 17 rebuild todo. Last session: timestamp + commits + "Resume file: None". |
| `.planning/ROADMAP.md` | Top phase list: `- [x] **Phase 17: ...** ✅ 2026-06-01`. Phase 17 details: `**Plans:** 7/7 plans complete`, populated 17-07 entry as `[x]`. Progress table row: `7/7 \| Complete \| 2026-06-01`. |
| `.planning/REQUIREMENTS.md` | Traceability table: SESS/CTXP/SUMP entries already `Complete` from prior plans; no flip needed (the plans before this one marked them on completion). Coverage line: `48 total \| Complete: 30 (POL × 6 + MCPS × 6 + RESS × 5 + SESS × 6 + CTXP × 4 + SUMP × 3) \| Pending: 18 (MCPC × 6 + RETR × 6 + EMBP × 2 + OBSV × 4)`. Footer: `*Last updated: 2026-06-01 — Phase 17 SHIPPED; SESS-01..06 + CTXP-01..04 + SUMP-01..03 closed (Plans 17-01..17-07).*`. |
| `deferred-items.md` (new) | Live tunnel rebuild operator action + rollout recipe + verification command. |

## Git commit hashes + log lines

```
22609aa feat(17-07): production composition + Pitfall 17-E counter (SESS-01/CTXP-01/SUMP-02)
a99c7dc feat(17-07): smoke SESSION section + DEPLOY/README docs + Q5 follower test (SESS-05/CTXP-04/SUMP-02)
[pending] feat(17): SessionStore + ContextProvider + SummaryProvider — Phase 17 SHIPPED
```

## Phase 17 final verification

| Check | Result |
|-------|--------|
| Full vitest suite (`npx vitest run`) | **1085 pass / 31 skip / 2 todo (was 1084/31/3 — Q5 flipped)** across 106 test files |
| `npx tsc --noEmit` | **0 errors** (was 1 pre-existing — Plan 17-07 cleaned it via `tests/fakes.ts:184` Rule-1 hygiene) |
| `npm run build` | **Succeeds** — ESM `dist/index.js` 596.31 KB |
| Cardinality CI guard (`scripts/check-prometheus-cardinality.ts`) | **Pass** — 14 tests green; the new `router_session_append_failed_total` counter has only the `reason` label (no `_id`) |
| `bash -n bin/smoke-test-router.sh` | **Exit 0** — Phase 17 section parses cleanly |
| Plan 16-04 P9-02 byte-identical golden snapshot | **PASS** (unchanged — SESS-06 byte-identical contract preserved) |
| Phase 14/15/16 integration suite + Plan 8 idempotency | **0 regressions** (sample-verified via full-suite run) |
| Live tunnel verification (smoke section against https://local-llms.luishelguera.dev) | **PENDING operator rebuild** — see deferred-items.md |

## Rule-N Deviations from PLAN.md

### Rule 1 — Bug / typing cleanup

**1. [Rule 1 — Typing] `tests/fakes.ts:184` TS2345 narrowed via type-predicate filter**
- **Found during:** Task 1, after re-running `npx tsc --noEmit` against the new wire-up.
- **Issue:** Pre-existing `Argument of type '(b: { text?: string; }) => string' is not assignable...` — the wider `ContentBlock` union after `.filter((b: { type?: string }) => b.type === 'text')` does not narrow to `{ text?: string }` because the filter callback's return is `boolean`, not a type predicate.
- **Fix:** Change the filter callback to a type predicate `(b: { type?: string; text?: string }): b is { type: 'text'; text: string } => b.type === 'text'` so map sees the text-block shape directly.
- **Files modified:** `router/tests/fakes.ts` (line 184 callback signature).
- **Commit:** Bundled into Task 1's commit `22609aa`.
- **Rationale:** Plan 17-06 SUMMARY documented this as pre-existing and flagged Plan 17-07 as the natural cleanup boundary; the plan's `<verification>` section requires `npx tsc --noEmit` exit 0.

### Rule 2 — Auto-add missing critical functionality

**2. [Rule 2 — Missing test seam] `BuildAppOpts.idempotency?` added to enable deterministic Q5 follower test**
- **Found during:** Task 2, when flipping the Q5 it.todo.
- **Issue:** `buildApp` constructed the `IdempotencyMultiplexer` internally from `opts.valkey` with no override seam. The Q5 follower gate test requires deterministic `acquire() → role:'follower'` behavior without spinning up the full Valkey-mock fixture from `tests/routes/idempotency-integration.test.ts` (~50 LOC of valkey pub/sub plumbing for what is fundamentally a leader/follower discriminator check).
- **Fix:** Added `idempotency?: IdempotencyMultiplexer` to `BuildAppOpts` with explicit JSDoc that production wiring never passes it. Internal construction logic changed from `if (opts.valkey)` to `if (!idempotency && opts.valkey)` — the injected multiplexer takes precedence.
- **Files modified:** `router/src/app.ts` (BuildAppOpts widening + construction bypass).
- **Production impact:** NONE — production code path in `index.ts` does not pass `opts.idempotency`, so the `opts.valkey`-driven construction is unchanged.
- **Commit:** Bundled into Task 2's commit `a99c7dc`.
- **Rationale:** The plan explicitly directs Plan 17-07 to "close the deferred Q5 follower integration test" (Task 3 acceptance criterion + Plan 17-06 SUMMARY line 228). Without this seam, the Q5 case would have to either remain as `it.todo` indefinitely or replicate the heavy ValkeyMock fixture from idempotency-integration.test.ts. The seam is the canonical clean solution; it mirrors the existing `breakerNow` / `rateLimitNow` clock-injection pattern.

### Rule 3 / Rule 4

No Rule 3 (blocking) or Rule 4 (architectural) deviations. The implementation matched the PLAN.md `<action>` sketches directly.

## Authentication Gates

None encountered. No external HTTP calls, no new secrets, no auth flows — Phase 17's production wiring consumes the existing `db` handle, `metrics` registry, and `loggerOpts` already constructed at boot.

## Issues Encountered

- **Pre-existing `hotreload.vram` test flake** — Not observed in this plan's full-suite run (1085 pass / 31 skipped / 2 todo — stable). Same as Plan 17-06 — Phase 17 closes cleanly without re-tripping it.
- **2 remaining `it.todo`** — Distributed across files unrelated to Phase 17 (the SESS-related ones are all flipped). Documented as out-of-scope for Phase 17.

## Threat Surface Scan

No new threat flags. The threat model declared by PLAN.md (T-17-07-T cardinality + T-17-07-I bearer leakage + T-17-07-D pg pool + T-17-07-E producer coverage) is fully mitigated:

- **T-17-07-T (cardinality explosion):** the new counter has only the bounded `reason` label; `scripts/check-prometheus-cardinality.ts` re-validates (14/14 green) + smoke gate 6 re-validates against live `/metrics` text.
- **T-17-07-I (bearer leakage in smoke):** the smoke script reads `ROUTER_BEARER_TOKEN` from the `.env` file (same WR-05 pattern as Phases 14/15/16) — never echoed.
- **T-17-07-D (pg pool growth):** `PostgresSessionStore` shares the same `db` handle as `request_log` + `bufferedWriter`; no new connection lifecycle.
- **T-17-07-E (producer coverage):** Plan 17-06 integration tests cover all 3 routes; the production composition in Task 1 just instantiates the same classes Plan 17-06's tests already verify behaviorally.

## Phase 17 Closing Statement

Phase 17 (Plans 17-01..17-07) closes 13 v0.11.0 requirements:

| Group | Requirements | Verified by |
|-------|-------------|-------------|
| SessionStore | SESS-01, SESS-02, SESS-03, SESS-04, SESS-05, SESS-06 | `tests/providers/session-store.interface.test.ts` + `tests/providers/postgres-session-store.test.ts` (live PG) + `tests/integration/migrations/0006-sessions.test.ts` + `tests/routes/session-attach.integration.test.ts` (3-route wire-up) + smoke section + production composition |
| ContextProvider | CTXP-01, CTXP-02, CTXP-03, CTXP-04 | `tests/providers/context-provider.test.ts` + `tests/config/registry-ctx.test.ts` (Zod widening) + `tests/routes/session-attach.integration.test.ts` SC-1/SC-3 |
| SummaryProvider | SUMP-01, SUMP-02, SUMP-03 | `tests/providers/summary-provider.test.ts` + production composition uses `NoopSummaryProvider` (Frame-03 default) |

**Strategic frame preserved:** "Memory Abstraction Layer, not Memory implementation" — the router stores raw conversation turns and trims them to fit `ctx_size`; it does NOT embed, summarize, or retrieve. Semantic memory / RAG belongs to consumer applications (n8n flows, Unsloth Studio) sitting downstream of this endpoint.

**Next step:** `/gsd:plan-phase 18` — Phase 18 — MCP Client + RetrieverProvider + Pre-Completion Hook. Phase 18 depends on Phase 15 (MCP SDK + Streamable HTTP transport pattern — SHIPPED) + Phase 17 (ContextProvider wired so hooks receive post-context-window canonical — SHIPPED). Both prerequisites are now satisfied.

## Self-Check: PASSED

- `router/src/index.ts` contains `PostgresSessionStore` + `DefaultContextProvider` + `NoopSummaryProvider` ✓ (grep verified lines 16–18 imports + lines 164–171 construction)
- `router/src/metrics/registry.ts` contains `routerSessionAppendFailedTotal` Counter with `labelNames: ['reason']` ✓ (grep line 152–157)
- `router/src/providers/postgres-session-store.ts` contains 2 `routerSessionAppendFailedTotal.inc(...)` callsites ✓ (lines 250 + 296)
- `bin/smoke-test-router.sh` parses with `bash -n` exit 0 ✓
- `DEPLOY.md` contains `## Sessions + ContextProvider (Phase 17 — v0.11.0)` section ✓
- `README.md` contains `## Sessions / X-Session-ID (v0.11.0)` section ✓
- `STATE.md` frontmatter `completed_phases: 4` + `percent: 67` ✓
- `ROADMAP.md` Phase 17 row has `7/7 \| Complete \| 2026-06-01` ✓
- `REQUIREMENTS.md` SESS/CTXP/SUMP entries all `Complete` ✓ (verified line 198–210)
- Git commits `22609aa` + `a99c7dc` reachable on master ✓
- `git log --oneline | grep 22609aa` → FOUND ✓
- `git log --oneline | grep a99c7dc` → FOUND ✓
- Full vitest: 1085 pass / 31 skipped / 2 todo (was 1084/31/3 — Q5 lit up; 0 existing failures) ✓
- `tsc --noEmit` exit 0 (was 1 pre-existing — Plan 17-07 cleaned via Rule-1 hygiene) ✓
- Cardinality CI guard: 14 tests pass; POL-06 invariant preserved ✓
- `npm run build`: succeeds (596 KB ESM bundle) ✓
- Plan 16-04 P9-02 byte-identical golden snapshot: PASS (SESS-06 contract preserved) ✓
- 0 file deletions across both Task 1 + Task 2 commits ✓

---
*Phase: 17-sessionstore-contextprovider-summaryprovider*
*Plan: 07*
*Completed: 2026-06-01*
*Phase 17: SHIPPED*
