---
phase: 3
slug: multi-backend-dispatch-llama-cpp-registry-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-12
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Sourced from `03-RESEARCH.md` §Validation Architecture (HIGH confidence).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.6` (already pinned in `router/package.json`) |
| **Config file** | `router/vitest.config.ts` (existing from Phase 2) |
| **Quick run command** | `npm test -- tests/unit/<name>.test.ts` (single file, < 1s) |
| **Full suite command** | `npm test` (unit + integration; < 30s) |
| **Integration upstream stubs** | `msw@^2.14.6` (existing pattern in `router/tests/msw/handlers.ts`) |
| **Estimated runtime** | ~30 seconds full / <1s per single file |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- tests/unit/<changed-module>.test.ts`
- **After every plan wave:** Run `npm test` (full unit + integration)
- **Before `/gsd-verify-work`:** Full suite must be green AND `bin/smoke-test-router.sh` runs end-to-end against live Docker Compose with both profiles
- **Max feedback latency:** ~30 seconds (full suite ceiling on this codebase)

---

## Per-Task Verification Map

> Populated by `gsd-planner`. The rows below are the Phase-Requirement → Test mapping from RESEARCH.md §Phase Requirements → Test Map; the planner attaches each row to a concrete task ID.

| Behavior | Req ID | Test Type | Automated Command | File Exists | Status |
|----------|--------|-----------|-------------------|-------------|--------|
| llama.cpp Compose service comes up with required flags | BCKND-02 | smoke | `bin/smoke-test-router.sh` (extended) | ❌ W0 | ⬜ pending |
| `models.yaml` over-budget rejected at startup w/ backend-named error | BCKND-04 | unit | `npm test -- tests/unit/registry.vram.test.ts` | ❌ W0 | ⬜ pending |
| `models.yaml` missing `capabilities` rejected | BCKND-04 | unit | `npm test -- tests/unit/registry.required.test.ts` | ❌ W0 | ⬜ pending |
| Hot-reload validation failure keeps previous registry | BCKND-04 | integration | `npm test -- tests/integration/hotreload.vram.test.ts` | ❌ W0 | ⬜ pending |
| Profile-swap brings down previous backend cleanly | BCKND-05 | smoke | `bin/smoke-test-router.sh` (SC1 section) | ❌ W0 | ⬜ pending |
| `/readyz` returns 503 with per-backend body when llamacpp down | ROUTE-06 | integration | `npm test -- tests/integration/readyz.test.ts` | ❌ W0 | ⬜ pending |
| `/readyz` returns 200 when all backends alive | ROUTE-06 | integration | same file | ❌ W0 | ⬜ pending |
| Stale-probe (`age > 2× interval`) marks backend as stale | ROUTE-06 | unit | `npm test -- tests/unit/readyz.stale.test.ts` | ❌ W0 | ⬜ pending |
| Probe scheduler de-dups on repeated `start([A,B])` | ROUTE-06 | unit | `npm test -- tests/unit/liveness.test.ts` | ❌ W0 | ⬜ pending |
| Probe scheduler stops all timers on `app.close()` | ROUTE-06 | integration | `npm test -- tests/integration/shutdown.test.ts` | ❌ W0 | ⬜ pending |
| N concurrent acquires succeed; (N+1)th queues | ROUTE-07 | unit | `npm test -- tests/unit/semaphore.test.ts` | ❌ W0 | ⬜ pending |
| Queue timeout → `BackendSaturatedError` → 429 + Retry-After | ROUTE-07 | integration | `npm test -- tests/integration/concurrency.test.ts` | ❌ W0 | ⬜ pending |
| Slot released on stream-end / abort / error | ROUTE-07 | unit + integration | `tests/unit/semaphore.test.ts` + `tests/integration/concurrency.stream.test.ts` | ❌ W0 | ⬜ pending |
| `/v1/models` returns the D-C1 shape with `capabilities` | OAI-03 | integration | `npm test -- tests/integration/models.test.ts` | ❌ W0 | ⬜ pending |
| `/v1/models` requires bearer (401 without) | OAI-03 | integration | same file | ❌ W0 | ⬜ pending |
| `/v1/models` lists all registered models regardless of liveness | OAI-03 | integration | same file | ❌ W0 | ⬜ pending |
| model-name switch routes to llamacpp adapter (SC1) | SC1 | integration | `npm test -- tests/integration/chat-completions.llamacpp.test.ts` | ❌ W0 | ⬜ pending |
| `AdapterFactory.makeAdapter({backend:'llamacpp'})` returns LlamacppOpenAIAdapter | SC1 | unit | `npm test -- tests/unit/factory.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave 0 = test scaffolding that MUST exist before implementation tasks can be sampled. No new framework install needed — vitest + msw are pinned in `router/package.json`.

- [ ] `tests/unit/semaphore.test.ts` — BackendSemaphore class (ROUTE-07 mechanics)
- [ ] `tests/unit/liveness.test.ts` — probe scheduler de-dup, stale, first-probe-immediate (ROUTE-06)
- [ ] `tests/unit/factory.test.ts` — `makeAdapter` returns correct concrete class per `entry.backend`
- [ ] `tests/unit/registry.vram.test.ts` — VRAM-envelope refinement; backend-named error message (BCKND-04)
- [ ] `tests/unit/registry.required.test.ts` — `capabilities` + `vram_budget_gb` required for local backends (BCKND-04)
- [ ] `tests/unit/readyz.stale.test.ts` — stale-probe computation (ROUTE-06)
- [ ] `tests/integration/models.test.ts` — `/v1/models` D-C1 shape + auth + lists-all (OAI-03)
- [ ] `tests/integration/readyz.test.ts` — `/readyz` 200/503 aggregation + body shape (ROUTE-06)
- [ ] `tests/integration/concurrency.test.ts` — semaphore wraps adapter; 429 on timeout + Retry-After (ROUTE-07)
- [ ] `tests/integration/concurrency.stream.test.ts` — slot released on stream end / abort / mid-stream error
- [ ] `tests/integration/chat-completions.llamacpp.test.ts` — llamacpp factory path; msw stub for `http://llamacpp:8080/v1/...`
- [ ] `tests/integration/hotreload.vram.test.ts` — VRAM violation in hot-reload preserves previous registry
- [ ] `tests/integration/shutdown.test.ts` — `app.close()` stops all liveness timers
- [ ] `tests/msw/handlers.ts` — extend with `llamacppNonStreamHandler` + `llamacppStreamHandler` + `llamacppModelsHandler`
- [ ] `bin/smoke-test-router.sh` — extended SC1 multi-backend dispatch section (profile-swap test)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| GGUF actually serves on GPU (nvidia-smi shows VRAM) | BCKND-02 | Requires live hardware + Compose stack | `docker compose --profile llamacpp up -d`; `docker compose exec gpu-preflight nvidia-smi`; verify Qwen model resident |
| `huggingface-cli` / `hf download` GGUF download | D-A2 | One-time host-side action; not reproducible from inside the container | README documents the exact `hf download bartowski/...` invocation |
| Open WebUI tolerates `capabilities` extra field on `/v1/models` | OAI-03 (forward-looking) | Open WebUI not installed until Phase 6 | Re-verify during Phase 6 verification; flagged as Pitfall 5 in RESEARCH.md |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
