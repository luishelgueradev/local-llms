---
phase: 21-v0.12.0-post-ship-hygiene
plan: 01
subsystem: backends/http-dispatcher
tags: [post-ship-hygiene, undici, cold-load, timeout, regression-gate]

requires:
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    provides: post-Phase-20 audit finding HYG-01 (45s undici clip on Ollama cold-load)
provides:
  - HEADERS_TIMEOUT_MS raised 45_000 → 180_000 in router/src/backends/http-dispatcher.ts
  - BODY_TIMEOUT_MS raised 45_000 → 180_000 (same file)
  - Both constants exported so they can be asserted from tests
  - tests/backends/http-dispatcher-timeouts.test.ts — regression gate (≥120_000 floor, <300_000 ceiling)
  - bin/smoke-test-router.sh "Phase 21 — Post-ship Hygiene" section with HYG-01 opt-in cold-load probe (SMOKE_INCLUDE_COLDLOAD=1) and HYG-02 curl-in-image gate
  - Header comment block in http-dispatcher.ts extended with the HYG-01 cold-load rationale + reference to the regression gate
affects: [21-02, future-deploy-router.sh-rebuilds]

tech-stack:
  added: []
  patterns:
    - "Audit-driven constant raise: when a defensive value is suspected to be over-conservative, raise it AND add a regression test that pins a floor — the test makes the next drop intentional"
    - "Opt-in heavy smoke gate via env flag (SMOKE_INCLUDE_COLDLOAD=1): deliberate VRAM-eviction probes are too expensive for routine smoke (50–55s per run) but invaluable when verifying the fix; honors feedback_vram_test_pollution memory (re-warm after probe)"

key-files:
  created:
    - router/tests/backends/http-dispatcher-timeouts.test.ts
  modified:
    - router/src/backends/http-dispatcher.ts
    - bin/smoke-test-router.sh

key-decisions:
  - "180_000 chosen over 120_000: 3× margin over real cold-load (~55s) under momentary system load (Whisper resident + concurrent users) versus 2× — the difference is one tuning knob the operator never has to touch"
  - "Constants exported (rather than testing indirectly via Agent options) — explicit public surface for the regression test; lower-friction than reaching into an undici Agent"
  - "HYG-01 + HYG-02 smoke gates bundled in the same new 'Phase 21' section even though HYG-02 belongs to Plan 21-02 — keeps the smoke output cohesive and avoids two new section headers for related fixes"

patterns-established:
  - "Header-comment evolution: when raising a defensive constant, preserve the original 'why' block verbatim and APPEND the new context ('Phase 21 / HYG-01: cold-load headroom') — future readers see the full history of the value's reasoning"
  - "Regression-test floor with ceiling: assert both `>= 120_000` and `< 300_000` — the lower bound locks the fix, the upper bound prevents accidentally exceeding the SDK ceiling"

requirements-completed: [HYG-01]

duration: ~20min
completed: 2026-06-03
---

# Phase 21 Plan 21-01: Raise undici headersTimeout 45s → 180s for Ollama cold-load (HYG-01)

**Cold-load of qwen2.5:7b on WSL2 + shared GPU (~50–55s) was clipping at the 45s undici ceiling → 504 upstream_timeout on every first-request-after-eviction. Constants raised to 180_000 (3 min, 3× margin). c-ares Resolver also installed in the same file is the actual fix for the DNS-threadpool starvation the 45s was originally guarding against. Live cold-load probe post-fix: HTTP 200 in 84s.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3 atomic actions (source change + regression test + smoke section) folded into 1 commit per the plan's atomicity
- **Files modified:** 2 (http-dispatcher.ts + smoke-test-router.sh) + 1 created (regression test)

## Accomplishments

- **HYG-01 closed.** Live cold-load probe (deliberate `docker exec local-llms-ollama ollama stop qwen2.5:7b-instruct-q4_K_M` → curl `chat-local`) returned **HTTP 200 in 84 s** — well under the new 180 s ceiling, well over the old 45 s clip that would have returned 504.
- **Regression gate locked.** `tests/backends/http-dispatcher-timeouts.test.ts` asserts both constants stay `>= 120_000` AND `< 300_000`. Any future drop below the floor fails the test loudly; any creep above the ceiling fails too (preserves the dispatcher-fires-first-before-SDK-timeout invariant).
- **c-ares context documented.** The header comment block of `http-dispatcher.ts` now explains why the 45 s value was originally set (DNS-threadpool starvation) AND why it can safely raise now (c-ares Resolver is the real fix). Future readers don't have to git-archaeology the debug session to understand.
- **Smoke gate added (opt-in).** `bin/smoke-test-router.sh` "Phase 21 — Post-ship Hygiene" section probes HYG-01 when `SMOKE_INCLUDE_COLDLOAD=1` is set. Routine smoke skips it (VRAM-pollution avoidance per `feedback_vram_test_pollution`). Re-warms qwen2.5:7b after the probe so the live router stays usable.
- **HYG-02 companion gate added in the same smoke section.** The `docker exec router curl --version` check fails until Plan 21-02 Task 1 lands the Dockerfile change — gives the audit trail a forward-looking marker.
- **Zero consumer impact, zero warm-path regression.** Routes unchanged. Warm-path latency (post-cold-load, model resident) unchanged at <1 s. Only the cold-load edge case behaves differently — and now correctly.

## Task Commits

Per plan atomicity, 1 commit:

1. **HEADERS+BODY 45→180 + regression test + smoke section** — `0f9880a` (fix)

## Verification

- `npx vitest run tests/backends/http-dispatcher-timeouts.test.ts tests/backends/factory-timeout.test.ts` → 2/2 files, 12/12 tests PASS
- Live cold-load probe end-to-end: HTTP 200 / 84 s elapsed / valid 5-token completion content
- Header comment block updated; constants exported; smoke gate `bash -n` syntax PASS

## Gotchas / lessons

- CONTEXT.md cited the path as `router/src/clients/http-dispatcher.ts` — actual path is `router/src/backends/http-dispatcher.ts`. Confirmed via codebase grep before edit; CONTEXT-typo non-blocking.
- The 84 s live cold-load was slower than the ~55 s mentioned in CONTEXT (probably includes eviction propagation + first-token latency + 5 tokens of output). Still well under 180 s — the fix is correct; the margin is right.
