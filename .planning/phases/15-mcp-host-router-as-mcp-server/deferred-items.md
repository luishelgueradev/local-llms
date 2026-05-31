# Phase 15 — Deferred Items

Out-of-scope discoveries logged during plan execution per scope-boundary rule.
Future plans should reconcile these against their own intended work.

## 2026-05-31 — Plan 15-01 execution

- **Untracked file `router/tests/unit/dispatch/preflight.test.ts`** (9572 bytes,
  mtime 2026-05-31 04:02:17): NOT created by Plan 15-01 execution. File header
  references "MCPS-01 / CONTEXT.md D-09" and `applyPreflight()` — Plan 15-01
  only touches `router/package.json`, `router/src/config/env.ts`,
  `router/tests/config/env.test.ts`, and root `.env.example`. This test was
  either pre-staged for a later plan (likely 15-02 or 15-03 where
  `applyPreflight` ships per CONTEXT.md D-09) or left over from an earlier
  abandoned session. Left in place (NOT deleted, NOT committed); next plan's
  executor should reconcile against its own intended work, either by adopting
  the file as-is or replacing it.

## 2026-05-31 — Plan 15-10 execution

- **Untracked `router/pnpm-lock.yaml` (148KB) + `router/pnpm-workspace.yaml`
  (83 bytes), mtime 2026-05-31 05:32**: Project standard is npm (per
  CLAUDE.md and `package-lock.json` present). These pnpm artifacts are
  out-of-scope leftovers from a prior tooling experiment. NOT created by
  Plan 15-10. Left in place; recommend `git clean`-ing them in a separate
  housekeeping task (NOT via this plan).
- **Pre-existing typecheck errors (4) in backend adapters**: the same stale
  pnpm-lock.yaml pulls a different `undici` version into the dep tree, which
  causes 4 TS2322 errors in `router/src/backends/{llamacpp,vllm,ollama-cloud,
  ollama}-openai.ts` (FormData / DispatchHandler shape mismatch between
  undici-types@6.21.0 and undici@7.26.0). Verified pre-existing by
  `git stash` before my changes — 4 errors before, 4 errors after; my work
  introduces NO new typecheck errors. Resolution path: delete the rogue
  pnpm-lock.yaml so npm resolves a single undici version, OR upgrade the
  backend code to undici@7 client shape. Out of scope for Plan 15-10.
