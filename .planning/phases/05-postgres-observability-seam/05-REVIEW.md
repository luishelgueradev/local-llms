---
phase: 05-postgres-observability-seam
reviewed: 2026-05-15T00:00:00Z
depth: standard
files_reviewed: 47
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
findings:
  critical: 1
  warning: 8
  info: 5
  total: 14
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-05-15T00:00:00Z
**Depth:** standard
**Files Reviewed:** 47
**Status:** issues_found

## Summary

The post-gap-closure code closes the three previously identified BLOCKERs (CR-01 hot-reload `pg` probe re-add, CR-02 stream pre-stream observability, CR-03 mid-stream upstream `status_class` fidelity) cleanly and adds correct test coverage, including a CR-03 server_error gate test in `chat-completions.stream.test.ts` and `messages.stream.test.ts` that asserts wire 200 + recorded server_error + redacted error_message + preserved upstream_message_id.

However, adversarial review surfaced one BLOCKER and several WARNINGs that pre-date the gap-closure (or sit just outside its diff scope) but live inside the reviewed file set:

- **CR-01 (BLOCKER)** — `bufferedWriter.drain()` is structurally inert: `stopped` is set BEFORE the awaited `flush()` runs, and `flush()` early-returns when `stopped===true`. The intended "final flush before shutdown" never executes; ALL non-empty buffers at SIGTERM are dropped to the `log_buffer_shutdown_drop` warn path. The unit tests encode this broken behavior as the expected behavior, so the regression is not visible in green tests.
- **WARNINGs (8)** — `Promise.race` timer leaks in the postgres probe and bufferedWriter drain (`setTimeout` not cleared on the winning branch); D-A1 capacity invariant silently violated by `unshift` after a failed flush; `usage_daily` SQL hardcodes the `StatusClass` enum values, drifting silently when new values are added; non-stream branch loses tokens on post-adapter throws; setErrorHandler route gating uses exact equality vs the protocol detection's `startsWith`; smoke test has SQL-injection-shaped psql interpolation; `pg_restore` log-tee buries pg_restore stderr; healthcheck filter substring-matches.
- **INFOs (5)** — Cosmetic, documentation, and naming nits.

The CR-02 / CR-03 / CR-01-hotreload diff itself is well-structured, idempotent, and fits the existing shape. The BLOCKER below sits in `bufferedWriter.ts` which is the load-bearing seam for the entire DATA-04 contract — drain must work for SC2 to mean what its smoke test claims it means.

## Critical Issues

### CR-01: `bufferedWriter.drain()` does not flush — final shutdown drops ALL buffered rows silently

**File:** `router/src/db/bufferedWriter.ts:147-167` (interaction with `flush()` at lines 98-117 and `stopped` flag at lines 96, 99, 127, 151)

**Issue:**
`drain()` sets `stopped = true` BEFORE invoking `flush()` inside the `Promise.race`:

```ts
async drain(timeoutMs = 3_000): Promise<void> {
  stopped = true;             // <-- stopped is now true
  clearInterval(timer);
  await Promise.race([
    flush(),                  // <-- flush() runs with stopped=true
    new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); }),
  ]);
  if (buf.length > 0) {
    opts.logger.warn(
      { event: 'log_buffer_shutdown_drop', buffered_at_shutdown: buf.length },
      'drain timeout — dropping buffered rows',
    );
  }
}
```

`flush()`'s first line gates on `stopped`:

```ts
const flush = async (): Promise<void> => {
  if (flushing || buf.length === 0 || stopped) return;   // <-- early-return on stopped
  ...
};
```

So the awaited `flush()` inside `drain()` returns immediately without doing any work. The setTimeout 3s timer wins the race trivially because flush resolved at zero, but `buf.length` is still whatever it was before drain was called. Every non-empty buffer at SIGTERM is dropped to `log_buffer_shutdown_drop`.

