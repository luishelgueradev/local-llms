---
status: diagnosed
phase: 05-postgres-observability-seam
source: [05-01-SUMMARY.md, 05-02-SUMMARY.md, 05-03-SUMMARY.md, 05-04-SUMMARY.md, 05-05-SUMMARY.md]
started: 2026-05-15T00:00:00Z
updated: 2026-05-15T14:40:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: From `docker compose down -v` → `docker compose up -d ...` → `curl /healthz` returns 200 within ~15s with no manual intervention. Migrations complete on first connect; postgres has no host port mapping.
result: pass
evidence: |
  After fixes (env prereqs, not Phase 5 code defects):
    1. ~/.docker/config.json `credsStore=desktop.exe` removed (WSL2 lacked the credential helper on PATH).
    2. .env `POSTGRES_PASSWORD=` was empty; generated a 32-char random value.
  Second up: postgres healthy, router healthy, no 0.0.0.0:5432 host exposure (postgres on internal `data` network only); router published on 127.0.0.1:3000 only. /healthz returned `{"status":"ok",...}`.

### 2. Stack comes up healthy
expected: `docker compose ps --format '{{.Name}} {{.Health}}'` shows every long-running service (postgres, pg-backup, router, ollama) as `healthy`. `gpu-preflight` may be empty/exited (one-shot is OK).
result: pass
evidence: |
  ollama healthy, postgres healthy, router healthy, pg-backup running (no healthcheck per Plan 03 D-F2 — fire-and-forget sidecar). gpu-preflight exited 0.

### 3. Full smoke script — bin/smoke-test-router.sh
expected: `bash bin/smoke-test-router.sh` exits 0 with all Phase 5 SC-P5-A..E + OBS-05 PASS.
result: issue
reported: "Script exit code 0 (likely script bug — exit-code propagation) but printed 'FAILED: 23 assertion(s) did not pass.' The Phase 5 section never ran correctly because Phase 3.B's `--profile llamacpp` teardown left the stack in a broken state: llamacpp container went unhealthy with `503 Loading model`, the 90s wait expired, then Phase 4 + Phase 5 sections all got HTTP 000000 (router unreachable). Also surfaced multiple unrelated bash syntax errors in the script (`[[: 0\n0: syntax error in expression`) suggesting some `curl --write-out` captures concatenate stderr+stdout."
severity: major
diagnosis: |
  Two distinct issues:
  (a) Script architecture flaw — Phase 3.B's teardown-and-restart-with-different-profile makes the script non-idempotent across phases. A llamacpp failure cascades into Phase 4/5 sections that depend on `--profile ollama` state. Should be split into per-phase scripts OR have explicit setup/teardown between sections.
  (b) Script's exit-code propagation: FAILURES counter > 0 but `exit 0` somewhere — likely `set -e` not in effect (only `-uo pipefail`), or the FAILURES check is misplaced.
  Phase 5 surfaces themselves work fine (proven by Tests 4–10 running each SC-P5-* check directly). The script is unable to exercise them because of issues (a) + (b).

### 4. /metrics is loopback-only
expected: `curl -s http://127.0.0.1:3000/metrics | head -5` returns Prometheus text/plain content. From external IP → Connection refused.
result: pass
evidence: |
  127.0.0.1:3000/metrics → HTTP 200, returns 36 metric HELP lines (5 router_* + 31 Node default).
  External host IP 172.24.171.178:3000/metrics → HTTP 000 (connection refused).
  `ss -tln` confirms only `127.0.0.1:3000` is bound, NOT `0.0.0.0:3000`. Plan 05-02's loopback-only binding works.

### 5. X-Agent-Id round-trips into request_log
expected: Send `X-Agent-Id: claude-code:uat-${RANDOM}` on /v1/chat/completions. Within 5s, `SELECT agent_id FROM request_log ORDER BY ts DESC LIMIT 1` returns the exact value.
result: pass
evidence: |
  Sent `claude-code:uat-27180`, recorded as `agent_id` column verbatim. Three subsequent test requests with different agent_ids all round-tripped correctly.

### 6. SC2 pause-postgres-5s mid-stream (regression gate)
expected: Streaming /v1/chat/completions with `stream:true` + `max_tokens:200` while postgres is paused for ~5s. Stream completes with continuous deltas; row eventually lands in `request_log`; `router_log_buffer_dropped_total` unchanged.
result: pass
evidence: |
  Captured 202 SSE delta lines during an 11-second postgres pause window (14:33:54 → 14:34:05). Stream completed cleanly. Row landed in request_log with status_class='success', http_status=200. router_log_buffer_dropped_total unchanged (delta=0). SC2 invariant holds.

