---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 00
subsystem: infra
tags: [registry, validation, probe-cache, zod, phase-8-precondition, fastify]

# Dependency graph
requires:
  - phase: 07-embeddings-vllm-gpu-telemetry
    provides: "RegistrySchema with superRefine VRAM-envelope check; probeAdapterFor cached by url alone (07-REVIEW-FIX §CR-02 deferred this widening to Phase 8)"
provides:
  - "RegistrySchema.superRefine — second clause rejecting any models.yaml where the same backend_url is declared under two DISTINCT backend values (with alphabetically-sorted backend list in the error message for test determinism)"
  - "app.ts probeAdapterFor — signature widened from (url) to (backend, url); adapter cache keyed by `${backend}|${url}`; registry lookup by `(m) => m.backend === backend && m.backend_url === url`"
  - "Scheduler probe callback in buildApp — resolves backend from registry by URL BEFORE calling probeAdapterFor; unknown URL returns synthetic `{ ok: false, error: 'no registry entry for url ...' }` instead of throwing"
  - "probeAdapterFor honors opts.makeAdapter (was hardcoded defaultMakeAdapter)"
affects: [08-02-ollama-cloud-adapter, all Phase 8 plans declaring backend: ollama-cloud entries, future plans introducing new backend values]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Composite-key adapter cache: (backend, url) tuple disambiguates when two backends might serve the same URL — runtime belt-and-suspenders pairing with schema-level invariant"
    - "Scheduler probe callback returns synthetic down for unknown URLs rather than throwing — the timer tick does not unwrap rejected promises from this path"

key-files:
  created:
    - router/tests/config/registry.test.ts
    - router/tests/app/probe-adapter.test.ts
  modified:
    - router/src/config/registry.ts
    - router/src/app.ts

key-decisions:
  - "Backend list in the 'shared by backends [...]' error message is sorted alphabetically so the test regex is deterministic (matches '[llamacpp, ollama]' regardless of YAML order)."
  - "Single superRefine block with two checks (VRAM envelope + shared-URL invariant) rather than two superRefine calls — per plan spec for clarity."
  - "Unknown URL in the scheduler probe callback returns { ok: false, error: 'no registry entry for url ...' } instead of throwing — the makeLivenessScheduler timer tick does not unwrap rejections from the probe function, so a throw would surface as an uncaught error."
  - "probeAdapterFor was changed to honor opts.makeAdapter (previously hardcoded defaultMakeAdapter). This closes a Rule 2 functional gap: the BuildAppOpts.makeAdapter contract explicitly says 'tests inject a fake here to mock the upstream', but the probe path silently ignored it. The fix was necessary to make Test 3 (probeAdapterFor disambiguation) hermetic."

patterns-established:
  - "Composite cache-key shape `${backend}|${url}`: any future cache that resolves by URL must include the discriminator (backend) in the key to remain unambiguous as the backend enum grows."

requirements-completed: [CLOUD-01]

# Metrics
duration: 5min
completed: 2026-05-17
---

# Phase 08 Plan 00: Phase-8 Precondition — RegistrySchema "shared backend_url" Gate + probeAdapterFor (backend, url) Widening Summary

**Closes 07-REVIEW-FIX §CR-02: RegistrySchema rejects any models.yaml declaring two distinct backends at the same backend_url, and probeAdapterFor's adapter cache is now keyed by `${backend}|${url}` — unblocking OllamaCloudAdapter in Plan 08-02.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-05-17T15:13:37Z
- **Completed:** 2026-05-17T15:20:29Z
- **Tasks:** 1 (TDD: RED → GREEN, no REFACTOR commit — implementation was minimal)
- **Files modified:** 4 (2 source, 2 new test files)

## Accomplishments