This contradicts the file header invariant **D-A4**: "drain(3_000) on SIGTERM raced against setTimeout(timeoutMs). Logs `log_buffer_shutdown_drop` warn when buf has leftover rows." — the warn is supposed to fire only when the race timeout beats a real flush, not because `flush()` short-circuits unconditionally.

This regression is masked by the existing tests because they encode the broken behavior as expected:
- `tests/unit/bufferedWriter.test.ts:248-310` (Test 6) explicitly notes "after the in-flight insert took the batch, the buf is empty. Drain in this state should NOT emit the shutdown-drop warn" — the test relies on the row-trigger / interval flush having already drained the buffer BEFORE drain was called.
- The deliberate "leftover row" branch starts a w2 writer, lets one tick fire (flush starts → batch=2 rows → in-flight), then pushes row 3 AFTER tick, then drains. The shutdown-drop warn is observed because flush() can't run (the existing flush's `flushing=true` lock holds), AND the race times out. Drain never gets a clean shot.

The smoke-test SC-P5-D ("row-count delta == 3") doesn't exercise drain — it relies on the 1s interval flush firing before assertion. So the bug is invisible end-to-end.

**Fix:**

The correct semantics: `drain` must (1) prevent NEW pushes (stopped check in push() — already correct), (2) issue a final flush that bypasses the `stopped` early-return, and (3) race the result against a timeout. Two clean options:

**Option A (smallest diff)** — split the stopped-gate into two flags:

```ts
let stopped = false;       // gates push() — accepts no new rows
let drained = false;       // gates flush() — once true, no more flushes
// ...
const flush = async (): Promise<void> => {
  if (flushing || buf.length === 0 || drained) return;  // <-- check drained, NOT stopped
  flushing = true;
  // ... existing splice/insert/unshift logic ...
};
// ...
async drain(timeoutMs = 3_000): Promise<void> {
  stopped = true;            // gate push()
  clearInterval(timer);
  await Promise.race([
    flush(),                 // runs because drained still false
    new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); }),
  ]);
  drained = true;            // any future flush() (e.g. row-trigger microtask leftover) is no-op
  if (buf.length > 0) {
    opts.logger.warn(
      { event: 'log_buffer_shutdown_drop', buffered_at_shutdown: buf.length },
      'drain timeout — dropping buffered rows',
    );
  }
}
```

**Option B** — pass an explicit "force" flag to flush:

```ts
const flush = async (force = false): Promise<void> => {
  if (flushing || buf.length === 0 || (stopped && !force)) return;
  // ...
};
async drain(timeoutMs = 3_000): Promise<void> {
  stopped = true;
  clearInterval(timer);
  await Promise.race([flush(true), /* timeout */]);
  // ...
}
```

After fixing, update `tests/unit/bufferedWriter.test.ts` Test 6 to assert that drain DOES flush remaining rows when called with a non-empty buffer + an idle flush slot (the load-bearing assertion that the fix has actually closed the gap).

---

## Warnings

### WR-01: `Promise.race` setTimeout leaks in postgres probe — accumulating timers on every probe tick

**File:** `router/src/app.ts:267-272`

**Issue:**
The postgres probe uses `Promise.race([pool.query('SELECT 1'), setTimeout(...)])` but the timer is not cleared when `pool.query` wins:

```ts
await Promise.race([
  pool.query('SELECT 1'),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('pg-probe-timeout-1s')), 1_000),
  ),
]);
```

Every probe (10s default interval) creates a new 1s timer that holds the event loop until it fires (and then rejects, which is swallowed because the race already settled — but the rejected promise leaves an unhandled rejection trace if the runtime is configured to surface them). Over a long-running router these timers accumulate transiently AND delay process exit by up to 1s on shutdown (Node will wait for the timer to fire even if no listeners care about its result).

Same shape exists in `bufferedWriter.ts:153-158` for drain (less impactful — drain runs once at shutdown, but the 3s setTimeout pins the process for an additional 3s after a successful flush).

**Fix:**

