---
phase: 21-v0.12.0-post-ship-hygiene
plan: 02
subsystem: dockerfile + smoke + vitest
tags: [post-ship-hygiene, dockerfile, smoke-test, vitest, flake]

requires:
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    provides: post-Phase-20 audit findings HYG-02 (smoke --profile prod broken), HYG-03 (Phase 3+7 expect disabled llamacpp), HYG-04 (vitest flake under load)
provides:
  - router/Dockerfile runtime stage installs `curl` (~+3 MB) via apt-get --no-install-recommends
  - bin/smoke-test-router.sh Phase 3 multi-backend section soft-skip when qwen2.5-7b-instruct-q4km absent from /v1/models
  - bin/smoke-test-router.sh Phase 7 capability gate fixture flipped qwen2.5-7b-instruct-awq → chat-local (enabled, no embeddings cap)
  - router/vitest.config.ts testTimeout 5_000 → 10_000 + hookTimeout same
affects: [future-deploy-router.sh-rebuilds, future-smoke-runs, future-vitest-sweeps]

tech-stack:
  added: []
  patterns:
    - "Pure script/config bundle, no router source touched — 3 atomic commits, 1 rebuild required (Dockerfile change)"
    - "Smoke section guard pattern: pre-check /v1/models for the specific fixture alias before running the section; if absent, skip-OK with traceable rationale (cites the upstream LOCK that disabled it)"
    - "Always-enabled semantic alias as capability-gate fixture: chat-local is the canonical lever — independent of which raw model is installed, the gate still fires for the right reason"

key-files:
  modified:
    - router/Dockerfile
    - bin/smoke-test-router.sh
    - router/vitest.config.ts
  created: []

key-decisions:
  - "Phase 7 cap-gate fixture flipped to `chat-local` (not `embed-local` or a custom test alias) — chat-local has capabilities [chat, tools, json_mode], no `embeddings`, so sending it to /v1/embeddings still fires the registry capability check; assertion of intent stays clean"
  - "vitest testTimeout 10_000 not 30_000 — minimal headroom that absorbs the WSL2 fs.watchFile flake under load while still failing fast on real hangs (the recovery-after-failed-VRAM-reload test is the canonical example; <500ms in isolation, ~5–8s under contention)"
  - "Phase 3 guard uses jq probe on the specific alias rather than searching backend names — `qwen2.5-7b-instruct-q4km` is THE llamacpp fixture; if operators re-enable a different llamacpp model they'd need to update the guard alias too (acceptable tax for clarity)"

patterns-established:
  - "Section-level early-out guard with traceable rationale: `if jq -e '... | select(.id == \"<fixture>\")' /v1/models > /dev/null; then ... else skip 'reason — how to re-enable'`"
  - "Soft-skip preserves the section structure: the inner block stays runnable for operators who re-enable llamacpp via `disabled: false` + start --profile llamacpp — zero refactor cost to re-light the section"

requirements-completed: [HYG-02, HYG-03, HYG-04]

duration: ~20min
completed: 2026-06-03
---

# Phase 21 Plan 21-02: Smoke + vitest + Dockerfile hygiene bundle (HYG-02 + HYG-03 + HYG-04)

**Three small, orthogonal fixes bundled in one plan, one rebuild. Router runtime now ships `curl` so --profile prod smoke works. Smoke Phase 3 + Phase 7 sections soft-skip / use enabled-fixture, no longer fight the Phase 20 disabled-alias decisions. Vitest testTimeout doubled to absorb WSL2 fs.watchFile flake under load.**

## Performance

- **Duration:** ~20 min total across 3 tasks
- **Tasks:** 3 atomic (Dockerfile / smoke guards / vitest config)
- **Files modified:** 3 (Dockerfile + smoke-test-router.sh + vitest.config.ts)
- **Rebuilds:** 1 (Dockerfile change requires rebuild; smoke + vitest are script/config only)

## Accomplishments

- **HYG-02 closed.** `router/Dockerfile` runtime stage now runs `apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*`. Post-rebuild: `docker exec local-llms-router curl --version` returns `curl 7.88.1 (x86_64-pc-linux-gnu) libcurl/7.88.1 OpenSSL/3.0.20 zlib/1.2.13 ...`. The companion smoke gate added in Plan 21-01 ("HYG-02: curl present in router runtime image") flips fail → PASS on every smoke run.
- **HYG-03 closed.** `bin/smoke-test-router.sh` Phase 3 multi-backend section now soft-skips when `qwen2.5-7b-instruct-q4km` is not in /v1/models (Wave 0 of Phase 20 disabled it per CAT-01 / D-01). Phase 7 capability-gate fixture flipped from disabled `qwen2.5-7b-instruct-awq` to always-enabled `chat-local` — gate still fires (`chat-local` has no embeddings cap), now for the right reason (capability mismatch, not model_not_found). Live smoke: Phase 3 SKIP-OK + Phase 7 all-PASS.
- **HYG-04 closed.** `router/vitest.config.ts` `testTimeout` raised 5_000 → 10_000 + `hookTimeout` same. Reproduced live during this plan: first sweep flaked at `config/__tests__/loader.reload.test.ts > recovery: after failed VRAM reload, valid reload succeeds and admits new requests` — the exact fs.watchFile-under-load symptom the audit flagged. Second sweep (post-config-change) clean: 140 files / 1355 tests / 0 fails / ~19 s wall-clock (unchanged — vitest blocks on assertion resolution, not timeout fires).
- **Zero router source touched.** Routes, business logic, dispatcher, registry, MCP host, MCP client — all unchanged. Pure deploy/test hygiene.
- **All Phase 20 deferred-items.md entries now have closure tags** (committed in a follow-up doc commit `375610a` after Plan 21-02 wrapped — see Phase 21 closeout commit `92e0a4d` for the full doc-chain).

## Task Commits

3 atomic commits per the plan's task-level atomicity rule:

1. **HYG-02: Dockerfile curl** — `f88eec3` (fix)
2. **HYG-03: Smoke Phase 3 + Phase 7 guards** — `95ad0eb` (fix)
3. **HYG-04: vitest testTimeout** — `a72d86c` (fix)

## Verification

- HYG-02: `docker exec local-llms-router curl --version` → curl 7.88.1; companion smoke gate flips fail → PASS
- HYG-03: `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210` → Phase 3 SKIP with traceable rationale; Phase 7 all 5 assertions PASS (including the cap-gate `chat-local` returns 400)
- HYG-04: `cd router && npx vitest run` → 140 files PASS / 1355 tests PASS / 0 fails (run #1 had the flake the fix addresses; run #2 clean)
- `bash -n bin/smoke-test-router.sh` PASS

## Gotchas / lessons

- The HYG-02 companion smoke gate ("curl present in router runtime image") was added in Plan 21-01's commit (`0f9880a`) — it correctly fails until this plan's Dockerfile rebuild lands. Forward-looking gate, not a backdated assertion. Documenting here so the audit trail makes sense end-to-end.
- The pre-existing `qwen2.5-7b-instruct-awq` Phase 7 fixture was technically returning the right 400 (model not found), but the wrong invariant — the smoke "passed" by accident. Flipping to `chat-local` makes the assertion of intent honest, which is a real improvement over keeping the old fixture working "by coincidence".
- Two smoke flakes observed post-fix (`SC4 hot-reload` fs.watchFile + `RESS-WITH-TOOLS` occasional cloud latency >60 s) are pre-existing and documented in `21-VERIFICATION.md` § Out-of-scope. Candidates for a future post-ship-hygiene cycle.
