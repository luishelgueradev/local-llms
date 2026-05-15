---
phase: 02-mvp-vertical-slice-router-ollama-sse
reviewed: 2026-05-15T22:49:41Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - bin/smoke-test-router.sh
  - router/models.yaml
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
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 2: Code Review Report (Refresh + Fix Cycle)

**Reviewed:** 2026-05-15
**Depth:** standard
**Files Reviewed:** 15
**Status:** clean — all findings resolved

## Fix Cycle Complete (2026-05-15)

All 8 findings from the 2026-05-15 refresh pass were resolved across 8 atomic commits:

| Finding | Commit | Resolution |
|---------|--------|------------|
| WR-01 — `skip()` called before defined (line 536 vs 662) | `45caa27` | Hoisted `SKIPS=0` + `skip()` to lines 104-107 alongside `fail()`/`pass()`. **Also closes 03/WR-05.** |
| WR-02 — B1/B2/B3 cascading false failures when llamacpp unhealthy | `7d04bed` | Gate B1/B2/B3 on `LLAMACPP_HEALTHY == "true"` |
| WR-03 — `$ROUTER_BEARER_TOKEN` interpolated into `grep -iE` without `-F` | `c0b3357` | Use `-F` for token in SC5 FIRST_MATCH diagnostic |
| IN-01 — `OLLAMA_URL` env var unused | `daa0ea5` | Removed dead `OLLAMA_URL` from EnvSchema. **Also closes 03/WR-04.** |
| IN-02 — Unreachable `?? '/'` in `bearer.ts:24` | `c4391ae` | Dropped fallback |
| IN-03 — SC3 describe name misleading | `78dd907` | Clarified describe block name |
| IN-04 — `id.unref?.()` optional chain unreachable on Node 22 | `e086c0f` | Removed optional chain |
| IN-05 — Dead export `chunkToSseEvents` from sse/stream.ts | `ab2f156` | Added deprecation banner |

**Validation:** `bash -n bin/smoke-test-router.sh` clean; `tsc --noEmit` clean; `vitest run` for affected tests — 21 passed, 2 skipped, 0 failures.

---

# Prior Refresh Findings (now all resolved — kept for traceability)

**Status (historical):** issues_found

**Refresh history:** Prior pass 2026-05-12 (7 warnings, 6 info). Current pass 2026-05-15.

## Summary

All seven WR-tier findings from the 2026-05-12 pass have been closed by the fix commits listed below. The 15 in-scope source files are in good shape: the bearer hook now correctly case-folds the scheme, the heartbeat byte counter is accurate, startup failures surface as structured stderr, the SSE heartbeat is always cleaned up, missing-socket degradation is observable, BearerAuthError flows through the centralized handler, and the non-aborted APIUserAbortError path emits `[DONE]`. The `models.yaml` canary debris is gone and the bearer unit test hook phase is aligned.

Three new warnings surface in this pass, all in `bin/smoke-test-router.sh`: the `skip()` helper is called before it is defined (bash will error when `SKIP_LLAMACPP=1` + GGUF present), the `LLAMACPP_HEALTHY` flag is set but never read so B-section assertions fire even after a failed compose-up, and the SC5 diagnostic grep injects the raw bearer token into an `-iE` pattern which breaks for tokens containing ERE metacharacters. Four previously-raised info items remain open (unused `OLLAMA_URL` env var, one unreachable null-coalescing branch, the SC3 test describe name, and the optional-chain on `id.unref?.()`) plus one newly-found dead export in `stream.ts`.

---

## Closed since prior pass

| ID | Fix commit | Status |
|----|-----------|--------|
| WR-01 Heartbeat byte counter off-by-2 | `3857a34` | **Closed** — `Buffer.byteLength` pre-computed at module scope; payload constant shared between write and counter |
| WR-02 Bearer scheme case-sensitive | `6b096fa` | **Closed** — 7-byte scheme prefix lower-cased before compare; `timingSafeEqual` still sees verbatim credential bytes |
| WR-03 Unhandled pre-listen rejection | `0156c57` | **Closed** — `main().catch(...)` wraps the whole chain; structured pino-shaped JSON written to stderr before `process.exit(1)` |
| WR-04 Heartbeat leaked when `reply.sse` rejects synchronously | `ef26725` | **Closed** — `try/finally` wraps `await reply.sse(...)` and calls idempotent `heartbeat.stop()` unconditionally |
| WR-05 Missing socket silent no-op | `d9136e6` | **Closed** — explicit `if (sock)` / `else req.log.warn(...)` branch; degradation now observable in logs |
| WR-06 BearerAuthError dead code | `5692373` | **Closed** — hook now throws `BearerAuthError`; centralized error handler translates to 401 envelope |
| WR-07 Non-router APIUserAbortError emits no terminator | `d364c59` | **Closed** — explicit `opts.signal?.aborted` guard first; `NO_ENVELOPE` path falls through to `yield { event: '', data: '[DONE]' }` |
| IN-03 Canary comments in models.yaml | (manual) | **Closed** — no canary lines present in current HEAD |
| IN-04 Bearer unit test wired as `preHandler` | (manual) | **Closed** — `bearer.test.ts:13` now uses `addHook('onRequest', ...)`; inner function renamed to `bearerOnRequest` |