```ts
const t = setTimeout(() => reject(new Error('pg-probe-timeout-1s')), 1_000);
try {
  await Promise.race([pool.query('SELECT 1'), new Promise<never>((_, reject) => {/* armed by t */})]);
} finally {
  clearTimeout(t);
}
```

Or use `AbortSignal.timeout(1000)` and pass it to `pool.query` (pg supports `query({...}, signal)` since pg@8.13). Cleaner.

For the bufferedWriter drain, mirror the same pattern — keep a handle to the setTimeout and clearTimeout it once the flush settles or the timer fires.

---

### WR-02: D-A1 capacity invariant violated by `buf.unshift(...batch)` after flush failure

**File:** `router/src/db/bufferedWriter.ts:113`

**Issue:**
On flush failure, `buf.unshift(...batch)` restores the failed rows to the head of the FIFO, but does NOT respect the capacity cap:

```ts
} catch (err) {
  // ...
  buf.unshift(...batch);
}
```

Sequence that violates D-A1:
1. buf is at capacity (10_000 rows).
2. Interval tick fires; flush() splices 1_000 rows out of buf → buf.length=9_000, batch.length=1_000.
3. While the insert is in-flight, push() runs ~1_001 times (real production rate). Each push past 10_000 drops the oldest. Now buf.length=10_000 again, droppedCounter incremented ~1.
4. Insert rejects. Catch runs `buf.unshift(...batch)`. Now buf.length = 10_000 + 1_000 = **11_000**, exceeding the documented 10_000 cap.
5. The `droppedCounter` was never incremented for the implicit overflow — D-A1's "drop-oldest at capacity" invariant is silently broken.

The next push() call DOES check `buf.length >= capacity` and drops oldest, but only one row per push. The buffer can stay over capacity for many pushes before steady-state.

**Fix:**

After unshift, restore the cap by trimming from the tail (newest) OR head (oldest, matching D-A1 drop-oldest semantics) and incrementing droppedCounter for each evicted row:

```ts
} catch (err) {
  opts.logger.warn(/* ... */);
  buf.unshift(...batch);
  // Restore D-A1 capacity invariant: drop excess from the head (oldest first).
  while (buf.length > capacity) {
    buf.shift();
    opts.droppedCounter.inc();
  }
}
```

Add a unit test seeding the race: fill buf to capacity, fire a flush, push during the in-flight insert, reject the insert, assert `buf.length <= capacity` AND `droppedCounter` was incremented for the displaced rows.

---

### WR-03: `usage_daily` aggregation hardcodes the `StatusClass` enum — silent drift when a new status is added

**File:** `router/src/db/usageDaily.ts:118-119`

**Issue:**
The error-bucket SQL hardcodes the `StatusClass` values:

```sql
count(*) FILTER (WHERE status_class IN ('client_error','server_error','disconnect'))::int AS error_count
```

The TypeScript source of truth lives in `router/src/metrics/recordOutcome.ts:36`:

```ts
export type StatusClass = 'success' | 'client_error' | 'server_error' | 'disconnect';
```

If a future change adds (e.g.) `'rate_limited'` to `StatusClass` and routes it via recordOutcome, those rows will land in `request_log` with `status_class='rate_limited'` but be dropped from `usage_daily.error_count` AND from `success_count` — they vanish from the rollup entirely. No error surfaces; downstream dashboards silently underreport totals.

**Fix:**

Two options:

**Option A** — derive error_count by exclusion (more robust):
```sql
count(*) FILTER (WHERE status_class != 'success')::int AS error_count
```
This treats anything-not-success as an error and survives type expansion. Document the inverse contract in `recordOutcome.ts`.

**Option B** — surface the SQL as a constant in `recordOutcome.ts` and import it:
```ts
export const STATUS_CLASS_ERROR_VALUES = ['client_error', 'server_error', 'disconnect'] as const satisfies readonly StatusClass[];
```
And construct the IN list from that constant. TypeScript's `satisfies readonly StatusClass[]` will fail to compile if a future StatusClass is added without updating the error list — the drift becomes a compile-time error.

