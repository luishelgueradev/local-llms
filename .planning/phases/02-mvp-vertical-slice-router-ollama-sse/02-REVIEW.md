---
phase: 02-mvp-vertical-slice-router-ollama-sse
reviewed: 2026-05-12T00:00:00Z
depth: standard
files_reviewed: 34
files_reviewed_list:
  - bin/smoke-test-gpu.sh
  - bin/smoke-test-router.sh
  - router/.dockerignore
  - router/.gitignore
  - router/biome.json
  - router/models.yaml
  - router/package-lock.json
  - router/package.json
  - router/src/app.ts
  - router/src/auth/bearer.ts
  - router/src/backends/adapter.ts
  - router/src/backends/ollama-openai.ts
  - router/src/config/env.ts
  - router/src/config/registry.ts
  - router/src/errors/envelope.ts
  - router/src/index.ts
  - router/src/log/logger.ts
  - router/src/routes/healthz.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/sse/heartbeat.ts
  - router/src/sse/stream.ts
  - router/tests/integration/auth.test.ts
  - router/tests/integration/chat-completions.nonstream.test.ts
  - router/tests/integration/chat-completions.stream.test.ts
  - router/tests/integration/hotreload.test.ts
  - router/tests/msw/handlers.ts
  - router/tests/setup.ts
  - router/tests/unit/bearer.test.ts
  - router/tests/unit/envelope.test.ts
  - router/tests/unit/log/redact.test.ts
  - router/tests/unit/registry.test.ts
  - router/tests/unit/sse/heartbeat.test.ts
  - router/tests/unit/sse/stream.test.ts
  - router/tsconfig.json
  - router/tsup.config.ts
  - router/vitest.config.ts
findings:
  critical: 0
  warning: 7
  info: 6
  total: 13
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-05-12T00:00:00Z
**Depth:** standard
**Files Reviewed:** 34
**Status:** issues_found

## Summary

The Phase 2 router slice is broadly sound for its stated scope: bearer auth is constant-time with length-padding defence, hot-reload uses parse-validate-then-swap with keep-previous-on-error semantics, the SSE pipeline has explicit `[DONE]` synthesis and an APIUserAbortError → `NO_ENVELOPE` path, and pino redact wildcards cover the obvious leak vectors plus future `apiKey`/`api_key` fields. Tests are well-targeted; the redact unit test directly asserts SC5.

No BLOCKER-tier defects were found. The findings below are all WARNING or INFO:

- One real correctness bug: the heartbeat byte counter is off by +2 per beat (writes 14 bytes, reports 16).
- Several quality issues around dead config (`OLLAMA_URL`), dead code (`BearerAuthError` defined but never thrown), unhandled startup-time rejections in `main()`, and a hook-type mismatch between the unit test (`preHandler`) and production (`onRequest`).
- One spec-compliance gap: `Bearer` scheme matching is case-sensitive (RFC 7235 requires case-insensitive).
- Several minor logic / cleanup gaps in the stream branch around `req.raw.socket` being undefined and heartbeat cleanup when `reply.sse(...)` rejects synchronously.

The SC3 unit test in `chat-completions.stream.test.ts` is honest about its limitation (it verifies signal wiring, not actual abort propagation) but flagging here so reviewers don't conflate "test passes" with "abort proven in-process".

## Warnings

### WR-01: Heartbeat reports wrong byte count (off-by-2 per beat)

**File:** `router/src/sse/heartbeat.ts:40-42`
**Issue:** The heartbeat writes the string `': keep-alive\n\n'` (14 bytes UTF-8, verified with `Buffer.byteLength`) but increments the counter by **16**: `bytes += 16;`. The comment on line 41 asserts "16 bytes UTF-8", which is wrong. Over a long-lived stream (e.g., a 60 s wait between tokens) the reported `bytesSinceStart` accumulates a linear error of +2 per 15 s. The value is used in the route's client-disconnect log line (`chat-completions.ts:135`) so the log becomes a small lie under sustained streams. No external observer is affected, but the assertion in the source comment is also false, which will mis-lead the next maintainer trying to debug a stuck stream.
**Fix:**
```ts
// ': keep-alive\n\n' is 14 bytes UTF-8 (':' + ' ' + 'keep-alive' + '\n' + '\n')
bytes += 14;
```
Or, more robustly, compute the byte length once and reuse:
```ts
const PAYLOAD = ': keep-alive\n\n';
const PAYLOAD_BYTES = Buffer.byteLength(PAYLOAD, 'utf8');
// ...
socket.write(PAYLOAD);
bytes += PAYLOAD_BYTES;
```