---

## Warnings

### WR-01: `skip()` called before it is defined — script aborts when `SKIP_LLAMACPP=1` + GGUF present

**File:** `bin/smoke-test-router.sh:536` (call) vs `:662` (definition)
**Issue:** `pass()` and `fail()` are defined at lines 106–107 and used safely throughout. `skip()` is defined at line 662 together with `SKIPS=0`, but it is first called at line 536 (inside the `if [[ "${SKIP_LLAMACPP:-0}" == "1" ]]; then` branch, which itself is inside the `if [[ -f "${GGUF_PATH}" ]]; then` block). When an operator runs the script with `SKIP_LLAMACPP=1` and the GGUF file exists, bash reaches line 536, finds `skip` is an undefined command, and exits with an error under `set -uo pipefail`. The `SKIPS` counter referenced inside `skip()` also does not exist at that point, so even a partial workaround (defining `skip` inline) would leave `SKIPS` unbound.

This path is not the common case (GGUF is optional, `SKIP_LLAMACPP` defaults to 0), but the operator comment in Phase 3.B explicitly documents `SKIP_LLAMACPP=1` as the recommended escape hatch for slow WSL2 hosts — the exact scenario where the bug fires.
**Fix:** Move the `SKIPS=0` initialization and `skip()` definition up alongside `fail()` and `pass()` at lines 104–107:
```bash
FAILURES=0
SKIPS=0
fail() { echo "[smoke-test-router] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[smoke-test-router] PASS: $*"; }
skip() { echo "[smoke-test-router] SKIP: $*"; SKIPS=$((SKIPS + 1)); }
```
And remove the duplicate declarations at lines 661–662.

### WR-02: `LLAMACPP_HEALTHY` flag set but never read — B1/B2/B3 assertions fire unconditionally

**File:** `bin/smoke-test-router.sh:540,549` (set) and `580–637` (B1/B2/B3 assertions)
**Issue:** When `docker compose --profile llamacpp up -d --wait` fails (line 541–548), `LLAMACPP_HEALTHY` is set to `false` and `fail()` is called. However, the B-section assertions (B1: model chat, B2: /readyz inverse, B3: GPU residency) at lines 580–637 run unconditionally regardless of `LLAMACPP_HEALTHY`. If the compose up failed, llamacpp is not running, so B1's curl returns an error, `python3 -c "d = json.load(sys.stdin)"` receives empty/error output and the assertion fails — inflating `FAILURES` with a cascading false failure on top of the real one. The `fail()` message added at line 548 already told the operator what went wrong; the subsequent B-section failures are noise that obscures the real signal and increases `FAILURES` by up to 3.

**Fix:** Guard B1/B2/B3 on `LLAMACPP_HEALTHY`:
```bash
if [[ "${LLAMACPP_HEALTHY}" == "true" ]]; then
  # Assertion B1: ...
  # Assertion B2: ...
  # Assertion B3: ...
fi
```
Or, consistent with the existing `SKIP_LLAMACPP` pattern, convert the B-section assertions to `skip` calls when `LLAMACPP_HEALTHY=false`:
```bash
if [[ "${LLAMACPP_HEALTHY}" != "true" ]]; then
  skip "Phase 3.B assertions B1/B2/B3: skipped because compose --profile llamacpp up failed"
else
  # ... B1/B2/B3 assertions ...
fi
```

### WR-03: SC5 diagnostic grep interpolates bearer token as ERE — breaks for tokens with regex metacharacters

