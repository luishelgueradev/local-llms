---
phase: 05-postgres-observability-seam
reviewed: 2026-05-15T12:00:00Z
depth: standard
files_reviewed: 50
files_reviewed_list:
  - bin/restore-drill.sh
  - bin/smoke-test-router.sh
  - postgres/initdb/01-init.sql
  - router/db/migrations/0000_init.sql
  - router/db/migrations/meta/0000_snapshot.json
  - router/db/migrations/meta/_journal.json
  - router/drizzle.config.ts
  - router/package.json
  - router/src/app.ts
  - router/src/auth/bearer.ts
  - router/src/config/env.ts
  - router/src/db/bufferedWriter.ts
  - router/src/db/index.ts
  - router/src/db/migrate.ts
  - router/src/db/schema/index.ts
  - router/src/db/schema/request_log.ts
  - router/src/db/schema/usage_daily.ts
  - router/src/db/usageDaily.ts
  - router/src/errors/envelope.ts
  - router/src/index.ts
  - router/src/metrics/recordOutcome.ts
  - router/src/metrics/registry.ts
  - router/src/middleware/agentId.ts
  - router/src/routes/readyz.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/messages.ts
  - router/src/translation/anthropic-out.ts
  - router/src/translation/openai-out.ts
  - router/tests/fakes.ts
  - router/tests/integration/agentIdPreHandler.test.ts
  - router/tests/integration/auth.test.ts
  - router/tests/integration/chat-completions.llamacpp.test.ts
  - router/tests/integration/chat-completions.nonstream.test.ts
  - router/tests/integration/chat-completions.stream.test.ts
  - router/tests/integration/concurrency.stream.test.ts
  - router/tests/integration/concurrency.test.ts
  - router/tests/integration/hotreload.test.ts
  - router/tests/integration/messages.count-tokens.test.ts
  - router/tests/integration/messages.nonstream.test.ts
  - router/tests/integration/messages.stream.test.ts
  - router/tests/integration/models.test.ts
  - router/tests/integration/readyz.test.ts
  - router/tests/integration/recordOutcome.test.ts
  - router/tests/integration/shutdown.test.ts
  - router/tests/integration/usageDaily.test.ts
  - router/tests/unit/bufferedWriter.test.ts
  - router/tests/unit/metricsRegistry.test.ts
  - bin/smoke-test-router.sh
  - router/src/db/bufferedWriter.ts
  - router/tests/unit/bufferedWriter.test.ts
findings:
  critical: 0
  warning: 7
  info: 5
  total: 12
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-05-15T12:00:00Z
**Depth:** standard
**Files Reviewed:** 50 (47 from prior round + 3 re-reviewed in gap-closure 05-06)
**Status:** issues_found

## Summary

This is the second gap-closure review cycle for phase 05 (gap-closure follow-up plan 05-06). The diff is narrow: 4 surgical fixes in `bin/smoke-test-router.sh`, the `drain()` force-flag fix in `router/src/db/bufferedWriter.ts`, and a new Test 8 + Test 3 cleanup update in `router/tests/unit/bufferedWriter.test.ts`.

**CR-01 from the prior review is now RESOLVED.** The `bufferedWriter.drain()` bug (stopped flag set before flush, causing the final shutdown flush to silently no-op) has been correctly fixed using Option B: a `force` parameter on `flush()` that bypasses the `stopped && !force` early-return. `drain()` now calls `flush({ force: true })`, which correctly issues the final INSERT before the race resolves.

**Test 8 is a valid regression gate.** It correctly fails against the old code path (where `flush()` with `stopped=true` early-returned, leaving `inserts.length === 0`) and passes after the fix. Test 3's cleanup adjustment (`Promise.all([w.drain(100), vi.advanceTimersByTimeAsync(101)])`) correctly handles the now-pending force-flush whose insert mock never resolves — the 100ms drain timeout wins the race cleanly.

**SC-P5-E is correctly fixed.** It now parses `body.postgres.status` rather than gating on the overall HTTP status code, resolving the false-fail under `--profile ollama` where `/readyz` always returns 503 because the llamacpp backend is permanently down. The stdin-based JSON parsing (`echo "${_BODY}" | python3 -c '...json.load(sys.stdin)...'`) has no injection vectors.

