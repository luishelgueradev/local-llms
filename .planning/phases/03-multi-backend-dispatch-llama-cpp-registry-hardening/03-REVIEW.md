---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
reviewed: 2026-05-13T02:30:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - router/src/app.ts
  - router/src/backends/adapter.ts
  - router/src/backends/factory.ts
  - router/src/backends/llamacpp-openai.ts
  - router/src/backends/ollama-openai.ts
  - router/src/backends/liveness.ts
  - router/src/routes/readyz.ts
  - router/src/routes/v1/models.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/concurrency/semaphore.ts
  - router/src/errors/envelope.ts
  - router/src/config/registry.ts
  - router/src/index.ts
  - router/models.yaml
  - compose.yml
  - bin/smoke-test-router.sh
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-05-13T02:30:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

Phase 3 ships a second backend (llama.cpp-server), registry hardening (VRAM envelope, tightened zod schema), liveness probes with `/readyz`, per-backend concurrency semaphores with 429 overflow, and a multi-backend smoke test. The core logic is sound and well-tested (170 passing tests, clean `tsc`). The semaphore implementation is correct (FIFO, idempotent release, abort-listener cleanup on drain promotion). The liveness scheduler is correct (inFlight guard, transition logging, idempotent start/stop). The registry VRAM validation and hot-reload keep-previous semantics are correct.

The known CONCERN C2 (factory.ts dead code in the production chat-completions path) is corroborated — `factory.ts` is used for liveness probes but not for chat requests in production. This is classified as a BLOCKER because the incorrect dispatch produces silent wrong-class usage today and will silently break authentication for Phase 8's `OllamaCloudAdapter`. The one-line fix is clear.

Beyond C2, four other issues were found: a socket listener leak on the hot-reload new-backend path, a hardcoded `INTERVAL_MS` constant duplicated between `readyz.ts` and `app.ts` with no programmatic link, a smoke test that permanently mutates `models.yaml` on every run without cleanup, and a dead `OLLAMA_URL` env var that is parsed but never consumed.

---

## Critical Issues

### CR-01: factory.ts dead in production chat-completions path — wrong adapter class for all requests

**File:** `router/src/app.ts:196`
**Issue:** The production boot path (`index.ts` calls `buildApp({registry, bearerToken, loggerOpts})` with no `makeAdapter` override) resolves the `??` fallback to `makeOllamaAdapterFromEntry` for every chat request, regardless of `entry.backend`. For llamacpp requests this creates `OllamaOpenAIAdapter('http://llamacpp:8080/v1')` — wrong class, correct URL. This works today because both adapters produce identical OpenAI-wire requests and llama.cpp-server accepts them. However:

1. `factory.ts` is imported and used for liveness probes (via `defaultMakeAdapter` in `probeAdapterFor`) but is completely inert for the primary request path. This is architectural dead code.
2. When Phase 8 adds `OllamaCloudAdapter`, which requires `Authorization: Bearer $OLLAMA_API_KEY` rather than the placeholder `'ollama'` apiKey, the production path will silently send `OllamaOpenAIAdapter` (apiKey `'ollama'`) to the cloud endpoint and fail authentication. The failure will appear as a mysterious 401 from Ollama Cloud with no indication of the dispatch error.
3. The comment at line 201–202 (`"Plan 03-01 (wave 2) will swap it to defaultMakeAdapter from factory.ts"`) is stale — no plan executed this swap.

**Fix:**
```typescript
// router/src/app.ts line 194-198 — change one import and one line:

// Remove this import (line 12):
// import { makeOllamaAdapterFromEntry } from './backends/ollama-openai.js';

// Change line 196:
// BEFORE:
registerChatCompletionsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? makeOllamaAdapterFromEntry,
  semaphores,
});

// AFTER:
registerChatCompletionsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
  semaphores,
});
```

The `defaultMakeAdapter` import is already present at line 17. This is a one-line change. All existing integration tests pass because tests inject `makeAdapter` via `opts.makeAdapter`, bypassing the default. The change makes the production path consistent with the test path.

