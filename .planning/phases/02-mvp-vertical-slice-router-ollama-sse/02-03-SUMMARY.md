---
phase: 02-mvp-vertical-slice-router-ollama-sse
plan: "03"
subsystem: router-chat-completions
tags: [router, backends, ollama, openai-sdk, chat-completions, non-stream, vertical-slice, fastify, zod, msw]
dependency_graph:
  requires:
    - router/src/app.ts (buildApp factory from plan 02-02)
    - router/src/errors/envelope.ts (D-C1 envelope + error mapping from plan 02-02)
    - router/src/config/registry.ts (RegistryStore + ModelEntry from plan 02-02)
    - router/tests/msw/handlers.ts (ollamaNonStreamHandler from plan 02-01)
    - openai@^6.37.0 (already in package.json from plan 02-01)
  provides:
    - router/src/backends/adapter.ts (BackendAdapter interface + AdapterFactory type — D-B2 seam)
    - router/src/backends/ollama-openai.ts (OllamaOpenAIAdapter + makeOllamaAdapterFromEntry)
    - router/src/routes/v1/chat-completions.ts (POST /v1/chat/completions — non-stream branch wired; stream=true returns 501 stub)
    - Live SC2 verified: curl POST with real GPU returns ChatCompletion + usage tokens
  affects:
    - plan 02-04: replaces the 501 stream stub with SSE handler; uses chatCompletionsStream() from BackendAdapter
    - plan 02-05: smoke test verifies SC2 end-to-end
    - Phase 3: LlamacppOpenAIAdapter drops in via BackendAdapter seam (zero route code change — SC1)
    - Phase 8: OllamaCloudAdapter drops in via same BackendAdapter seam
tech_stack:
  added:
    - "hasZodFastifySchemaValidationErrors from @bram-dc/fastify-type-provider-zod (for 400 envelope mapping)"
  patterns:
    - "BackendAdapter interface (D-B2): route handlers type-check against interface, not concrete class"
    - "AdapterFactory type: injectable for test-time adapter injection via buildApp(makeAdapter)"
    - "apiKey: 'ollama' non-empty placeholder for SDK v6 (empty string throws at construction)"
    - "stream_options.include_usage: true baked into both stream and non-stream paths (D-B3)"
    - "req.raw.socket.once('close') for abort signal (NOT req.raw.once('close') which fires on body consumption)"
    - "501 stub for stream branch — explicit contract that plan 02-04 replaces"
    - "hasZodFastifySchemaValidationErrors used in envelope.ts to map Fastify validation errors to 400"
    - "onRequest hook for bearer auth (before body parsing) — NOT preHandler (after body validation)"
key_files:
  created:
    - router/src/backends/adapter.ts
    - router/src/backends/ollama-openai.ts
    - router/src/routes/v1/chat-completions.ts
  modified:
    - router/src/app.ts (wires chat-completions route; adds makeAdapter to BuildAppOpts; bearer moved to onRequest)
    - router/src/errors/envelope.ts (handles Fastify zod validation errors with hasZodFastifySchemaValidationErrors)
    - router/tests/integration/auth.test.ts (updated assertion to reflect route now exists)
    - router/tests/integration/chat-completions.nonstream.test.ts (replaced 3 it.todo stubs with 5 real tests + live smoke)
key_decisions:
  - "D-B1: OllamaOpenAIAdapter uses apiKey: 'ollama' (non-empty placeholder) — SDK v6 throws on empty string"
  - "D-B2: BackendAdapter seam established — route references interface, not OllamaOpenAIAdapter directly"
  - "D-B3: stream_options.include_usage: true baked into both methods unconditionally"
  - "req.raw.socket.once('close') for abort — IncomingMessage close fires on body consumption not TCP disconnect"
  - "Bearer auth moved to onRequest hook (runs before body parsing) to ensure auth gates before validation"
  - "hasZodFastifySchemaValidationErrors added to envelope.ts for proper 400 mapping of Fastify validation errors"
requirements-completed: [OAI-01, OAI-05]
duration: 28min
completed: "2026-05-12"
---

# Phase 2 Plan 03: BackendAdapter Seam + POST /v1/chat/completions Non-Stream Branch Summary

**POST /v1/chat/completions non-stream branch wired end-to-end through BackendAdapter seam to OllamaOpenAIAdapter (openai SDK v6), verified live against GPU with usage tokens populated (SC2 + OAI-01 + OAI-05 non-stream halves green)**

## Performance