**File:** `bin/smoke-test-router.sh:379`
**Issue:** The `FIRST_MATCH` diagnostic at line 379 places `${ROUTER_BEARER_TOKEN}` verbatim into a `grep -iE` pattern:
```bash
FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -iE "${ROUTER_BEARER_TOKEN}|bearer ..." | head -1)
```
`grep -E` treats the pattern as an extended regular expression. If the token contains ERE metacharacters — `[`, `]`, `(`, `)`, `.`, `*`, `+`, `?`, `{`, `}`, `^`, `$`, `|`, `\` — the resulting pattern is either malformed (grep exits non-zero, which with `set -uo pipefail` aborts the script) or silently matches wrong log lines. For example, a token `my.secret[key]` would make the `[key]` a character class that matches `k`, `e`, or `y`. The minimum-length validation in `env.ts` does not constrain the character set.

Prong 1 at line 374 correctly uses `grep -cF "${ROUTER_BEARER_TOKEN}"` (fixed-string), so the literal leak check is safe. Only the diagnostic `FIRST_MATCH` line uses ERE interpolation.

Note: this path is only reachable when `LEAK_COUNT != 0` — i.e., when prong 1 or prong 2 already detected a leak. Nevertheless, a malformed regex would abort the test at exactly the moment the operator needs the diagnostic to succeed.

**Fix:** Use `-F` (fixed string) for the token portion of the `FIRST_MATCH` grep, or use two separate greps:
```bash
FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -F "${ROUTER_BEARER_TOKEN}" | head -1)
if [[ -z "${FIRST_MATCH}" ]]; then
  FIRST_MATCH=$(printf '%s\n' "${SC5_LOGS}" | grep -iE 'bearer [A-Za-z0-9._+/=-]{16,}|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._+/=-]{16,}' | head -1)
fi
```

---

## Info

### IN-01: `OLLAMA_URL` env var is declared but never referenced (still open)

**File:** `router/src/config/env.ts:11`
**Issue:** `OLLAMA_URL: z.string().url().default('http://ollama:11434/v1')` is parsed and validated but not consumed anywhere in `router/src/`. The model registry's per-entry `backend_url` field is the source of truth for backend URLs. The dead variable invites operator confusion ("which one wins?") and adds a spurious validation path.
**Fix:** Remove the field, or document the intended use with a `// TODO(phase-N):` marker that a grep can surface.

### IN-02: `?? '/'` fallback in `bearer.ts` is unreachable

**File:** `router/src/auth/bearer.ts:24`
**Issue:** `const path = (req.url.split('?')[0] ?? '/');` — `String.prototype.split` always returns an array with at least one element, so `[0]` is never `undefined`. The `?? '/'` default is dead code.
**Fix:** Drop the null-coalescing: `const path = req.url.split('?')[0];`

### IN-03: SC3 test describe block name overstates coverage (still open)

**File:** `router/tests/integration/chat-completions.stream.test.ts:136`
**Issue:** `describe('POST /v1/chat/completions stream=true — abort + error paths (SC3 mocked, D-C2, RESEARCH Pitfall 2 + 8)', ...)` — the name contains "SC3 mocked" but a reader scanning test output may conflate this with full SC3 coverage. Real abort propagation (kill-curl → signal → upstream TCP close) is only proven by the bash smoke test. The function-level comment at line 147 does acknowledge the limitation, but the describe name is what appears in CI summaries.
**Fix:** Rename to make the limitation visible in the describe string:
```ts
describe('POST /v1/chat/completions stream=true — abort signal wiring (SC3 real-abort proven by bash smoke, not vitest)', ...)
```

### IN-04: `id.unref?.()` optional-chain is unreachable on Node 22

**File:** `router/src/sse/heartbeat.ts:88`
**Issue:** `id.unref?.()` — `setInterval` returns `NodeJS.Timeout` in Node 22, which always has `unref()`. The optional chain signals uncertainty that no longer exists on the pinned runtime.
**Fix:** `id.unref();`

### IN-05: `chunkToSseEvents` in `stream.ts` is exported but not used in any production source

**File:** `router/src/sse/stream.ts:20`
**Issue:** `chunkToSseEvents` is exported from `sse/stream.ts` and tested in `tests/unit/sse/stream.test.ts`, but no file under `router/src/` imports it. The route now uses `canonicalToOpenAISse` from `translation/openai-out.ts` (which duplicates the same try/catch/finally cleanup discipline documented in comments referencing `stream.ts` as the pattern source). The function is therefore not reachable from `src/index.ts` and will not be present in the production bundle built by tsup.

The tests continue to exercise it as a unit (valuable for regression-testing the SSE contract), but the source file may mislead a maintainer into thinking the route still depends on it.
**Fix:** Add a comment block at the top of `stream.ts` clarifying its current status:
```ts
/**
 * DEPRECATED PRODUCTION PATH: chunkToSseEvents was the original SSE generator used
 * by /v1/chat/completions (Phase 2). Phase 4 replaced it with canonicalToOpenAISse
 * (translation/openai-out.ts) which operates on the canonical layer. This file is
 * retained as a unit-test target; it is NOT imported by any production source.
 * Consider removing when the unit tests are migrated to canonicalToOpenAISse directly.
 */
```
Or delete the file and its test once the migration is considered final.

---

_Reviewed: 2026-05-15T22:49:41Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
