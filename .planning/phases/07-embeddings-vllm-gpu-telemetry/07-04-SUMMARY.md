---
phase: 07-embeddings-vllm-gpu-telemetry
plan: 04
subsystem: api
tags: [openai, embeddings, fastify, zod, ollama, vllm, bge-m3]

requires:
  - phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
    provides: BackendAdapter interface + factory dispatch by entry.backend + per-backend BackendSemaphore + RegistryUnknownModelError
  - phase: 05-observability-request-log-metrics
    provides: makeRecordRequestOutcome helper + safeRecord idempotency pattern + bufferedWriter row enqueue path
  - phase: 07-03 (vLLM router adapter + registry widening)
    provides: VLLMOpenAIAdapter class + 'vllm' / 'vllm-embed' backend enum values
provides:
  - POST /v1/embeddings — OpenAI-compat embedding endpoint
  - BackendAdapter.embeddings() interface method (Ollama + vLLM = passthrough; llama.cpp = CapabilityNotSupportedError throw)
  - CapabilityNotSupportedError widened to accept 'embeddings' as the third missingCapability value
  - Route-level capability gate (defense-in-depth layer 1) + adapter-level CapabilityNotSupportedError throw on llama.cpp (defense-in-depth layer 2) — T-07-11 mitigation
affects:
  - 07-05 (dashboards)
  - 07-06 (live smoke — will curl /v1/embeddings against the running stack)
  - 08-ollama-cloud (OllamaCloudAdapter must implement .embeddings() passthrough)

tech-stack:
  added: []
  patterns:
    - "BackendAdapter widening pattern — new method added to the interface + implemented on all concrete adapters in the same task (TypeScript compile is the structural enforcement)"
    - "Capability gate dual-layer pattern — route-level check on entry.capabilities + adapter-level CapabilityNotSupportedError throw; must be bypassed independently (T-07-11)"
    - "Embeddings observability seam — same makeRecordRequestOutcome helper used by chat/messages routes; widening the app.setErrorHandler isRecordedRoute allowlist is the single edit needed to plumb a new route into request_log"

key-files:
  created:
    - router/src/routes/v1/embeddings.ts
    - router/tests/routes/embeddings.test.ts
    - router/tests/unit/adapter-embeddings.test.ts
    - .planning/phases/07-embeddings-vllm-gpu-telemetry/deferred-items.md
  modified:
    - router/src/backends/adapter.ts (interface widened with .embeddings())
    - router/src/backends/ollama-openai.ts (.embeddings() passthrough)
    - router/src/backends/vllm-openai.ts (.embeddings() passthrough)
    - router/src/backends/llamacpp-openai.ts (.embeddings() throws CapabilityNotSupportedError)
    - router/src/errors/envelope.ts (CapabilityNotSupportedError accepts 'embeddings')
    - router/src/app.ts (registerEmbeddingsRoute wire + isRecordedRoute allowlist widened)
    - router/tests/integration/chat-completions.stream.test.ts (inline mock adapters updated)
    - router/tests/integration/messages.stream.test.ts (inline mock adapters updated)

key-decisions:
  - "Capability gate inside the try block (not before): so the outer finally records the error path with the resolved entry's backend/model labels rather than 'unknown' from the centralized setErrorHandler. The route is the canonical observability seam for resolved-entry errors."
  - "tokensOut: 0 on success (not null): per 07-RESEARCH Open Question 3 — embeddings have no completion-side token count, but dashboards aggregating SUM(tokens_out) WHERE route='/v1/embeddings' must include the row without a COALESCE."
  - "Adapter-level throw uses backend name ('llamacpp') as the modelName arg: so the resulting CapabilityNotSupportedError message identifies the backend rather than a specific model — operationally useful when the route-level gate is bypassed and the adapter throws (e.g. misdeclared registry entries)."
  - "Embeddings route does NOT translate to/from canonical: the route returns the OpenAI SDK's CreateEmbeddingResponse shape verbatim because the Anthropic protocol has no embeddings analog. Single-protocol surface unlike /v1/chat/completions + /v1/messages."

