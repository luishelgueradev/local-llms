---
phase: 02-mvp-vertical-slice-router-ollama-sse
verified: 2026-05-12T00:00:00Z
status: passed
score: 6/6 must-haves verified (SC3 attested via HUMAN-UAT.md)
overrides_applied: 0
human_verification:
  - test: "SC3 live abort — kill curl mid-stream and confirm Ollama stops generating within ~1s"
    expected: "Ollama /api/ps expires_at delta = 0s between two snapshots 1.5s apart (model went idle, not still generating)"
    why_human: "req.raw.socket?.once('close') uses optional chaining — in inject() test harness socket is undefined so the close listener is never registered (WR-05). Live SC3 can only be verified end-to-end against the real GPU stack. Operator confirmed PASS in SUMMARY.md cycle 2, but the test harness cannot replicate this."
---

# Phase 2: MVP Vertical Slice (Router + Ollama + SSE) Verification Report

**Phase Goal:** Smallest end-to-end thing that proves the architecture: one agent curl-streams tokens from a real local model through the router, with auth and abort-propagation correct from day one. No platform services; no Anthropic; no other backends.
**Verified:** 2026-05-12T00:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | `curl -N` streams OpenAI-shape `data:` deltas, ends with `data: [DONE]`, includes `usage` in final chunk | VERIFIED | `chunkToSseEvents` yields `{ data: JSON.stringify(chunk) }` per upstream chunk, unconditionally yields `{ data: '[DONE]' }`. `stream_options: { include_usage: true }` baked into `OllamaOpenAIAdapter.chatCompletionsStream()`. Smoke-test: 32 chunks, pt=34 ct=30 tt=64, arithmetic correct. |
| SC2 | `POST /v1/chat/completions` non-stream returns full OpenAI response with `usage.{prompt_tokens,completion_tokens,total_tokens}` | VERIFIED | `OllamaOpenAIAdapter.chatCompletions()` passes `stream_options: { include_usage: true }` and returns the full `ChatCompletion` via the SDK. Route sends `result` verbatim. Smoke-test: pt=38 ct=9 tt=47. |
| SC3 | Killing curl mid-stream returns GPU to idle within ~1s — socket close fires, AbortController aborts, Ollama stops | UNCERTAIN | Code path exists: `req.raw.socket?.once('close', onClose)` → `controller.abort()` → SDK signal → undici closes upstream TCP. WR-05 flags that optional chaining silently no-ops when `req.raw.socket` is undefined (inject() harness, future HTTP/2). Integration test only verifies signal is non-null (not abort propagation). Smoke-test cycle 2 reports PASS (delta=0.00s) but this is operator-attested, not code-verified in CI. Routing to human verification. |
| SC4 | Bearer auth: `/healthz` unauth → 200; `/v1/*` missing/wrong bearer → 401; models.yaml hot-reload within 1s | VERIFIED | `/healthz` in `PUBLIC_PATHS`, `addHook('onRequest', makeBearerHook(...))` before body parsing. `watchRegistry` uses fs.watch + 250ms debounce + `store._swap()`. `index.ts` logs `'registry reloaded'`. Smoke-test: auth assertions + hot-reload PASS. |
| SC5 | No bearer-token leaks in router logs | VERIFIED | pino `redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["proxy-authorization"]', '*.apiKey', '*.api_key', 'headers.authorization', 'headers.cookie'], censor: '[REDACTED]' }`. Smoke-test SC5 two-prong regex (literal token + token-shaped suffix ≥16 chars): 0 matches. |
| SC6 (ROUTE-02) | Hot-reload of models.yaml without restart | VERIFIED | `watchRegistry()` in `registry.ts`: fs.watch + 250ms debounce + validate-then-swap. Invalid YAML keeps previous registry (D-C3). Registry tests cover: valid swap, debounce coalesce, invalid-YAML-keeps-previous, idempotent stop, canary fs.watch fires. Smoke-test PASS. |

