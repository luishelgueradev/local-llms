# Phase 07 — Deferred Items

Out-of-scope items discovered during Phase 07 execution and tracked for later phases.

## Flaky Tests (not introduced by Phase 07)

### `hotreload.vram.test.ts` — "recovery: after failed VRAM reload, valid reload succeeds and advances createdAtSec"

- **Discovered during:** Plan 07-04 execution (2026-05-17)
- **Symptom:** Passes when run in isolation (`npx vitest run tests/integration/hotreload.vram.test.ts`); fails ~50% of the time when run as part of the full suite (`npm test`).
- **Failure detail:** The test relies on `Math.floor(Date.now() / 1000)` advancing between two consecutive registry swaps. Under suite load, both swaps can land in the same UTC second, so `createdAtSec` does not advance and the test assertion fires.
- **Root cause:** Pre-existing timing-sensitivity in the test — not related to any Phase 7 work. The hotreload module itself is correct; the assertion just needs a small sleep or fake timer.
- **Suggested fix (deferred):** Wrap the test's "second reload" step in a 1s sleep, OR refactor `createdAtSec` to use a monotonic counter (`hrtime.bigint()`) so consecutive swaps within the same wall-clock second still produce a strictly increasing value.
- **Scope:** Pre-existing; out of scope for Plan 07-04. Recommended for inclusion in a Phase 7 review-fix or as a standalone `/gsd-quick` task.

## (No other deferred items as of 2026-05-17)
