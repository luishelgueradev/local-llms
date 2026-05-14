---
phase: 05-postgres-observability-seam
plan: 02
subsystem: observability
tags: [prom-client, metrics, request-log, recordOutcome, agent-id, prehandler, safe-record, truncate-redact, fastify-hooks]

# Dependency graph
requires:
  - phase: 05-postgres-observability-seam
    plan: 01
    provides: "BufferedWriter contract (push/drain/size) wired into BuildAppOpts; RequestLogInsert type; droppedCounter STUB to replace"
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision
    provides: "canonicalToOpenAISse + canonicalToAnthropicSse onCleanup callback shape; CanonicalResponse.usage + canonical msg_<ulid> id"
  - phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
    provides: "safeRelease idempotency pattern that safeRecord mirrors (Pitfall 8); BackendSaturatedError class"
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: "pino redact config, bearer skip-list pattern, heartbeat.msSinceStart TTFT source, error envelope shape"
provides:
  - "GET /metrics on port 3000 (unauth via skip-list) — Prometheus text/plain;version=0.0.4 with 5 custom router_* metrics + Node defaults"
  - "5 prom-client metrics: router_requests_total / router_request_duration_seconds / router_ttft_seconds / router_tokens_total / router_log_buffer_dropped_total — low-cardinality labels only (D-C3)"
  - "makeMetricsRegistry() factory — fresh Registry per call (Pitfall 2 regression gate); pass-through registers:[register] on every metric"
  - "X-Agent-Id round-trip: regex-validated preHandler → req.agentId → pino child logger → request_log.agent_id column (D-D5 / ROUTE-09)"
  - "InvalidAgentIdError class on envelope.ts mirroring CapabilityNotSupportedError shape (parallel OpenAI + Anthropic envelope branches)"
  - "single recordOutcome helper that BOTH observes 5 metrics AND enqueues a request_log row populated per D-D6 field map (D-C6)"
  - "truncateAndRedact regex set strips Bearer / Authorization / apiKey / api_key / api-key patterns to literal [REDACTED] before write (D-D3 + Pitfall 12)"
  - "deriveStatusClass(httpStatus, clientAborted) → D-C4 mapping with clientAborted precedence"
  - "mapErrorToCode(err) → D-D2 taxonomy covering every typed error class in envelope.ts plus zod / fastify-zod sentinels"
  - "safeRecord idempotent closure per request (Pitfall 8) — sseCleanup may fire twice; second call is a no-op"
  - "app.setErrorHandler also records — covers pre-resolve errors (unknown_model thrown before route body) and preHandler errors (InvalidAgentIdError)"
  - "Plan 01 droppedCounter stub replaced with real metrics.logBufferDroppedTotal Counter"
  - "TODO comment in bearer.ts flagging Phase 6 Traefik /metrics blacklist follow-up (Pitfall 11)"
  - "onCleanup signature in openai-out.ts + anthropic-out.ts widened to expose final {tokensIn, tokensOut} (anthropic also exposes upstreamMessageId) so routes don't re-aggregate"
affects: [05-03-pg-dump-cron, 05-04-readyz-postgres-probe-smoke, 06-traefik-open-webui, 07-prometheus-grafana]