### 7. CR-01 hot-reload preserves postgres probe
expected: After triggering a registry reload (edit models.yaml), `/readyz.postgres.status` continues to be `alive` AND `last_probe_at` advances (probe keeps running on its 10s interval).
result: pass
evidence: |
  Edited models.yaml (added no-op comment). Log: `"msg":"registry reloaded","models":3`. Pre-reload postgres.last_probe_at=14:32:06; 12s later post-reload=14:32:18. Probe continued running through the reload. CR-01 fix verified.

### 8. CR-02 / CR-03 error paths produce non-success request_log rows
expected: Error paths produce a request_log row with non-success status_class and matching error_code.
result: pass
evidence: |
  Three distinct error outcomes all wrote correctly-classified rows:
    - `server_error` / http=504 / error_code=`upstream_timeout` (initial cold model-load timeout — CR-02 inner pre-stream catch path)
    - `client_error` / http=499 / error_code=`internal_error` (curl gave up at 120s — CR-03 mid-stream client disconnect path)
    - `success` / http=200 / no error_code (warm request — success path)
  Plan 05 SUMMARY's "every completed request after bearer auth produces a request_log row" invariant verified end-to-end.

### 9. pg-backup dump file lands + restore drill happy path
expected: Dump file under `${HOST_DATA_ROOT}/postgres-backups/` size > 0; `bin/restore-drill.sh --yes <dump>` exits 0 with PASS message.
result: issue
reported: "On first run, pg_terminate_backend in Step 1 succeeded but DROP DATABASE router in Step 2 FAILED. A postgres backend process crashed (`server process (PID 5593) exited with exit code 2`), triggering recovery. The router database ended up in `invalid` state requiring manual `DROP DATABASE router WITH (FORCE)` to recover. After manual recovery, second invocation of restore-drill.sh --yes <dump> succeeded — data preserved (4 request_log + 3 usage_daily rows restored). Backup file landed correctly (7.9K, custom format)."
severity: major
diagnosis: |
  Root cause: race between bin/restore-drill.sh Step 1 (pg_terminate_backend) and Step 2 (DROP DATABASE). The router's pg.Pool reconnects rapidly after terminate — between Step 1's PASS and Step 2's DROP attempt, the router can re-establish a connection that prevents the DROP. The DROP then either fails with "is being accessed by other users" OR (as we observed) triggers a postgres backend crash if a connection is mid-transaction.
  Fix: Use PostgreSQL 13+'s `DROP DATABASE router WITH (FORCE)` which forcibly terminates connections and drops in one atomic statement. Alternative: take the router service down (`docker compose stop router`) before the drill, restore, then bring it back. The current script's design assumes pg_terminate is sufficient — it isn't when an aggressive reconnecting client is still up.

### 10. usage_daily refresh produces rows
expected: Manual refresh produces correct per-(day, protocol, backend, model, agent_id) rows from request_log; idempotent (same input → same output).
result: pass
evidence: |
  Invoked the same SQL refreshUsageDaily() runs (INSERT INTO usage_daily ... SELECT FROM request_log ... GROUP BY ... ON CONFLICT DO UPDATE). Produced 3 rows for 3 distinct agent_ids with correct request_count/success_count/error_count splits matching the request_log source data.

## Summary

total: 10
passed: 8
issues: 2
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "bin/smoke-test-router.sh exits 0 with all Phase 5 sections PASS"
  status: failed
  reason: "User reported: script architecture cascades a Phase 3.B llamacpp setup failure into Phase 4+5 sections; also exit-code propagation broken (prints 23 failures, exits 0)"
  severity: major
  test: 3
  root_cause: "(a) Phase 3.B's `up --profile llamacpp --wait` waits only 90s for llamacpp model to load; on this hardware it doesn't finish in time. The teardown then leaves the stack in a corrupt state. (b) Script's main exit logic doesn't honor the FAILURES counter."
  artifacts:
    - path: "bin/smoke-test-router.sh"
      issue: "Phase 3.B section tears down --profile ollama and brings up --profile llamacpp with a 90s timeout; if llamacpp can't load in 90s, all subsequent phase sections fail. Also: final exit appears to be `exit 0` regardless of FAILURES."
  missing:
    - "Split smoke script by phase OR add explicit setup-stack-state and teardown-between-sections that guarantees each section starts from a known state."
    - "Fix final-exit logic to `exit $([ $FAILURES -gt 0 ] && echo 1 || echo 0)` or equivalent."
    - "Bump --wait timeout for --profile llamacpp section, OR detect llamacpp-model-not-loaded and SKIP rather than FAIL-cascade."
  debug_session: ""

