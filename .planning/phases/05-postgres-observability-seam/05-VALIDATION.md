---
phase: 5
slug: postgres-observability-seam
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-14
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `05-RESEARCH.md` §"Validation Architecture" (lines 887–933).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.x` (already in router/package.json) |
| **Config file** | `router/vitest.config.ts` (existing) |
| **Quick run command** | `cd router && npm run test:unit` — fast unit tests only |
| **Full suite command** | `cd router && npm test` — unit + integration (msw-mocked) |
| **Smoke harness** | `bash bin/smoke-test-router.sh` — extended in Phase 5 with metrics + agent-id + pause-pg scenarios |
| **Estimated runtime** | ~10s unit, ~30s full, ~120s smoke (E2E with Compose up) |

---

## Sampling Rate

- **After every task commit:** Run `cd router && npm run test:unit` (< 10s)
- **After every plan wave:** Run `cd router && npm test` (< 30s)
- **Before `/gsd-verify-work`:** Full suite must be green + `bash bin/smoke-test-router.sh` E2E passes
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD-by-planner | TBD | TBD | DATA-01 | — | postgres:17-alpine running on `data` network (no host port); two DBs (`router`, `openwebui`); `app` role created via init script (CONTEXT D-E1, D-B3) | smoke | `docker compose ps postgres \| grep healthy && docker compose exec postgres psql -U app -l \| grep -E '\\b(router\|openwebui)\\b'` | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | DATA-02 | DoS (self-inflicted) — Postgres-down cascading SSE stall | bufferedWriter never blocks SSE: 1s OR 200-row flush, drop-oldest, `flushing` re-entrancy lock, 3s SIGTERM drain (CONTEXT D-A1..D-A7; RESEARCH Pitfall 1) | unit + smoke | Unit: `cd router && vitest run tests/unit/bufferedWriter.test.ts`. Smoke: `bash bin/smoke-test-router.sh --pause-pg-scenario` | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | DATA-03 | Information Disclosure — bearer/apiKey leak in error_message | request_log row has backend, protocol, model, tokens_in, tokens_out, latency_ms, ttft_ms, error, agent_id, ts populated per D-D1; error_message bearer/Authorization/apiKey-redacted per D-D3 | integration | `cd router && vitest run tests/integration/recordOutcome.test.ts` | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | DATA-04 | — | usage_daily populated from request_log via idempotent UPSERT on (day, protocol, backend, model, agent_id) PK; NULL agent_id handled via COALESCE/sentinel | integration | `cd router && vitest run tests/integration/usageDaily.test.ts` | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | DATA-05 | — | pg_dump daily cron runs; `bin/restore-drill.sh` exits 0 with pre/post row counts matching | smoke | `bash bin/restore-drill.sh router-YYYY-MM-DDTHH.dump` | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | OBS-01 | Information Disclosure — /metrics externally reachable (Phase 6 follow-up) | GET /metrics returns Prometheus text/plain; version=0.0.4 with 5 custom metrics + Node defaults; /metrics on bearer-skip-list (CONTEXT D-C5) | unit + smoke | Unit: `cd router && vitest run tests/unit/metricsRegistry.test.ts`. Smoke: `curl http://127.0.0.1:3000/metrics \| grep -cE 'router_(requests_total\|ttft_seconds\|request_duration_seconds\|tokens_total\|log_buffer_dropped_total)'` ≥ 5 | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | OBS-05 | — | `docker compose ps` shows `healthy` for every service via real healthchecks (`pg_isready` for postgres, existing for others) | smoke | `docker compose ps --format '{{.Name}} {{.Health}}' \| grep -vE 'healthy\|gpu-preflight'` returns 0 lines | ❌ W0 | ⬜ pending |
| TBD-by-planner | TBD | TBD | ROUTE-09 | DoS — X-Agent-Id ReDoS via malicious header | X-Agent-Id regex `/^[A-Za-z0-9._:-]{1,128}$/` anchored + bounded; header → req.agentId → pino child + request_log.agent_id column; absent → NULL; violation → 400 invalid_agent_id (CONTEXT D-D5) | unit + smoke | Unit: `cd router && vitest run tests/integration/agentIdPreHandler.test.ts`. Smoke: `curl -H 'X-Agent-Id: claude-code:luis' ... && psql 'SELECT agent_id FROM request_log ORDER BY ts DESC LIMIT 1'` returns `claude-code:luis` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Planner will fill Task IDs and Plan/Wave columns during plan generation.*

---

## Wave 0 Requirements

Net-new test infrastructure required before any Phase 5 task can be green:

- [ ] `router/tests/unit/bufferedWriter.test.ts` — covers DATA-02: re-entrancy lock, dual-trigger flush (1s OR 200), drop-oldest, 3s drain timeout
- [ ] `router/tests/unit/metricsRegistry.test.ts` — covers OBS-01: 5 custom metrics + Node defaults present in `register.metrics()` output; per-Registry isolation (no double-register hazard)
- [ ] `router/tests/integration/agentIdPreHandler.test.ts` — covers ROUTE-09: header validation regex, 400 on violation, pino child propagation, absent-header NULL fallthrough
- [ ] `router/tests/integration/recordOutcome.test.ts` — covers DATA-03: route handler → `recordRequestOutcome` → mock `pg.Pool` capture → assert row shape matches D-D1
- [ ] `router/tests/integration/usageDaily.test.ts` — covers DATA-04: idempotent UPSERT keyed on (day, protocol, backend, model, agent_id)
- [ ] `bin/smoke-test-router.sh` — Phase 5 section: 5 new scenarios (metrics curl, agent-id round-trip, pause-pg 5s, restore-drill invocation, all-healthy check)
- [ ] `bin/restore-drill.sh` — new file: drop + recreate + `pg_restore` + sanity `SELECT count(*)`
- [ ] Test fixture: mock `pg.Pool` that captures `.query(text, params)` calls for assertion (planner picks library — `@databases/pg-test` or hand-rolled mock)

vitest + msw are already installed (Phases 2–4); no framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First-init alpine postgres uid resolution (Pitfall 7 / Assumption A2) | DATA-01 | Bind-mount permission setup depends on host filesystem — automated probe only confirms inside-container uid | Run `docker run --rm postgres:17-alpine id postgres` once on this host; if uid != 70, document the correct uid in `bin/bootstrap-host.sh` chown step |
| README operator docs (pg_dump command, X-Agent-Id usage, /metrics curl) | DATA-05, OBS-01, ROUTE-09 | Documentation correctness is a human read | Walk through each command in README's Phase 5 section on a fresh checkout |

---

## Validation Sign-Off

- [ ] Planner fills Task IDs + Plan/Wave columns in the verification map
- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (bufferedWriter, metricsRegistry, agentIdPreHandler, recordOutcome, usageDaily, smoke section, restore-drill)
- [ ] No watch-mode flags in commands (vitest --watch is forbidden in CI)
- [ ] Feedback latency < 30s for the full suite
- [ ] SC2 pause-pg-5s smoke scenario is the regression gate for the non-blocking buffered-writer claim
- [ ] `nyquist_compliant: true` set in frontmatter after planner fills the map and Wave 0 stubs land

**Approval:** pending
