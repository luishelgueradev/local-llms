---
phase: 08-ollama-cloud-fallback-resilience-hardening
reviewed: 2026-05-27T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - router/src/clients/valkey.ts
  - router/src/config/registryCache.ts
  - router/src/index.ts
  - router/src/resilience/idempotency.ts
  - router/tests/clients/valkey.test.ts
  - router/tests/config/registryCache.test.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 08: Code Review Report (gap-closure 08-11 re-review)

**Reviewed:** 2026-05-27T00:00:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Scoped re-review of the 08-11 DATA-06 gap-closure diff against base `66ddd13`
(this REVIEW.md previously held the full-phase 08 report from 2026-05-17 and
has been replaced for the gap-closure scope). The diff: a shared
`waitUntilReady` helper extracted into `clients/valkey.ts` and consumed on two
paths (boot in `index.ts`, idempotency subscriber in `idempotency.ts`), the
registry-cache TTL raised 30s→300s, and the idempotency subscriber's inline
ready-wait replaced by the shared helper.

The TTL bump and the cache refactor are sound and tested. The `waitUntilReady`
extraction is the load-bearing change and carries a real correctness defect: a
time-of-check/time-of-use race on the `status === 'ready'` short-circuit. On
the idempotency path (`rejectOnTimeout: true`) this race turns a perfectly
healthy subscriber connection into a 2-second hang followed by a thrown error
— a 504 for a follower whose connection actually came up fine. That is the
headline finding. Secondary findings: the boot call is documented as fail-open
but rejects on a Valkey `error` event (boot crash on Valkey-down), unobservable
terminal-state hangs, the primary Valkey client is never gracefully closed, and
test/comment staleness that let the race ship.

No source files were modified during review.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `waitUntilReady` has a TOCTOU race on the `status === 'ready'` short-circuit; on the fail-closed idempotency path it spuriously rejects a healthy connection

**File:** `router/src/clients/valkey.ts:113-139` (consumed at `router/src/resilience/idempotency.ts:246`)

**Issue:**
The helper short-circuits with `if (typeof c.once !== 'function' || c.status === 'ready') return;` and otherwise attaches `once('ready', …)` / `once('error', …)` listeners. ioredis emits the `ready` event exactly once per connection lifecycle; the `status` getter transitions `connecting → connect → ready`.

There is an unguarded window between the status read (line 113) and the listener attachment (lines 137-138). The subscriber connection is freshly created by `subscriberFactory()` on the line just before the call site (`idempotency.ts:205`), so it is very likely mid-handshake when `waitUntilReady` is entered. Consider the interleaving:

1. `waitUntilReady` reads `c.status` → `'connecting'`, so it does **not** short-circuit.
2. The ioredis client finishes its handshake and emits `'ready'` from an I/O callback **before** line 137 runs.
3. `waitUntilReady` then calls `c.once('ready', onReady)` — but `ready` has already fired and will never fire again.
4. No `error` is emitted (the connection is healthy).
5. The `setTimeout` fires after `timeoutMs`.

On the **boot path** (`index.ts:113`, `rejectOnTimeout` defaults to `false`) the timeout silently resolves — a 2s boot stall, no failure. On the **idempotency path** (`idempotency.ts:246`, `rejectOnTimeout: true`) the timeout **rejects** with `valkey: not ready within 2000ms`. `subscribeToChannel` then tears down the freshly-allocated (and actually-ready) subscriber connection and rethrows, so the follower's `awaitStreamResult` / `awaitNonStreamResult` fails. Net effect: a healthy multiplexed follower request intermittently hangs 2s then errors (504) and a usable Valkey connection is discarded — exactly the path this phase is hardening.

The pre-refactor inline code (now deleted) had the same race, so this is not introduced by the extraction — but the extraction was the chance to fix it and did not.

**Fix:** Re-check `status` after attaching the listeners to close the window:

```ts
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    c.removeListener?.('ready', onReady);
    c.removeListener?.('error', onError);
    if (opts.rejectOnTimeout) reject(new Error(`valkey: not ready within ${timeoutMs}ms`));
    else resolve();
  }, timeoutMs);
  const onReady = (): void => {
    clearTimeout(timer);
    c.removeListener?.('error', onError);
    resolve();
  };
  const onError = (err: unknown): void => {
    clearTimeout(timer);
    c.removeListener?.('ready', onReady);
    reject(err instanceof Error ? err : new Error(String(err)));
  };
  c.once?.('ready', onReady);
  c.once?.('error', onError);
  // Close the TOCTOU window: status may have flipped to 'ready' between the
  // initial guard and listener attachment, in which case 'ready' already fired.
  if (c.status === 'ready') {
    clearTimeout(timer);
    c.removeListener?.('ready', onReady);
    c.removeListener?.('error', onError);
    resolve();
  }
});
```

## Warnings

### WR-01: Boot path is documented as fail-open but rejects on a Valkey `error` event — Valkey-down at boot crashes the router

**File:** `router/src/index.ts:113` (helper at `router/src/clients/valkey.ts:132-135`)

**Issue:**
The boot call is `await waitUntilReady(valkey);` with no try/catch and `rejectOnTimeout` defaulting to `false`. The comment at `index.ts:106-112` claims fail-open: "if Valkey never becomes ready within 2000ms, waitUntilReady resolves and the existing try/catch ... handle the Valkey-down case." That is true only for the **timeout** branch. The **`error` branch** (`valkey.ts:132-135`) calls `reject(...)` regardless of `rejectOnTimeout`. If the client emits `'error'` during the readiness window — `ECONNREFUSED`, wrong `VALKEY_PASSWORD`, etc., i.e. the canonical "Valkey down at boot" case — `waitUntilReady` rejects, the unguarded `await` propagates out of `main()`, and the process dies via the top-level catch (`index.ts:298-313`). That is the opposite of the documented intent: a Valkey outage should let the router boot from the file (the source of truth), not crash it.

**Fix:** Wrap the boot call so the error branch is tolerated:
```ts
try {
  await waitUntilReady(valkey);
} catch (err) {
  bootLog.warn({ err }, 'valkey not ready at boot; continuing with file-load fallback');
}
```
(Or make the helper honor `rejectOnTimeout` for the error branch as well, so fail-open never rejects.)

### WR-02: `waitUntilReady` never settles on terminal connection states (`end`/`close`); fail-closed path burns the full timeout on a known-dead socket

**File:** `router/src/clients/valkey.ts:114-139`

**Issue:**
The promise settles only on `ready`, `error`, or the timeout. ioredis can reach `status === 'end'` and emit `'end'`/`'close'` **without** `'error'` (connection closed with no reconnection — plausible given `enableOfflineQueue: false` + `maxRetriesPerRequest: 1`, or a `disconnect()` elsewhere). In that state the connection will never become ready, yet `waitUntilReady` blocks the entire `timeoutMs` (2s) before settling. On the idempotency fail-closed path that is 2s of dead wait per follower before the inevitable reject; on boot it is 2s of stall. Given the explicit fail-fast intent in `valkey.ts:10-20`, waiting out the timeout on a dead socket contradicts the design.

**Fix:** Also listen for `'end'` and settle immediately (reject when `rejectOnTimeout`, resolve otherwise); remove the `'end'` listener in `onReady`/`onError` for symmetry.

### WR-03: 300s boot-warm cache can serve a stale registry over an edited `models.yaml` on cold boot — staleness window widened 10x

**File:** `router/src/index.ts:123-134`, `router/src/config/registryCache.ts:40-41`

