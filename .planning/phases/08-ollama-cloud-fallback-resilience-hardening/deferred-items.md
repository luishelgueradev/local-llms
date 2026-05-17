
## Plan 08-01 deferred (out-of-scope)

**Discovered 2026-05-17 during 08-01 Task 3 typecheck.**

Pre-existing `tsc --noEmit` errors in `router/tests/app/probe-adapter.test.ts`:
- Lines 104, 105: TS2367 — the test fixtures use string-literal backend names
  `'backend-a'` / `'backend-b'` to validate the new `(backend, url)` cache-key
  shape from Plan 08-00, but those literals are compared against the
  `LocalBackendEnum` union (`'ollama' | 'llamacpp' | 'vllm' | 'vllm-embed'`),
  which TS sees as a no-overlap comparison.

These errors:
- Are NOT triggered by 08-01's changes (confirmed via `git stash` rerun).
- Do NOT block `npm test` (vitest tolerates the no-overlap warning).
- Do NOT block `npm run build` (tsup's transpile-only path).

Suggested fix (out of scope for 08-01): widen the test fixture's backend type
with `as unknown as LocalBackend` or pick a real backend name for the
fictional registry entries.

## Plan 08-06 flake (out-of-scope)

**Discovered 2026-05-17 during 08-06 Task 3 full-suite run.**

`tests/integration/hotreload.vram.test.ts > recovery: after failed VRAM
reload, valid reload succeeds and advances createdAtSec` — intermittently
times out at ~2s on full-suite parallel run; passes deterministically in
isolation and on suite rerun. Root cause: pre-existing fs.watch debounce
race in the hot-reload watcher under concurrent test-file pressure (Pitfall 7
in PITFALLS.md). NOT introduced by 08-06; tracked here for future hardening.

## Plan 08-08 deferred (out-of-scope)

**Discovered 2026-05-17 during 08-08 typecheck.**

Pre-existing `tsc --noEmit` errors in `router/tests/routes/circuit-breaker-integration.test.ts`
lines 228 + 499: TS2741 — the test's `env` literal omits the new
`ROUTER_RATE_LIMIT_RPM` field that Plan 08-06 added to the env shape. NOT
triggered by 08-08's changes (which only touch
`router/db/migrations/0001_cloud_spend_daily.sql` +
`router/db/migrations/meta/_journal.json` + the new test file).

These errors:
- Do NOT block `npm test` (vitest tolerates).
- Do NOT block `npm run build` (tsup transpile-only).

Suggested fix (out of scope for 08-08): add `ROUTER_RATE_LIMIT_RPM: 60` to
the two `env: {...}` literals in `circuit-breaker-integration.test.ts`.
Also fold in the Plan 08-01 fixture-typing fix in `probe-adapter.test.ts`
(carried over above).