### WR-02: Bearer scheme match is case-sensitive (RFC 7235 violation)

**File:** `router/src/auth/bearer.ts:22`
**Issue:** `auth.startsWith('Bearer ')` rejects `bearer foo`, `BEARER foo`, and any other case variant. RFC 7235 §2.1 explicitly states that the auth-scheme token is case-insensitive. A spec-conforming client SDK (or proxy like Traefik that may lower-case headers, depending on configuration) could send `bearer <token>` and get a 401 despite providing the correct credential. Not a security hole — wrong cases just fail open to "rejected" — but it is a wire-compatibility bug that will silently bite an integration in Phase 6 (Traefik / proxy chain).
**Fix:**
```ts
const auth = req.headers.authorization;
if (typeof auth !== 'string') {
  /* 401 ... */
}
const SCHEME = 'bearer ';
const lower = auth.slice(0, SCHEME.length).toLowerCase();
if (lower !== SCHEME) {
  /* 401 ... */
}
const supplied = auth.slice(SCHEME.length);
```
Comparing only the first 7 bytes for case keeps the constant-time property of the token compare intact (the credential bytes are still compared with `timingSafeEqual`).

### WR-03: `main()` rejection at startup is unhandled (noisy fatal path)

**File:** `router/src/index.ts:6-58`
**Issue:** `loadEnv()` (line 7), `loadRegistryFromFile()` (line 12), `buildApp()` (line 15), and `makeLoggerOptions()` may all throw before the `try`/`catch` around `app.listen(...)` at lines 49–55. When they do, the throw bubbles to the top-level `void main();` at line 58 and surfaces as an unhandled promise rejection. Node 22's default `--unhandled-rejections=throw` will terminate, but the operator gets a stack trace instead of the readable `app.log.fatal({ err }, 'failed to start')` line. That's noisier than necessary and skips structured logging for the most failure-prone startup paths (bad models.yaml, missing env var).
**Fix:**
```ts
main().catch((err) => {
  // No app.log yet — write a structured JSON line ourselves so log shippers still parse it.
  process.stderr.write(JSON.stringify({
    level: 60, time: Date.now(), msg: 'failed to start',
    err: { name: err?.name, message: err?.message, stack: err?.stack },
  }) + '\n');
  process.exit(1);
});
```
Or wrap the pre-listen block in its own try/catch with a console.error fallback before the logger exists.

### WR-04: Heartbeat is started before reply.sse() — leaks interval if reply.sse rejects synchronously

**File:** `router/src/routes/v1/chat-completions.ts:117-130`
**Issue:** The heartbeat is started at line 117, then `await reply.sse(...)` is called at line 127. If `reply.sse(...)` throws synchronously (e.g., headers already sent, or the plugin in a degraded state), the `sseCleanup` callback inside `chunkToSseEvents`' `finally` block never runs — the iterator is never iterated. Control jumps to the outer `try`/`catch` at line 147, which `req.raw.socket?.off('close', onClose)`s but does NOT call `heartbeat.stop()`. The `unref()` on the interval (heartbeat.ts:52) prevents it from blocking event-loop teardown, but the leak is real until the next write attempt EPIPEs the socket. Two corollary issues:

1. The `stopHeartbeat = () => heartbeat.stop();` closure (line 118) is only wired to the `onClose` listener — and `onClose` may have already been removed before this synchronous throw path. So neither cleanup avenue fires in the worst case.
2. A subtler issue: the `unref()?.()` chain (heartbeat.ts:52) means `process.exit(0)` in `closeGracefully` could fire while a heartbeat interval is still scheduled but unreffed. Harmless on shutdown but not on normal route teardown.

**Fix:** Add a `catch`/`finally` around `reply.sse(...)` that always stops the heartbeat:
```ts
const heartbeat = startHeartbeat(reply.raw);
stopHeartbeat = () => heartbeat.stop();
try {
  await reply.sse(chunkToSseEvents(upstream, { signal: controller.signal, onCleanup: sseCleanup }));
} finally {
  heartbeat.stop(); // idempotent — onCleanup may have already called it
}
```

### WR-05: `req.raw.socket` may be undefined under HTTP/2 or app.inject — abort listener silently no-ops