**SC-P4-A/C/E f-string fix is correct.** All three sections now use string concatenation (`"OK id=" + msg_id[:14] + "..."`) rather than f-strings containing nested quotes. Python 3.12 compatibility is restored.

**SC-P4-D model-not-found skip branch is correct.** The new `SCP4D_PREFLIGHT` check correctly distinguishes a `model_not_found` error envelope from a real vision response, converting a false-fail into a skip without changing the happy-path assertion.

**Remaining open issues from the prior review:** WR-01 through WR-08 from the 05-05 review. WR-08 was partially addressed (pg-backup added to the OBS-05 exclusion list) but the root substring-matching problem is not fixed. All other WRs are unchanged. The items below carry forward the full warning list with WR-08 updated to reflect the partial fix status.

---

## Critical Issues

No critical issues remain in the 3 files reviewed this round. CR-01 is resolved.

---

## Warnings

### WR-01: `Promise.race` setTimeout leaks in postgres probe — accumulating timers on every probe tick

**File:** `router/src/app.ts:267-272`

**Issue:**
The postgres probe uses `Promise.race([pool.query('SELECT 1'), setTimeout(...)])` but the timer is not cleared when `pool.query` wins. Every probe tick (10s default interval) creates a 1s timer that holds a pending rejection until it fires. Over a long-running router these accumulate transiently and may delay process exit by up to 1s on shutdown.

Same shape exists in `router/src/db/bufferedWriter.ts:167-172` for drain — less impactful (drain runs once at shutdown) but the 3s setTimeout pins the process for an additional 3s after a successful flush.

**Fix:**

```ts
let t: NodeJS.Timeout | undefined;
try {
  await Promise.race([
    pool.query('SELECT 1'),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error('pg-probe-timeout-1s')), 1_000);
    }),
  ]);
} finally {
  clearTimeout(t);
}
```

Or use `AbortSignal.timeout(1000)` and pass it to `pool.query` (pg@8.13 supports a `signal` option). Mirror the same pattern in `bufferedWriter.drain()`.

---

### WR-02: D-A1 capacity invariant violated by `buf.unshift(...batch)` after flush failure

**File:** `router/src/db/bufferedWriter.ts:121`

**Issue:**
On flush failure, `buf.unshift(...batch)` restores the failed rows to the head of the FIFO without respecting the capacity cap. Sequence: buf is at capacity (10_000), flush splices 1_000 rows into batch, pushes arrive during the in-flight insert and fill buf back to 10_000, insert rejects, `buf.unshift(...batch)` sets buf.length to 11_000 — silently exceeding D-A1. The `droppedCounter` is not incremented for the implicit overflow.

**Fix:**

```ts
} catch (err) {
  opts.logger.warn(
    { event: 'log_buffer_flush_error', err, count: batch.length },
    'flush failed',
  );
  buf.unshift(...batch);
  // Restore D-A1 capacity invariant after re-inserting failed batch.
  while (buf.length > capacity) {
    buf.shift();
    opts.droppedCounter.inc();
  }
}
```

---

### WR-03: `usage_daily` aggregation hardcodes the `StatusClass` enum — silent drift when a new status is added

**File:** `router/src/db/usageDaily.ts:118-119`

**Issue:**
`count(*) FILTER (WHERE status_class IN ('client_error','server_error','disconnect'))::int AS error_count` hardcodes enum values. If a future change adds a new `StatusClass` value, those rows vanish from the rollup silently — neither `error_count` nor `success_count` captures them.

**Fix:**

Option A (simpler) — derive by exclusion:
```sql
count(*) FILTER (WHERE status_class != 'success')::int AS error_count
```

Option B — export `STATUS_CLASS_ERROR_VALUES` as a `satisfies readonly StatusClass[]` constant from `recordOutcome.ts` and make the SQL drift a compile-time error.

---

### WR-04: Non-stream branch loses tokens when `reply.send` throws after `canonicalResult` is captured