patterns-established:
  - "Adapter interface widening: when adding a new method to BackendAdapter, edit interface + ALL 3 concrete adapters in one commit; TypeScript compile gates correctness across all adapters and inline test mocks."
  - "Route-level capability gate: check entry.capabilities BEFORE acquiring a semaphore slot; throw CapabilityNotSupportedError(entry.name, capability) so the centralized error handler emits the right envelope (400 / model_capability_mismatch on OpenAI surface)."
  - "isRecordedRoute allowlist widening: each new bearer-gated route that needs request_log coverage must be added to app.setErrorHandler's isRecordedRoute check (Plan 05-02 D-D4) — single edit per new route."

requirements-completed: [OAI-02, EMBED-01]

duration: 25min
completed: 2026-05-17
---

# Phase 7 Plan 4: Embeddings Route Summary

**POST /v1/embeddings dispatches to Ollama (bge-m3) and vLLM-embed (BAAI/bge-m3) via a widened BackendAdapter.embeddings() seam; llama.cpp throws CapabilityNotSupportedError as defense-in-depth back-up to the route-level capability gate (T-07-11).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-17T03:33Z (approx)
- **Completed:** 2026-05-17T03:50Z
- **Tasks:** 3
- **Files modified:** 11 (4 created, 7 modified)
- **Test count delta:** +15 (5 adapter unit + 10 route integration)
- **Total tests:** 520 passing, 2 skipped, 0 failing

## Accomplishments

- **BackendAdapter widened with `.embeddings()`** — interface now requires the third entry-point method alongside `chatCompletionsCanonical{,Stream}` and `probeLiveness`. TypeScript compile is the structural gate; all three concrete adapters and four inline test mocks implement it.
- **OllamaOpenAIAdapter + VLLMOpenAIAdapter** — passthrough to `this.client.embeddings.create({ model, input }, { signal })`. Ollama serves `/v1/embeddings` via its OpenAI-compat shim; vLLM's vllm-embed pool (started with `--runner pooling --task embed`) serves it natively. The same adapter class hits both backends — only the baseURL differs (factory dispatch).
- **LlamacppOpenAIAdapter** — throws `CapabilityNotSupportedError('llamacpp', 'embeddings')` unconditionally. llama.cpp-server does not expose an OpenAI-compat /v1/embeddings endpoint as of Phase 7.
- **CapabilityNotSupportedError widened** — third allowed value of `missingCapability` is `'embeddings'`. The error class' centralized 400 / `model_capability_mismatch` mapping (envelope.ts) and request_log error_code mapping (recordOutcome.ts) work unchanged for the new value.
- **POST /v1/embeddings route** — zod schema rejects empty string + empty array (Pitfall E-1), capability gate fires inside the route's try block (so outer finally records error path with the resolved entry's labels), passes through to the adapter, returns the SDK response verbatim.
- **app.ts wire** — single import + single function call alongside the existing chat/messages/count-tokens/models registrations. `isRecordedRoute` allowlist extended to include `/v1/embeddings` so pre-resolve errors (RegistryUnknownModelError) still produce a request_log row.

## Task Commits

1. **Task 1: Widen BackendAdapter + implement .embeddings() on all three adapters** — `0f0821f` (feat)
2. **Task 2: Create router/src/routes/v1/embeddings.ts + 10-case integration tests** — `7716516` (feat)
3. **Task 3: Wire registerEmbeddingsRoute into router/src/app.ts** — `66142a1` (feat)

## Files Created/Modified

### Created

- `router/src/routes/v1/embeddings.ts` (~200 lines) — Fastify POST /v1/embeddings handler. Zod-validated body, capability gate, semaphore acquire/release, adapter call, recordOutcome on finally.
- `router/tests/routes/embeddings.test.ts` (~310 lines) — 10 integration tests covering happy path (single string + array), capability mismatch, empty string, empty array, array with empty element, unknown model, missing bearer, invalid bearer, schema passthrough.
- `router/tests/unit/adapter-embeddings.test.ts` (~165 lines) — 5 unit tests covering OllamaOpenAIAdapter (single + batch) + VLLMOpenAIAdapter (batch) passthroughs + LlamacppOpenAIAdapter throw (with HTTP non-call assertion).
- `.planning/phases/07-embeddings-vllm-gpu-telemetry/deferred-items.md` — tracks pre-existing flaky `hotreload.vram.test.ts` test.