# Tech tracking
tech-stack:
  added: []  # prom-client@^15.1.3 was already declared by Plan 01; this plan is the first consumer.
  patterns:
    - "Pattern A — Fresh prom-client Registry per buildApp (Pitfall 2 regression gate): `new Registry()` + `collectDefaultMetrics({ register })` + `registers: [register]` on every Counter/Histogram"
    - "Pattern B — Single helper, two effects (D-C6): metric observe + bufferedWriter.push co-located so label set + column set cannot drift"
    - "Pattern C — Idempotent record closure (Pitfall 8 / mirrors semaphore safeRelease): `recorded: boolean` flag + early return; sets req.__recorded so setErrorHandler skips"
    - "Pattern D — Hook ordering: onRequest:bearer → preHandler:agentId — bearer gates first, agent-id is post-auth metadata enrichment (Fastify v5 verified)"
    - "Pattern E — Precompiled regex set for redaction (BEARER_RE / AUTH_RE / APIKEY_RE module-level) — applied INSIDE recordRequestOutcome before bufferedWriter.push"
    - "Pattern F — Module augmentation `FastifyRequest { agentId?, _t0?, __recorded? }` colocated with agentId middleware"
    - "Pattern G — Translator onCleanup callback widening with OPTIONAL parameter — existing `() => void` callers still type-check; new callers read final {tokensIn, tokensOut[, upstreamMessageId]}"
    - "Pattern H — setErrorHandler dual-purpose: envelope mapping + recordOutcome for pre-route paths (zod / InvalidAgentIdError / RegistryUnknownModelError thrown before route body)"

key-files:
  created:
    - router/src/metrics/registry.ts
    - router/src/metrics/recordOutcome.ts
    - router/src/middleware/agentId.ts
    - router/tests/unit/metricsRegistry.test.ts
    - router/tests/integration/agentIdPreHandler.test.ts
    - router/tests/integration/recordOutcome.test.ts
  modified:
    - router/src/app.ts
    - router/src/index.ts
    - router/src/auth/bearer.ts
    - router/src/errors/envelope.ts
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
    - router/src/translation/openai-out.ts
    - router/src/translation/anthropic-out.ts
    - router/tests/fakes.ts
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
    - router/tests/integration/shutdown.test.ts

key-decisions:
  - "Open Q4 resolution: BackendSaturatedError → status_class='client_error' (4xx group per D-C4 since HTTP is 429) AND error_code='backend_saturated' (D-D2). The taxonomy split is what differentiates saturation from generic 4xx client errors when querying request_log."
  - "Pre-resolve error coverage lives in app.setErrorHandler (NOT route-handler outer try/catch). Cleaner: route handlers do their own recording in finally; setErrorHandler covers the pre-route path (zod / InvalidAgentIdError / unknown_model thrown by registry.resolve before route body). req.__recorded coordinates between the two so we never double-write."
  - "X-Agent-Id preHandler captures req._t0 = performance.now() as the FIRST action — this is the latency_ms source (D-D6). Bearer onRequest already gated by the time the preHandler runs, so the captured timestamp measures only the request-processing portion. This is also the ONLY production req.log reassignment (Pitfall 9 grep gate)."
  - "truncateAndRedact uses LITERAL replacement string '[REDACTED]' — must_haves truth requires the post-redaction text to contain NEITHER the token NOR the literal `Bearer ` substring. Capture-group preservation would leave the keyword visible."
  - "onCleanup signature in anthropic-out.ts ALSO passes upstreamMessageId (canonical msg_<ulid> captured from message_start.message.id BEFORE optional idOverride rewrite). This avoids re-iterating the canonical stream in the route just to surface the id."
  - "tokensTotal counter only increments when tokens > 0 — avoids zero-rate rows in router_tokens_total that would pollute Prometheus storage."
  - "Test 2 in agentIdPreHandler.test.ts sends a VALID body so zod preValidation passes; agentIdPreHandler (preHandler hook) fires AFTER preValidation. With an invalid body, validation 400s before agent-id can decorate the log child. This is correct Fastify v5 ordering (verified)."

patterns-established:
  - "Pattern I — Cardinality discipline: labelNames arrays exclude agent_id/request_id/http_status/error_message (T-5-11). Those columns live in request_log where unbounded cardinality is fine. Grep gate: `grep 'labelNames' src/metrics/registry.ts | grep -cE '<forbidden>' == 0`."
  - "Pattern J — Phase 6 carrier-comment discipline: TODO comments anchored to specific Phase 6 deliverables (Traefik /metrics blacklist) so the follow-up survives plan-handoff. Comment lives at the literal change site (bearer.ts skip-list extension)."

