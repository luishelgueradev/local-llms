---
phase: 08-ollama-cloud-fallback-resilience-hardening
reviewed: 2026-05-17T00:00:00Z
depth: standard
files_reviewed: 23
files_reviewed_list:
  - .env.example
  - README.md
  - bin/smoke-test-cloud.sh
  - bin/smoke-test-router.sh
  - compose.yml
  - router/db/migrations/0001_cloud_spend_daily.sql
  - router/models.yaml
  - router/src/app.ts
  - router/src/backends/factory.ts
  - router/src/backends/ollama-cloud.ts
  - router/src/clients/valkey.ts
  - router/src/config/constants.ts
  - router/src/config/env.ts
  - router/src/config/registry.ts
  - router/src/config/registryCache.ts
  - router/src/errors/envelope.ts
  - router/src/index.ts
  - router/src/metrics/recordOutcome.ts
  - router/src/middleware/agentId.ts
  - router/src/middleware/idempotencyKey.ts
  - router/src/middleware/rateLimit.ts
  - router/src/resilience/circuitBreaker.ts
  - router/src/resilience/idempotency.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/embeddings.ts
  - router/src/routes/v1/messages.ts
findings:
  critical: 4
  warning: 7
  info: 4
  total: 15
status: issues_found
---

# Phase 8: Code Review Report

**Reviewed:** 2026-05-17
**Depth:** standard
**Files Reviewed:** 23 (across router/src, compose, smoke scripts, README, migrations, env)
**Status:** issues_found

## Summary

Phase 8 ships a wide surface (Ollama Cloud adapter, Valkey infra, circuit breaker, rate limit, max_tokens cap, idempotency multiplexer, X-Model-Backend header, cloud_spend_daily view, registry cache). The implementation is mostly tight — boot-time cross-checks, fail-open Valkey discipline, atomic SETNX usage, careful ordering of guards (max_tokens before breaker, breaker before semaphore, idempotency follower before semaphore). However:

**Four blockers are present** and all are coverage-vs-reality mismatches between the implementation, the documentation, and the smoke tests:

1. **`request_log.idempotency_key` column does not exist** but both smoke scripts and the README rely on it (CR-01). Plan 08-07 wired the multiplexer at the route layer but never added the column to the Drizzle schema or shipped a migration. Plan 08-08's `cloud_spend_daily` view groups by `upstream_message_id` so it survives this, but the documented dedup verification query is broken.
2. **Stream-replay duplicate-event race** in the idempotency multiplexer (CR-02): leader RPUSHes before PUBLISHing; a follower that subscribes between the RPUSH and PUBLISH receives the event TWICE (once via LRANGE replay, once via the live channel) — producing duplicated content deltas in the follower's SSE.
3. **Probe-lock TTL bug in the circuit breaker** (CR-03): the probe_lock TTL equals `CIRCUIT_COOLDOWN_MS` (60s), but Ollama Cloud's documented timeout-on-thinking can exceed this on a 120B model — the lock expires WHILE the probe is still in-flight, allowing a second concurrent probe to acquire half-open state. Worst case: two probes hit cloud, the second succeeds and closes the breaker before the first one returns.
4. **Subscriber connection leak** on Valkey transient failures (CR-04): if `subscribeToChannel`'s internal `subscribe(channel)` throws, the freshly-created subscriber connection is never closed — accumulates one orphaned TCP connection per failure.

Seven warnings cover: race conditions, partial-failure ordering, fail-open holes, and observability gaps. Four info items are style/coverage suggestions.

The four blockers must be addressed before this phase ships. The remaining items represent defense-in-depth fixes that increase robustness.

## Critical Issues

### CR-01: `request_log.idempotency_key` column is missing — smoke tests and README dedup verification will fail

**File:** `router/src/db/schema/request_log.ts:18-46` (column missing) + `router/db/migrations/meta/_journal.json:1-20` (no migration adds it) + `bin/smoke-test-cloud.sh:583-598`, `bin/smoke-test-router.sh:1697-1707`, `README.md:1163-1167` (all query the column).
**Issue:** The Drizzle schema declares only `id, ts, protocol, route, backend, model, status_class, http_status, tokens_in, tokens_out, ttft_ms, latency_ms, error_code, error_message, agent_id, request_id, upstream_message_id`. There is **no `idempotency_key` column**. The migrations directory contains only `0000_init.sql` + `0001_cloud_spend_daily.sql`; no `ALTER TABLE request_log ADD COLUMN idempotency_key text` migration exists.

