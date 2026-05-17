---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 07
subsystem: resilience
tags: [idempotency, valkey, sse, pubsub, retry-storm, route-12]

requires:
  - phase: 08
    provides: Plan 08-01 (DATA-06 — Valkey client wired into BuildApp); Plan 08-04 (CLOUD-03 breaker pattern as the model for Valkey-backed state machines); Plan 08-06 (ROUTE-11 rate-limit's fail-soft Valkey discipline + bearerHash module shape)
provides:
  - Idempotency-Key multiplexer (router/src/resilience/idempotency.ts) — SETNX + pub/sub + chunks LRANGE replay
  - InvalidIdempotencyKeyError envelope class (400 + invalid_request_error + invalid_idempotency_key + param 'Idempotency-Key')
  - extractIdempotencyKey validation helper (regex /^[A-Za-z0-9._:-]{1,256}$/, duplicate-header rejection)
  - Leader/follower wiring on /v1/chat/completions (stream + non-stream)
  - Leader/follower wiring on /v1/messages (stream + non-stream)
  - Leader/follower wiring on /v1/embeddings (non-stream only)
  - Shared upstream_message_id propagation from leader to follower request_log rows (Plan 08-08 cost-attribution grouping)
affects: [08-08, 08-10]

tech-stack:
  added: []
  patterns:
    - "Valkey pub/sub multiplexer with HYBRID subscribe-first + LRANGE-replay strategy (avoids both the missed-chunk race and the poll-spam alternatives)"
    - "Async-iterable wrapper around upstream stream that fire-and-forget publishes each canonical event to the channel BEFORE yielding (publish/yield co-located keeps the wire ordering deterministic)"
    - "Test override seam `timeoutMs` on the multiplexer factory mirrors `breakerNow` / `rateLimitNow` — avoids `vi.useFakeTimers()` which freezes Fastify's app.inject internals"
    - "Followers never acquire the per-backend semaphore (Phase 3 ROUTE-07) — that's the cost-saving the multiplexer provides; leader holds 1 slot, N followers hold 0"

key-files:
  created:
    - router/src/resilience/idempotency.ts
    - router/src/middleware/idempotencyKey.ts
    - router/tests/resilience/idempotency.test.ts
    - router/tests/routes/idempotency-integration.test.ts
  modified:
    - router/src/errors/envelope.ts
    - router/src/metrics/recordOutcome.ts
    - router/src/app.ts
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/routes/v1/embeddings.ts

key-decisions:
  - "TTL ceiling 30 min on lock SETNX EX 1800 — bigger than any reasonable stream — guarantees stale locks from a crashed leader self-clean naturally (D-D6)."
  - "Data TTL 15 min (900s) on result + chunks keys after finalize — late-arriving followers within 15 min get cached replay; after that the key is GC'd (D-D6 explicit ceiling)."
  - "Terminal markers distinguished via a `$terminal` field on the channel payload that canonical stream events never use — discriminant is unambiguous without inspecting payload shape."
  - "Subscriber connections are ioredis-duplicated per ioredis pub/sub semantics (a subscribed connection cannot issue other commands). subscriberFactory opt makes the production wire (valkey.duplicate()) and the test wire (a mock-aware factory) symmetric."
  - "Single-user single-bearer scope (T-08-T-07 accept): the key namespace `idempotency:${key}:*` is global; multi-tenant would prefix with bearer hash. Out of scope for v1."
  - "Fire-and-forget publish on the leader's per-event hot path — the Valkey RTT (sub-ms in-network) must NOT serialize behind the upstream → SSE pipeline. Failures log + continue (the follower may miss an event but receives the terminal marker eventually)."

patterns-established:
  - "Idempotency-Key as the SOLE retry-storm guard for SDK-driven retries — agents with default exponential-backoff supply the header automatically; storms without the header are bounded by Plans 08-04 (breaker) + 08-06 (rate-limit) + Phase 3 (per-backend semaphore)."
  - "request_log rows for leader + N followers share upstream_message_id — Plan 08-08's cloud_spend_daily aggregation MUST collapse via GROUP BY upstream_message_id so 1 charged generation appears as 1 row regardless of follower count."
  - "Test override seam (`timeoutMs`) for clock-dependent timeouts — avoids fake-timer freezes inside Fastify's internal timer machinery."

requirements-completed: [ROUTE-12]

duration: 45min
completed: 2026-05-17
---

# Phase 8 Plan 07: Idempotency-Key multiplexer (ROUTE-12) Summary

**Valkey-backed SETNX + pub/sub multiplexer that collapses N concurrent same-key retries into ONE upstream generation, with byte-identical SSE replay for stream followers — closes PITFALLS Pitfall 14 for SDK-driven retries.**

## Performance

- **Duration:** ~45 min (3 atomic tasks)
- **Started:** 2026-05-17T17:00:00Z
- **Completed:** 2026-05-17T17:23:00Z
- **Tasks:** 3 of 3 (each atomic, each verified)
- **Files modified:** 6 source files + 2 test files + 1 new validator module + 1 new resilience module = 10 files touched
- **Test growth:** 638 → 662 (+24: 15 unit + 9 integration; 2 pre-existing skipped)

## Accomplishments

- **ROUTE-12 closes.** 8 concurrent same-key retries consume 1 upstream generation; 8 SSE responses receive byte-identical event sequences. The leader's `for await (const event of upstream)` loop fire-and-forget publishes each canonical event to a Valkey channel BEFORE yielding to the SSE translator; followers SUBSCRIBE FIRST then LRANGE the chunks list (hybrid race-free strategy).
- **PITFALLS Pitfall 14 closes** for SDK-driven retries that supply Idempotency-Key. Storms WITHOUT the header are still bounded by the 3-layer stack from Plans 08-04 + 08-06 + Phase 3 (breaker + rate-limit + semaphore).
- **Plan 08-08 cost-attribution dashboard is unblocked.** Leader + N followers' request_log rows share `upstream_message_id`; GROUP BY collapses them to a single charged generation.
- **InvalidIdempotencyKeyError envelope class** with the full taxonomy mapping (400 + invalid_request_error + invalid_idempotency_key + param 'Idempotency-Key' on OpenAI; invalid_request_error on Anthropic). Mirrors the InvalidAgentIdError shape from Plan 05-02.

## Task Commits

Each task was committed atomically:

1. **Task 1: Validator + InvalidIdempotencyKeyError + multiplexer module + 15 unit tests** — `4ac2908` (feat). Module surface: `acquire` (SETNX EX 1800 → leader/follower), `publishNonStream` (SET EX 900 result + PUBLISH 'done'), `publishStreamEvent` (RPUSH + PUBLISH), `finalizeStream` (SET EX 900 + EXPIRE 900 + PUBLISH terminal), `awaitNonStreamResult` (SUBSCRIBE → GET → block → IdempotencyTimeoutError), `awaitStreamResult` (async iterable that yields cached + future events with terminal yield).

2. **Task 2: app.ts construction + non-stream route wiring + 6 integration tests** — `7e5b06c` (feat). Multiplexer constructed in buildApp (gated on `opts.valkey`, `subscriberFactory = () => opts.valkey.duplicate()`). 3 route handlers extract Idempotency-Key via `extractIdempotencyKey`, acquire role between breaker.check + semaphore.acquire, follower path returns cached body, leader path publishes after reply.send.

3. **Task 3: Stream branch wiring + 3 stream integration tests** — `ac31b36` (feat). Stream follower path pipes `awaitStreamResult` iterator through the same canonical SSE translator the leader uses (`canonicalToOpenAISse` / `canonicalToAnthropicSse` with the same `displayModel` — guarantees byte-identical wire output). Leader stream path wraps the upstream iterable in a generator that publishes events fire-and-forget BEFORE yielding to the translator; `sseCleanup` finalizes with terminal='done' / 'error' / 'aborted'.

**Plan metadata commit:** _(this commit — docs)_

## Files Created/Modified

### Created

- `router/src/resilience/idempotency.ts` (460 lines) — `makeIdempotencyMultiplexer` factory + `subscribeToChannel` helper + `IdempotencyTimeoutError` class. Constants: `IDEMPOTENCY_TIMEOUT_MS=30_000`, `IDEMPOTENCY_DATA_TTL_SEC=900`, `IDEMPOTENCY_LOCK_TTL_SEC=1800`. Key namespacing `idempotency:${key}:{lock|result|chunks|channel}`. Terminal-discriminant via `$terminal` field on payloads.
- `router/src/middleware/idempotencyKey.ts` (40 lines) — `extractIdempotencyKey` helper + KEY_RE regex `/^[A-Za-z0-9._:-]{1,256}$/`. Rejects array (duplicate-header) form per RFC 9110 §5.3 single-value convention.
- `router/tests/resilience/idempotency.test.ts` (420 lines) — 15 tests: 5 for the validator (undefined / ULID / UUID / regex violations / duplicates), 9 for the multiplexer state machine (acquire roles, publish + finalize, race-free subscribe-first, replay, terminal markers, timeout), 1 for different-keys parallel leadership.
- `router/tests/routes/idempotency-integration.test.ts` (650 lines) — 9 end-to-end tests against buildApp: 5 non-stream (chat 5x, messages 3x, embeddings 2x, invalid key, no-key + sequential), 3 stream (chat 3x, messages 3x, sequential replay), 1 sequential non-stream. Hand-rolled Valkey mock with shared `EventEmitter` pub/sub bus across `duplicate()` connections.

### Modified

- `router/src/errors/envelope.ts` — `InvalidIdempotencyKeyError` class + mapToHttpStatus mapping (400) + OpenAI envelope branch (`invalid_request_error` / `invalid_idempotency_key` / param `Idempotency-Key`) + Anthropic envelope branch (`invalid_request_error`).
- `router/src/metrics/recordOutcome.ts` — `mapErrorToCode` bucket label `invalid_request` for `InvalidIdempotencyKeyError` (parity with `InvalidAgentIdError`).
- `router/src/app.ts` — construct multiplexer after Plan 08-01's Valkey decoration; thread `idempotency` into chat/messages/embeddings route registration.
- `router/src/routes/v1/chat-completions.ts` — Idempotency-Key extraction + acquire; non-stream follower replay; stream follower path; leader-side per-event publish via wrapped iterable; leader-side `finalizeStream` in `sseCleanup`; `upstreamMessageId` captured from `message_start` event and threaded into both leader + follower request_log rows.
- `router/src/routes/v1/messages.ts` — same wiring on the Anthropic surface (`canonicalToAnthropicSse`, `startAnthropicHeartbeat`).
- `router/src/routes/v1/embeddings.ts` — non-stream multiplexer wiring (no stream branch).

## Decisions Made

- **Test override seam `timeoutMs` on the multiplexer factory** (auto-added — see Deviations Rule 3). The plan called for 30s timeout testing via `vi.useFakeTimers`, but that freezes Fastify's internal timers and breaks `app.inject`. Adding a `timeoutMs` constructor opt mirrors the existing `breakerNow` / `rateLimitNow` seams from Plans 08-04 / 08-06; production wiring omits it (defaults to `IDEMPOTENCY_TIMEOUT_MS=30_000`).
- **Fake adapter reads `pauseBetweenEvents` flag LIVE inside the generator** (auto-added — see Deviations Rule 1). Initial capture-at-generator-start approach left followers blocked waiting for events that would never come because the test's mid-stream flag flip didn't propagate. Reading the flag live made Test 6 + Test 7 deterministic.
- **Followers never acquire the per-backend semaphore.** This is the explicit cost-saving the multiplexer provides — leader holds 1 slot, N followers hold 0. If followers acquired slots, the multiplexer would degrade to "saves the adapter call but still consumes concurrency", which defeats the purpose at the per-backend cap (Phase 3 ROUTE-07's 2 default for cloud, 1 for vLLM).
- **Per-event `publishStreamEvent` is fire-and-forget**, not awaited. Valkey RTT (sub-ms in-network) must not serialize behind the upstream → SSE pipeline. The downside is that a Valkey blip mid-stream may cause a follower to miss an event; the upside is that the leader's wire latency is unchanged. The terminal marker is also fire-and-forget but uses `.catch` to log + suppress, so unhandled-rejection warnings don't bubble.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test override seam `timeoutMs` on the multiplexer factory**
- **Found during:** Task 1 (Test 9 — follower timeout when leader hangs).
- **Issue:** The plan's Test 9 spec assumed `vi.useFakeTimers()` + `vi.advanceTimersByTime(IDEMPOTENCY_TIMEOUT_MS + 100)` would deterministically fire the 30s timeout, but vitest's fake timers conflict with Fastify v5's internal timer machinery — `app.inject` hangs indefinitely under fake timers and the existing `breakerNow` + `rateLimitNow` injection seams (Plans 08-04 + 08-06) explicitly exist for this reason.
- **Fix:** Added an optional `timeoutMs` opt to `MakeIdempotencyMultiplexerOpts` defaulting to `IDEMPOTENCY_TIMEOUT_MS=30_000` (D-D6 unchanged in production). Test 9 passes `timeoutMs=200` to exercise the timeout path in <1s without fake timers.
- **Files modified:** router/src/resilience/idempotency.ts, router/tests/resilience/idempotency.test.ts
- **Verification:** Test 9 passes deterministically; the production default value matches D-D6.
- **Committed in:** `4ac2908` (Task 1 commit)

**2. [Rule 1 - Bug] Fake adapter must read pauseBetweenEvents LIVE inside the async generator**
- **Found during:** Task 3 stream integration tests (Tests 6 + 7 hung at 5s timeout).
- **Issue:** The initial fake adapter captured `streamHook.pauseBetweenEvents` into a local `hookPause` constant at generator-start time. When tests later flipped the flag to `false` and released pending pauses, the generator's loop still saw the captured `true` value and queued ANOTHER pause on the next iteration — leading to a deadlock where followers waited for events the leader never emitted.
- **Fix:** Read `streamHook.pauseBetweenEvents` live inside the generator loop. Tests can flip the flag mid-stream and have subsequent events flow without pause.
- **Files modified:** router/tests/routes/idempotency-integration.test.ts
- **Verification:** Tests 6 + 7 pass in <200ms each; the leader stream completes deterministically after the test releases all pending pauses.
- **Committed in:** `ac31b36` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking — Rule 3; 1 test bug — Rule 1).
**Impact on plan:** Both deviations were necessary for testability; neither changed the production semantics. The `timeoutMs` seam mirrors existing patterns (breakerNow / rateLimitNow) and the fake-adapter fix is a test-infrastructure correction.

## Issues Encountered

- **Test 5 chunks serialization assertion was wrong in the initial draft.** The plan's Test 5 said "RPUSHes each event JSON" but didn't specify the wrapping. My implementation wraps events as `{event: ...}` so the channel payload has a consistent shape (terminal payloads use `$terminal` field; stream events use `event` field). Updated the test assertion to parse `.event` instead of expecting the raw canonical event JSON.
- **Initial Valkey mock `on('message', ...)` was malformed** (registered handlers via the bus directly without channel routing). Rewrote to track per-connection `messageListeners[]` array + per-channel `busListeners[]` map; `subscribe(channel)` attaches a bus handler that fans out via the message listeners, matching ioredis's actual event signature `'message' (channel, message)`. After the rewrite, all 15 unit tests pass.

## User Setup Required

None. The multiplexer engages automatically when a request supplies the `Idempotency-Key` header AND a Valkey client is wired (production always; test fixtures opt-in). Operators don't need to provision anything beyond the existing Valkey deployment from Plan 08-01.

## Next Phase Readiness

- **Plan 08-08 (cloud_spend_daily aggregation)** can now collapse leader + followers via `GROUP BY upstream_message_id`. The shared `upstream_message_id` is the dedup key the cost-attribution dashboard relies on.
- **Plan 08-10 (smoke tests)** has the verification target: `bin/smoke-test-cloud.sh` should fire 3+ concurrent same-key requests against a live cloud model and assert (a) identical response bodies and (b) ONE row in `cloud_spend_daily` for that `upstream_message_id`.
- **Cloud-cost-protection layer 4/4 complete.** The full stack now reads: rate-limit (RPM cap, Plan 08-06) → breaker (per-backend trip, Plan 08-04) → max_tokens cap (cloud-only, Plan 08-05) → idempotency mux (per-key dedupe, Plan 08-07). Each layer is independent; together they bound retry-storm cost without coordination.

## Self-Check: PASSED

Verified before declaring complete:

- `router/src/resilience/idempotency.ts` exists, exports `makeIdempotencyMultiplexer` + `IdempotencyTimeoutError` + constants.
- `router/src/middleware/idempotencyKey.ts` exists, exports `extractIdempotencyKey` with the regex `/^[A-Za-z0-9._:-]{1,256}$/`.
- `InvalidIdempotencyKeyError` defined in envelope.ts; wired into mapToHttpStatus + toOpenAIErrorEnvelope + toAnthropicErrorEnvelope + recordOutcome.mapErrorToCode.
- All 3 routes (chat / messages / embeddings) grep `extractIdempotencyKey` AND `publishNonStream`; chat + messages additionally grep `publishStreamEvent` + `finalizeStream` + `awaitStreamResult`.
- Commit hashes verified: `4ac2908` (Task 1) + `7e5b06c` (Task 2) + `ac31b36` (Task 3) all in `git log --all`.
- `npm test` clean: 662 passed | 2 skipped (664 total) across 3 consecutive runs.
- `npm run build` clean: ESM 181.41 KB.

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Plan: 07*
*Completed: 2026-05-17*