---

## Warnings

### WR-01: Socket listener leak when `opts.semaphores.get()` throws (hot-reload new-backend path)

**File:** `router/src/routes/v1/chat-completions.ts:107-127`
**Issue:** The `sock.once('close', onClose)` listener is registered at line 108 (inside the `if (sock)` block) before the `try` block begins at line 140. `opts.semaphores.get(entry.backend)` at line 127 is also outside the `try` block. If `semaphores.get()` throws — which happens when a hot-reload adds a backend not present at router boot, causing the semaphore Map to lack an entry — the throw propagates to Fastify's centralized error handler but the socket `close` listener is never removed via `.off('close', onClose)`.

The listener is registered with `.once()`, so it auto-removes on first fire. However, if the socket is kept alive (HTTP/1.1 keep-alive) and serves subsequent requests, a stale `onClose` from a failed request remains attached. When it eventually fires it calls `controller.abort()` (on a stale AbortController) and `stopHeartbeat?.()` (null, no-op). No crash, no data corruption, but a memory leak per affected request until the socket closes.

**Fix:** Move `opts.semaphores.get(entry.backend)` inside the `try` block, or add a `finally` cleanup for the socket listener that covers errors thrown before the `try`:

```typescript
// Option A: move semaphore lookup inside the try block
// (simplest — consistent with the comment at line 124-126 which says the acquire IS inside try)

// Around line 127, move to after line 140 (try {):
try {
  const semaphore = opts.semaphores.get(entry.backend);  // ← moved inside try
  release = await semaphore.acquire(controller.signal);
  // ... rest unchanged
} catch (err) {
  req.raw.socket?.off('close', onClose);  // already present — covers the moved lookup too
  throw err;
} finally {
  safeRelease();
}
```

The catch block already calls `req.raw.socket?.off('close', onClose)` at line 225, so moving the lookup into the `try` scope automatically covers the leak.

---

### WR-02: `INTERVAL_MS` hardcoded in `readyz.ts` without programmatic link to the scheduler

**File:** `router/src/routes/readyz.ts:24-25`
**Issue:** `readyz.ts` declares `const INTERVAL_MS = 10_000` with a comment "Must match the scheduler's intervalMs default in app.ts / makeLivenessScheduler." The scheduler is created in `app.ts` with `intervalMs: 10_000`. These two constants are not linked — if one is changed without updating the other, stale detection will be silently wrong (either too eager or too slow).

The `registerReadyz` function signature does not accept an `intervalMs` parameter, so there is no way for `app.ts` to pass the actual scheduler interval to the stale detection logic. A test that injects a custom `livenessFactory` with a different `intervalMs` will produce incorrect stale-detection behavior from `/readyz` if the test doesn't account for the hardcoded 10-second assumption.

**Fix:** Pass the interval to `registerReadyz` or expose it via a shared constant in `liveness.ts`:

```typescript
// Option A: pass intervalMs to registerReadyz (cleanest)
export function registerReadyz(
  app: FastifyInstance,
  registry: RegistryStore,
  liveness: LivenessScheduler,
  intervalMs = 10_000,  // ← new param, defaults to match scheduler default
): void {
  const staleThresholdMs = STALE_FACTOR * intervalMs;
  // replace the hardcoded `STALE_FACTOR * INTERVAL_MS` with `staleThresholdMs`
  ...
}

// app.ts calls registerReadyz with the actual value:
const LIVENESS_INTERVAL_MS = 10_000;
// use in both makeLivenessScheduler and registerReadyz
registerReadyz(app, opts.registry, liveness, LIVENESS_INTERVAL_MS);
```

---

### WR-03: `models.yaml` permanently mutated on every smoke test run — no cleanup