`RequestLogInsert` (the type from `$inferInsert`) therefore has no `idempotency_key` field, and `makeRecordRequestOutcome` (router/src/metrics/recordOutcome.ts:200-237) does not populate one. `OutcomeContext` in `recordOutcome.ts:59-76` has no `idempotencyKey` field either.

The downstream consumers expect the column:
- `bin/smoke-test-cloud.sh:584`: `SELECT COUNT(DISTINCT upstream_message_id) FROM request_log WHERE idempotency_key = '${IDEM_KEY}';` — will fail with `ERROR: column "idempotency_key" does not exist`.
- `bin/smoke-test-router.sh:1697`: same query.
- `README.md:1165`: the documented "verify dedup" recipe uses the same query.
- Plan 08-07-SUMMARY.md provides:11 even claims it: *"Shared upstream_message_id propagation from leader to follower request_log rows"* and the smoke documentation block claims it. But the smoke's assertion logic actually grouped on `idempotency_key` (lines 583-598).

Note: the multiplexer DOES propagate `upstream_message_id` to follower rows (chat-completions.ts:733, messages.ts:707) — so a corrected smoke query `WHERE upstream_message_id IN (SELECT ...)` would work. But the literal smoke / README query is broken.

**Fix:** Add the column + index + migration + record propagation, OR rewrite the smoke/README queries to discover followers via `upstream_message_id` already present in `request_log`. Adding the column is the right move because operators will reasonably want to filter by Idempotency-Key directly when debugging:
```sql
-- router/db/migrations/0002_request_log_idempotency_key.sql
ALTER TABLE request_log
  ADD COLUMN idempotency_key text;
CREATE INDEX idx_request_log_idempotency_key
  ON request_log (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```