requirements-completed: [DATA-03, OBS-01, ROUTE-09]

# Metrics
duration: 23min
completed: 2026-05-14
---

# Phase 5 Plan 02: Observability Seam Summary

**Five prom-client metrics + per-request request_log row + X-Agent-Id round-trip — wired through a single `recordRequestOutcome` helper that both routes call from sseCleanup (stream) and the non-stream finally, with `safeRecord` idempotency guarding double-fire and `app.setErrorHandler` catching pre-route errors.**

## Performance

- **Duration:** ~23 min
- **Started:** 2026-05-14T18:04:45Z (wave 2 spawn)
- **Completed:** 2026-05-14T18:19:30Z
- **Tasks:** 3 (all `type=auto` + `tdd=true`)
- **Files modified / created:** 22 (6 new under router/src/metrics/, router/src/middleware/, router/tests/; 16 existing files updated)

## Accomplishments

- `GET /metrics` returns Prometheus text/plain;version=0.0.4 with all 5 custom `router_*` metrics plus Node `process_*` / `nodejs_*` defaults. Bearer skip-list extended in `auth/bearer.ts` — `PUBLIC_PATHS = new Set(['/healthz', '/readyz', '/metrics'])`.
- `makeMetricsRegistry()` is idempotent across calls — vitest builds 30+ apps in sequence without `prom-client` "metric already registered" errors (Pitfall 2 regression gate).
- `X-Agent-Id` round-trip works end-to-end: regex-validated by preHandler (post-bearer), attached as `req.agentId`, decorated into `req.log` via `.child({ agent_id })`, surfaced into `request_log.agent_id`. Absent header → `undefined` → `NULL` column. Regex violation → 400 with `code:'invalid_agent_id'` on BOTH wire surfaces.
- `recordRequestOutcome(ctx)` is the single source of truth for label↔column consistency (D-C6) — one helper, two effects, called from BOTH route files at the same lifecycle hook points.
- Plan 01's `droppedCounterStub` in `index.ts` (was `{ inc: () => {} }`) is now the real `metrics.logBufferDroppedTotal` prom-client Counter. `request_log_dropped_total` will increment in production when the bufferedWriter's drop-oldest fires (D-A1).
- `safeRecord` closure (mirrors `safeRelease`) prevents double-writes when sseCleanup fires twice. Sets `req.__recorded = true` so `app.setErrorHandler` does not also record the same outcome.
- `app.setErrorHandler` now records pre-resolve errors — unknown_model thrown by `registry.resolve(body.model)` BEFORE the route's try block runs gets a row with `backend='unknown', model='unknown', status_class='client_error', http_status=404, error_code='unknown_model'`. D-D4 skip list applied: meta-routes + 401 bearer failures do NOT add rows.
- Translator `onCleanup` signatures widened (optional parameter — backward compatible). `openai-out.ts` callback now receives `{ tokensIn, tokensOut }` from `capturedInputTokens` / `capturedOutputTokens`. `anthropic-out.ts` callback also receives `upstreamMessageId` (canonical `msg_<ulid>` captured BEFORE optional idOverride rewrite).
- Full router test suite: 39 files, 462 passing + 2 skipped (was 423 before Plan 05-02; +39 new tests: 5 unit metrics + 6 agent-id integration + 27 recordOutcome integration + 1 auth case). No regressions in Phase 2/3/4 suites.

## Task Commits

Each task followed RED → GREEN with distinct commits:

1. **Task 1 — Metrics registry + InvalidAgentIdError + agentIdPreHandler + /metrics route + skip-list:**
   - RED: `c93e4e0` (`test(05-02): add failing tests for metrics registry, agent-id preHandler, /metrics route`) — 12 cases across 3 files
   - GREEN: `989e08a` (`feat(05-02): metrics registry, agent-id preHandler, /metrics route, InvalidAgentIdError`)