### Modified

- `router/src/backends/adapter.ts` — `BackendAdapter` interface gained `.embeddings(input, model, signal)` with the OpenAI SDK's structural return type.
- `router/src/backends/ollama-openai.ts` — `.embeddings()` passthrough implementation.
- `router/src/backends/vllm-openai.ts` — `.embeddings()` passthrough implementation.
- `router/src/backends/llamacpp-openai.ts` — `.embeddings()` throws `CapabilityNotSupportedError('llamacpp', 'embeddings')`.
- `router/src/errors/envelope.ts` — `CapabilityNotSupportedError` `missingCapability` widened from `'vision' | 'tools'` to `'vision' | 'tools' | 'embeddings'`.
- `router/src/app.ts` — import + `registerEmbeddingsRoute()` invocation; `isRecordedRoute` allowlist widened to include `/v1/embeddings`.
- `router/tests/integration/chat-completions.stream.test.ts` — three inline `BackendAdapter` mocks gained `.embeddings()` stubs (TS compile gate).
- `router/tests/integration/messages.stream.test.ts` — four inline `BackendAdapter` mocks gained `.embeddings()` stubs (TS compile gate).

## Decisions Made

See `key-decisions` in frontmatter. Highlights:

- **Capability gate placement inside try block** — explicitly different from `chat-completions.ts` (where the vision gate is outside the try). The chat-completions outer setErrorHandler observes the throw and emits 'unknown' backend/model labels for pre-resolve errors; for /v1/embeddings we WANT the resolved entry's labels in request_log because the capability mismatch is a real entry-bound event, not a registry-resolution failure.
- **`tokensOut: 0` on success** — embedding requests have no completion-side token count. Emit 0 (not NULL) so SUM-aggregation SQL works without a COALESCE.
- **Adapter-level throw uses 'llamacpp' as modelName** — the route-level gate uses `entry.name`; the adapter-level defense-in-depth uses the backend identifier. Both surface in different operator-debug scenarios.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened `CapabilityNotSupportedError` to accept `'embeddings'`**

- **Found during:** Task 1 (BackendAdapter widening)
- **Issue:** The existing `CapabilityNotSupportedError` class accepts `missingCapability: 'vision' | 'tools'` only. Task 1's `LlamacppOpenAIAdapter.embeddings()` impl needs to throw it with `'embeddings'` as the third value. TypeScript would refuse the call without widening.
- **Fix:** Extended the union to `'vision' | 'tools' | 'embeddings'` in `router/src/errors/envelope.ts`. The centralized envelope handler + recordOutcome mapper already use `err instanceof CapabilityNotSupportedError` (not the literal value) so no downstream changes needed.
- **Files modified:** `router/src/errors/envelope.ts`
- **Verification:** Existing CapabilityNotSupportedError tests still pass (vision/tools); new adapter-embeddings tests pass with the 'embeddings' value.
- **Committed in:** `0f0821f` (Task 1 commit)

**2. [Rule 3 - Blocking] Added `.embeddings()` stubs to inline `BackendAdapter` mocks in 2 integration test files**

- **Found during:** Task 1 (TypeScript compile after BackendAdapter widening)
- **Issue:** `tests/integration/chat-completions.stream.test.ts` and `tests/integration/messages.stream.test.ts` define inline `class MockAbortAdapter implements BackendAdapter` + several object literals typed as `BackendAdapter`. After widening the interface, all of them fail TS2420 / TS2741. The fixtures cannot be left broken or `tsc --noEmit` blocks the build.
- **Fix:** Added a one-line `.embeddings()` stub that throws `'not used in stream test'` to every inline mock (7 total across the two files). Pure compile-gate fix; no runtime behavior change.
- **Files modified:** `router/tests/integration/chat-completions.stream.test.ts`, `router/tests/integration/messages.stream.test.ts`
- **Verification:** `npx tsc --noEmit` returns 0 errors; all 510 pre-existing tests still pass.
- **Committed in:** `0f0821f` (Task 1 commit)