- **Schema-level invariant landed:** RegistrySchema.superRefine now rejects models.yaml configurations where two DISTINCT `backend` values share the same `backend_url`. Error message: `Config error: backend_url "<url>" is shared by backends [b1, b2, ...]` with alphabetically-sorted backend names. The existing pattern of multiple entries under the SAME backend at one URL (today's three `backend: ollama` rows at `http://ollama:11434/v1`) remains valid — the check only fires on DISTINCT backends.
- **Runtime invariant landed:** `app.ts probeAdapterFor` signature changed from `(url)` to `(backend, url)`. The adapter cache is now keyed by `${backend}|${url}` (composite) and the registry entry is resolved by both backend AND backend_url. This is the runtime belt-and-suspenders guarantee paired with the schema gate.
- **Scheduler resilience improvement:** The buildApp scheduler probe callback now resolves the backend from the registry by URL FIRST before calling `probeAdapterFor`. An unknown URL returns a synthetic `{ ok: false, latencyMs: 0, error: 'no registry entry for url "..."' }` instead of throwing — the scheduler timer tick does not unwrap rejected promises from the probe function.
- **Closes Phase 8 precondition (CLOUD-01):** Plan 08-02 can now introduce `backend: ollama-cloud` (base URL `https://ollama.com/v1`) into LocalBackendEnum and `models.yaml` knowing the URL-ambiguity risk the 07-REVIEW called out as a Phase 8 blocker is structurally impossible.

## Task Commits

Each task was committed atomically (TDD cycle: RED → GREEN):

1. **Task 1 RED — failing regression tests:** `eb79103` (`test(08-00): add failing regression tests for shared-URL backend disambiguation`)
2. **Task 1 GREEN — schema + probeAdapterFor widening:** `e790918` (`fix(08-00): widen RegistrySchema + probeAdapterFor to disambiguate (backend, url)`)

No REFACTOR commit — the implementation was already minimal and clean as written; no cleanup needed.

## Files Created/Modified

- `router/src/config/registry.ts` — Extended the existing `.superRefine` block with a second check that builds a `url → Set<backend>` map and emits a custom zod issue for any url whose set has size > 1. Backend list sorted alphabetically in the message for test determinism.
- `router/src/app.ts` — `probeAdapters` cache map now uses `${backend}|${url}` keys; `probeAdapterFor` takes both `backend` and `url` args; the scheduler probe callback resolves the backend from the registry by URL before delegating to `probeAdapterFor`; unknown-URL handling returns a synthetic down probe result rather than throwing. `probeMakeAdapter = opts.makeAdapter ?? defaultMakeAdapter` honors the BuildAppOpts.makeAdapter contract.
- `router/tests/config/registry.test.ts` — Two regression tests: (1) zod issue assertion for shared URL across distinct backends; (2) happy-path acceptance of multiple entries under the same backend at one URL.
- `router/tests/app/probe-adapter.test.ts` — Two regression tests: (3) scheduler probe callback returns DIFFERENT adapter instances for the same URL under distinct backends (proved via FakeAdapterA's latencyMs=1 vs FakeAdapterB's latencyMs=2 flip after swapping the registry models order between calls); (4) unknown URL returns synthetic `{ ok: false, error: /no registry entry for url/ }` rather than throwing.

## Decisions Made

- **Composite cache key shape:** `${backend}|${url}` rather than a `Map<string, Map<string, Adapter>>` of nested maps. The flat string key is simpler and the pipe (`|`) is not a valid character in any current backend enum value (`ollama`, `llamacpp`, `vllm`, `vllm-embed`) nor in URL schemes, so collisions are impossible.
- **Single superRefine block, two checks:** Kept both the VRAM-envelope check and the new shared-URL check inside one `.superRefine` callback per plan spec — clearer than two separate `.superRefine` calls and the issues are independent so they can coexist.
- **Unknown URL → synthetic down, not throw:** The `makeLivenessScheduler` timer tick path does not unwrap rejected promises from the probe function (verified by reading `router/src/backends/liveness.ts:65-90`). A throw would surface as an uncaught error in the timer callback. The synthetic `{ ok: false }` is the contract-correct way for `/readyz` to report an unreachable URL.
- **Honor opts.makeAdapter in probeAdapterFor:** Pre-08-00, the probe path hardcoded `defaultMakeAdapter(entry)`, ignoring the documented BuildAppOpts contract ("tests inject a fake here to mock the upstream"). This was a latent Rule 2 functional gap — the probe path was untestable hermetically. Fixed alongside the cache-key widening because Test 3 needed the injected fake to assert the cache disambiguates by `(backend, url)`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] probeAdapterFor honored hardcoded defaultMakeAdapter instead of opts.makeAdapter**
- **Found during:** Task 1 RED run — Test 3 failed with `Error: No adapter registered for backend "backend-a"` thrown from `defaultMakeAdapter`, proving the synthetic test backends never reached `opts.makeAdapter`.
- **Issue:** `BuildAppOpts.makeAdapter` documents itself as "tests inject a fake here to mock the upstream", but `probeAdapterFor` called `defaultMakeAdapter(entry)` directly, bypassing the injection point. This made the probe path untestable hermetically and silently locked tests into the production adapter factory.
- **Fix:** Added `const probeMakeAdapter = opts.makeAdapter ?? defaultMakeAdapter;` once at adapter-cache setup time, then changed `a = defaultMakeAdapter(entry)` to `a = probeMakeAdapter(entry)` in `probeAdapterFor`.
- **Files modified:** `router/src/app.ts`
- **Verification:** Test 3 passes with FakeAdapterA / FakeAdapterB latencyMs flip (1 → 2 after swapping registry models order), proving the fakes flow through.
- **Committed in:** `e790918` (same commit as the planned widening — it was a single coherent change).