**File:** `bin/smoke-test-router.sh:326`
**Issue:** The SC4 hot-reload test appends a YAML comment to `router/models.yaml` with `>>` (line 326) and never removes it. Every execution of `smoke-test-router.sh` leaves an additional comment line:
```
# smoke-test-router hot-reload canary 1715517600123456789
```
Repeated runs accumulate these lines. `git status` shows `models.yaml` as modified after each run, which is noise in the working tree and can cause confusion. If a test automation system auto-resets the repo (`git checkout -- .`) between runs, the canary marker disappears before the log check at line 332 — in that scenario SC4 would always fail.

**Fix:** Restore the original file after the assertion:

```bash
# SC4 (hot-reload half): edit models.yaml — router logs reload within 1s
echo ""
echo "[smoke-test-router] SC4 (hot-reload half): edit router/models.yaml + watch for reload log..."
HOTRELOAD_MARKER="# smoke-test-router hot-reload canary $(date +%s%N)"
PRE_LINES=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | wc -l)
echo "${HOTRELOAD_MARKER}" >> "${REPO_ROOT}/router/models.yaml"
sleep 1.0
POST_LINES=$(docker compose logs --no-color "${ROUTER_SVC}" 2>&1 | wc -l)
NEW_LINE_COUNT=$((POST_LINES - PRE_LINES + 5))
[[ "${NEW_LINE_COUNT}" -lt 1 ]] && NEW_LINE_COUNT=10
NEW_LINES=$(docker compose logs --no-color --tail "${NEW_LINE_COUNT}" "${ROUTER_SVC}" 2>&1 || true)
# Restore models.yaml — remove the canary line we appended
# Use a temp file to avoid sed -i portability issues
grep -vF "${HOTRELOAD_MARKER}" "${REPO_ROOT}/router/models.yaml" > "${REPO_ROOT}/router/models.yaml.tmp" \
  && mv "${REPO_ROOT}/router/models.yaml.tmp" "${REPO_ROOT}/router/models.yaml"
if echo "${NEW_LINES}" | grep -q 'registry reloaded'; then
  pass "SC4 hot-reload: router logged 'registry reloaded' within 1s of models.yaml edit"
else
  fail "SC4 hot-reload: no 'registry reloaded' log line within 1s of edit. Last log lines: $(echo "${NEW_LINES}" | tail -5)"
fi
```

---

### WR-04: `OLLAMA_URL` parsed from env but never consumed — dead configuration

**File:** `router/src/config/env.ts:5`
**Issue:** `OLLAMA_URL` is declared in `EnvSchema` and validated at startup, but `env.OLLAMA_URL` is never accessed anywhere in `router/src/`. All backend URLs are sourced from `models.yaml` via the registry (Phase 3 design). The `OLLAMA_URL` env var is set in `compose.yml` line 218 and was meaningful in an earlier architecture, but it is now dead configuration that:

