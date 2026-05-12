---
phase: 02-mvp-vertical-slice-router-ollama-sse
fixed_at: 2026-05-12T16:28:00Z
review_path: .planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 2: Code Review Fix Report

**Fixed at:** 2026-05-12T16:28:00Z
**Source review:** `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-REVIEW.md`
**Iteration:** 1
**Worktree:** `/tmp/sv-02-reviewfix-1wf7Dn` on branch `gsd-reviewfix/02-72675`
**Fix scope:** `critical_warning` (0 critical, 7 warnings; INFO findings out of scope per workflow)

**Summary:**

- Findings in scope: 7 (WR-01 through WR-07)
- Fixed: 7
- Skipped: 0

This run was a **resumption** — a prior fixer landed WR-01 (`3857a34`) and WR-02 (`6b096fa`) before hitting the Anthropic usage cap. It also had an uncommitted in-progress WR-03 edit that was reverted before this run started. This iteration applied WR-03..WR-07 fresh.

All 66 vitest tests pass (2 unrelated skips); `tsc --noEmit` is clean across the router.

## Fixed Issues

### WR-01: Heartbeat reports wrong byte count (off-by-2 per beat)

**Files modified:** `router/src/sse/heartbeat.ts`
**Commit:** `3857a34` (landed by prior run — verified in this run)
**Applied fix:** Lifted the payload literal to a module-level constant and replaced the hard-coded `bytes += 16` with `bytes += HEARTBEAT_PAYLOAD_BYTES`, where the byte count is computed once with `Buffer.byteLength(HEARTBEAT_PAYLOAD, 'utf8')`. The "16 bytes" comment is also gone — replaced with the correct "14 bytes UTF-8" assertion. Matches the review's "more robust" variant rather than the inline `bytes += 14` minimal patch.

### WR-02: Bearer scheme match is case-sensitive (RFC 7235 violation)

**Files modified:** `router/src/auth/bearer.ts`
**Commit:** `6b096fa` (landed by prior run — verified in this run)
**Applied fix:** Compared `auth.slice(0, 7).toLowerCase() === 'bearer '` instead of `startsWith('Bearer ')`. The 7-byte prefix is the only thing lowered; the credential bytes after the scheme are still passed to `timingSafeEqual` verbatim, preserving the constant-time property. `bearer foo`, `BEARER foo`, etc. are now accepted as RFC 7235 §2.1 requires.

### WR-03: `main()` rejection at startup is unhandled (noisy fatal path)

**Files modified:** `router/src/index.ts`
**Commit:** `0156c57`
**Applied fix:** Replaced `void main();` with `main().catch((err) => { ... })`. The catch handler writes a single pino-shaped JSON line on stderr (`level: 60`, `msg: 'failed to start'`, with `err.{name, message, stack}`) before `process.exit(1)`. Pre-listen throws from `loadEnv`, `loadRegistryFromFile`, `buildApp`, and `makeLoggerOptions` now surface as structured logs instead of unhandled-promise stack traces. Matches the review's recommended snippet.

### WR-04: Heartbeat is started before reply.sse() — leaks interval if reply.sse rejects synchronously

**Files modified:** `router/src/routes/v1/chat-completions.ts`
**Commit:** `ef26725`
**Applied fix:** Wrapped `await reply.sse(...)` in `try { ... } finally { heartbeat.stop(); }`. `heartbeat.stop()` is idempotent (early-return on the internal `stopped` flag), so the existing `sseCleanup` and `onClose` paths can still call it without double-firing. If `reply.sse(...)` rejects synchronously (headers already sent, plugin in a degraded state), the heartbeat is now stopped via the `finally` block instead of leaking an unref'd interval until the next EPIPE.

### WR-05: `req.raw.socket` may be undefined — abort listener silently no-ops

**Files modified:** `router/src/routes/v1/chat-completions.ts`
**Commit:** `d9136e6`
**Applied fix:** Promoted the silent optional-chain (`req.raw.socket?.once('close', onClose)`) to an explicit branch: if `req.raw.socket` is truthy, attach the listener (production behaviour unchanged); otherwise emit `req.log.warn({ url }, '... abort propagation may not fire (HTTP/2 or inject?)')`. The three downstream `.off('close', onClose)` cleanup sites keep optional chaining because they're inherently no-op-safe when the listener was never attached. Matches the review's option (a) — log-and-observe rather than `req.socket`/`reply.raw` rewires, on the grounds that visibility of the degraded path is the higher-value fix today.

### WR-06: `BearerAuthError` is dead code — defined and re-exported but never thrown