**Score:** 5/6 truths verified (SC3 uncertain — human verification required)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `router/src/app.ts` | Fastify factory with SSE, zod, bearer hook, healthz | VERIFIED | `buildApp()` wires FastifySSEPlugin, zod type providers, `onRequest` bearer hook, error handler, healthz route, chat-completions route |
| `router/src/auth/bearer.ts` | timingSafeEqual + PUBLIC_PATHS + length-padding | VERIFIED | `crypto.timingSafeEqual`, `randomBytes` padBuf, `PUBLIC_PATHS = new Set(['/healthz'])` |
| `router/src/log/logger.ts` | pino redact OBJECT form, 7 paths, `[REDACTED]` censor | VERIFIED | Object-form redact with 7 paths present; `censor: '[REDACTED]'` |
| `router/src/config/env.ts` | Zod env loader, ROUTER_BEARER_TOKEN required | VERIFIED | `z.string().min(8)` for token; PORT, LOG_LEVEL, NODE_ENV, MODELS_YAML_PATH all validated |
| `router/src/config/registry.ts` | Zod schema + js-yaml + resolve + watchRegistry | VERIFIED | ModelEntrySchema, RegistrySchema, loadRegistryFromFile, loadRegistryFromString, makeRegistryStore, watchRegistry all present and substantive |
| `router/src/errors/envelope.ts` | D-C1 envelope + D-C3 status mapping + NO_ENVELOPE | VERIFIED | BearerAuthError, RegistryUnknownModelError, NO_ENVELOPE sentinel, toOpenAIErrorEnvelope, mapToHttpStatus, midStreamErrorFrameLines |
| `router/src/routes/healthz.ts` | GET /healthz → 200 no auth | VERIFIED | Returns `{ status, service, phase, registry_models }` synchronously |
| `router/src/routes/v1/chat-completions.ts` | Full stream + non-stream branches | VERIFIED | Non-stream: adapter.chatCompletions → reply.send. Stream: adapter.chatCompletionsStream → startHeartbeat → reply.sse(chunkToSseEvents). Abort via socket?.once('close') |
| `router/src/backends/adapter.ts` | BackendAdapter interface (D-B2 seam) | VERIFIED | BackendAdapter interface, AdapterFactory type |
| `router/src/backends/ollama-openai.ts` | OllamaOpenAIAdapter wrapping openai SDK v6 | VERIFIED | `apiKey: 'ollama'`, `timeout: 60_000`, `stream_options: { include_usage: true }` in both paths |
| `router/src/sse/heartbeat.ts` | 15s keep-alive heartbeat helper | VERIFIED | `startHeartbeat(socket, intervalMs=15_000)`, `.stop()` idempotent, `id.unref?.()`, EPIPE-safe |
| `router/src/sse/stream.ts` | chunkToSseEvents async generator | VERIFIED | Yields `{ data: JSON }` per chunk, synthesizes `{ data: '[DONE]' }`, D-C2 mid-stream error frame, Pitfall-8 early-return on `signal.aborted` |
| `router/src/index.ts` | Bootstrap: env → registry → buildApp → watchRegistry → listen | VERIFIED | loadEnv → loadRegistryFromFile → makeRegistryStore → buildApp → watchRegistry → listen; SIGTERM/SIGINT with watcher.stop() before app.close() |
| `bin/smoke-test-router.sh` | End-to-end SC1..SC5 bash smoke | VERIFIED | All 5 SCs implemented with FAILURES counter, pass()/fail() helpers, exit 0/1 discipline |
| `compose.yml` | Router service: localhost-only port, networks, bind-mount, healthcheck | VERIFIED | `127.0.0.1:3000:3000`, networks: app + backend, `./router/models.yaml:/app/models.yaml:ro`, healthcheck via node fetch |
| `compose.yml` | Ollama host port removed (D-A4) | VERIFIED | No `127.0.0.1:11434` port publish; tombstone comment `Phase 2 D-A4 removed` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `app.ts` | `auth/bearer.ts` | `addHook('onRequest', makeBearerHook(...))` | WIRED | `onRequest` hook confirmed — runs before body parsing (Rule 1 fix from plan 02-02) |
| `app.ts` | `log/logger.ts` | `Fastify({ logger: loggerOptions })` — OPTIONS not instance | WIRED | `opts.loggerOpts ?? loggerOptions` pattern; Fastify v5 contract honored |
| `index.ts` | `config/registry.ts` | `watchRegistry(env.MODELS_YAML_PATH, registry, {...})` | WIRED | Both `loadRegistryFromFile` and `watchRegistry` imported and called with `env.MODELS_YAML_PATH` |
| `chat-completions.ts` | `backends/adapter.ts` | `adapter: BackendAdapter` type reference | WIRED | Route handler typed against interface; `makeAdapter(entry)` factory injection |
| `chat-completions.ts` | `config/registry.ts` | `opts.registry.resolve(body.model)` | WIRED | Registry resolve called; throws `RegistryUnknownModelError` on miss → 404 envelope |
| `chat-completions.ts` | `sse/heartbeat.ts` + `sse/stream.ts` | `startHeartbeat(reply.raw)` + `reply.sse(chunkToSseEvents(...))` | WIRED | Both imports present and called in stream branch |
| `chat-completions.ts` | `AbortController` | `req.raw.socket?.once('close', onClose)` → `controller.abort()` → `adapter.chatCompletionsStream(params, controller.signal)` | WIRED | Signal forwarded to SDK; socket close listener registered (with optional chaining caveat — WR-05) |
| `ollama-openai.ts` | `openai SDK` | `new OpenAI({ baseURL: entry.backend_url, apiKey: 'ollama', timeout: 60_000 })` | WIRED | SDK v6 instantiated with `stream_options: { include_usage: true }` in both methods |
| `compose.yml` | `router/Dockerfile` | `build: ./router` | WIRED | Confirmed in compose.yml |
| `compose.yml` | `router/models.yaml` | `./router/models.yaml:/app/models.yaml:ro` | WIRED | Read-only bind mount present |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `chat-completions.ts` (stream) | `upstream` (AsyncIterable) | `adapter.chatCompletionsStream(upstreamParams, signal)` → openai SDK → Ollama `/v1/chat/completions` | Yes — real GPU inference via HTTP to `http://ollama:11434/v1` | FLOWING |
| `chat-completions.ts` (non-stream) | `result` (ChatCompletion) | `adapter.chatCompletions(upstreamParams, signal)` → openai SDK → Ollama | Yes — real GPU inference | FLOWING |
| `healthz.ts` | `registry_models` | `registry.get().models.length` | Yes — sourced from parsed models.yaml | FLOWING |
| `registry.ts` | `snapshot` | `loadRegistryFromFile(path)` → js-yaml → zod parse | Yes — from real file on disk | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Bearer auth rejects missing token | Code review: `addHook('onRequest', makeBearerHook(...))` at app.ts:46; returns 401 when `PUBLIC_PATHS.has(path)` is false and auth header absent | Code path confirmed | PASS |
| healthz skips auth | `PUBLIC_PATHS = new Set(['/healthz'])` at bearer.ts:6; early return at bearer.ts:19 | Code path confirmed | PASS |
| stream_options.include_usage baked in | Both methods in ollama-openai.ts set `stream_options: { include_usage: true }` | Code path confirmed | PASS |
| [DONE] always synthesized | `yield { data: '[DONE]' }` at stream.ts:31 — unconditional after upstream iterates | Code path confirmed | PASS |
| Hot-reload keeps prev on invalid YAML | `try { ... store._swap(next) } catch { opts.onError?.(err) }` in registry.ts:104-114 | Code path confirmed; 3 registry unit tests + 1 integration test cover this | PASS |
| Ollama host port absent | grep '127.0.0.1:11434' compose.yml → not in ports block | Confirmed — tombstone comment only | PASS |

