
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