**Files modified:** `router/src/auth/bearer.ts`, `router/tests/unit/bearer.test.ts`
**Commit:** `5692373`
**Applied fix:** Picked the **"throw" variant** the review recommends after verifying that `app.setErrorHandler` (`app.ts:51-60`) is wired and routes `BearerAuthError` through `toOpenAIErrorEnvelope` → 401 / `authentication_error` / `unauthorized` — bit-identical to the prior inline envelope.

Concretely:
- Both bearer-hook short-circuit paths (`reply.code(401).send({...})`) replaced with `throw new BearerAuthError('Missing or malformed Authorization header')` and `throw new BearerAuthError('Invalid bearer token')` respectively.
- Inner function renamed from `bearerPreHandler` to `bearerOnRequest` (IN-04-adjacent — the production wiring at `app.ts:46` is `onRequest`, so the function name now matches the registered phase).
- Unit test (`tests/unit/bearer.test.ts`) updated to register the same `setErrorHandler` shape and to use `onRequest` instead of `preHandler`. The SC5 leak-test case also wires `setErrorHandler` so the throw flows through the central `req.log.warn` path.

Result: the `instanceof BearerAuthError` branches in `errors/envelope.ts` (lines 34 and 52) are now reachable in production. The duplicate envelope literal in `bearer.ts` is gone. All 6 integration auth tests and 8 unit bearer tests still pass.

**Note:** The previous `bin/smoke-test-router.sh` SC4 path checks `error.code === "unauthorized"` and `error.type === "authentication_error"` — both preserved by the central envelope, so the SC4 smoke test does not need to change.

### WR-07: `chunkToSseEvents` swallows non-aborted APIUserAbortError without terminator

**Files modified:** `router/src/sse/stream.ts`
**Commit:** `d364c59`
**Applied fix:** Split the catch block into three cases:
- `opts.signal?.aborted === true` (our abort): silently return — the client is gone, no terminator needed.
- `toOpenAIErrorEnvelope(err) === NO_ENVELOPE` AND we did NOT abort (upstream's own abort path): yield `{ event: '', data: '[DONE]' }` before returning so strict clients close cleanly.
- Otherwise: emit the existing D-C2 mid-stream error frame.

The router's "every stream ends with data: `[DONE]`" contract (documented in the same file's leading comment) is now preserved for non-router-initiated aborts. Matches the review's recommended snippet verbatim.

## Skipped Issues

None — all 7 in-scope warnings were fixed cleanly.

## Out of Scope

INFO findings IN-01 through IN-06 were not touched per the resumption-context directive:

- IN-01: dead `OLLAMA_URL` env field
- IN-02: dead `?? '/'` fallback in `bearer.ts` split
- IN-03: leftover smoke-test canary comments in `models.yaml`
- IN-04: unit test uses `preHandler`, production uses `onRequest` — **partially addressed as a side effect of WR-06** (unit test now uses `onRequest`; function renamed to `bearerOnRequest`). The standalone IN-04 fix is therefore mostly subsumed by this iteration's WR-06 commit.
- IN-05: SC3 integration test name overstatement
- IN-06: optional-call `id.unref?.()` in heartbeat

Recommend a follow-up `--fix=info` pass to clean these up.

## Verification Performed

- `npx tsc --noEmit` clean after every commit (5 invocations).
- Targeted vitest sweep after each fix: bearer+envelope unit tests, SSE stream unit tests, full integration auth suite.
- Final full-suite run: **10 test files passed, 66 tests passed, 2 skipped (unrelated)** with no new skips introduced.
- Manual inspection of `git diff HEAD~5..HEAD --stat` confirms changes are scoped:
  ```
  router/src/auth/bearer.ts                 |  16 ++++------------
  router/src/index.ts                       |  17 ++++++++++++++++-
  router/src/routes/v1/chat-completions.ts  |  31 ++++++++++++++++++++++++++-----
  router/src/sse/stream.ts                  |  16 ++++++++++++++--
  router/tests/unit/bearer.test.ts          |  20 ++++++++++++++++++--
  ```

## Branch / Worktree State

- Worktree: `/tmp/sv-02-reviewfix-1wf7Dn`
- Branch: `gsd-reviewfix/02-72675` (5 new commits ahead of `master`, plus 2 from prior run = 7 fix commits total)
- Main repo `master` is unchanged at `1c192c5` (no fast-forward attempted — orchestrator handles merge).
- Working tree is clean; no uncommitted changes.

---

_Fixed: 2026-05-12T16:28:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