- **Duration:** 28 min
- **Started:** 2026-05-12T11:29:02Z
- **Completed:** 2026-05-12T11:57:00Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- BackendAdapter interface (D-B2 seam) established: route handlers reference `BackendAdapter` not `OllamaOpenAIAdapter`, enabling Phase 3 to drop in `LlamacppOpenAIAdapter` with zero route code changes
- OllamaOpenAIAdapter wraps openai SDK v6 with `apiKey: 'ollama'`, `timeout: 60_000`, `stream_options.include_usage: true` baked in, and AbortSignal passthrough for both stream/non-stream paths
- POST /v1/chat/completions: zod-validated body → registry resolve → adapter.chatCompletions → verbatim ChatCompletion response with usage tokens
- Live SC2 verified: `curl POST http://127.0.0.1:3000/v1/chat/completions` with real GPU returns `choices[0].message.content` + `usage.{prompt_tokens, completion_tokens, total_tokens}` all populated and arithmetic-correct

## Task Commits

Each task was committed atomically:

1. **Task 1: BackendAdapter + OllamaOpenAIAdapter** - `600db5f` (feat)
2. **Task 2: Chat route + app wiring + tests** - `a2e64b8` (feat)
   - Includes bug fixes: bearer hook moved to onRequest; envelope updated for Fastify validation errors; auth test assertion updated
3. **Task 3: Socket abort fix (live verification bug)** - `959703a` (fix)
   - Found during live SC2 verification: req.raw.once('close') fires immediately on body consumption

## Files Created/Modified

- `router/src/backends/adapter.ts` - BackendAdapter interface (D-B2) and AdapterFactory type
- `router/src/backends/ollama-openai.ts` - OllamaOpenAIAdapter (openai SDK v6) + makeOllamaAdapterFromEntry factory
- `router/src/routes/v1/chat-completions.ts` - POST /v1/chat/completions: zod body validation, non-stream branch, 501 stub for stream
- `router/src/app.ts` - registerChatCompletionsRoute wired; makeAdapter injectable; bearer moved to onRequest
- `router/src/errors/envelope.ts` - hasZodFastifySchemaValidationErrors import + handling for 400 envelope mapping
- `router/tests/integration/auth.test.ts` - Updated "correct bearer" assertion (route now exists)
- `router/tests/integration/chat-completions.nonstream.test.ts` - Replaced 3 it.todo stubs with 5 real tests + live smoke block

## Decisions Made

- **D-B1 (apiKey: 'ollama'):** SDK v6 throws at construction time on empty apiKey. Non-empty placeholder used; local Ollama ignores it.
- **D-B2 (BackendAdapter seam):** Route handler uses `BackendAdapter` interface (not `OllamaOpenAIAdapter`). Phase 3 SC1 requires adding `LlamacppOpenAIAdapter` with no route code change — this seam makes that possible.
- **D-B3 (stream_options.include_usage: true):** Baked unconditionally into both stream/non-stream paths. SDK strips it for non-stream calls automatically — keeping it symmetric avoids divergence.
- **Socket vs IncomingMessage close:** `req.raw.socket.once('close')` is the correct way to detect TCP client disconnect. `req.raw.once('close')` fires when the HTTP message body has been consumed by the parser, causing immediate AbortController.abort() on every real request.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Bearer auth preHandler ran AFTER body validation (preHandler vs onRequest lifecycle)**
- **Found during:** Task 2 (running auth integration tests)
- **Issue:** `app.addHook('preHandler', bearerHook)` runs after body parsing AND validation (`preValidation`). When a route with a zod body schema exists, Fastify validates the body before `preHandler` runs. This meant auth failures returned 500 (serializer error) instead of 401.
- **Fix:** Changed to `app.addHook('onRequest', bearerHook)` — `onRequest` runs before body parsing, ensuring auth is always the first gate.
- **Files modified:** `router/src/app.ts`
- **Committed in:** `a2e64b8`

**2. [Rule 1 - Bug] Fastify zod validation errors not mapped to 400 in envelope.ts**
- **Found during:** Task 2 (integration test for missing `model` field)
- **Issue:** When zod validates via `validatorCompiler`, it produces a `ZodFastifySchemaValidationError[]` array (not a `z.ZodError`). The `toOpenAIErrorEnvelope` function only checked for `z.ZodError`, so validation failures fell through to the 500 `internal_error` case.
- **Fix:** Added `hasZodFastifySchemaValidationErrors(err)` check from `@bram-dc/fastify-type-provider-zod` to both `mapToHttpStatus` and `toOpenAIErrorEnvelope`. Returns 400 with `invalid_request_error` type.
- **Files modified:** `router/src/errors/envelope.ts`
- **Committed in:** `a2e64b8`

