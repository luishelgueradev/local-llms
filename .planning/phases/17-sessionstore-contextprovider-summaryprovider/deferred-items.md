# Phase 17 — Deferred Items

Items found during Phase 17 execution that are out-of-scope for the phase
itself and have been deferred. Each item is tracked here with enough
context for a future operator or planner to pick it up.

## Live tunnel rebuild (operator action)

**Status:** PENDING operator
**Trigger:** Phase 17 SHIPPED 2026-06-01 — image not yet rolled out to the
live deployment.

The currently-deployed router behind https://local-llms.luishelguera.dev
(loopback localhost:3210 via the cloudflared systemd tunnel in WSL2) is
the post-Phase-16 image — Phase 17's production composition root
(`router/src/index.ts` constructs `PostgresSessionStore` +
`DefaultContextProvider` + `NoopSummaryProvider` and threads them through
`buildApp`) and the new Prometheus counter
`router_session_append_failed_total{reason}` are NOT yet in the running
container.

### Rollout recipe

```bash
cd /home/luis/proyectos/local-llms
docker compose up -d --build --force-recreate router
```

`--build` forces the multi-stage Dockerfile to rebuild from the updated
source. `--force-recreate` ensures the new image replaces the running
container (a `restart` alone is not sufficient — Compose would re-use the
existing image if the tag didn't change).

### Verification after rollout

```bash
bash bin/smoke-test-router.sh --profile prod
```

The new Phase 17 SESSION section (lines 2290..2410 of
`bin/smoke-test-router.sh`) should print 6 PASS gates:

1. `SESS-05: X-Session-ID response header present on non-stream`
2. `SC-1: second turn references the sentinel from turn 1` (or the soft-WARN
   pass with sentinel-not-echoed but content present)
3. `invalid_session_id: 400 returned for bad X-Session-ID`
4. `SC-4: stateless mode (no X-Session-ID) returns Phase-16-shaped response`
5. `router_session_append_failed_total present in /metrics`
6. `POL-06: router_session_append_failed_total has bounded labels only (no _id)`

If any FAIL: see `docker compose logs router` for stack traces and check
that the migration 0006 ran cleanly (`docker compose exec postgres
psql -U app router -c '\dt'` should list both `sessions` and
`conversation_turns`).

## Notes

No code-side deferrals from Phase 17 — every Phase 17 requirement
(SESS-01..06, CTXP-01..04, SUMP-01..03) is verified by automated tests +
production composition + the new smoke section. The Q5 follower gate
deferred from Plan 17-06 was flipped to a real `it()` in Plan 17-07
(see `tests/routes/session-attach.integration.test.ts:743`).