Option A is simpler; Option B is more explicit. Either closes the gap.

---

### WR-04: Non-stream branch loses tokens when `reply.send` throws after `canonicalResult` is captured

**File:** `router/src/routes/v1/chat-completions.ts:418-419` and `router/src/routes/v1/messages.ts:441-442`

**Issue:**
The outer-finally records `tokensIn: caughtErr ? undefined : canonicalResult?.usage.input_tokens`. If `caughtErr` is set (anything thrown during `try`), tokens are dropped. But the non-stream branch order is:

```ts
canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
req.raw.socket?.off('close', onClose);
return reply.send(canonicalToOpenAIResponse(canonicalResult, { displayModel: entry.name }));
```

If `canonicalToOpenAIResponse` or `reply.send` throws AFTER `canonicalResult` was set (e.g., serialization error, TCP write error), the catch sets `caughtErr` → finally records with `tokensIn: undefined / tokensOut: undefined`. The upstream actually returned a valid completion AND the router billed VRAM/throughput for it, but `request_log` claims no tokens were exchanged. Audit trail loses the most expensive rows.

Same pattern in `messages.ts:441-442`.

**Fix:**

Always populate from `canonicalResult` when it's defined, regardless of `caughtErr`:

```ts
tokensIn: canonicalResult?.usage.input_tokens,
tokensOut: canonicalResult?.usage.output_tokens,
```

The `caughtErr ? undefined :` ternary was conservative defense, but `canonicalResult?` already short-circuits to undefined when the adapter call itself threw. The ternary only matters for "adapter succeeded but downstream serialization threw" — and in THAT path we DO want the tokens recorded.

For Anthropic, also keep `upstreamMessageId: canonicalResult?.id` (already correct).

---

### WR-05: `setErrorHandler` route gating asymmetric vs protocol detection — exact equality vs startsWith

**File:** `router/src/app.ts:189` (uses `startsWith`) vs `router/src/app.ts:194-195` (uses `===`)

**Issue:**
```ts
const isAnthropicRoute = route.startsWith('/v1/messages');     // line 189 — startsWith
// ...
const isRecordedRoute =
  (route === '/v1/chat/completions' || route === '/v1/messages') && status !== 401;   // line 194 — exact
```

A request to `/v1/chat/completions/` (trailing slash) — which Fastify by default treats as 404 — would match neither route literal in line 194, so the centralized error handler skips recording. Pre-resolve errors on a malformed route would land in pino logs but NOT in `request_log`. Marginal — trailing slashes won't typically reach this path on the OpenAI surface, and the OpenAI SDK never appends one — but the asymmetry is the bug: protocol detection is permissive, recording gate is strict.

The asymmetry also means the comment on line 192-194 ("D-D4 — coverage policy. Record /v1/chat/completions and /v1/messages outcomes (but NOT /v1/messages/count_tokens ...)") is partially betrayed by `route.startsWith('/v1/messages')` evaluating true for `/v1/messages/count_tokens` — meaning isAnthropicRoute=true for count_tokens, but isRecordedRoute=false — so count_tokens errors get the Anthropic envelope (correct) AND get skipped from recording (correct), but only by coincidence of two different gates lining up.

**Fix:**

Strip a trailing slash and use a small explicit set:

```ts
const cleanRoute = route.replace(/\/$/, '');
const isAnthropicRoute = cleanRoute.startsWith('/v1/messages');
const isRecordedRoute =
  (cleanRoute === '/v1/chat/completions' || cleanRoute === '/v1/messages') && status !== 401;
```

Now both gates use the same normalized route. The intent (record only on /v1/chat/completions and exactly /v1/messages, NOT /v1/messages/count_tokens) is explicit.

---

### WR-06: `smoke-test-router.sh` SQL-injection-shaped psql interpolation in SC-P5-B

**File:** `bin/smoke-test-router.sh:923-924`