2. **Task 2 — recordOutcome helper + truncateAndRedact + deriveStatusClass + mapErrorToCode:**
   - RED: `bded75b` (`test(05-02): add failing recordOutcome integration suite`) — 27 cases
   - GREEN: `39bd450` (`feat(05-02): recordOutcome helper + truncateAndRedact + deriveStatusClass + mapErrorToCode`)

3. **Task 3 — Wire recordOutcome into both routes + widen onCleanup translators:**
   - GREEN: `e51f163` (`feat(05-02): wire recordOutcome into route lifecycle + widen onCleanup translators`) — no new tests; the recordOutcome integration tests (Task 2) already cover row-shape, taxonomy, redaction. Route-level end-to-end (curl + psql) lands in Plan 05-04.

## Files Created/Modified

### New observability layer

- `router/src/metrics/registry.ts` (NEW) — `makeMetricsRegistry()` factory with 5 custom Counters/Histograms + Node defaults attached to OUR register. Pitfall 2 invariants encoded in module header comment.
- `router/src/metrics/recordOutcome.ts` (NEW) — `OutcomeContext` interface (16 D-D6 fields), `makeRecordRequestOutcome(deps)` factory, exported helpers `truncateAndRedact` / `deriveStatusClass` / `mapErrorToCode`. 3 precompiled module-level RegExps for redaction.
- `router/src/middleware/agentId.ts` (NEW) — preHandler hook, module augmentation extending FastifyRequest with `agentId` / `_t0` / `__recorded`. The ONLY production `req.log = ` reassignment (Pitfall 9 gate returns 1).

### Envelope + auth + boot wiring

- `router/src/errors/envelope.ts` — `InvalidAgentIdError extends Error` with `readonly code = 'invalid_agent_id'`; `mapToHttpStatus` returns 400; parallel branches in `toOpenAIErrorEnvelope` (invalid_request_error / param: 'X-Agent-Id') and `toAnthropicErrorEnvelope` (invalid_request_error). Supplied value truncated to 32 chars in message for safety.
- `router/src/auth/bearer.ts` — `PUBLIC_PATHS` extended to `['/healthz', '/readyz', '/metrics']`. Multi-line TODO comment ABOVE the constant flagging Phase 6 Traefik /metrics blacklist (Pitfall 11). Currently safe via 127.0.0.1:3000 binding.
- `router/src/app.ts` — `BuildAppOpts` gains REQUIRED `metrics: MetricsRegistry` + optional `agentIdPreHandler?: preHandlerAsyncHookHandler`. `addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler)` AFTER bearer `onRequest`. `GET /metrics` route lands after registerReadyz. `makeRecordRequestOutcome` constructed at buildApp scope from `{ metrics, bufferedWriter }`. `setErrorHandler` records pre-resolve errors with `req.__recorded` coordination.
- `router/src/index.ts` — `makeMetricsRegistry()` constructed BEFORE bufferedWriter so the writer's `droppedCounter` parameter is the real `metrics.logBufferDroppedTotal` Counter (replacing Plan 01 stub).

### Routes

- `router/src/routes/v1/chat-completions.ts` — `RegisterChatCompletionsOpts` gains `recordOutcome: RecordRequestOutcome`. Per-request `safeRecord` closure + `caughtErr` + `canonicalResult` captured on outer scope. `sseCleanup` signature widened to `(final?: { tokensIn, tokensOut }) => void`; calls `safeRecord` with `deriveStatusClass(reply.statusCode, controller.signal.aborted)` + `heartbeat.msSinceStart` for ttft + `controller.signal.aborted ? 'client_disconnect' : undefined` for error_code. Non-stream `finally` records via safeRecord (idempotent — no-op if stream branch already ran).
- `router/src/routes/v1/messages.ts` — mirrors chat-completions.ts. `protocol: 'anthropic'`. Stream branch reads `upstreamMessageId` from canonicalToAnthropicSse's widened onCleanup callback. Non-stream branch reads `upstreamMessageId` from `canonicalResult.id`.