1. Confuses operators who see it in `compose.yml` and assume it controls Ollama routing.
2. Adds a spurious URL validation step at startup (minor, but it validates a value that's never used).
3. Will cause confusion when adding new backends — the operator may expect a similar `LLAMACPP_URL` env var when the actual path is `models.yaml`.

**Fix:**
```typescript
// router/src/config/env.ts — remove OLLAMA_URL from EnvSchema:
const EnvSchema = z.object({
  ROUTER_BEARER_TOKEN: z.string().min(8, 'ROUTER_BEARER_TOKEN must be at least 8 characters'),
  // OLLAMA_URL removed — backend URLs are now sourced from models.yaml (Phase 3)
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  MODELS_YAML_PATH: z.string().default('/app/models.yaml'),
});
```

Also remove `OLLAMA_URL=http://ollama:11434/v1` from `compose.yml` line 218 to eliminate the stale configuration.

---

## Info

### IN-01: Semaphore hot-reload gap — new backends added by hot-reload have no semaphore

**File:** `router/src/app.ts:148-169`
**Issue:** The `semaphoreMap` is built once at `buildApp()` time from the initial registry. `index.ts`'s `onReload` callback only calls `app.liveness.start(newUrls)` — it does not update `semaphoreMap`. If a hot-reload adds a new backend name (e.g., a future `vllm` entry), the next request to that backend will throw `Error("No semaphore for backend 'vllm'")` from the `semaphores.get()` accessor, producing a 500 response.

Within Phase 3's scope (ollama + llamacpp both present at boot), this is unreachable. The zod schema only allows `['ollama', 'llamacpp']` so no unknown backend can appear via hot-reload. Becomes a real defect when Phase 7 widens the enum to add `'vllm'` without restarting the router.

**Note:** This is also the root cause of the socket listener leak described in WR-01.

**Suggestion:** Before Phase 7, add semaphore initialization to the `onReload` callback, or document that adding a new backend type requires a router restart.

---

### IN-02: Stale success message banner after Phase 3 section added to smoke test

**File:** `bin/smoke-test-router.sh:99, 617`
**Issue:** Line 99 prints `"local-llms — Phase 2 Router Verification"` in the banner, and line 617 prints `"Phase 2 router verification: COMPLETE."` in the success summary. The Phase 3 section was appended without updating these labels. A reader running the full test sees a "Phase 2" success banner even after all Phase 3 assertions pass.

**Fix:**
```bash
# Line 99:
echo "[smoke-test-router]  local-llms — Phase 2+3 Router Verification"
# Line 617:
echo "[smoke-test-router]  Phase 2+3 router verification: COMPLETE."
```

---

### IN-03: Production `router` service omits `MODELS_YAML_PATH` env var — relies on default

**File:** `compose.yml:216-221`
**Issue:** The production `router` service environment block does not set `MODELS_YAML_PATH`. It relies on the env schema default (`'/app/models.yaml'`) which happens to match the volume mount at line 231 (`./router/models.yaml:/app/models.yaml:ro`). The `router-dev` service correctly sets `MODELS_YAML_PATH=/app/models.yaml` explicitly (line 269). If the volume mount path is changed in a future phase without updating the env schema default, the mismatch will be silent at startup (no validation error) and the router will fail to find `models.yaml` only at runtime.

**Fix:**
```yaml
# compose.yml router service environment section:
environment:
  - ROUTER_BEARER_TOKEN=${ROUTER_BEARER_TOKEN}
  - MODELS_YAML_PATH=/app/models.yaml  # ← add explicit value; matches volume mount
  - PORT=3000
  - LOG_LEVEL=info
  - NODE_ENV=production
```

---

## CONCERN C2 Corroboration

The verification report's CONCERN C2 is **corroborated and reclassified as BLOCKER (CR-01)**.

Evidence:
- `app.ts` line 196: `makeAdapter: opts.makeAdapter ?? makeOllamaAdapterFromEntry`
- `index.ts` line 15: `buildApp({ registry, bearerToken, loggerOpts })` — no `makeAdapter` passed
- Therefore: production always uses `OllamaOpenAIAdapter` for ALL chat requests (wrong class, correct URL for llamacpp today)
- `factory.ts` IS used for liveness probes (`probeAdapterFor` calls `defaultMakeAdapter` at app.ts line 109) — not dead for probes, dead for requests
- The stale comment at app.ts line 201–202 confirms the swap was promised but never executed

The reclassification from concern to blocker is warranted because the incorrect wiring is already present in production, not just a future risk. The fix is a one-line change with zero test impact.

---

## Verdict: ship-with-follow-ups

Phase 3 is functionally correct for its stated scope (Phase 3 only has two backends, both sharing the same OpenAI-compatible wire format, so CR-01 does not cause observable failure today). All 170 tests pass, TypeScript is clean, and live smoke-test FAILURES=0.

**Recommended action before Phase 4 ships:** Apply CR-01 (one-line fix, zero risk). WR-01, WR-02, WR-03, WR-04 can ship as follow-ups but are each straightforward fixes.

**Required before Phase 8 planning begins:** CR-01 must be fixed as a prerequisite. WR-01 (socket listener leak) should also be fixed since Phase 8 adds hot-reload scenarios with new backend types.

---

_Reviewed: 2026-05-13T02:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