Step 7b runtime checks skipped: router requires `docker compose up` + GPU — cannot test without live stack. Live verification performed by operator per 02-05-SUMMARY.md.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| ROUTE-01 | 02-01, 02-02 | Fastify v5 + TypeScript router as Compose service on Node 22 LTS | SATISFIED | router Compose service with `build: ./router`; Dockerfile uses `node:22-bookworm-slim` exclusively (4 stages); `src/index.ts` listens on `:3000` |
| ROUTE-02 | 02-02, 02-05 | models.yaml zod-validated at load; hot-reloaded via fs.watch | SATISFIED | `loadRegistryFromFile` + zod; `watchRegistry` with 250ms debounce + swap; keep-previous on error |
| ROUTE-03 | 02-02 | Bearer-token auth with constant-time compare on all model endpoints | SATISFIED | `crypto.timingSafeEqual` + length-padding padBuf; `onRequest` hook fires before body parsing |
| ROUTE-04 | 02-02 | `/healthz` returns 200 without auth | SATISFIED | `PUBLIC_PATHS.has('/healthz')` early return in bearer hook; healthz route returns 200 synchronously |
| ROUTE-05 | 02-02 | pino redacts authorization, cookie, *.apiKey | SATISFIED | 7-path OBJECT-form redact with `[REDACTED]` censor; SC5 smoke confirms zero leaks |
| ROUTE-08 | 02-04 | SSE: 15s heartbeat, backpressure, req.raw.on('close') aborts AbortController | PARTIAL — see note | 15s heartbeat present (`startHeartbeat`). Abort via `req.raw.socket?.once('close')` present. Backpressure (`reply.raw.write()` return-value check + `'drain'` await) is NOT implemented — `fastify-sse-v2`'s `reply.sse()` async-iterable consumer handles internal flow control but there is no explicit `'drain'` listener or write-return-value check in the router code. The phase scope accepted `reply.sse(asyncIterable)` delegation as sufficient for Phase 2. |
| OAI-01 | 02-03, 02-04 | POST /v1/chat/completions non-stream and stream | SATISFIED | Both branches fully implemented; 501 stub replaced in plan 02-04 |
| OAI-04 | 02-04 | SSE responses follow OpenAI delta-based wire format | SATISFIED | `chunkToSseEvents` yields `{ data: JSON.stringify(chunk) }` per ChatCompletionChunk; format matches OpenAI convention |
| OAI-05 | 02-03, 02-04 | Token usage in non-stream and final SSE chunk | SATISFIED | `stream_options: { include_usage: true }` baked into both adapter methods; usage present in final chunk (choices:[], usage:{pt,ct,tt}) |

