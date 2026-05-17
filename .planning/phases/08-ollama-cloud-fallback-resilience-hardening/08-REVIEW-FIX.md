---
phase: 08-ollama-cloud-fallback-resilience-hardening
fixed_at: 2026-05-17T18:30:36Z
review_path: .planning/phases/08-ollama-cloud-fallback-resilience-hardening/08-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 11
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report

**Fixed at:** 2026-05-17T18:30:36Z
**Source review:** `.planning/phases/08-ollama-cloud-fallback-resilience-hardening/08-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 11 (CR-01..04 + WR-01..07; Info findings out of scope)
- Fixed: 11
- Skipped: 0
- Post-fix tests: 683 passing | 7 skipped (matches pre-fix baseline)
- Post-fix build: succeeds (`dist/index.js` 189.23 KB)

## Fixed Issues

### CR-01: `request_log.idempotency_key` column is missing

**Files modified:** `router/src/db/schema/request_log.ts`, `router/db/migrations/0002_request_log_idempotency_key.sql`, `router/db/migrations/meta/_journal.json`, `router/src/metrics/recordOutcome.ts`, `router/src/routes/v1/chat-completions.ts`, `router/src/routes/v1/messages.ts`, `router/src/routes/v1/embeddings.ts`
**Commit:** `2547461`
**Applied fix:** Added nullable `idempotency_key text` column to the Drizzle `request_log` schema with a partial index `idx_request_log_idempotency_key WHERE idempotency_key IS NOT NULL`. Shipped Drizzle migration `0002_request_log_idempotency_key.sql` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`) and registered it in `_journal.json`. Extended `OutcomeContext` with the `idempotencyKey?: string` field and populated it in `makeRecordRequestOutcome`. Threaded `idempotencyKey` into every `safeRecord({...})` call site in the three route handlers (5 sites in chat-completions, 5 in messages, 1 in embeddings — covering leader, follower, pre-stream-error, stream-end, and outer-finally paths). The smoke-test queries (`smoke-test-cloud.sh`, `smoke-test-router.sh`) and README dedup recipe now resolve against a real column.

### CR-02: Idempotency stream-replay duplicate-event race

**Files modified:** `router/src/resilience/idempotency.ts`
**Commit:** `e774adf`
**Applied fix:** Extended `StreamEventPayload` with an optional `seq?: number` field. `publishStreamEvent` now derives `seq = newLen - 1` from `RPUSH`'s return value and embeds it only in the PUBLISH payload (the cached payload stays seq-less because its LRANGE index implicitly identifies its position). `awaitStreamResult` tracks `maxReplayedSeq = cached.length - 1` after replay completes; any channel message with `seq <= maxReplayedSeq` was already emitted from the LRANGE replay and is dropped. The blocking `sub!.next(timeoutMs)` path is now a loop so the dedup filter can drop multiple raced events before the next legitimate event arrives. Messages without a `seq` (legacy / defensive) still flow through to preserve back-compat.

### CR-03: Circuit breaker probe_lock TTL shorter than worst-case probe

**Files modified:** `router/src/config/constants.ts`, `router/src/backends/ollama-cloud.ts`, `router/src/resilience/circuitBreaker.ts`
**Commit:** `0d410d4`
**Applied fix:** Lifted the cloud SDK timeout to `CLOUD_ADAPTER_TIMEOUT_MS = 120_000` in `config/constants.ts` (single source of truth shared between adapter and breaker). The breaker's `check()` half-open transition now computes `probeLockTtlMs = Math.max(env.CIRCUIT_COOLDOWN_MS, CLOUD_ADAPTER_TIMEOUT_MS)` so the lock cannot expire while a single probe is in flight. Documented the invariant `probe_lock_ttl_ms >= max(adapter_timeout_ms)` in the module header.

### CR-04: Subscriber connection leak on subscribe failure

**Files modified:** `router/src/resilience/idempotency.ts`
**Commit:** `499c1ac`
**Applied fix:** Wrapped `await sub.subscribe(channel)` in `subscribeToChannel` in try/catch. On throw, the function calls `disconnect()` on the freshly-allocated subscriber (non-blocking, non-throwing on ioredis) before re-raising. The caller's try/finally never gets to run when `subscribeToChannel` rejects pre-return, so the teardown has to happen here.