**File:** `router/src/routes/v1/chat-completions.ts:92`
**Issue:** `req.raw.socket?.once('close', onClose);` uses optional chaining, which means when `req.raw.socket` is undefined (Fastify `app.inject()` synthesizes the request without a real TCP socket; future HTTP/2 also detaches `socket`), the close listener is **never registered**. There is no diagnostic log when this happens. SC3 (kill-curl-mid-stream → abort propagates to Ollama) silently degrades to "router holds the stream open until upstream finishes" — exactly the failure mode this code is supposed to prevent. The integration test for the stream abort branch (chat-completions.stream.test.ts:118–206) even acknowledges that `inject()` cannot exercise this path, so the code is shipping without coverage of the no-socket case.

Today this is an artifact of the test harness, not a real client-facing bug — production traffic does have `req.raw.socket`. But the optional chaining masks a future regression: if HTTP/2 lands in Phase 6 (Traefik front-ends often negotiate HTTP/2 downstream), abort propagation will silently break.
**Fix:** Either (a) log a warning when `req.raw.socket` is undefined so the silent degradation is observable, or (b) use `req.socket` (Fastify's framework-managed accessor that works under HTTP/2), or (c) listen on `reply.raw.on('close', ...)` as a fallback. Belt-and-suspenders option:
```ts
const sock = req.raw.socket;
if (sock) {
  sock.once('close', onClose);
} else {
  req.log.warn({ url: req.url }, 'stream: req.raw.socket undefined — abort propagation may not fire');
}
```

### WR-06: `BearerAuthError` is dead code — defined and re-exported but never thrown

**File:** `router/src/errors/envelope.ts:13-19` + `router/src/auth/bearer.ts:3, 65`
**Issue:** `BearerAuthError` is declared (envelope.ts:13), imported into bearer.ts (line 3), and re-exported (line 65). The envelope module also branches on it twice (lines 34 and 52). But the actual auth hook never throws it — it short-circuits with `reply.code(401).send(...)` (bearer.ts:24, 52). The class is functionally dead, the imports are unused (TS `noUncheckedSideEffectImports` will not catch this — it's a regular import), and the envelope's `instanceof BearerAuthError` branches are unreachable. This is misleading: a future contributor reading envelope.ts would assume a code path exists that funnels auth errors through the centralized handler. There isn't one.
**Fix:** Pick one direction:
- **Either** make the bearer hook throw `BearerAuthError` and let `setErrorHandler` build the envelope (more consistent with the centralized D-C1 design), **or**
- Delete `BearerAuthError` and the dead branches in envelope.ts.

Recommended: throw the error so the auth envelope flows through the same code path as every other 4xx/5xx, reducing duplicated envelope shapes (bearer.ts lines 25-31 vs envelope.ts lines 52-54 are byte-identical today but could drift).

### WR-07: `chunkToSseEvents` swallows non-aborted APIUserAbortError without terminator

**File:** `router/src/sse/stream.ts:32-39`
**Issue:** If the upstream iterator throws `APIUserAbortError` from a NON-router-initiated abort (e.g., upstream SDK's internal timeout, future kill-switch, or any other abort path that doesn't go through `controller.abort` in chat-completions.ts), the flow is:

1. Line 34: `opts.signal?.aborted` is `false` — our controller didn't fire.
2. Line 37: `toOpenAIErrorEnvelope(err)` returns `NO_ENVELOPE` because the error IS an `APIUserAbortError`.
3. Line 38: `return` — generator exits without yielding error frame OR `[DONE]`.

The client sees a truncated stream with no terminator, violating the router's contract that "every stream ends with `data: [DONE]`" (per stream.ts line 28 comment). The original SC1 chunks already sent are valid, but a strict client SDK that waits for `[DONE]` to consider the message complete will hang.
**Fix:** Distinguish "our abort" from "any abort":
```ts
} catch (err) {
  if (opts.signal?.aborted) return;          // (a) we cancelled — no frame, no DONE
  const env = toOpenAIErrorEnvelope(err);
  if (env === NO_ENVELOPE) {
    // (b) APIUserAbortError NOT from us — still surface SOMETHING so the client doesn't hang
    yield { event: '', data: '[DONE]' };
    return;
  }
  // (c) real upstream error — D-C2 frame
  for (const line of midStreamErrorFrameLines(env)) yield line;
}
```

## Info

### IN-01: `OLLAMA_URL` env var is declared but never referenced

**File:** `router/src/config/env.ts:5`
**Issue:** `OLLAMA_URL: z.string().url().default('http://ollama:11434/v1')` is parsed but not consumed anywhere in `router/src/`. The model registry's `backend_url` per-entry is the source of truth. Dead config invites confusion ("which one wins?") in operator handover.
**Fix:** Remove the field, or — if you intend it as a Phase 3 default for vLLM/llama.cpp fallbacks — document the intent inline with a `// TODO(phase-3):` marker so the grep is discoverable.

### IN-02: `req.url.split('?')[0] ?? '/'` — the `??` fallback is unreachable

**File:** `router/src/auth/bearer.ts:18`
**Issue:** `String.prototype.split` always returns an array with at least one element (the original string when no separator matches, the empty string when the input is empty). `[0]` is therefore never `undefined`. The `?? '/'` is dead. Cosmetic but signals over-defensive coding.
**Fix:** Drop the `?? '/'`: `const path = req.url.split('?')[0];`

### IN-03: `models.yaml` contains leftover smoke-test canary comments

**File:** `router/models.yaml:14-15`
**Issue:**
```yaml
# smoke-test-router hot-reload canary 1778589936270300492
# smoke-test-router hot-reload canary 1778591532663322553
```
These are debris from `bin/smoke-test-router.sh` runs (the script appends a canary line at line 326). They were committed by accident. Not a bug — comments are valid YAML and don't affect parsing — but the file is the production registry and should not carry test artifacts.
**Fix:** Strip the canaries before merge:
```bash
sed -i '/# smoke-test-router hot-reload canary/d' router/models.yaml
```
Optionally update `bin/smoke-test-router.sh` to use a sentinel file (e.g., `router/.canary.yaml`) symlinked into the watch path during smoke tests so production `models.yaml` is never mutated.

### IN-04: Unit test for bearer hook uses `preHandler`, production wires it as `onRequest`

**File:** `router/tests/unit/bearer.test.ts:9` vs `router/src/app.ts:46`
**Issue:** The unit test sets the hook on `preHandler` (`tests/unit/bearer.test.ts:9`), but production registers it on `onRequest` (`app.ts:46`). The hook function name in `bearer.ts:17` is also `bearerPreHandler` — vestigial from the earlier wiring decision noted in the inline comment. The behavioural difference matters: `onRequest` runs before body parsing (the comment at app.ts:44 calls this out as the Rule 1 fix), while `preHandler` runs after. So the unit test does not actually exercise the production behaviour around large/malformed bodies arriving with bad auth.
**Fix:** Align the test wiring with production:
```ts
app.addHook('onRequest', makeBearerHook(TOKEN));
```
And rename the inner function to `bearerOnRequest` (or `bearerHook`) so the call site matches the registered phase.

### IN-05: SC3 integration test only verifies signal wiring, not abort propagation

**File:** `router/tests/integration/chat-completions.stream.test.ts:118-206`
**Issue:** The test docstring (lines 122–127) and inline comments (lines 187–195) acknowledge that `app.inject` cannot exercise real client-disconnect because there's no real socket. The test verifies that `capturedSignal !== null` and `capturedSignal.aborted === false`, then lets the generator run to completion. The actual abort path (`req.raw.socket.once('close', ...)` → `controller.abort()` → SDK forwards to undici → upstream connection closes) is only covered by the bash smoke test (`bin/smoke-test-router.sh` SC3 with the `expires_at` static check).

This is by design — vitest cannot fake TCP socket lifecycle reliably — but the test name "abort + error paths (SC3 mocked, ...)" overstates what is verified. A reader scanning test names assumes SC3 is covered in CI; it is not.
**Fix:** Rename the `describe` block to make the limitation explicit:
```ts
describe('POST /v1/chat/completions stream=true — signal wiring (SC3 abort proven by bash smoke, not vitest)', ...)
```
Plus a comment at the top of the file linking to the smoke test:
```ts
// SC3 (real abort propagation to Ollama) is covered by bin/smoke-test-router.sh SC3.
// In-process tests can only verify the signal is plumbed to the adapter.
```

### IN-06: Heartbeat `unref()` uses optional-call (`id.unref?.()`) — defensive but unreachable in Node 22

**File:** `router/src/sse/heartbeat.ts:52`
**Issue:** `id.unref?.()` is optional-called. `setInterval`'s return type in Node 22 (`NodeJS.Timeout`) always provides `unref()`. The `?.` is harmless but signals "I'm not sure this method exists" — which is no longer true on the pinned engines (`engines.node: ">=22.0.0"`). Cosmetic.
**Fix:** Drop the optional chain: `id.unref();`

---

_Reviewed: 2026-05-12T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