**File:** `router/src/routes/v1/chat-completions.ts:418-419` and `router/src/routes/v1/messages.ts:441-442`

**Issue:**
The outer-finally records `tokensIn: caughtErr ? undefined : canonicalResult?.usage.input_tokens`. If `canonicalToOpenAIResponse` or `reply.send` throws after `canonicalResult` was set (serialization error, TCP write error), `caughtErr` is set and the finally drops the tokens — even though the upstream returned a valid completion and the VRAM/throughput was consumed. The audit trail loses the most expensive rows.

**Fix:**

Remove the `caughtErr ? undefined :` ternary:
```ts
tokensIn: canonicalResult?.usage.input_tokens,
tokensOut: canonicalResult?.usage.output_tokens,
```

`canonicalResult?` already short-circuits to undefined when the adapter call itself threw. The ternary only incorrectly suppresses tokens when the adapter succeeded but downstream serialization threw.

---

### WR-05: `setErrorHandler` route gating asymmetric vs protocol detection — exact equality vs startsWith

**File:** `router/src/app.ts:189` vs `router/src/app.ts:194-195`

**Issue:**
Protocol detection uses `route.startsWith('/v1/messages')` (permissive) but recording gate uses `route === '/v1/messages'` (exact). A trailing-slash variant or other edge route would get the Anthropic envelope (correct) but skip recording (incorrect). The asymmetry makes the intent fragile.

**Fix:**

Normalize before both checks:
```ts
const cleanRoute = route.replace(/\/$/, '');
const isAnthropicRoute = cleanRoute.startsWith('/v1/messages');
const isRecordedRoute =
  (cleanRoute === '/v1/chat/completions' || cleanRoute === '/v1/messages') && status !== 401;
```

---

### WR-06: `smoke-test-router.sh` SQL-injection-shaped psql interpolation in SC-P5-B

**File:** `bin/smoke-test-router.sh:990-991`

**Issue:**
```bash
DB_AGENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  "SELECT agent_id FROM request_log WHERE agent_id = '${AGENT_ID}' ORDER BY ts DESC LIMIT 1" ...)
```

`AGENT_ID="claude-code:smoke-${RANDOM}"` is safe today (only digits in `RANDOM`) but the pattern is string-interpolation into a SQL literal. A future change to the AGENT_ID generator that includes a quote character would turn a smoke run into an accidental schema mutation.

**Fix:**

Use psql's parameter binding:
```bash
DB_AGENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  -v aid="${AGENT_ID}" \
  "SELECT agent_id FROM request_log WHERE agent_id = :'aid' ORDER BY ts DESC LIMIT 1" \
  2>/dev/null | tr -d '[:space:]')
```

---

### WR-07: `restore-drill.sh` pg_restore log capture buries live progress and is not cleaned up on early exit

**File:** `bin/restore-drill.sh:295-310`

**Issue:**
pg_restore's stderr is redirected to `/dev/null` during execution (operator sees nothing live on long restores). `/tmp/restore-drill.log` is a fixed path not cleaned up if the script exits early (SIGINT during the sanity SELECT on line 315).

**Fix:**

```bash
LOG_FILE=$(mktemp -t restore-drill.XXXXXX.log)
trap 'rm -f "${LOG_FILE}"' EXIT
if ! docker compose exec -T pg-backup pg_restore \
    --host=postgres --username=app --dbname=router --no-owner --no-privileges \
    --verbose \
    "/backups/${DUMP_FILE}" 2>&1 | tee "${LOG_FILE}"; then
  echo "[restore-drill] pg_restore log (last 20 lines):" >&2
  tail -20 "${LOG_FILE}" >&2 || true
  fail "pg_restore failed"
  exit 1
fi
```

Remove `>/dev/null` for live progress visibility. Use `mktemp` + `trap EXIT` for cleanup safety.

---

### WR-08: `smoke-test-router.sh` OBS-05 healthcheck filter uses substring matching — partial fix applied, root issue remains

**File:** `bin/smoke-test-router.sh:1184`

