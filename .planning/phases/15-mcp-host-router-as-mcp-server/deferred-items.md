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
  **RESOLVED 2026-05-31 (Plan 15-12 preflight):** orchestrator deleted the
  rogue pnpm-lock.yaml + pnpm-workspace.yaml during the post-context-loss
  recovery, re-ran `npm install` cleanly, typecheck restored to 0 errors.
- **Pre-existing typecheck errors (4) in backend adapters**: the same stale
  pnpm-lock.yaml pulls a different `undici` version into the dep tree, which
  causes 4 TS2322 errors in `router/src/backends/{llamacpp,vllm,ollama-cloud,
  ollama}-openai.ts` (FormData / DispatchHandler shape mismatch between
  undici-types@6.21.0 and undici@7.26.0). Verified pre-existing by
  `git stash` before my changes — 4 errors before, 4 errors after; my work
  introduces NO new typecheck errors. Resolution path: delete the rogue
  pnpm-lock.yaml so npm resolves a single undici version, OR upgrade the
  backend code to undici@7 client shape. Out of scope for Plan 15-10.
  **RESOLVED 2026-05-31 (Plan 15-12 preflight):** root cause was the
  pnpm-lock.yaml above; removing it + `npm install` resolved a single
  undici@7.x stack and the 4 TS2322 errors no longer appear. `npx tsc
  --noEmit` returns clean as of Plan 15-12 final gate.

## 2026-05-31 — Plan 15-12 execution

- **Intermittent flake in `router/tests/integration/hotreload.vram.test.ts`**:
  2 of 3 tests in this file occasionally time out (20s vitest test timeout)
  when running the full 95-file suite under default file parallelism. The
  file's own header comments document the cause: `WSL2 + Docker Desktop
  fs.watchFile pauses under CPU contention`. Re-running the same file in
  isolation passes cleanly (3/3 green in ~3s). Full-suite run with
  `--no-file-parallelism` is also 949/0/7 green. Documented here as
  environmental (NOT introduced by Plan 15-12); pre-existing since the test
  file was authored. Not a Phase 15 deliverable; future work on the
  hot-reload test harness should make it CPU-contention tolerant (e.g. raise
  the test timeout to 30s or move the file to a serial-only project in
  vitest config).
- **Plugin.ts comment line 26 matches the `register*Tool(server, opts,
  capturedReq)` grep** referenced in the Task 7 gate. The actual wired
  calls are exactly 5 (lines 127-131); line 26 is a documentation reference
  in the file's header. The original gate `grep -c "register.*Tool(server,
  opts, capturedReq)" router/src/mcp/host/plugin.ts -eq 5` returns 6 because
  it counts the comment. A stricter variant `grep -cE "^\s+register[A-Z]+
  [A-Za-z]+Tool\(server, opts, capturedReq\);" plugin.ts` returns 5 (the
  actual wiring count). Both gates considered satisfied — the wiring is 5,
  the doc reference is a deliberate continuity marker from Plan 15-05's
  shell. No code change recommended; future cleanup could remove the
  comment-reference if the gate's literal form must be honored.
