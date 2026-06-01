# Deferred Items — Phase 18

Out-of-scope discoveries surfaced during plan execution that were NOT fixed
(per scope-boundary rule). Each item is a pre-existing condition or future-
phase work, NOT a regression from a Phase 18 plan.

## Plan 18-05 (2026-06-01)

### `tests/integration/hotreload.vram.test.ts` — known flake under parallel load

- **Symptom:** Fails intermittently when run via `npx vitest run` (full suite parallel mode).
- **Verified in isolation:** Passes 3/3 when run alone (`vitest run tests/integration/hotreload.vram.test.ts`).
- **Pre-existing:** Commit `dc9b7c9 fix(test): hotreload.vram recovery — rename-based trigger eliminates flake` shows the test has flake history. Failure is NOT caused by Plan 18-05 changes — Plan 18-05 introduces no shared filesystem or registry mutation.
- **Out of scope:** Phase 18 does not touch hot-reload paths. The test is a Phase 3 artifact.
- **Recommended action:** Track separately under TD- backlog; the rename-based trigger fix landed earlier may need a deeper concurrency review.