**Issue (updated — partially addressed in 05-06):**
The 05-06 gap-closure added `pg-backup` to the exclusion list, which is the correct intent. However the fix only extended the substring-match exclusion pattern, not the matching strategy:

```bash
UNHEALTHY_LINES=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -vE 'healthy|gpu-preflight|pg-backup' || true)
```

The filter still excludes any line that contains "healthy" anywhere (including in the service NAME), and excludes any line containing "gpu-preflight" or "pg-backup" as a substring — a future service named `my-pg-backup-v2` or `router-healthy-canary` would be incorrectly excluded from the health check.

**Fix:**

Use awk to match discrete fields rather than substring:
```bash
UNHEALTHY_LINES=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null \
  | awk '$1 != "gpu-preflight" && $1 != "pg-backup" && $2 != "healthy"' || true)
```

This treats Name and Health as discrete fields — no substring confusion, immune to future service name collisions.

---

## Info

### IN-01: `chat-completions.ts` and `messages.ts` outer-finally CR-02/CR-03 comments are accurate but very long

**File:** `router/src/routes/v1/chat-completions.ts:384-403`, `router/src/routes/v1/messages.ts:409-428`

**Issue:**
The 20-line block comment explaining the `body.stream !== true || caughtErr` re-instatement is essential context but reads as a "deviation log" in production code.

**Fix:**

Move the deep-dive prose to a planning pattern document and leave a 2-line summary comment in the route code, cross-referencing the document by path.

---

### IN-02: `chat-completions.ts:289-301` CR-03 override uses non-null assertions where type narrowing is available

**File:** `router/src/routes/v1/chat-completions.ts:289-301`, `router/src/routes/v1/messages.ts:319-331`

**Issue:**
`final!.error` uses a non-null assertion where binding `final.error` first would allow the TypeScript compiler to narrow the type safely.

**Fix:**

```ts
const upstreamError = final?.error;
const errStatus = upstreamError ? mapToHttpStatus(upstreamError) : reply.statusCode;
```

No behavior change; eliminates the `!` assertions.

---

### IN-03: `restore-drill.sh:181` size-formatting fallback chain is brittle

**File:** `bin/restore-drill.sh:181`

**Issue:**
The Linux `stat -c` / BSD `stat -f` fallback chain masks errors with a literal "unknown" string if both fail.

**Fix:**

```bash
SIZE=$(wc -c < "${DUMP_PATH}" 2>/dev/null || echo "?")
```

`wc -c` is POSIX and works identically on Linux and BSD.

---

### IN-04: `usageDaily.ts` `previousUtcDay()` allocates an extra `Date` object

**File:** `router/src/db/usageDaily.ts:55-59`

**Issue:**
The function does an unnecessary intermediate `new Date(ms)` allocation.

**Fix:**

```ts
function previousUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}
```

`Date.UTC` normalizes negative day-of-month automatically.

---

### IN-05: `app.ts:204` records pre-resolve errors with `model: 'unknown'` / `backend: 'unknown'` — sentinel values pollute metric labels

**File:** `router/src/app.ts:204`

**Issue:**
Pre-resolve errors (RegistryUnknownModelError, InvalidAgentIdError) generate permanent `'unknown'` labels on `router_requests_total` and related metrics. Cardinality is bounded but the sentinel will appear permanently in Grafana dashboards.

**Fix:**

Add a comment documenting the sentinel so Phase 6+ dashboards can filter `{backend!="unknown",model!="unknown"}` when computing per-backend rates. No code change required.

---

## Gap-Closure 05-06: Resolved Issues

The following finding from the prior review is now **RESOLVED**:

- **CR-01 (RESOLVED):** `bufferedWriter.drain()` does not flush. Fixed by adding `force` parameter to `flush()` (line 106-108 in `bufferedWriter.ts`). `drain()` now calls `flush({ force: true })` which bypasses the `stopped && !force` early-return. Test 8 in `bufferedWriter.test.ts` gates the regression. Test 3 cleanup correctly handles the now-pending force-flush via `Promise.all([w.drain(100), vi.advanceTimersByTimeAsync(101)])`.

---

_Reviewed: 2026-05-15T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