---

**Total deviations:** 1 auto-fixed (1 missing critical — contract enforcement on opts.makeAdapter)
**Impact on plan:** The deviation fix was strictly necessary for Test 3 to be hermetic per the plan's explicit `<action>` step 4 directive ("Use a makeAdapter fake per the BuildAppOpts.makeAdapter contract"). Scope did not creep: no other route or non-probe path was touched.

## Issues Encountered

None — TDD cycle was clean. RED phase produced the expected 3/4 failures (Test 2 happy path passed pre-implementation as a regression guard). GREEN phase passed all 4 new tests + 524 pre-existing tests (528 total, 2 skipped) on the first run.

## Threat Flags

None — this plan tightens an existing trust boundary (operator → models.yaml) by moving the failure from "silent wrong-routing at runtime" to "loud zod issue at boot". No new network endpoint, auth path, file access pattern, or schema surface at a trust boundary.

## Self-Check

- [x] `router/src/config/registry.ts` exists with `shared by backends` literal at line 90 (`grep -c` returned 1).
- [x] `router/src/app.ts` contains `m.backend === backend && m.backend_url === url` (lookup widening, `grep -c` returned 1).
- [x] `router/src/app.ts` contains `probeAdapterFor(entry.backend, url)` (call-site update, `grep -c` returned 1).
- [x] `router/tests/config/registry.test.ts` exists.
- [x] `router/tests/app/probe-adapter.test.ts` exists.
- [x] `cd router && npm test` reported **528 passed | 2 skipped | 0 failed** across 45 test files.
- [x] `cd router && npm run build` reported `ESM ⚡️ Build success in 48ms` with no TypeScript errors.
- [x] Smoke: existing `router/models.yaml` (3 ollama, 1 llamacpp, 1 vllm, 1 vllm-embed entries — distinct URLs per distinct backend) loads cleanly under the new superRefine.
- [x] Commits `eb79103` (RED) and `e790918` (GREEN) exist in `git log --oneline`.

## Self-Check: PASSED

## Next Phase Readiness

**Closes:** 07-REVIEW-FIX.md §CR-02 (deferred to this phase). The structural prerequisite is in place.

**Unblocks:**
- **Plan 08-01:** N/A — does not depend on this gate.
- **Plan 08-02 (OllamaCloudAdapter):** Can safely add `'ollama-cloud'` to `LocalBackendEnum` and declare `backend: ollama-cloud` entries at `https://ollama.com/v1` in `models.yaml`. Even if a future entry shares that URL with a hypothetical alias, the schema and runtime cache disambiguate by `(backend, url)`.
- **All Phase 8 plans (Waves 1+):** Can introduce new backend values without inheriting URL-ambiguous behavior.

**Operator-visible behavior change:** Zero. Today's `router/models.yaml` does not violate the new invariant (each backend value has a unique URL). The fix is preemptive — locks down a contract before the first plan that could trip it (Plan 08-02).

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Completed: 2026-05-17*