**Issue:**
On a warm-cache hit, `initialRegistry` is taken from Valkey (`index.ts:127`) in preference to the file. The cache key `registry:models-yaml:cache:v1` carries no fingerprint of the file's content/mtime. If `models.yaml` is edited while the router is **down**, the next cold boot serves the **stale** cached registry for the remaining TTL — now up to 300s instead of 30s — logs "warm cache hit (Valkey)", and silently ignores the on-disk edit until the cache expires or a hot-reload fires. The file is documented as the source of truth (D-D4); preferring a 5-minute-stale cache over the file on a cold boot violates that, and the TTL bump multiplies the exposure window 10x. (`assertCloudEnvIfConfigured` still runs against the cached registry at `index.ts:140`, so the cloud-env gate itself is preserved — this is a freshness bug, not an auth bypass.)

**Fix:** Incorporate the file's mtime/size or a content hash into the cache key, or stat the file at boot and only trust the cache when the file is unreadable. If boot-warm-over-file is intentional, document the now-300s staleness window explicitly.

### WR-04: Primary Valkey client is never gracefully closed on shutdown; the tested `closeValkey` QUIT-race path is dead in production

**File:** `router/src/index.ts:74-78, 255-269`

**Issue:**
`makeValkeyClient` opens an eager connection at `index.ts:74`. `closeGracefully` (`index.ts:255-269`) stops the watcher, closes the app, and ends the pg pool, but never calls `closeValkey(valkey)`. The QUIT-with-1s-race helper added for exactly this purpose (`valkey.ts:60-76`, tested in `valkey.test.ts:248-291`) never runs for the primary client — the connection is released only when `process.exit(0)` kills the process. In-flight Valkey commands are abandoned rather than drained, and the tested graceful path has no production caller.

**Fix:** Add `await closeValkey(valkey, app.log);` inside `closeGracefully` before `process.exit(0)`, alongside the existing `app.close()` / `pool.end()` teardown.

## Info

### IN-01: Stale comment — `index.ts` still calls the cache "30s ... read-through" after the 300s/boot-warm rename

**File:** `router/src/index.ts:80, 84`

**Issue:**
`registryCache.ts:1-10` was explicitly updated to drop the "read-through" misnomer and the 30s figure, but `index.ts:80` still reads "30s Valkey-backed read-through cache for the parsed models.yaml" and `index.ts:84` calls it a "read-through cache." These now contradict the corrected source doc and the actual 300s TTL.

**Fix:** Update `index.ts:80-84` to "300s Valkey-backed boot-warm cache" to match `registryCache.ts`.

### IN-02: Test docstring claims TTL 30s while the assertions check 300s

**File:** `router/tests/config/registryCache.test.ts:13, 70`

**Issue:**
The file header (line 13) documents "Test 5 (set TTL): set(reg) calls valkey.set with 'EX', 30" but the constant `TTL_SEC = 300` and the line-172 assertion check `300`. Only the inline test-5 title (line 163) was updated for the gap-closure; the header docstring is stale.

**Fix:** Update the line-13 docstring to "'EX', 300".

### IN-03: `waitUntilReady` TOCTOU race (CR-01) is uncovered by tests — the suite only drives the `connecting → emit ready` happy ordering

**File:** `router/tests/clients/valkey.test.ts:189-245`

**Issue:**
Tests C and F drive `connecting`-then-`_emit('ready')`, and test A covers the already-`'ready'` short-circuit, but nothing covers the CR-01 interleaving: status `'connecting'` at the guard with `ready` having **already fired** before the listener attaches. Because the fake client's `_emit` is driven manually after the call, the harness can't reproduce the production race, giving false confidence that the fail-closed path is safe — which is why CR-01 shipped.

**Fix:** Add a test where the fake client flips to `'ready'` synchronously during the `once('ready', …)` registration window, asserting `waitUntilReady(client, 100, { rejectOnTimeout: true })` resolves. After the CR-01 status re-check fix it passes; before it, it reproduces the spurious reject.

---

_Reviewed: 2026-05-27T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