### Translators

- `router/src/translation/openai-out.ts` — `CanonicalToOpenAISseOpts.onCleanup` widened to `(final?: { tokensIn: number; tokensOut: number }) => void`. Iterator's finally block passes `{ tokensIn: capturedInputTokens, tokensOut: capturedOutputTokens }`. Existing `() => void` callers still type-check.
- `router/src/translation/anthropic-out.ts` — same widening + ALSO surfaces `upstreamMessageId: capturedUpstreamMessageId` (captured from `message_start.message.id` BEFORE optional `idOverride` rewrite, so the canonical id always flows to request_log even when test fixtures override the wire id). Added `capturedInputTokens` / `capturedOutputTokens` tracking (Anthropic translator didn't previously aggregate these — Plan 04-03's pipeline emits but doesn't sum).

### Test fixtures (mechanical)

- `router/tests/fakes.ts` — `makeFakeMetrics()` factory added alongside existing `makeFakeBufferedWriter()`. Lightweight: calls real `makeMetricsRegistry()` (fresh Registry per call — Pitfall 2 safe).
- `router/tests/integration/auth.test.ts` — added `metrics: makeMetricsRegistry()` to existing buildApp call + new test case for GET /metrics unauth.
- 12 other integration test files — added `metrics: makeFakeMetrics()` to every buildApp opts object (mechanical fixup mirroring Plan 01's bufferedWriter fixup).

### Test files (new)

- `router/tests/unit/metricsRegistry.test.ts` (5 cases) — names + buckets + Pitfall 2 regression gate + T-5-11 cardinality gate
- `router/tests/integration/agentIdPreHandler.test.ts` (6 cases) — D-D5 all 5 branches: absent → undefined, valid → pino child carries agent_id, regex violation on both wire surfaces, duplicate header first-wins, 129-char too-long → 400
- `router/tests/integration/recordOutcome.test.ts` (27 cases) — 6 redaction, 4 status_class, 11 error_code taxonomy, 6 D-D1 row-shape integration

## Decisions Made

1. **Open Question Q4 resolution — BackendSaturatedError taxonomy.** status_class='client_error' (4xx group per D-C4) AND error_code='backend_saturated' (D-D2). Documented at the top of `mapErrorToCode`. Rationale: the HTTP status IS 429 so it groups with client errors; the error_code split lets queries distinguish saturation from generic 4xx clients.
2. **Pre-resolve error coverage via app.setErrorHandler, not outer-try/catch in routes.** Cleaner — the route handler owns its own lifecycle recording; setErrorHandler covers the seam between Fastify hooks and the route body. `req.__recorded` boolean on the FastifyRequest module augmentation coordinates the two paths (Pitfall 8-adjacent — we already use this idempotency idiom inside the route's safeRecord; extending it to span setErrorHandler keeps the pattern uniform).
3. **X-Agent-Id preHandler captures req._t0 first.** Earliest possible capture post-bearer. The captured timestamp is the latency_ms source (D-D6). preHandler runs AFTER onRequest:bearer but BEFORE preValidation:zod, so latency_ms includes preValidation overhead — operationally correct (preValidation is part of the request-handling cost).
4. **truncateAndRedact uses literal '[REDACTED]' replacement.** Capture-group preservation would leave the keyword (`Bearer`, `apiKey`) visible — must_haves truth requires `SELECT error_message FROM request_log WHERE error_message ~ '[Bb]earer'` returns 0 rows, which means the literal token must NOT remain.
5. **anthropic-out.ts onCleanup also passes upstreamMessageId.** Captured from `message_start.message.id` BEFORE optional `idOverride` rewrite (test fixtures use idOverride for deterministic golden assertions; request_log should always carry the canonical msg_<ulid>). This is the cleanest way to surface the id without re-iterating the canonical stream from the route.
6. **tokensTotal Counter only fires when tokens > 0.** Avoids zero-rate rows polluting Prometheus storage. The conditional is `ctx.tokensIn !== undefined && ctx.tokensIn > 0` — preserves the D-D6 semantic that `undefined` → NULL column, but skips no-op metric increments.
7. **Test 2 in agentIdPreHandler.test.ts uses a VALID body (not zod-invalid).** Initial draft used `payload: { messages: [...] }` (missing model) expecting a 400 from zod. That fails because preValidation runs BEFORE preHandler — agentIdPreHandler never fires when zod 400s. Adjusted to send a valid body; the request hits either 200 (if msw mock) or 502 (no upstream mock for /v1/chat/completions in this fixture), but in either case the agentIdPreHandler fires and req.log.child decorates the pino lines that follow. Verified against fastify.dev/docs/v5.8.x/Reference/Hooks/.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] mapErrorToCode test fixtures had wrong constructor signatures**

- **Found during:** Task 2 GREEN (`tsc --noEmit` after writing the helper)
- **Issue:** Initial test for `InvalidImageUrlError` called `new InvalidImageUrlError('bad')` (single string arg). The actual class signature is `constructor(url, reason)` per `ollama-native-out.ts:57`. Same issue with `ImageFetchError`: `constructor(url, code, detail)` — I had passed two args.
- **Fix:** Updated test invocations to use real signatures: `new InvalidImageUrlError('https://example.com/x.png', 'malformed_url')` and `new ImageFetchError('https://example.com/x.png', 'http_error', 'http err')`.
- **Verification:** `tsc --noEmit` exits 0; tests pass.
- **Committed in:** `39bd450` (Task 2 GREEN — single squashed commit with the fix inline)

**2. [Rule 3 - Blocking] cardinality grep gate self-match in comment**

- **Found during:** Task 3 post-implementation grep verification
- **Issue:** Plan-level grep gate `grep 'labelNames' src/metrics/registry.ts | grep -cE 'agent_id|request_id|error_message|http_status'` reported 1 (expected 0 per T-5-11). Investigation showed the grep was matching my own descriptive comment listing the forbidden labels, not an actual `labelNames` array entry.
- **Fix:** Reworded the cardinality discipline comment to reference T-5-11 / D-C3 without literally listing the forbidden field names on the same line. The actual labelNames arrays remain clean.
- **Verification:** Grep returns 0; all 5 metrics still inspectable via `register.metrics()`.
- **Committed in:** `e51f163` (Task 3 GREEN — folded into the same commit)

**3. [Rule 2 - Missing Critical] anthropic-out.ts did not aggregate input/output tokens**

- **Found during:** Task 3 wiring (translator widening)
- **Issue:** Plan 04-03 added the message_delta.usage.output_tokens emission but did NOT track `capturedInputTokens` / `capturedOutputTokens` inside `canonicalToAnthropicSse` the way `openai-out.ts` does. Without these, the widened `onCleanup` callback would always pass `{ tokensIn: 0, tokensOut: 0 }` for the Anthropic stream — request_log.tokens_in/out would always be 0 on /v1/messages stream requests.
- **Fix:** Added `let capturedInputTokens = 0; let capturedOutputTokens = 0;` at the top of the generator. Captured in the `message_start` handler (`capturedInputTokens = ev.message.usage.input_tokens`) and the `message_delta` handler (`capturedOutputTokens = ev.usage.output_tokens` — cumulative). Surfaced through `onCleanup`.
- **Verification:** No existing tests broke; new recordOutcome.test.ts test 2 ("success stream openai") covers the openai-out.ts side; manual smoke against /v1/messages stream (Plan 05-04) will cover the anthropic side end-to-end.
- **Committed in:** `e51f163` (Task 3 GREEN)

---

**Total deviations:** 3 auto-fixed (1 bug, 1 blocking, 1 missing-critical). No architectural changes.

**Impact on plan:** All three were friction at integration points (test fixture signatures, grep-gate self-match, missing aggregation in anthropic-out). The plan's structural decisions held.

## Issues Encountered

- **No infrastructure smoke run.** The plan's `<verify>` block includes manual end-to-end smoke (`curl -N -H "X-Agent-Id: claude-code:luis" .../v1/chat/completions && psql -c "SELECT ..."`) — NOT run inside the worktree (Docker access from the executor agent is not guaranteed). All deterministic checks (`tsc --noEmit`, `npm test`, grep gates) pass; the end-to-end smoke + the SC2 pause-postgres scenario both land in Plan 05-04.
- **Phase 5 SC4 partial validation only.** `/metrics` returns 200 + the expected content-type + body in integration tests (`auth.test.ts`), but the "5 # HELP router_* lines AND at least one # HELP process_* / nodejs_* line" assertion needs the actual prom-client rendering — covered in `metricsRegistry.test.ts` test 3 directly via `await m.register.metrics()`. ✓
- **One `safeRecord` reference imbalance against the plan's grep estimate.** The plan said "grep -rn 'safeRecord' router/src/routes/v1/ returns ≥ 2 (one per route file)". Actual grep returns 13 — every safeRecord usage (declaration, sseCleanup call, finally call, `req.__recorded` assignment etc.). Both routes use it extensively. Spec satisfied.

## User Setup Required

None. The metrics registry + recordOutcome wiring is fully self-contained inside the router process. When the operator next runs `docker compose up postgres router` and sends a request, the resulting request_log row will appear in `psql -c "SELECT * FROM request_log ORDER BY ts DESC LIMIT 1"`. `curl http://127.0.0.1:3000/metrics` returns the Prometheus text without auth.

## Next Phase Readiness

### Open hand-offs

- **Plan 05-03 (pg_dump + restore drill):** No dependency on Plan 05-02's surface. Reads request_log via psql; Plan 05-02's writes populate the table for the restore-drill SELECT sanity check.
- **Plan 05-04 (/readyz postgres probe + SC2 smoke + DATA-05 docs):** Owns the end-to-end smoke test slice — the pause-postgres-5s-streams-keep-running scenario, the X-Agent-Id round-trip curl + psql verification, and the request_log row-count assertion section of `bin/smoke-test-router.sh`. Also owns the operator-doc for the WSL2 uid-mismatch resolution if Pitfall 7 bites on first up.
- **Phase 7 (Prometheus + Grafana):** Consumes the 5 router_* metrics. Bucket boundaries are tunable post-Phase 7 if the dashboards reveal a better profile.
- **Phase 6 (Traefik):** MUST add a path-blacklist middleware for external /metrics (TODO comment carrier in `bearer.ts`). Without it, the metrics surface becomes publicly readable when Traefik removes the 127.0.0.1 binding.

### Phase 5 SC mapping anchored

- **SC1 (request_log schema populated):** Foundation from Plan 05-01; this plan populates the table on every recorded request. End-to-end SQL verification lives in Plan 05-04 smoke.
- **SC2 (every-request-has-row + ttft_ms for stream):** Stream-branch sseCleanup populates ttft_ms from heartbeat.msSinceStart. Non-stream branch leaves ttft_ms NULL (D-D6). Pause-postgres smoke (5s buffered writes don't stall stream) lands in 05-04.
- **SC4 (/metrics unauth on loopback):** Delivered here — `auth.test.ts` GET /metrics → 200 + text/plain + body contains router_requests_total HELP line.
- **ROUTE-09 (X-Agent-Id round-trip):** Delivered here — D-D5 all 5 branches covered in `agentIdPreHandler.test.ts`.

### Threat register mitigations live in code

- **T-5-08 (bearer-leak via error_message):** `truncateAndRedact` applies BEARER_RE / AUTH_RE / APIKEY_RE pre-write per D-D3 + Pitfall 12. Integration test 5 in `recordOutcome.test.ts` asserts the stored error_message contains NEITHER 'sk-leaked-secret-1234567' NOR matches `/[Bb]earer\s+\S+/`.
- **T-5-09 (/metrics externally readable post-Phase 6):** Accept disposition. TODO comment in `auth/bearer.ts` flags the Phase 6 Traefik blacklist follow-up.
- **T-5-10 (X-Agent-Id ReDoS):** Regex `/^[A-Za-z0-9._:-]{1,128}$/` anchored + bounded + no nested quantifiers per RESEARCH Pattern 3 line 375. Documented in `middleware/agentId.ts` header comment.
- **T-5-11 (prom-client cardinality blow-up):** Grep gate `grep 'labelNames' src/metrics/registry.ts | grep -cE 'agent_id|request_id|error_message|http_status' == 0`. Verified post-implementation.
- **T-5-12 (agent_id in pino logs):** Accept disposition (public identifier per D-D5).
- **T-5-13 (double-row via sseCleanup firing twice):** Per-request `safeRecord` closure with `recorded: boolean` flag (mirrors `safeRelease`). Verified by code-structure — sseCleanup AND non-stream finally both invoke safeRecord; the second call is a no-op.
- **T-5-14 (collectDefaultMetrics exposes process info):** Accept disposition (process telemetry only — no request bodies).

### TDD gate compliance

Tasks 1 + 2 followed RED → GREEN with separate commits:
- Task 1 RED: `c93e4e0` (`test(05-02): add failing tests ...`)
- Task 1 GREEN: `989e08a` (`feat(05-02): metrics registry ...`)
- Task 2 RED: `bded75b` (`test(05-02): add failing recordOutcome ...`)
- Task 2 GREEN: `39bd450` (`feat(05-02): recordOutcome helper ...`)

Task 3 is a wire-up task — the new behavior surface is already covered by Task 2's recordOutcome integration tests + existing chat-completions / messages integration suites (which exercise the route lifecycle end-to-end). No new test file added for Task 3 per plan instructions; manual end-to-end smoke (curl + psql) lives in Plan 05-04.

## Self-Check: PASSED

Files verified to exist on disk:
- router/src/metrics/registry.ts: FOUND
- router/src/metrics/recordOutcome.ts: FOUND
- router/src/middleware/agentId.ts: FOUND
- router/tests/unit/metricsRegistry.test.ts: FOUND
- router/tests/integration/agentIdPreHandler.test.ts: FOUND
- router/tests/integration/recordOutcome.test.ts: FOUND

Commits verified in `git log`:
- c93e4e0: FOUND (Task 1 RED)
- 989e08a: FOUND (Task 1 GREEN)
- bded75b: FOUND (Task 2 RED)
- 39bd450: FOUND (Task 2 GREEN)
- e51f163: FOUND (Task 3 wire-up)

Grep gates verified:
- `grep -rn 'req\.log = ' router/src/ | wc -l` == 1 (Pitfall 9) ✓
- `grep -rn 'safeRecord' router/src/routes/v1/ | wc -l` == 13 (≥ 2 spec) ✓
- `grep -v '^\s*//' router/src/auth/bearer.ts | grep -c '/metrics'` == 1 (≥ 1 spec) ✓
- `grep -v '^\s*//' router/src/metrics/registry.ts | grep -c 'new Registry()'` == 1 ✓
- `grep 'labelNames' router/src/metrics/registry.ts | grep -cE 'agent_id|request_id|error_message|http_status'` == 0 (T-5-11) ✓

Test suite: 462 passing + 2 skipped, no regressions.

---
*Phase: 05-postgres-observability-seam*
*Completed: 2026-05-14*