Then add to `request_log.ts`:
```ts
idempotency_key: text('idempotency_key'),
```
Update `OutcomeContext` + `makeRecordRequestOutcome` to accept + persist `idempotencyKey`, and have each route pass `idempotencyKey` into safeRecord (it's already in scope as the local `idempotencyKey` variable in chat-completions.ts:258, messages.ts:268, embeddings.ts:174). Also regenerate the Drizzle journal so the migration runs on next boot.

---

### CR-02: Idempotency stream-replay duplicate-event race — followers see the same chunk twice

**File:** `router/src/resilience/idempotency.ts:296-312` (publishStreamEvent) + `:399-503` (awaitStreamResult).
**Issue:** Leader's `publishStreamEvent` runs `RPUSH chunks` THEN `PUBLISH channel`:
```ts
await valkey.rpush(keys.chunks(key), serialized);  // step 1
await valkey.publish(keys.channel(key), serialized); // step 2
```

Follower's `awaitStreamResult` subscribes BEFORE replaying the cached chunks:
1. `ensureSetup()` — subscribes to channel.
2. `replayCached()` — LRANGE all chunks 0..-1, push each onto replayQueue.

If the leader interleaves a new event between the follower's subscribe and the follower's LRANGE:
- Leader executes step 1 (event E appended to list).
- Leader executes step 2 (event E published to channel).
- Follower's `on('message')` handler fires for E — pushes onto subscriber queue.
- Follower runs LRANGE — sees E in the list, pushes onto replayQueue.

The follower then yields E from replayQueue (replay) AND drains the subscriber queue (yields E again). Duplicate canonical event → duplicate content delta in the follower's wire SSE. Visible to the agent as a doubled token / fragment.

The hybrid-strategy comment at `idempotency.ts:25-30` claims it "avoids the race where the leader finalizes between the follower's lock-check and subscribe" — true for the FINALIZE marker case, but the strategy does NOT prevent mid-stream chunk duplication.

**Fix:** Snapshot the list length BEFORE subscribing OR de-dup by sequence number. Lowest-impact: capture an event sequence ID per chunk (rpush returns the new list length; embed the index in the chunk payload), then on the follower side skip already-replayed indices when draining the subscribe queue:
```ts
async function publishStreamEvent(key: string, event: unknown): Promise<void> {
  // Increment a per-key sequence atomically so the position is part of the payload.
  const seq = await valkey.rpush(keys.chunks(key), '__placeholder__');
  const payload = JSON.stringify({ event, seq });
  // Replace the placeholder atomically via LSET (or use INCR + serialize seq into the RPUSH).
  await valkey.lset(keys.chunks(key), seq - 1, payload);
  await valkey.publish(keys.channel(key), payload);
}
```
On the follower side track `lastSeenSeq` from replay, drop subscribe-channel messages whose seq <= lastSeenSeq.

Alternative fix (simpler): publish FIRST, then rpush; track sequence per leader-side. Either approach requires a sequence number on the wire — without it the race is unavoidable.

---

### CR-03: Circuit breaker probe_lock TTL is shorter than the operational worst-case probe duration

**File:** `router/src/resilience/circuitBreaker.ts:184-202`.
**Issue:** When the breaker transitions from open → half-open, `check()` acquires `probe_lock` with `PX = CIRCUIT_COOLDOWN_MS` (default 60_000 ms = 60s). The lock's purpose is "only ONE probe runs concurrently" (line 39). But the cloud adapter's SDK timeout is `120_000` ms (router/src/backends/ollama-cloud.ts:70). A probe against `gpt-oss:120b-cloud` can legitimately take 60-120s on a cold cloud GPU.

Sequence:
- t=0: probe A acquires probe_lock with PX=60s, transitions state to half-open with PX=120s.
- t=60s: probe_lock expires (still held by probe A logically; Valkey doesn't know).
- t=60.1s: a second request arrives, sees state='open' (NOT 'half-open' because half-open's `check()` returns 'open' to non-leader callers — but the SECOND caller hitting state=='open' AND now>=probe_at will try to acquire probe_lock; SET NX succeeds because the lock expired). The second caller becomes a SECOND probe.
- t=90s: probe B succeeds. recordSuccess closes the breaker and clears all state.
- t=100s: probe A returns success. recordSuccess no-ops (state is already 'closed' / cleared — falls through line 304).

The bug is mostly self-healing on success but breaks the safety invariant ("only ONE probe runs concurrently"). The worse case: probe A is failing (slow timeout), probe B sees state='open' (was reset by `recordSuccess` calling DEL? No — half-open ran with probe A); actually trace more carefully — probe A set state='half-open' PX=120s. So at t=60.1s state is STILL 'half-open'. check() at line 210-214 sees 'half-open' and returns `{state: 'open'}`. So the second caller is NOT a probe — they get a 503. **The bug is therefore mitigated, but the comment at line 199 ("ensures only ONE probe runs concurrently") is technically violated only across the cooldown-equals-lock-TTL boundary** and **the comment at line 25-26 says "TTL = cooldown so a wedged probe doesn't permanently block re-arming" — exactly the scenario in question**. If probe A wedges past 120s (the state TTL), state expires; the next call sees stateRaw === null → 'closed'. The next failure has to re-fill the counter.

Net effect: a wedged probe extends the breaker outage by up to (state TTL = 2 * cooldown = 120s) but does NOT cause double-billing or thundering herd. Severity downgraded from "breaks invariant" to "comment-vs-code mismatch with operational surprise."

**More serious sub-bug at same site:** the cloud probe timeout (120s) > probe_lock TTL (60s). For a wedged probe, the lock expires before the state does. If the wedge resolves (success) AFTER the state TTL also expired, recordSuccess looks up state — sees `null` — falls through to the closed-state no-op (line 304). The recovery from a wedged probe is silent. Hard to detect operationally.

**Fix:** Set probe_lock TTL = `CIRCUIT_COOLDOWN_MS * 2` (mirror the state key's TTL), and tighten the comment. Or, simpler, derive the probe_lock TTL from the cloud adapter's timeout:
```ts
const probeLockTtlMs = Math.max(env.CIRCUIT_COOLDOWN_MS, 120_000);
const acquired = await valkey.set(
  keys.probeLock(backend),
  String(t),
  'PX',
  probeLockTtlMs,
  'NX',
);
```
Document explicitly that probe_lock TTL ≥ adapter timeout is the invariant.

---

### CR-04: Subscriber connection leak when `subscribeToChannel` fails after `subscriberFactory()` succeeds

**File:** `router/src/resilience/idempotency.ts:186-250`.
**Issue:** `subscribeToChannel` instantiates `const sub = subscriberFactory()` (line 191), attaches the `on('message', ...)` handler (line 211), THEN `await sub.subscribe(channel)` (line 215). If `subscribe(channel)` throws (e.g., transient Valkey hiccup, AUTH failure post-construction, connection drop during the SUBSCRIBE round-trip), the subscriber connection is fully allocated but `sub.close()` is never called — the caller's `try { ... } finally { await sub.close(); }` (line 339-392) never runs because `subscribeToChannel` rejected before returning the handle.

Each transient failure leaks one TCP connection to Valkey. Under sustained Valkey instability the router accumulates orphaned connections; ioredis's default `maxRetriesPerRequest: 1` (set in `clients/valkey.ts:51`) means a flapping Valkey could leak multiple connections per second.

**Fix:**
```ts
async function subscribeToChannel(
  channel: string,
  subscriberFactory: () => ValkeyClient,
  log: Logger,
): Promise<SubscriptionHandle> {
  const sub = subscriberFactory();
  const queue: ChannelMessage[] = [];
  const waiters: ((m: ChannelMessage) => void)[] = [];
  const onMessage = (_channel: string, message: string): void => { /* ... */ };
  (sub as ...).on('message', onMessage as ...);
  try {
    await (sub as ...).subscribe(channel);
  } catch (err) {
    // Defensive: tear down the freshly-created sub to avoid a connection leak.
    try {
      await (sub as unknown as { quit(): Promise<unknown> }).quit().catch(() => {});
    } catch { /* idempotent */ }
    throw err;
  }
  return { /* ... */ };
}
```

## Warnings

### WR-01: `extractIdempotencyKey` array-header rejection truncates an attacker-controlled value to 32 chars but does not redact

**File:** `router/src/middleware/idempotencyKey.ts:31-39` + `router/src/errors/envelope.ts:192-204`.
**Issue:** When duplicate `Idempotency-Key` headers arrive (Fastify normalizes to array), the route throws `InvalidIdempotencyKeyError(raw.join(','))`. The error envelope's message renders the joined string. The `InvalidIdempotencyKeyError` constructor (envelope.ts:195-199) truncates to 32 chars — but it does NOT redact. An attacker who controls the headers can stuff arbitrary characters (within URL-encoding limits) into the error envelope (up to ~32 chars), and the FULL untruncated value lands in pino logs via the centralized error handler's `req.log.warn({ err, url, status }, 'route error -> envelope')` in `app.ts:344, 353`. Combined with `req.url` and the request_id, the log line becomes attacker-controllable up to ~256 chars per element.

This is below the severity of a CVE but represents log-injection / observability noise. The bearer is already redacted (recordOutcome.ts:101-110) but the agent-id + Idempotency-Key paths are not.

**Fix:** Sanitize the supplied value before passing to the error: strip control characters, length-cap to 64 in the message, leave the type=`invalid_request_error` envelope as-is.
```ts
constructor(public readonly suppliedValue: string) {
  const sanitized = String(suppliedValue ?? '').replace(/[^A-Za-z0-9._:,-]/g, '?');
  const display = sanitized.length > 32 ? `${sanitized.slice(0, 32)}...` : sanitized;
  super(`Idempotency-Key "${display}" violates regex /^[A-Za-z0-9._:-]{1,256}$/`);
  this.name = 'InvalidIdempotencyKeyError';
}
```

---

### WR-02: Rate-limit middleware: `auth.length < 8` defensive skip lets `Bearer xxx` (7-char tail) bypass

**File:** `router/src/middleware/rateLimit.ts:83-85`.
**Issue:** The defensive guard is `if (typeof auth !== 'string' || auth.length < 8) return;`. The bearer hook (auth/bearer.ts:15) requires `expectedToken.length >= 8`, but the supplied (attacker-controlled) bearer can be ANY length the attacker chooses. An attacker who sends `Authorization: Bearer x` (9 chars total, 1-char token) passes this guard — the hash is computed over a 1-char string, INCR runs, and the rate-limit operates correctly. So this guard is effectively a no-op for production traffic. But the COMMENT misrepresents this — "If we got here without a usable Authorization header" implies an empty or malformed value, not a short-token value. The guard does not actually protect against bypass; it just short-circuits cases that the bearer hook would already reject (in which case the rate-limit hook never runs because bearer threw earlier via `app.addHook('onRequest')`).

The hook ordering in app.ts:240-258 registers bearer FIRST, then rate-limit. Fastify runs onRequest hooks in registration order, so this works — but if a future maintainer reorders them, the rate-limit hook silently fails open for malformed auth headers without the audit log entry that the bearer hook would otherwise emit.

**Fix:** Remove the misleading `auth.length < 8` magic number and document the dependency on bearer-running-first. If the dependency is sacred, add an `if (PUBLIC_PATHS.has(path))` skip BEFORE the auth check (already exists at line 76) AND assert auth is present + has the bearer prefix; throw an internal error otherwise:
```ts
const auth = req.headers.authorization;
if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
  // Bearer hook should have rejected this before we ran. If we got here,
  // something is wrong; do not fail-open silently.
  log.error({ url: req.url }, 'rate-limit: missing bearer (hook ordering broken?)');
  return;
}
```

---

### WR-03: Cloud adapter probeLiveness leaks the upstream error message into the public `/readyz` JSON

**File:** `router/src/backends/ollama-cloud.ts:119-128` + downstream readyz handler.
**Issue:** `probeLiveness` returns `{ ok: false, error: err.message }` when the cloud `/v1/models` call fails. The OpenAI SDK's `APIConnectionError` / 401 / 5xx errors include the upstream response body in `err.message` ("status 401: invalid api key" — or worse, on a transient cloud bug, the body could include diagnostic data the operator wouldn't want public). `/readyz` is in `PUBLIC_PATHS` (auth/bearer.ts:12) — no bearer required to query it. If Traefik exposes `/readyz` externally (currently it does NOT — Phase 6 binds router to localhost only — but the comment at bearer.ts:6-11 explicitly warns this changes when Traefik lands), the error message body leaks externally.

The same concern applies to the local adapter, but the local adapter's failure mode is "connection refused to localhost:11434" which is not sensitive. The cloud adapter's failure modes include the Ollama Cloud auth path.

**Fix:** Sanitize the error string passed to `/readyz`. Either bound the length + scrub `Bearer` / `apiKey` patterns (same regex as `truncateAndRedact` in `recordOutcome.ts:93-95`), or replace with a generic `cloud_unreachable` token:
```ts
} catch (err) {
  const raw = err instanceof Error ? err.message : String(err);
  // Reuse the redactor from recordOutcome.ts (or inline equivalent) so /readyz never
  // ships upstream-API-key fragments to a public surface.
  return { ok: false, latencyMs: Date.now() - t0, error: truncateAndRedact(raw, 120) };
}
```

---

### WR-04: Idempotency: leader's `finalizeStream` race condition — chunks list TTL may not fire

**File:** `router/src/resilience/idempotency.ts:314-335`.
**Issue:** `finalizeStream`:
1. SET result-key with TTL 900s.
2. EXPIRE chunks-list with TTL 900s.
3. PUBLISH terminal.

If step 2 fails (Valkey transient — `.catch(...) => 0`), the chunks list has NO TTL. The leader has been RPUSHing to the chunks list throughout the stream; the list was created on first RPUSH without an EXPIRE attached. Now finalize fails to set the TTL. The chunks list persists indefinitely.

Three failure modes:
- Leader crashed mid-stream → list has no TTL, persists forever.
- finalize's EXPIRE failed → list has no TTL, persists forever.
- Late-finalize after subscriber-only Valkey hiccup recovered → may be fine or may already leak.

For `idempotency:${key}:chunks` per request_id, sustained operation produces unbounded keyspace growth.

**Fix:** Set TTL on the chunks key at the FIRST `publishStreamEvent` call (not on finalize):
```ts
async function publishStreamEvent(key: string, event: unknown): Promise<void> {
  const serialized = JSON.stringify({ event });
  try {
    const newLen = await valkey.rpush(keys.chunks(key), serialized);
    if (newLen === 1) {
      // First chunk — set ceiling TTL so the key is bounded even if the leader crashes.
      await valkey.expire(keys.chunks(key), IDEMPOTENCY_LOCK_TTL_SEC).catch(() => {});
    }
  } catch (err) { /* ... */ }
  try { await valkey.publish(...); } catch { /* ... */ }
}
```
Then `finalizeStream` only shortens TTL (from 30 min to 15 min). Same shape as how the breaker handles `fail_count` (circuitBreaker.ts:257-262 uses INCR + first-time PEXPIRE).

---

### WR-05: `publishNonStream` cache-then-publish race — late follower may miss the cached body if cache write fails

**File:** `router/src/resilience/idempotency.ts:277-294`.
**Issue:** `publishNonStream`:
1. SET result-key with TTL 900s.
2. PUBLISH terminal.

Both operations are `await`-ed without try-catch. If SET succeeds and PUBLISH fails (Valkey hiccup between operations), the cache is populated but live followers are NOT notified — they remain blocked on `sub.next(timeoutMs)` until the 30s timeout. Late followers (after step 1) would see the cached body via GET in `awaitNonStreamResult:343-363`.

If step 1 fails (SET fails) and step 2 succeeds, late followers don't see the cache; live followers got the terminal marker and exited successfully. The follower's response was cached only ephemerally in the channel handler.

Worse: if both fail, follower waits 30s for IdempotencyTimeoutError. The leader's request_log row records success; the follower's row records 504. This is a coherence violation: 1 leader + N followers should all share the same outcome.

**Fix:** Wrap both in try-catch + emit a finalizeStream-shaped error fallback. Or use a Lua script for atomic SET+PUBLISH. Or accept the limitation and document: at-least-one of cache/publish must succeed, so the wire effect for a late follower is unpredictable on a partial Valkey failure.

Minimum fix — wrap in try and log:
```ts
async function publishNonStream(...): Promise<void> {
  const serialized = JSON.stringify(payload);
  let cacheOk = false, publishOk = false;
  try { await valkey.set(...); cacheOk = true; } catch (err) { log.warn(...); }
  try { await valkey.publish(...); publishOk = true; } catch (err) { log.warn(...); }
  if (!cacheOk && !publishOk) {
    // Both failed — followers will time out. Surface so the caller knows.
    throw new Error('idempotency: publishNonStream failed both cache + publish');
  }
}
```

---

### WR-06: Circuit-breaker `recordFailure`: read state via separate GET → race with concurrent state mutations

**File:** `router/src/resilience/circuitBreaker.ts:226-288`.
**Issue:** `recordFailure` reads `state` via a non-atomic GET (line 229), then branches:
- If state==='half-open' → SET state='open' + SET probeAt + DEL probeLock (line 231-251).
- Else → INCR fail_count + maybe SET state='open' (line 253-287).

The closed→open transition under high concurrency is racy: two concurrent failures both read `stateRaw === null` (closed), both INCR. The first INCR returns 5 (assuming threshold=5); the second returns 6. Both pass the `count >= threshold` gate (line 263); both run the Promise.all that SETs state='open' + probe_at. The second SET overwrites the first with a slightly later probe_at — minor effect, breaker opens correctly.

The half-open → open transition under concurrent failures is more problematic: probe is in-flight; recordFailure can be called from a second source (e.g., a separate stream-cleanup that the route fired-and-forgot). Both read state='half-open', both run the "re-open" branch, both DEL the probe_lock. The state TTL is re-extended twice (idempotent). The probe_at is set twice. Minor effect — but the comment at line 231-241 reads as if the half-open branch is atomic. It is not.

**Fix:** Use a Lua script or Valkey transaction (MULTI/EXEC) for the half-open re-open and the closed-threshold-open paths. Or accept this as a non-issue for v1 (single-user; concurrent breaker mutations are bounded) and remove the implication of atomicity from the file header. Minimum: a comment in the half-open branch acknowledging the race + asserting it's safe (both SETs land in any order; the DEL is idempotent).

---

### WR-07: `gpu-init-libcuda.sh` mount and `cloudApiKey` empty-string fallback can mask boot-time misconfigurations

**File:** `router/src/app.ts:233` (cloudApiKey default) + `router/src/backends/factory.ts:67-76` + `router/src/index.ts:140`.
**Issue:** Production wiring passes `cloudApiKey: env.OLLAMA_API_KEY ?? ''` from `index.ts:140`. If `assertCloudEnvIfConfigured` (index.ts:29-38) passes (because no cloud entries exist), and an operator later hot-reloads `models.yaml` to ADD a cloud entry, the running router has `cloudApiKey = ''` cached in the `makeAdapterWithCloudKey` closure (app.ts:233). The factory's check (factory.ts:69-72) throws *only at adapter construction time*, which is per-request — so the FIRST request to the newly-cloud-tagged model gets a clear error. Acceptable, but the error path is a 500-ish runtime error on the first request, not a controlled boot-time refusal.

The hot-reload code in index.ts:165-201 does not re-run `assertCloudEnvIfConfigured` — it logs success and updates the registry but does not validate that the new shape is compatible with the boot-time environment. A new cloud entry post-boot is a silent runtime trap.

**Fix:** In `index.ts:165` onReload callback, re-run `assertCloudEnvIfConfigured(next, env)` — but instead of throwing (which would kill the watcher), log at `error` and skip the swap (mirror the existing `onError` keep-previous semantics in watchRegistry:215-220). Or: drop the empty-string fallback in `cloudApiKey: env.OLLAMA_API_KEY ?? ''` and pass `undefined` so the factory check is exercised on every adapter call (with the existing error message). Either way, surface the operator misconfiguration BEFORE the agent gets a 500.

## Info

### IN-01: README documentation falsely claims cloud entries fail gracefully without `OLLAMA_API_KEY`

**File:** `README.md:1063-1064`.
**Issue:** README states *"If `OLLAMA_API_KEY` is empty, the router still loads — cloud-tagged models simply return upstream auth errors when called."* This contradicts the implementation: `index.ts:124` calls `assertCloudEnvIfConfigured(initialRegistry, env)`, which THROWS at boot if cloud entries exist + `OLLAMA_API_KEY` is empty. The router refuses to start, not "still loads."

Additionally, `models.yaml` ships with `gpt-oss:120b-cloud` and `gpt-oss:20b-cloud` entries (lines 106-124), so the default-installed router cannot boot without `OLLAMA_API_KEY` set. A fresh operator copying `.env.example` (which has `OLLAMA_API_KEY=`) will see the router fail to start.

**Fix:** Update the README sentence to reflect actual behavior:
```
If `OLLAMA_API_KEY` is empty AND `router/models.yaml` declares any
`backend: ollama-cloud` entry, the router refuses to start with a clear
error message. Remove the cloud entries from `models.yaml` (or comment
them out) to run a local-only stack without the cloud key.
```

---

### IN-02: `bin/smoke-test-cloud.sh` Section 6 burst loop has a latent flaky-test foot-gun

**File:** `bin/smoke-test-cloud.sh:471-525`.
**Issue:** The smoke pre-seeds the rate-limit counter to `RPM+1` via `SET ... KEEPTTL`. If the seeded key's TTL is in its final ~5s (the 65s TTL after a real request), the test's "next request → 429" can race with TTL expiry: the next request lands in a NEW minute bucket (epoch_minute changed), INCR creates a fresh key with count=1, returns success. The smoke would FAIL with "expected 429, got 200" intermittently around minute boundaries.

**Fix:** Re-seed the key with a fresh ~60s TTL even when KEEPTTL succeeds:
```bash
# Force fresh TTL window so the minute boundary doesn't race us out.
valkey_cli SET "${RL_KEY}" "${OVER_RPM}" EX 90 >/dev/null
```
And drop the `KEEPTTL` first-attempt — it's an optimization that introduces the race.

---

### IN-03: `closeValkey` race — `quit()` errors during shutdown could double-log

**File:** `router/src/clients/valkey.ts:60-76`.
**Issue:** `closeValkey` races `client.quit()` against a 1s timeout. On timeout, it forcibly disconnects. The `client.on('error', ...)` handler from `makeValkeyClient:55` fires on the same event, so the shutdown error gets logged twice (once by the on-error handler, once by `log?.warn`). Cosmetic; no correctness impact.

**Fix:** Detach the error listener before quit, or use `client.removeAllListeners('error')` after a successful boot.

---

### IN-04: `recordOutcome` redaction regexes miss `api_key=`, `key:` patterns

**File:** `router/src/metrics/recordOutcome.ts:93-95`.
**Issue:** The three redaction regexes cover `Bearer`, `Authorization:`, and `apiKey|api_key|api-key` with `=` or `:` separator + a quoted value. But cloud SDK error messages can include:
- `key='oss_...'` (where `key` is the literal variable name) — not matched.
- `Token oss_...` (Token scheme, hypothetical future) — not matched.
- Bare hex/base64 strings that happen to be tokens (no surrounding keyword) — by design unmatchable.

The OpenAI Node SDK error format is well-defined and includes the bearer in the `Authorization: Bearer ...` header echo, so this is mostly covered. The risk is a future Cloud surface change.

**Fix:** Add `oss_[A-Za-z0-9]{20,}` as a fallback regex specifically for Ollama's `oss_` prefix:
```ts
const OLLAMA_KEY_RE = /oss_[A-Za-z0-9]{20,}/g;
out = out.replace(OLLAMA_KEY_RE, '[REDACTED_OSS]');
```

---

_Reviewed: 2026-05-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