**3. [Rule 2 - Missing Critical] Widened `app.setErrorHandler` `isRecordedRoute` allowlist to include `/v1/embeddings`**

- **Found during:** Task 2 (writing the embeddings route)
- **Issue:** Plan 07-04's `<interfaces>` block stated "the centralized error handler in app.ts already maps ... to the right HTTP status + openai-envelope JSON" + "the throw branch's recordOutcome is wired by the same centralized handler". This is only HALF true: the envelope mapping happens unconditionally, but the request_log row from `app.setErrorHandler`'s `recordOutcome` call is gated on `isRecordedRoute = (route === '/v1/chat/completions' || route === '/v1/messages')`. /v1/embeddings was NOT in that allowlist. Without the widening, pre-resolve errors (RegistryUnknownModelError, etc.) would emit envelopes but skip the audit trail.
- **Fix:** Added `'/v1/embeddings'` to the OR chain (`(route === '/v1/chat/completions' || route === '/v1/messages' || route === '/v1/embeddings')`).
- **Files modified:** `router/src/app.ts`
- **Verification:** New test `returns 400 / model_capability_mismatch when model lacks embeddings capability` asserts `pushed.length === 1` — the bufferedWriter row IS recorded for the error path.
- **Committed in:** `7716516` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 widening of typed error, 1 compile-gate fix, 1 missing observability seam)
**Impact on plan:** All three are correctness/observability requirements — none were scope creep. The plan's `<interfaces>` block underspecified the `app.setErrorHandler` allowlist; that lacuna was caught by Rule 2 (missing critical functionality) and surfaced by the test fixture.

## Issues Encountered

- **OpenAI SDK v6 defaults `encoding_format='base64'`** (perf optimization per openai-node#1312): the initial RED test assumed MSW could return `embedding: number[]` directly, but the SDK then attempted base64-decode on a JSON array and produced 256 chars instead of the expected 1024. Fixed by adding a `floatsToBase64()` helper to the test that emulates the real wire shape — the SDK auto-decodes correctly and returns the original `number[]`.
- **Pre-existing flaky test `hotreload.vram.test.ts`**: passes when run in isolation, fails ~50% in the full suite due to `Date.now() / 1000` granularity. Tracked in `deferred-items.md`. Out of scope for Plan 07-04.

## User Setup Required

None — no external service configuration. The /v1/embeddings endpoint will be exercised end-to-end by Plan 07-06's smoke test against the live stack.

## Next Phase Readiness

- **Plan 07-05 (dashboards)** can now query `request_log` for `route='/v1/embeddings'` and `backend IN ('ollama', 'vllm-embed')` to surface embedding traffic — the rows exist as of this plan landing.
- **Plan 07-06 (smoke)** has a working `/v1/embeddings` to curl against; bge-m3 must be `ollama pull`'d on the host before the smoke runs.
- **Phase 8 (OllamaCloudAdapter)** must implement `.embeddings()` as a passthrough — the interface widening is permanent.

## Self-Check: PASSED

- File `router/src/routes/v1/embeddings.ts` exists ✓
- File `router/tests/routes/embeddings.test.ts` exists ✓
- File `router/tests/unit/adapter-embeddings.test.ts` exists ✓
- Commit `0f0821f` exists in git log ✓
- Commit `7716516` exists in git log ✓
- Commit `66142a1` exists in git log ✓
- All 6 plan-frontmatter verify greps pass (registerEmbeddingsRoute export, zod union one-liner, CapabilityNotSupportedError import, recordOutcome call, `tokensOut: 0` literal, import in app.ts) ✓
- `npm test`: 520 passing, 0 failing ✓
- `npm run build`: clean, 134 KB ESM bundle ✓

---
*Phase: 07-embeddings-vllm-gpu-telemetry*
*Completed: 2026-05-17*