**Issue:**
```bash
DB_AGENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  "SELECT agent_id FROM request_log WHERE agent_id = '${AGENT_ID}' ORDER BY ts DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]')
```

`AGENT_ID="claude-code:smoke-${RANDOM}"` is currently safe-by-construction (only digits in `RANDOM`), so no real injection risk today. But the pattern is the SQL-injection anti-pattern: string interpolation into a SQL literal. If a future maintainer changes the AGENT_ID generator to include a quote, a smoke run could DROP TABLE.

**Fix:**

Use psql's parameter binding via `-v`:

```bash
DB_AGENT=$(docker compose exec -T postgres psql -U app -d router -tAc \
  -v aid="${AGENT_ID}" \
  "SELECT agent_id FROM request_log WHERE agent_id = :'aid' ORDER BY ts DESC LIMIT 1" \
  2>/dev/null | tr -d '[:space:]')
```

The `:'aid'` syntax safely quotes the variable. Or pass via stdin and use `\set`. Cheap insurance against future regression.

---

### WR-07: `restore-drill.sh` pg_restore log capture buries pg_restore live progress and is not cleaned up on early exit

**File:** `bin/restore-drill.sh:295-310`

**Issue:**
```bash
if ! docker compose exec -T pg-backup pg_restore \
    --host=postgres --username=app --dbname=router --no-owner --no-privileges \
    "/backups/${DUMP_FILE}" 2>&1 | tee /tmp/restore-drill.log >/dev/null; then
  echo "[restore-drill] pg_restore log (last 20 lines):" >&2
  tail -20 /tmp/restore-drill.log >&2 || true
  fail "pg_restore failed"
  exit 1
fi
pass "pg_restore completed"
rm -f /tmp/restore-drill.log
```

`set -uo pipefail` is set (line 49), so the pipe DOES preserve pg_restore's exit status — the `if ! ...` check is correct. But two issues remain:

1. `pg_restore` writes useful diagnostic information to stderr DURING execution (table-by-table progress). Redirecting `2>&1` then `>/dev/null` means the operator sees nothing live; the user only sees the final 20 lines on failure. On long restores (~minutes), the operator has no visibility of progress.
2. `/tmp/restore-drill.log` is shared across concurrent runs (rare here) and not cleaned up if the script exits early between the `tee` and the `rm -f` (e.g., SIGINT during the sanity SELECT on line 315).

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

Removing `>/dev/null` makes progress visible. `--verbose` makes per-table progress explicit. `mktemp` + EXIT trap eliminates the cross-run collision and guarantees cleanup on any exit path.

---

### WR-08: `bin/smoke-test-router.sh` healthcheck filter substring-matches "gpu-preflight"

**File:** `bin/smoke-test-router.sh:1086`

**Issue:**
```bash
UNHEALTHY_LINES=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -vE 'healthy|gpu-preflight' || true)
```

`grep -vE 'healthy|gpu-preflight'` excludes any line containing "healthy" anywhere in name OR health, AND any line containing "gpu-preflight" anywhere. A future service named e.g. `router-healthy-canary` would be incorrectly excluded. The intent is to exclude the one-shot `gpu-preflight` service AND match `Health == healthy` for the rest.

**Fix:**

Anchor the filter to whitespace-separated fields exactly:

```bash
UNHEALTHY_LINES=$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null \
  | awk '$1 != "gpu-preflight" && $2 != "healthy"' || true)
```

This treats `Name` and `Health` as discrete fields, no substring confusion.

---

## Info

### IN-01: `chat-completions.ts` and `messages.ts` outer-finally CR-02/CR-03 comments are accurate but very long

**File:** `router/src/routes/v1/chat-completions.ts:384-403`, `router/src/routes/v1/messages.ts:409-428`

**Issue:**
The 20-line block comment explaining the `body.stream !== true || caughtErr` re-instatement is essential context but reads as a "deviation log" in production code. Future readers will skim it.

**Fix:**

Move the deep-dive prose into `05-PATTERNS.md` (or similar) and leave a 2-line summary comment in the route:

```ts
// Outer-finally records ONLY for non-stream paths, OR stream-branch synchronous
// throws BEFORE reply.sse spawns. Stream success/error path records via sseCleanup.
// See .planning/phases/05-postgres-observability-seam/05-PATTERNS.md §"deferred record-outcome".
```

The `safeRecord` idempotency means the precise reasoning is not load-bearing for correctness.

---

### IN-02: `chat-completions.ts:289-301` CR-03 override uses non-null assertions on a pattern that could be type-narrowed

**File:** `router/src/routes/v1/chat-completions.ts:289-301`, `router/src/routes/v1/messages.ts:319-331`

**Issue:**
```ts
const hasUpstreamError = final?.error !== undefined;
const errStatus = hasUpstreamError
  ? mapToHttpStatus(final!.error)
  : reply.statusCode;
```

`final!.error` uses two non-null assertions where TypeScript could narrow if you bind `final.error` first:

```ts
const upstreamError = final?.error;
const hasUpstreamError = upstreamError !== undefined;
const errStatus = upstreamError ? mapToHttpStatus(upstreamError) : reply.statusCode;
const statusClass = upstreamError
  ? deriveStatusClass(errStatus, false)
  : deriveStatusClass(reply.statusCode, controller.signal.aborted);
const errorCode = upstreamError
  ? mapErrorToCode(upstreamError)
  : controller.signal.aborted ? 'client_disconnect' : undefined;
const errorMessage = upstreamError?.message;
```

No behavior change; cleaner type-narrowing. Same pattern in `messages.ts`.

---

### IN-03: `restore-drill.sh:181` size-formatting fallback chain is brittle

**File:** `bin/restore-drill.sh:181`

**Issue:**
```bash
$(stat -c '%s bytes' "${DUMP_PATH}" 2>/dev/null || stat -f '%z bytes' "${DUMP_PATH}" 2>/dev/null || echo 'unknown')
```

The Linux `stat -c` and BSD `stat -f` chain works in practice but the third fallback `'unknown'` masks a real error if both fail (e.g., file vanished between checks). Cosmetic; only surfaces in the human-readable header line.

**Fix:**

```bash
SIZE=$(wc -c < "${DUMP_PATH}" 2>/dev/null || echo "?")
echo "[restore-drill]  Dump size : ${SIZE} bytes"
```

`wc -c` is POSIX and works identically on Linux + BSD.

---

### IN-04: `usageDaily.ts` `previousUtcDay()` could be one-line shorter and clearer

**File:** `router/src/db/usageDaily.ts:55-59`

**Issue:**
```ts
function previousUtcDay(now: Date): Date {
  const ms = now.getTime() - 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
```

Works but does an extra `new Date` allocation. Equivalent:

```ts
function previousUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}
```

JavaScript's `Date.UTC` normalizes negative day-of-month to the previous month/year automatically.

---

### IN-05: `app.ts:204` records pre-resolve errors with `model: 'unknown'` / `backend: 'unknown'` — sentinel values pollute metric labels

**File:** `router/src/app.ts:204`

**Issue:**
The centralized error handler records pre-resolve errors (e.g., `RegistryUnknownModelError`, `InvalidAgentIdError`) with `backend: 'unknown'` / `model: 'unknown'`. These become permanent labels on `router_requests_total`, `router_request_duration_seconds`, etc. Cardinality is bounded (1 per error type), but the `'unknown'` sentinel will show up forever in any Grafana dashboard filtering by backend.

**Fix:**

Document this in a comment so Phase 6+ dashboards can explicitly filter `backend!="unknown"` when they care about real-backend metrics. No code change required; add ~2 lines:

```ts
// model/backend = 'unknown' for pre-resolve errors (RegistryUnknownModelError,
// InvalidAgentIdError, zod validation). Phase 6 dashboards should filter
// {backend!="unknown",model!="unknown"} when computing per-backend rates.
```

---

_Reviewed: 2026-05-15T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