**Note on ROUTE-08 partial:** The requirement text specifies "backpressure via `reply.raw.write()` return-value check + `'drain'` await" — this exact mechanism is not implemented. The router delegates stream flow control entirely to `fastify-sse-v2`'s `reply.sse(asyncIterable)` which handles its own internal buffering. For Phase 2 single-user load this is functionally adequate, but the requirement as written is not letter-for-letter met. This is not a blocker given Phase 2 scope (single user, no high-concurrency requirement), but is flagged for completeness.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `router/src/sse/heartbeat.ts` | 41 | `bytes += 16` — wrong byte count for `': keep-alive\n\n'` (actual: 14 bytes UTF-8). WR-01 from code review. | Warning | `bytesSinceStart` inaccurate in client-disconnect log; cosmetic but comment is wrong |
| `router/src/auth/bearer.ts` | 22 | `auth.startsWith('Bearer ')` — case-sensitive; RFC 7235 requires case-insensitive scheme. WR-02. | Warning | Clients sending `bearer <token>` (lowercase) get 401 despite correct credential; will bite in Phase 6 (Traefik proxy chain) |
| `router/src/index.ts` | 58 | `void main()` — unhandled rejection path for pre-listen throws (env, registry, buildApp). WR-03. | Warning | Operator gets raw stack trace instead of structured fatal log on startup failures |
| `router/src/routes/v1/chat-completions.ts` | 117-130 | Heartbeat started before `reply.sse()` — if `reply.sse` throws synchronously, `heartbeat.stop()` may not be called via either cleanup path. WR-04. | Warning | Interval leak until EPIPE; mitigated by `id.unref?.()` but not fully resolved |
| `router/src/routes/v1/chat-completions.ts` | 92 | `req.raw.socket?.once('close', onClose)` — optional chaining silently no-ops when socket is undefined (inject() harness, future HTTP/2). WR-05. | Warning | SC3 abort propagation silently degrades to no-op; no diagnostic log |
| `router/src/errors/envelope.ts` | 13-19 | `BearerAuthError` defined but never thrown — bearer hook does `reply.code(401).send(...)` directly, making the class dead code. WR-06. | Info | Misleading: envelope.ts has unreachable branches for this class |
| `router/src/sse/stream.ts` | 32-39 | Non-router-initiated `APIUserAbortError` path returns without `[DONE]` terminator — client may hang waiting for terminator. WR-07. | Warning | Edge case; would only trigger if SDK's internal mechanism aborts without our controller firing |
| `router/models.yaml` | 14-15 | Leftover smoke-test canary comments (IN-03 from code review). | Info | Production registry contains test artifacts; harmless but untidy |
| `router/src/config/env.ts` | 5 | `OLLAMA_URL` declared but never consumed in src/. Registry's per-entry `backend_url` is the source of truth. IN-01. | Info | Dead config; possible operator confusion |

