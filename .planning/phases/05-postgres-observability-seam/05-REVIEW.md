---
phase: 05-postgres-observability-seam
reviewed: 2026-05-14T18:00:00Z
depth: standard
files_reviewed: 46
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
  critical: 3
  warning: 7
  info: 5
  total: 15
status: issues_found
---

# Phase 5: Code Review Report

**Reviewed:** 2026-05-14T18:00:00Z
**Depth:** standard
**Files Reviewed:** 46
**Status:** issues_found

## Summary

Phase 5 ships the Postgres + observability seam: request_log + usage_daily schema with Drizzle, a buffered writer, prom-client metrics, X-Agent-Id middleware, /readyz postgres probe extension, daily aggregation scheduler, restore drill, and pg redaction. The implementation is generally solid — token redaction is rigorous (Bearer/Authorization/apiKey patterns), the bufferedWriter implements all D-A1..D-A7 invariants with sound microtask flush dispatch, the X-Agent-Id regex is ReDoS-safe (anchored, bounded, no nested quantifiers), and the usage_daily UPSERT is parameterized via Drizzle's `sql\`\`` tag.

Three load-bearing defects need fixing before this code can be relied on:

1. **Hot-reload silently kills the postgres /readyz probe** — `index.ts` `onReload` rebuilds the URL set from registry models and calls `liveness.start(urls)`, but never includes `POSTGRES_PROBE_URL`. The liveness scheduler's `start()` removes timers for URLs absent from the new set, so after the first models.yaml change postgres probing stops and `/readyz` will report it as "down — never probed" until the next router restart.
2. **Stream pre-stream errors emit NO observability record** — both `chat-completions.ts` and `messages.ts` stream branches handle adapter-rejection by `return reply.code(status).send(env)`, which neither throws (so `setErrorHandler` doesn't fire) nor satisfies the `body.stream !== true` guard in the `finally` block, so no metric is observed and no `request_log` row is written for upstream-rejection-before-first-chunk on streaming requests.
3. **Mid-stream upstream errors are recorded as `success`** — the translator catches the error, emits an SSE error frame, and returns. The route's `sseCleanup` then runs with `reply.statusCode === 200` and `controller.signal.aborted === false`, producing `status_class='success'`, `error_code=null`, `error_message=null`. The wire is correct; the audit trail is misleading.

The remaining warnings cover the bufferedWriter's documented-but-still-buggy capacity-invariant violation under failed-flush + concurrent-push, mis-classified status for pre-stream/validation errors via `_t0=undefined`, the brittle `pg-backup` startup race in the restore drill, and a few quality items in the shell scripts.

## Critical Issues

### CR-01: Hot-reload of models.yaml silently drops the postgres /readyz probe

**File:** `router/src/index.ts:74-80`
**Issue:** `watchRegistry.onReload` rebuilds the URL set from `next.models` only:
```ts
onReload: (next) => {
  app.log.info({ models: next.models.length, names: ... }, 'registry reloaded');
  const urls = Array.from(new Set(next.models.map((m) => m.backend_url)));
  app.liveness.start(urls);
},
```
`liveness.start()` (router/src/backends/liveness.ts:101-119) explicitly **deletes timers and cache entries for URLs no longer in the new set** (the "hot-reload shrinkage" logic). After the first models.yaml edit, `POSTGRES_PROBE_URL` ("postgres://pool") is absent from `urls`, so the postgres probe timer is cleared, the cache entry is deleted, and `/readyz` (router/src/routes/readyz.ts:81-96) sees `liveness.get(POSTGRES_PROBE_URL) === undefined`, classifies postgres as `status: 'down', error: 'never probed'`, and returns 503. The router has to be restarted to recover.

This is the *exact* postgres reachability signal that gates the 200/503 contract; losing it after every YAML edit defeats Plan 05-04 D-G2.

**Fix:** Re-add the postgres probe URL when rebuilding the list, mirroring the boot wiring at `router/src/app.ts:308-312`:
```ts
onReload: (next) => {
  app.log.info({ models: next.models.length, names: ... }, 'registry reloaded');
  const backendUrls = Array.from(new Set(next.models.map((m) => m.backend_url)));
  // Preserve the postgres probe across hot-reloads — boot wiring at app.ts:308-312
  // already includes it; the scheduler's start() will tear it down if we don't.
  const urls = pool ? [...backendUrls, POSTGRES_PROBE_URL] : backendUrls;
  app.liveness.start(urls);
},
```
This requires importing `POSTGRES_PROBE_URL` from `./app.js` and either capturing the pool reference in `main()` (already in scope at line 27) or moving the urls computation into a helper that `buildApp` returns. Add an integration test that hot-reloads the registry and asserts the `/readyz` response still has `postgres` present + `alive` after the reload.

---

### CR-02: Stream pre-stream errors skip recordOutcome — no metric + no request_log row

**File:** `router/src/routes/v1/chat-completions.ts:210-217`, `router/src/routes/v1/messages.ts:238-245`
**Issue:** Both stream branches wrap the adapter call in an inner try/catch and, on failure, call `reply.code(status).send(env)` directly:
```ts
upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
} catch (err) {
  req.raw.socket?.off('close', onClose);
  const env = toOpenAIErrorEnvelope(err);
  const status = mapToHttpStatus(err);
  if (env === NO_ENVELOPE) return;
  return reply.code(status).send(env);   // <-- returns; does NOT throw
}
```
Because this path returns rather than throws:
- `app.setErrorHandler` does **not** fire (so the pre-resolve fallback `recordOutcome` at app.ts:181-212 is not invoked).
- The outer `try { ... } catch (err) { ... }` at chat-completions.ts:300 is bypassed.
- The `finally` block at chat-completions.ts:314 *does* run, but its `safeRecord(...)` call is gated by `if (body.stream !== true)` (line 325), so it is skipped on streaming requests.

Net effect: any upstream/SDK error that surfaces **before the first chunk** on a streaming request produces a correct HTTP error envelope on the wire but **zero rows in request_log** and **zero metric observations**. D-D4's "every completed request after bearer auth produces a request_log row" is violated. Worst case is the regression where Phase 5 metrics for a degraded backend look healthier than reality — exactly the wrong tilt for an observability seam.

**Fix:** Call `safeRecord` from inside the inner catch on both routes before returning. Example for `chat-completions.ts`:
```ts
} catch (err) {
  req.raw.socket?.off('close', onClose);
  const env = toOpenAIErrorEnvelope(err);
  const status = mapToHttpStatus(err);
  caughtErr = err instanceof Error ? err : new Error(String(err));
  safeRecord({
    protocol: 'openai',
    route: req.url.split('?')[0] ?? req.url,
    backend: entry.backend,
    model: entry.name,
    statusClass: deriveStatusClass(status, false),
    httpStatus: status,
    durationMs: performance.now() - (req._t0 ?? performance.now()),
    errorCode: mapErrorToCode(err),
    errorMessage: caughtErr.message,
    agentId: req.agentId,
    requestId: req.id,
    timestamp: new Date(),
  });
  if (env === NO_ENVELOPE) return;
  return reply.code(status).send(env);
}
```
Apply the symmetric fix in `messages.ts:238-245` (protocol='anthropic', toAnthropicErrorEnvelope, ANTHROPIC_NO_ENVELOPE). Then drop the `body.stream !== true` guard in the `finally` block if `safeRecord` becomes the only call site — `safeRecord` is already idempotent via `recorded`. Add an integration test that wires a stream request to a backend that rejects synchronously and asserts (a) the wire is a JSON envelope at the mapped status, and (b) the bufferedWriter receives exactly one push with the correct status_class.

---

### CR-03: Mid-stream upstream errors recorded as status_class='success'

**File:** `router/src/translation/openai-out.ts:418-429`, `router/src/translation/anthropic-out.ts:237-253`, `router/src/routes/v1/chat-completions.ts:235-255`, `router/src/routes/v1/messages.ts:261-286`
**Issue:** When upstream errors after `message_start` has shipped:
1. `canonicalToOpenAISse`'s `catch` branch yields the error frame + `[DONE]` and returns (translator finishes "normally" as far as the caller is concerned).
2. The `finally` block calls `opts.onCleanup({tokensIn, tokensOut})`.
3. The route's `sseCleanup` runs with `reply.statusCode === 200` (SSE headers already flushed) and `controller.signal.aborted === false`.
4. `deriveStatusClass(200, false)` → `'success'`. `errorCode` is set only on `controller.signal.aborted`. `errorMessage` is never set on this path.

Result: the wire shows an error to the client but `request_log` records `status_class='success'`, `error_code=null`, `error_message=null`, and the prom counter `router_requests_total{status_class="success"}` is incremented. The observability seam reports success for what was, from the model serving standpoint, a failure. The `chat-completions.stream.test.ts` "emits D-C2 error frame on real upstream error" test confirms the wire shape but does not inspect the recorded outcome.

**Fix:** Surface the error state from the translator's catch into `onCleanup`. Widen the callback shape:
```ts
onCleanup?: (final?: { tokensIn: number; tokensOut: number; error?: Error }) => void;
```
Capture the caught error in `openai-out.ts:418-429` / `anthropic-out.ts:237-253` and pass it to `opts.onCleanup({tokensIn, tokensOut, error: err as Error})` in the finally block (instead of just `{tokensIn, tokensOut}`). Then in each route's `sseCleanup`, set status_class to `'server_error'` (or use `deriveStatusClass(mapToHttpStatus(final.error), false)`) and populate `errorCode: mapErrorToCode(final.error)` + `errorMessage: final.error.message` when `final?.error` is present. Add a `recordOutcome` integration test that fires a mid-stream upstream error and asserts `pushed[0].status_class === 'server_error'` (or 'client_error' depending on the upstream class) and that `error_message` is redacted-truncated and present.

---

## Warnings

### WR-01: bufferedWriter capacity invariant can be violated by unshift after flush failure with concurrent pushes

**File:** `router/src/db/bufferedWriter.ts:104-113, 130-134`
**Issue:** The flush flow:
1. `splice(0, Math.min(buf.length, MAX_BATCH_ROWS))` removes up to 1000 rows into `batch`, emptying `buf` toward 0.
2. While the insert promise is in flight (network round-trip), `push()` can append up to `capacity` more rows, triggering drop-oldest only when `buf.length >= capacity`.
3. If the insert fails, `buf.unshift(...batch)` prepends the original rows. Now `buf.length` can be up to `batch.length + capacity` (e.g., 1000 + 10_000 = 11_000), exceeding the documented capacity invariant.

The header comment (lines 30-36) acknowledges this as a "trade-off" but the code does not enforce the cap after unshift. With `flushIntervalMs=1_000ms` and a typical 1–5s round-trip on a degraded Postgres, the buffer can carry 1.1x–1.5x its declared capacity for whole flush cycles. The droppedCounter is also NOT incremented even though older rows ARE de-facto pushed past the documented eviction policy on subsequent pushes — every push when `buf.length >= capacity` evicts the front-most row (which is now one of the unshift'd OLD rows), so failed-flush rows lose to new pushes silently.

**Fix:** Right after `buf.unshift(...batch)`, trim the buffer back to capacity and count the trimmed rows:
```ts
} catch (err) {
  opts.logger.warn({ event: 'log_buffer_flush_error', err, count: batch.length }, 'flush failed');
  buf.unshift(...batch);
  if (buf.length > capacity) {
    const overflow = buf.length - capacity;
    buf.splice(capacity, overflow);  // evict tail (newer rows preserved, or use shift loop if you prefer old-first)
    opts.droppedCounter.inc(overflow);
  }
}
```
Decide explicitly whether to drop the head (the unshift'd OLDEST) or the tail (the most recent pushes) and document it. The current implicit behavior (drop-oldest on next push) loses retried rows first, which is the opposite of "rows STAY in buffer for the next interval tick retry" claimed in D-A7.

---

### WR-02: latency_ms is 0 for pre-preHandler errors because _t0 is never set

**File:** `router/src/app.ts:205-211`, `router/src/middleware/agentId.ts:54`
**Issue:** `req._t0` is captured at the **preHandler** hook (agentId.ts:54), which Fastify v5 runs *after* validation (`preParsing` → `preValidation` → validator → `preHandler`). When request body validation fails (most common 400 path) or the bearer onRequest hook short-circuits, `agentIdPreHandler` never runs, `req._t0` is `undefined`, and the fallback `performance.now() - (req._t0 ?? performance.now())` evaluates to 0. The `request_log.latency_ms` column is NOT NULL, so `Math.round(0) = 0` is inserted. Every validation-rejected request reports `latency_ms=0` in the audit trail — making any p50/p95 latency query on validation-heavy clients meaningless.

**Fix:** Move the `req._t0 = performance.now()` capture to the earliest hook that always runs. Two clean options:
- Set it in `bearerOnRequest` (auth/bearer.ts:23) before any other work — covers all routes including public ones, and runs in `onRequest` which fires before validation.
- Add a tiny `onRequest` hook in `buildApp` that does `req._t0 = performance.now()` unconditionally, registered before `makeBearerHook`.

The second is cleaner and keeps `bearerOnRequest`'s contract focused.

---

### WR-03: Schema-class migration errors leak the pool sockets before process exit

**File:** `router/src/db/migrate.ts:54-56`, `router/src/index.ts:114-129`
**Issue:** When `migrate()` throws a schema-class error (e.g., drift between schema and a manually-edited table), `runMigrations` rethrows so `main()` rejects and the catch in `main().catch(...)` writes a structured fatal line and calls `process.exit(1)`. The pool is never `pool.end()`ed. On hard-exit this is fine; on `SIGTERM` after partial migration failure (less common), pg sockets dangle.

The bigger concern is that the `code` introspection at migrate.ts:35 only recognizes a fixed set of pg error code prefixes. The pg driver may surface connection errors via `cause` (nested AggregateError, drizzle-orm wraps via `DatabaseError`). If the underlying ECONNREFUSED is buried inside `err.cause.code`, the schema-class branch fires unintentionally and crashes the process even though Postgres is just temporarily unreachable — directly contradicting D-B5 "lazy connect; non-blocking-on-boot".

**Fix:** Walk `err.cause` chains when classifying:
```ts
function isConnectionClassErr(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur; depth++) {
    const code = (cur as { code?: string }).code;
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' ||
        (typeof code === 'string' && code.startsWith('08'))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
```
Add a `main().catch` handler that calls `await pool.end()` (best-effort with a 1s race) before `process.exit(1)`.

---

### WR-04: restore-drill.sh's pg-backup auto-start race can mask a real failure

**File:** `bin/restore-drill.sh:285-289`
**Issue:** When pg-backup is not running, the script does:
```bash
docker compose up -d pg-backup >/dev/null 2>&1 || true
sleep 2
```
`|| true` swallows any actual failure (e.g. image pull failure, port conflict, exit-on-bind-mount-error). The subsequent `docker compose exec -T pg-backup pg_restore ...` then fails because the container never started, but the error reported is "pg_restore failed" without context. The 2s sleep is also unreliable — the postgres image entrypoint typically needs longer than 2s before `pg_restore --host=postgres` can establish a session.

**Fix:** Replace with a wait-for-healthy loop and surface the start failure:
```bash
if ! docker compose up -d pg-backup; then
  fail "could not start pg-backup container — check docker compose logs pg-backup"
  exit 1
fi
for i in $(seq 1 15); do
  if docker compose ps --services --filter status=running 2>/dev/null | grep -q '^pg-backup$'; then
    break
  fi
  sleep 1
done
```

---

### WR-05: restore-drill.sh accepts path-traversal DUMP_FILE that escapes /backups

**File:** `bin/restore-drill.sh:97-114, 148, 295-301`
**Issue:** `DUMP_FILE` from positional CLI arg is concatenated as `BACKUP_DIR/$DUMP_FILE` for the host-side existence check and then as `/backups/$DUMP_FILE` inside the pg-backup container. Bash does not normalize the path. If `DUMP_FILE='../../../../etc/passwd'`:
- Host check resolves to `/srv/local-llms/postgres-backups/../../../../etc/passwd` → `/etc/passwd` — the `[[ -f ]]` test passes if root readable on the host filesystem from the operator's vantage.
- Inside the pg-backup container, `/backups/../../../etc/passwd` resolves to whatever `/etc/passwd` is in the container.

Since the script is destructive and requires an interactive `RESTORE` confirmation (or `--yes`), the threat model is "local operator with privileged shell" — but the script presents itself as a managed runbook and path-traversal opens a footgun where a typo (`router-2026-05-14T12.dump/../router-old.dump`) reads something the operator did not intend. pg_restore would error harmlessly on `/etc/passwd` so this is "footgun" not "exploit".

**Fix:** Validate `DUMP_FILE` shape early, before any docker exec:
```bash
if [[ "${DUMP_FILE}" != "${DUMP_FILE##*/}" ]] || [[ "${DUMP_FILE}" == *".."* ]]; then
  echo "[restore-drill] ERROR: <dump-filename> must be a bare filename (no slashes, no ..)" >&2
  exit 1
fi
```

---

### WR-06: makeBearerHook constant-time false branch leaks length information via padBuf

**File:** `router/src/auth/bearer.ts:18-22, 46-57`
**Issue:** The comment says "ensures the comparison still runs in constant time" and the implementation does:
```ts
const padBuf = randomBytes(expectedBuf.length);
// ...
if (suppliedBuf.length === expectedBuf.length) {
  ok = timingSafeEqual(suppliedBuf, expectedBuf);
} else {
  const sized = Buffer.alloc(expectedBuf.length);
  suppliedBuf.copy(sized, 0, 0, Math.min(suppliedBuf.length, expectedBuf.length));
  timingSafeEqual(sized, padBuf);  // result discarded
  ok = false;
}
```
The length-mismatch branch does extra work (`Buffer.alloc`, `copy`, then `timingSafeEqual`) that the length-match branch skips. The two branches are not the same number of operations — under a sufficiently precise oscilloscope/eBPF attacker, this leaks the high bit "supplied.length == expected.length". That's not catastrophic for a single-secret deployment (attacker still needs ~32 bytes of brute-force to find the matching length AND value), but the "constant time" promise in the comment is overstated.

**Fix:** Either (a) drop the timing-safe pretense and just `if (auth !== expectedConst) throw` since this is a single-secret bearer and the threat model is realistic, or (b) make both branches do the same `Buffer.alloc + copy + timingSafeEqual` work. For (b):
```ts
const sized = Buffer.alloc(expectedBuf.length);
suppliedBuf.copy(sized, 0, 0, Math.min(suppliedBuf.length, expectedBuf.length));
const cmpResult = timingSafeEqual(sized, expectedBuf);
ok = cmpResult && suppliedBuf.length === expectedBuf.length;
```
Note also that the `randomBytes(expectedBuf.length)` at module load is a *per-process* pad, not per-comparison — it does not get refreshed between requests. The branches are still not equivalent so the fix should match per-request shape.

---

### WR-07: usageDaily.ts sentinel '_no_agent_' literal not parameterized

**File:** `router/src/db/usageDaily.ts:103, 116, 128`
**Issue:** The SQL embeds `'_no_agent_'` as a raw literal inside the `sql\`\`` template. The comment at lines 100-103 acknowledges this is intentional ("keeps the sentinel as a SQL literal (not a bound parameter)"). That's fine for THIS sentinel because it's hard-coded in the codebase, NOT user input — but the comment alone doesn't prevent a future maintainer from duplicating the pattern with a user-derived value. The `usage_daily.agent_id.default` is a sibling declaration at `router/src/db/schema/usage_daily.ts:30` so the two literals must be kept in sync manually. If they drift (e.g., someone changes `usage_daily` schema default to `'no-agent'` but forgets `usageDaily.ts`), the UPSERT `ON CONFLICT` will create duplicate buckets for "no-agent" rows.

**Fix:** Export the sentinel from schema and reference it:
```ts
// router/src/db/schema/usage_daily.ts
export const NO_AGENT_SENTINEL = '_no_agent_';
agent_id: text('agent_id').notNull().default(NO_AGENT_SENTINEL),

// router/src/db/usageDaily.ts
import { NO_AGENT_SENTINEL } from './schema/usage_daily.js';
// ... in the SQL: COALESCE(agent_id, ${sql.raw(`'${NO_AGENT_SENTINEL}'`)}) AS agent_id
```
Or, more simply, use a bound parameter for the sentinel — Postgres handles `COALESCE(col, $1)` correctly. Document either choice in a single place so the two never drift.

---

## Info

### IN-01: truncateAndRedact appends '...' AFTER hitting maxLen, producing output up to maxLen+3 chars

**File:** `router/src/metrics/recordOutcome.ts:98-107`
**Issue:** `truncateAndRedact` slices to `maxLen` then appends `'...'`, producing up to `maxLen+3 == 503` chars. The `error_message` column is `text` so storage is fine, but the comment "truncated to 500 chars" (request_log schema, recordOutcome header doc) is misleading. The unit test asserts `out.length <= 503` which matches the code but not the spec wording.

**Fix:** Either (a) clarify the spec to "≤ 500 + 3 ellipsis", or (b) slice to `maxLen - 3` before adding `'...'` so the total stays at `maxLen`.

---

### IN-02: deriveStatusClass returns 'server_error' for 1xx/3xx fall-through

**File:** `router/src/metrics/recordOutcome.ts:115-121`
**Issue:** The defensive `return 'server_error'` at the end is unreachable in practice (the route's `reply.statusCode` is always 2xx/4xx/5xx) but misclassifies 1xx/3xx as server_error if ever reached. Not a bug today; a footgun for future code that emits 3xx redirects (Phase 6 Traefik / OAuth proxy).

**Fix:** Either throw on unreachable cases (`throw new Error(`unexpected http_status ${httpStatus}`)`) or return a distinct sentinel like `'unknown'` so the misclassification is visible in metrics.

---

### IN-03: Smoke test SC5 regex misses some token shapes

**File:** `bin/smoke-test-router.sh:374-376`
**Issue:** The shaped-leak grep regex is `bearer [A-Za-z0-9._+/=-]{16,}`. If the project ever issues tokens containing other base64url-tolerable characters (e.g. `~`) or uses URL-encoded `+` (`%2B`) in the token surface, the regex misses. Today's token shape (`local-llms_t1t2t3...`) is safely inside the class, so this is informational.

**Fix:** Broaden to `[[:graph:]]{16,}` if the project standardizes on bearer tokens of unspecified character class, or document the class explicitly.

---

### IN-04: postgres-probe latency_ms includes the rejected Promise.race timeout race

**File:** `router/src/app.ts:265-281`
**Issue:** The `pgProbe` measures `latencyMs = performance.now() - t0` from BEFORE `Promise.race`. On a timeout case (1s elapsed, reject fires), `latencyMs ≈ 1000`. On a fast-fail case (pool throws ECONNREFUSED at 5ms), `latencyMs ≈ 5`. Both behaviors are reasonable, but the timeout latency reports as 1000ms which is indistinguishable from a slow-but-completed query. `/readyz` exposes this as `postgres.latency_ms: 1001` (line 369 of readyz.test.ts asserts this). Operationally that's fine; just note it.

**Fix:** None required. If you want sharper signal, add a small `timedOut` boolean in the probe result and bubble it through readyz, or use a smaller timeout (e.g., 500ms) so the cap is more distinctive.

---

### IN-05: Several tests import POSTGRES_PROBE_URL from app.ts — circular dependency hazard

**File:** `router/src/routes/readyz.ts:23`, `router/src/app.ts:129`
**Issue:** `readyz.ts` imports `POSTGRES_PROBE_URL` from `../app.js`. `app.ts` imports `registerReadyz` from `./routes/readyz.js`. This creates an import cycle that works today because both symbols are referenced after module initialization, but the cycle is fragile (any top-level side-effect import inserted into readyz.ts could trigger an init-order TDZ error).

**Fix:** Move `POSTGRES_PROBE_URL` to its own constants file (e.g., `router/src/db/probeUrl.ts`) and import it from both `app.ts` and `readyz.ts`. Trivial change, removes the cycle.

---

_Reviewed: 2026-05-14T18:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