- truth: "bin/restore-drill.sh --yes <dump> reliably exits 0 on a running stack"
  status: failed
  reason: "User reported: first run failed at Step 2 (DROP DATABASE router) due to router pool reconnecting between terminate and drop; this caused a postgres backend crash that left the router database in `invalid` state. Required manual `DROP DATABASE WITH (FORCE)` recovery. Second run after manual fix succeeded."
  severity: major
  test: 9
  root_cause: "Race condition: pg_terminate_backend terminates current connections but does not block subsequent reconnects. The router's pg.Pool reconnects within milliseconds of termination, holding a connection during the subsequent DROP DATABASE. DROP fails (sometimes loudly, sometimes triggering a backend crash). The script proceeds as if Step 2 succeeded in some paths."
  artifacts:
    - path: "bin/restore-drill.sh"
      issue: "Step 2 issues `DROP DATABASE IF EXISTS router` without WITH (FORCE) on PG 17. Step 1's pg_terminate is insufficient against an aggressively-reconnecting pool."
  missing:
    - "Change Step 2 to `DROP DATABASE IF EXISTS router WITH (FORCE);` (PostgreSQL 13+ syntax; postgres:17-alpine supports it)."
    - "OR: add `docker compose stop router pg-backup` before Step 1 and `docker compose start router pg-backup` at the end."
    - "OR: revoke CONNECT privilege on router DB before terminate, restore it after Step 5."
  debug_session: ""

## Out-of-band defects discovered during UAT (NOT in original SUMMARYs)

These are real Phase 5 code defects that were not captured in any plan's summary or verifier report. They block production deployment from a clean state.

- truth: "router image builds clean and starts on a fresh `docker compose build router`"
  status: failed
  reason: "tsup config bundled `pino` (and all other deps) into the ESM output; pino does `require('os')` internally which crashes under ESM-bundled mode with `Error: Dynamic require of 'os' is not supported`. Router would crash-loop on any fresh build."
  severity: blocker
  test: out-of-band
  root_cause: "router/tsup.config.ts did not configure `external` for runtime dependencies. tsup defaults to bundling all imports."
  artifacts:
    - path: "router/tsup.config.ts"
      issue: "Missing `external` config — all deps got inlined"
    - path: "router/package.json"
      issue: "pino was only a transitive dep via fastify but is imported directly in src/index.ts:1; should be an explicit dependency"
  missing:
    - "Fix applied during UAT: tsup.config.ts now reads `Object.keys(pkg.dependencies)` and sets `external` to keep every runtime dep out of the bundle."
    - "Fix applied during UAT: pino@^10.3.1 added as a direct dependency in router/package.json."
  debug_session: ""

- truth: "router runtime image contains the Drizzle migration files (db/migrations/) at /app/db/migrations"
  status: failed
  reason: "Dockerfile's `runtime` stage did not COPY the `db/` directory. After fixing the tsup bundling, the next crash was `Error: Can't find meta/_journal.json file` from drizzle's migrator looking for ./db/migrations at runtime."
  severity: blocker
  test: out-of-band
  root_cause: "Plan 05-01 added Drizzle migrations under router/db/migrations but the Dockerfile was never updated to copy that directory into the runtime image."
  artifacts:
    - path: "router/Dockerfile"
      issue: "Runtime stage missing `COPY db ./db`"
  missing:
    - "Fix applied during UAT: added `COPY db ./db` to the runtime stage of router/Dockerfile."
  debug_session: ""

## Test-environment defects (NOT Phase 5 code issues — recorded for completeness)

- ~/.docker/config.json had `credsStore: desktop.exe` from Docker Desktop's WSL2 integration; the helper binary wasn't on the WSL PATH, blocking `docker pull` for public images. Resolved by removing the credsStore field. (Backup at ~/.docker/config.json.bak.<ts>.)
- .env had `POSTGRES_PASSWORD=` empty. Generated and set a 32-char random value. The Phase 1/Phase 5 docs say "set POSTGRES_PASSWORD in .env before bring-up" — could be more prominent in the README's Phase 5 section.
- `docker compose restart router` failed to remount `models.yaml` (Docker Desktop WSL bind-mount weirdness). Workaround: `docker compose up -d --force-recreate router`. NOT a Phase 5 defect.