All Warning-severity items were identified in the code review (`02-REVIEW.md`). None are blockers for Phase 2 goal achievement, but WR-02 (Bearer case-sensitivity) and WR-05 (socket optional chaining) should be addressed before Phase 6 (Traefik proxy).

### Human Verification Required

#### 1. SC3 — Abort propagates to Ollama under real TCP disconnect

**Test:** Start a long stream with `curl -N`, kill curl after ~2 seconds, wait 1.5s, compare two `/api/ps` `expires_at` snapshots via the smoke test.
**Expected:** `expires_at` delta = 0.00s between snapshots (model went idle, not still generating); or model absent from `size_vram`; smoke test exits 0 for SC3.
**Why human:** `req.raw.socket?.once('close', onClose)` uses optional chaining. In the vitest `app.inject()` harness, `req.raw.socket` is undefined, so the close listener is never registered and the test cannot exercise the actual abort chain. The integration test (`chat-completions.stream.test.ts`) honestly acknowledges this limitation — it only verifies the signal is non-null, not that real abort propagation fires. The bash smoke test at `bin/smoke-test-router.sh` SC3 is the only CI-equivalent check. Operator recorded PASS (delta=0.00s) in cycle 2 SUMMARY.md. A repeat run is the recommended verification.

**Command to verify:**
```bash
bash bin/smoke-test-router.sh
# Look for: PASS: SC3: abort propagated to Ollama (PASS:static expires_at delta=0.00s)
```

### Gaps Summary

No blocking gaps found. The phase goal — one agent curl-streams tokens from a real local model through the router with auth and abort-propagation correct — is implemented in the codebase. All six observable truths are either VERIFIED or UNCERTAIN pending human re-run of a known-passing live test.

The one UNCERTAIN item (SC3) is uncertain not because the code is wrong, but because the test infrastructure (inject() harness) cannot exercise real TCP disconnect. Operator live verification in cycle 2 confirmed PASS. Human verification is requested to confirm the live result is reproducible.

**ROUTE-08 backpressure note:** The requirement text specifies `reply.raw.write()` return-value check + `'drain'` await. The implementation delegates to `fastify-sse-v2`'s async-iterable consumer. This is a spec-reading gap, not a runtime failure for Phase 2's single-user scope.

**WR-02 (case-sensitive Bearer):** Not a Phase 2 blocker (all current clients send `Bearer`) but flagged for Phase 6 (Traefik may normalize headers).

---

_Verified: 2026-05-12T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
