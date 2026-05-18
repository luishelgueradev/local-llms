---
phase: 02-mvp-vertical-slice-router-ollama-sse
fixed_at: 2026-05-15T23:08:30Z
review_path: .planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-REVIEW.md
iteration: 2
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 2: Code Review Fix Report (Iteration 2)

**Fixed at:** 2026-05-15T23:08:30Z
**Source review:** `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-REVIEW.md`
**Iteration:** 2 (refresh pass — prior iteration fixed WR-01..WR-07 on 2026-05-12)

**Summary:**
- Findings in scope: 8 (3 Warning + 5 Info — fix_scope=all per objective)
- Fixed: 8
- Skipped: 0

## Fixed Issues

### WR-01: `skip()` called before it is defined — script aborts when SKIP_LLAMACPP=1 + GGUF present

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** 45caa27
**Applied fix:** Moved `SKIPS=0` and `skip()` up alongside `fail()`/`pass()` at the top of the failure-tracking block (lines 104-109). Replaced the duplicate declarations at the former Phase-4-header location with a comment referencing the WR-01 fix. Phase 3 WR-05 is the same bug in the same file — hoisting the definition once closes both findings.

### WR-02: `LLAMACPP_HEALTHY` flag set but never read — B1/B2/B3 assertions fire unconditionally

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** 7d04bed
**Applied fix:** Wrapped all three B-section assertions (B1: model chat, B2: /readyz inverse, B3: GPU residency) in `if [[ "${LLAMACPP_HEALTHY}" != "true" ]]; then skip ... else ... fi`. A failed `compose --profile llamacpp up -d --wait` now increments SKIPS by 1 instead of cascading up to 3 spurious FAILURES that obscure the real signal.

### WR-03: SC5 diagnostic grep interpolates bearer token as ERE — breaks for tokens with regex metacharacters

**Files modified:** `bin/smoke-test-router.sh`
**Commit:** c0b3357
**Applied fix:** Replaced the single `grep -iE "${ROUTER_BEARER_TOKEN}|bearer..."` with two sequential greps: first `grep -F "${ROUTER_BEARER_TOKEN}"` (fixed-string, zero false-positives), then `grep -iE 'bearer ...'` as a fallback for the token-shaped pattern. Prevents ERE metacharacters in the token from aborting the script or silently matching wrong log lines.

### IN-01: `OLLAMA_URL` env var is declared but never referenced

**Files modified:** `router/src/config/env.ts`
**Commit:** daa0ea5
**Applied fix:** Removed the `OLLAMA_URL` field from `EnvSchema`. It had a `.default()` so it never broke `loadEnv()`, but it added a spurious validation path and confused operators about which URL wins. Added a comment explaining the removal and pointing to the correct future extension point (registry.ts / adapter.ts). Also closes Phase 3 WR-04 which independently identified the same dead field.

### IN-02: `?? '/'` fallback in `bearer.ts` is unreachable

**Files modified:** `router/src/auth/bearer.ts`
**Commit:** c4391ae
**Applied fix:** Dropped the null-coalescing fallback: `const path = req.url.split('?')[0];`. Added a brief comment explaining why the fallback is absent (`String.prototype.split` always returns a non-empty array so `[0]` is never `undefined`).

### IN-03: SC3 test describe block name overstates coverage

**Files modified:** `router/tests/integration/chat-completions.stream.test.ts`
**Commit:** 78dd907
**Applied fix:** Renamed describe block from `'abort + error paths (SC3 mocked, D-C2, RESEARCH Pitfall 2 + 8)'` to `'abort signal wiring (SC3 real-abort proven by bash smoke, not vitest)'` as recommended, making the limitation visible in CI output summaries.

### IN-04: `id.unref?.()` optional chain is unreachable on Node 22

**Files modified:** `router/src/sse/heartbeat.ts`
**Commit:** e086c0f
**Applied fix:** Changed `id.unref?.()` to `id.unref()`. Added a comment noting that Node 22 `Timeout` always has `unref()`, so the optional chain signalled false uncertainty.

### IN-05: `chunkToSseEvents` in `stream.ts` is exported but not used in any production source

**Files modified:** `router/src/sse/stream.ts`
**Commit:** ab2f156
**Applied fix:** Added a module-level JSDoc deprecation block at the top of `stream.ts` explaining that `chunkToSseEvents` is not imported by any production source (Phase 4 replaced it with `canonicalToOpenAISse`), that the file is retained as a unit-test target, and that it should be considered for removal when unit tests are migrated.

---

## Validation

- `bash -n bin/smoke-test-router.sh`: exit 0
- `npx tsc --noEmit` (from `router/`): exit 0
- `npx vitest run tests/integration/auth.test.ts tests/integration/chat-completions.nonstream.test.ts tests/integration/chat-completions.stream.test.ts`: 21 passed, 2 skipped (0 failures)

---

_Fixed: 2026-05-15T23:08:30Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