### WR-01: Idempotency-Key error value not sanitized

**Files modified:** `router/src/errors/envelope.ts`
**Commit:** `f8d7473`
**Applied fix:** `InvalidIdempotencyKeyError`'s constructor now replaces any char outside the validator regex set `[A-Za-z0-9._:-]` with `?` BEFORE truncating to 32 chars. This neutralizes newline / ANSI escape / null-byte log-injection vectors that previously reached pino via the centralized error handler.

### WR-02: Rate-limit `auth.length < 8` defensive skip is a no-op

**Files modified:** `router/src/middleware/rateLimit.ts`
**Commit:** `7b64b81`
**Applied fix:** Replaced the misleading length check with a structural check on the bearer prefix (`auth.toLowerCase().startsWith('bearer ')`). If the prefix is absent, log at error level (not warn) so a future hook-ordering refactor is loud, not silent. Production traffic is unchanged since bearer-auth still runs first.

### WR-03: Cloud `probeLiveness` leaks upstream error into public `/readyz`

**Files modified:** `router/src/backends/ollama-cloud.ts`
**Commit:** `76e9c03`
**Applied fix:** `probeLiveness` now feeds the SDK error message through `truncateAndRedact(raw, 120)` (the same redactor used for `request_log.error_message`). Strips Bearer/Authorization/apiKey patterns so an externally-exposed `/readyz` cannot leak token fragments.

### WR-04: chunks list TTL set only on finalize

**Files modified:** `router/src/resilience/idempotency.ts`
**Commit:** `9cc5e55`
**Applied fix:** `publishStreamEvent` now calls `valkey.expire(keys.chunks(key), IDEMPOTENCY_LOCK_TTL_SEC)` when `RPUSH` returns `newLen === 1` (the FIRST chunk for this key). `finalizeStream` still shortens TTL to `IDEMPOTENCY_DATA_TTL_SEC` on the happy path; the ceiling guarantees the chunks list is bounded even when the leader crashes mid-stream or `finalizeStream` fails. Mirrors the breaker's `fail_count` INCR-then-first-time-PEXPIRE pattern.

### WR-05: `publishNonStream` cache-then-publish coherence violation

**Files modified:** `router/src/resilience/idempotency.ts`
**Commit:** `f25a8b8`
**Applied fix:** Wrapped the `SET result` and `PUBLISH terminal` calls in independent try/catch blocks, each with descriptive warn-level logging. The helper throws only when BOTH calls fail. Documented the partial-failure matrix in-line so future maintainers understand what each branch produces (live followers timeout vs. late followers see cache, etc).

### WR-06: Circuit-breaker `recordFailure` half-open race

**Files modified:** `router/src/resilience/circuitBreaker.ts`
**Commit:** `3764a94`
**Applied fix:** Per the review's "minimum acceptable" path, added an in-line comment to the half-open branch acknowledging that GET → branched SET is not atomic, naming the race, and asserting it's benign at single-operator scale (both concurrent paths land on the same end-state). Flagged Lua/MULTI as the multi-instance follow-up so the next maintainer doesn't read the existing comment and assume atomicity. **Status: fixed: requires human verification** — semantic comment-only change; logic unchanged.

### WR-07: Cloud env cross-check not re-run on hot reload

**Files modified:** `router/src/index.ts`
**Commit:** `bd66efd`
**Applied fix:** Inside `watchRegistry`'s `onReload` callback, call `assertCloudEnvIfConfigured(next, env)` inside a try/catch. On failure, log at error level (does NOT throw — would kill the watcher) so the operator who adds a cloud entry to `models.yaml` post-boot without `OLLAMA_API_KEY` set sees the misconfiguration in logs instead of getting a runtime 500 on the first request. The pre-swap rollback semantics are documented inline as a v2 two-phase-commit follow-up.

---

_Fixed: 2026-05-17T18:30:36Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