**3. [Rule 1 - Bug] req.raw.once('close') fires immediately on body consumption, causing APIUserAbortError on every live request**
- **Found during:** Task 3 (live SC2 verification with real TCP connection)
- **Issue:** The route registered `req.raw.once('close', () => controller.abort(...))`. `IncomingMessage.close` fires when the HTTP message body has been fully consumed by Fastify's body parser — immediately, before the handler does any upstream work. This triggered `controller.abort()` before the SDK call, throwing `APIUserAbortError`. The error handler mapped this to `NO_ENVELOPE` and returned without sending a response, leaving the client hanging.
  - Note: `app.inject()` in vitest uses an in-memory transport with no real sockets, so this bug was NOT caught by the integration tests.
- **Fix:** Changed to `req.raw.socket?.once('close', onSocketClose)` — the Socket `close` event fires only when the TCP connection is destroyed (true client disconnect). Added `finally` block to remove the socket listener after the response is sent.
- **Files modified:** `router/src/routes/v1/chat-completions.ts`
- **Committed in:** `959703a`

**4. [Rule 1 - Bug] chatCompletionsStream return type mismatch**
- **Found during:** Task 1 (typecheck)
- **Issue:** Plan template showed `chatCompletionsStream` returning `AsyncIterable<ChatCompletionChunk>` directly. The SDK's `chat.completions.create()` with `stream: true` returns `APIPromise<Stream<ChatCompletionChunk>>` — the outer `Promise` must be awaited.
- **Fix:** Changed method signature to `async chatCompletionsStream(...): Promise<AsyncIterable<ChatCompletionChunk>>` and updated BackendAdapter interface to match.
- **Files modified:** `router/src/backends/adapter.ts`, `router/src/backends/ollama-openai.ts`
- **Committed in:** `600db5f`

---

**Total deviations:** 4 auto-fixed (4 Rule 1 bugs)
**Impact on plan:** All fixes necessary for correctness and live operation. No scope creep. The socket abort fix was discovered only via live TCP testing — app.inject() simulations cannot detect this class of bug.

## Known Stubs

- `router/src/routes/v1/chat-completions.ts` — stream=true returns 501 with `code: 'stream_pending'`. This is intentional and documented as the contract plan 02-04 must replace. A test in `chat-completions.nonstream.test.ts` verifies the stub is in place.

## Live Verification Result (SC2)

```
curl POST http://127.0.0.1:3000/v1/chat/completions
  Authorization: Bearer local-llms_...
  body: {"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"What is 2+2? Answer in one short sentence."}]}

Response:
  choices[0].message.content: "The answer to 2+2 is 4."
  usage.prompt_tokens: 38
  usage.completion_tokens: 12
  usage.total_tokens: 50
  arithmetic check: 38 + 12 == 50 ✓

SC4 (no-auth returns 401): PASS
SC5 (token not in logs): PASS — "bearer header" text in log message is not a token value
```

## Threat Surface Scan

No new threat surfaces beyond the plan's threat model:

| Threat | Mitigation Applied | Verified By |
|--------|--------------------|-------------|
| T-02-F: malformed upstream chunks | openai SDK v6 validates chunk shape natively; `APIError` -> `setErrorHandler` -> 502 | `chat-completions.nonstream.test.ts` upstream-error case |
| T-02-H: body tampering | zod schema validates `model: string.min(1)`, `messages: array.min(1)`; failure -> 400 | `chat-completions.nonstream.test.ts` missing-model case |
| T-02-A carry: token in logs | SC5 live check: grep for token value returns 0 matches | Task 3 live verification |

## Next Phase Readiness

Plan 02-04 (stream branch) builds on this plan:
- The 501 stub in `registerChatCompletionsRoute` is the exact contract plan 02-04 replaces
- `BackendAdapter.chatCompletionsStream()` is defined and implemented; plan 02-04 calls it
- `FastifySSEPlugin` is already registered in `buildApp()` (plan 02-02)
- The `AbortController` / socket-close pattern from this plan is the template for plan 02-04's heartbeat + abort wiring

---
*Phase: 02-mvp-vertical-slice-router-ollama-sse*
*Completed: 2026-05-12*

## Self-Check: PASSED

Files verified:
- router/src/backends/adapter.ts: FOUND
- router/src/backends/ollama-openai.ts: FOUND
- router/src/routes/v1/chat-completions.ts: FOUND

Commits verified:
- 600db5f: feat(02-03): add BackendAdapter interface and OllamaOpenAIAdapter implementation
- a2e64b8: feat(02-03): add POST /v1/chat/completions non-stream route + app wiring + tests
- 959703a: fix(02-03): use socket close event for abort signal (not IncomingMessage close)
