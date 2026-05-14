---
status: partial
phase: 05-postgres-observability-seam
source: [05-04-SUMMARY.md, 05-04-PLAN.md]
started: 2026-05-14T18:30:00Z
updated: 2026-05-14T18:30:00Z
---

## Current Test

[awaiting human testing — live stack smoke deferred from plan 05-04 task 5]

## Tests

### 1. Stack comes up healthy
expected: `docker compose ps --format '{{.Name}} {{.Health}}'` reports every long-running service (postgres, pg-backup, router, ollama) as `healthy`. `gpu-preflight` is one-shot — empty health or `(exited)` is OK.
commands:
```
docker compose up -d gpu-preflight
docker compose --profile ollama up -d ollama postgres pg-backup router
docker compose ps --format '{{.Name}} {{.Health}}'
```
result: [pending]

### 2. Full smoke script — 0 failures including SC-P5-A..E + OBS-05
expected: `bin/smoke-test-router.sh` exits 0, with the Phase 5 section reporting PASS for all 5 scenarios (SC-P5-A metrics, SC-P5-B agent-id round-trip, SC-P5-C pause-pg-5s regression, SC-P5-D row-count delta, SC-P5-E /readyz state).
commands:
```
bash bin/smoke-test-router.sh
```
result: [pending]

### 3. pg-backup dump file lands on disk
expected: at least one `router-YYYY-MM-DDTHH.dump` file under `${HOST_DATA_ROOT}/postgres-backups/` with size > 0.
commands:
```
ls -lh "${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups/"
```
result: [pending]

### 4. Restore drill — happy path
expected: `bin/restore-drill.sh --yes <dump>` exits 0 with `PASS — restore drill completed without error.`
commands:
```
LATEST=$(ls -t "${HOST_DATA_ROOT:-/srv/local-llms}/postgres-backups/"router-*.dump | head -1 | xargs basename)
bin/restore-drill.sh --yes "${LATEST}"
```
result: [pending]

### 5. /metrics is loopback-only
expected: `curl 127.0.0.1:3000/metrics` returns Prometheus text; `curl <host-external-ip>:3000/metrics` returns Connection refused.
commands:
```
curl -s http://127.0.0.1:3000/metrics | head -5
curl -s http://<host-external-ip>:3000/metrics
```
result: [pending]

### 6. request_log has rows after the smoke
expected: both columns > 0 after the smoke test ran.
commands:
```
docker compose exec postgres psql -U app -d router -c \
  "SELECT count(*), count(*) FILTER (WHERE agent_id IS NOT NULL) FROM request_log;"
```
result: [pending]

### 7. usage_daily — manual refresh trigger (idempotent)
expected: prints `rows: <n>` where n > 0 if request_log has activity for today; n == 0 is OK on a fresh stack.
commands:
```
docker compose exec -T router node -e "
  const { makePool, makeDb } = require('./dist/db/index.js');
  const { refreshUsageDaily } = require('./dist/db/usageDaily.js');
  const pool = makePool(process.env.ROUTER_DATABASE_URL);
  const db = makeDb(pool);
  const today = new Date(); today.setUTCHours(0,0,0,0);
  refreshUsageDaily(db, console, { day: today }).then(r => { console.log('rows:', r.rowsUpserted); pool.end(); });
"
```
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps

[none yet — populated when items move to failed]
