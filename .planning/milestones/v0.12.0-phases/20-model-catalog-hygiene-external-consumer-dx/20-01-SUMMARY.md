---
phase: 20-model-catalog-hygiene-external-consumer-dx
plan: 01
subsystem: config
tags: [catalog-hygiene, disabled-flag, models-yaml, registry, dispatch]

requires:
  - phase: 19-embeddingprovider-formalization-observability-hardening
    provides: post-19-09 image baseline (Plan 19-08 tool_calls translation fix deployed)
provides:
  - ModelEntrySchema.disabled field (Zod default false; no migration required)
  - enabledModels(reg) canonical filter helper
  - resolve() anti-leak: disabled aliases throw RegistryUnknownModelError identical to unknown
  - superRefine skip for disabled entries (VRAM envelope, URL uniqueness, dims-for-embeddings)
  - /v1/models + /v1/models/:id filter through enabledModels (10 entries, was 13)
  - 3 dead-backend aliases flagged disabled:true in models.yaml (preserved for 1-line re-enable)
affects: [20-02, 20-03, 20-04, 20-05, 20-06, 20-07, future-disabled-aliases]

tech-stack:
  added: []
  patterns:
    - "Operator-flagged disabled entries pattern: schema field + helper + route filter + resolve gate as one indivisible 4-touchpoint contract"
    - "Anti-leak via shared knownNames list: error envelopes use enabledModels(snapshot) so disabled aliases are invisible to enumeration attacks (T-20-01)"
    - "Cross-field validator skip-on-disabled pattern: re-enabling a dormant backend later requires only flipping disabled:false — never renegotiating VRAM/URL/dims contracts on other entries"

key-files:
  created:
    - router/src/config/__tests__/registry-disabled.test.ts
  modified:
    - router/models.yaml
    - router/src/config/registry.ts
    - router/src/routes/v1/models.ts
    - router/tests/unit/factory.test.ts
    - router/tests/unit/mcp/host/tools/create-embedding.test.ts
    - router/tests/unit/mcp/host/tools/list-models.test.ts
    - router/tests/unit/mcp/host/tools/rerank.test.ts
    - router/tests/unit/registry.test.ts

key-decisions:
  - "D-01 LOCKED: disabled:true flag instead of removal — preserves backends: schema and rationale comments so v0.13.0 re-enable is a 1-line flip"
  - "Anti-leak invariant T-20-01: error envelope's available list uses enabledModels() — consumer cannot distinguish 'unknown' from 'intentionally offline' via error messages"
  - "Superrefine skip pattern applied to VRAM envelope + URL uniqueness + dims-for-embeddings (three independent checks all share the skip-on-disabled rule)"
  - "Updated 5 pre-existing fixture files with disabled:false (mirrors Phase 17 ctx_size/context_strategy literal-fixture migration precedent)"

patterns-established:
  - "Schema field with .default(false): Zod populates at parse-time → existing YAML files require no migration; new literal-constructed fixtures must supply explicitly"
  - "enabledModels() helper as canonical public-surface filter: single source of truth — any future public surface (e.g. CDX-01 recommendations map) must funnel through it"
  - "Route-layer 404 mirroring: /v1/models/:id treats disabled as not-found with the EXACT same envelope as fully-unknown — uniform surface preserved"

requirements-completed: [CAT-01]

duration: ~35min
completed: 2026-06-03
---

# Phase 20 Plan 20-01: Disabled-Flag Dead-Backend Aliases Summary

**3 dead-backend aliases flagged `disabled: true` — `/v1/models` returns 10 entries (was 13), each disabled alias returns 404 model_not_found identical to unknown, closing the artiscrapper 15s ENOTFOUND failure class (CAT-01).**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-06-03T03:50Z (approx — plan kickoff)
- **Completed:** 2026-06-03T04:00Z (post-deployment verification)
- **Tasks:** 3 completed
- **Files modified:** 8 (1 new test + 1 yaml + 2 source + 5 fixture-updates)

## Accomplishments

- **CAT-01 closed.** The 3 dead-backend aliases (`qwen2.5-7b-instruct-q4km` → llamacpp, `qwen2.5-7b-instruct-awq` → vllm, `bge-m3-vllm` → vllm-embed) are invisible to the public surface; dispatch never reaches the non-running containers; the artiscrapper failure mode (consumer picks alias → 15s ENOTFOUND timeout) is structurally gone.
- **Anti-leak invariant T-20-01 enforced.** Both `enabledModels()` filtering on /v1/models and `resolve()` rejecting disabled with the same error envelope as unknown means consumers cannot enumerate disabled aliases via error-message inspection.
- **Reversibility preserved.** The 3 entries remain physically present in `models.yaml` with explanatory comments — an operator can re-enable any of them via a 1-line flip + Valkey DEL + force-recreate (per `project_models_yaml_hot_edit`).
- **Zero consumer impact.** `chat-local`, `big-cloud`, `embed-local`, `vision-local`, `gpt-oss:20b-cloud`, `bge-reranker-local`, and all other live-consumer aliases continue to resolve identically.
- **Phase 19 RESS-WITH-TOOLS smoke gate verified post-deployment** (passes on attempt 1 of up-to-5 retries — the gpt-oss:20b-cloud ~40-60% tool-path non-determinism is documented in `phase-19-ress-with-tools-delta.md`).

## Task Commits

Per plan `commit_strategy: one_atomic_commit`, all 3 tasks landed in a single commit:

1. **All 3 tasks (schema + yaml + route + tests)** — `cf49ef4` (feat)

**Plan metadata commit:** TBD (after this SUMMARY)

## Files Created/Modified

### Created
- `router/src/config/__tests__/registry-disabled.test.ts` — 6 vitest cases: backward compat (default disabled=false), enabledModels() filter excludes disabled, resolve() anti-leak (identical message+knownNames for disabled vs unknown), resolve() returns enabled entries normally, VRAM envelope skip, URL uniqueness skip.

### Modified
- `router/models.yaml` — 3 entries (`qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`, `bge-m3-vllm`) each gain a one-line `disabled: true  # Phase 20 / CAT-01 / D-01 — backend not running on this host ...` annotation as the LAST field. Diff is minimal (3 added lines, 0 removed).
- `router/src/config/registry.ts` — added `disabled: z.boolean().default(false)` to ModelEntrySchema with JSDoc citing T-20-01 anti-leak; added 3 `if (m.disabled) continue` skips in the superRefine (VRAM envelope + URL uniqueness + dims-for-embeddings); modified `makeRegistryStore.resolve()` to treat `found.disabled` identically to `!found` (throws RegistryUnknownModelError with knownNames built from `enabledModels(snapshot)` not raw `snapshot.models`); added new exported `enabledModels(reg)` helper.
- `router/src/routes/v1/models.ts` — imported `enabledModels`; switched `filterAndProject` to use `enabledModels(reg).filter(...)` instead of `reg.models.filter(...)`; added `entry.disabled` to the 404 condition in `/v1/models/:id`; added inline comment block documenting Phase 20 / CAT-01 / D-01.
- `router/tests/unit/factory.test.ts` — added `disabled: false` to 5 literal `ModelEntry` fixture builders (Phase 17 ctx_size precedent).
- `router/tests/unit/mcp/host/tools/create-embedding.test.ts` — added `disabled: false` to EMBED_ENTRY literal.
- `router/tests/unit/mcp/host/tools/list-models.test.ts` — added `disabled: false` to CHAT_LOCAL + EMBED_LOCAL + CLOUD_DENIED literals.
- `router/tests/unit/mcp/host/tools/rerank.test.ts` — added `disabled: false` to RERANK_ENTRY literal.
- `router/tests/unit/registry.test.ts` — added `disabled: false` to the inline _swap fixture (mirrors ctx_size addition).

## Decisions Made

All decisions inherited from `20-CONTEXT.md` (D-01..D-09); only D-01 is in scope for Wave 0.

- **D-01 LOCKED (honored)** — disabled flag, not removal. Operator can re-enable a backend in v0.13.0 via 1-line flip + Valkey DEL + force-recreate. The 3 entries' comments cite `project_vram_budget` so future operators understand why they were disabled.
- **Operational adjustment** (Rule 1 deviation — see below): the plan said `docker compose up -d --force-recreate router` but did NOT include `--build`. Since registry.ts (TypeScript source) was modified, the new schema field must be compiled into `dist/index.js` inside the image — a `--force-recreate` alone reuses the stale image. Added `docker compose build router` before the recreate. This matches the CONTEXT.md §D-07 `deploy-router.sh full` path (`build && up -d --force-recreate && wait-for-healthz && smoke`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Pre-existing literal ModelEntry fixtures missing the new required `disabled` field**
- **Found during:** Task 1 (running `tsc --noEmit` after adding the schema field)
- **Issue:** Zod's `.default(false)` makes `disabled` a REQUIRED field on the inferred `ModelEntry` type at the output layer. 5 pre-existing test files build `ModelEntry` literals (factory.test.ts, list-models.test.ts, create-embedding.test.ts, rerank.test.ts, registry.test.ts) and started failing typecheck with TS2719 / TS2741 / TS2322.
- **Fix:** Added `disabled: false` to each literal — identical pattern to Phase 17 (ctx_size + context_strategy were added via `.default()` and the same fixtures were updated then).
- **Files modified:** 5 test files (listed above under "Modified").
- **Verification:** `npx tsc --noEmit` exits 0 after the fixture updates.
- **Committed in:** `cf49ef4` (part of the atomic Plan 20-01 commit).

**2. [Rule 3 — Blocking issue] `docker compose up -d --force-recreate router` without `--build` would deploy stale dist/**
- **Found during:** Deployment step (post-commit)
- **Issue:** The plan's verification recipe (§verification step 5) called for `docker compose up -d --force-recreate router` only. But this plan modifies `router/src/config/registry.ts` — a TypeScript source file that gets bundled into `dist/index.js` inside the image via the multi-stage Dockerfile. Running `--force-recreate` alone would reuse the cached image (built from pre-Plan-20-01 source) and the disabled-filter logic would never run inside the container. This is exactly the failure class Plan 19-09 closed (commit `7afbd96`).
- **Fix:** Inserted `docker compose build router` BEFORE the `--force-recreate`. This is also the canonical `bin/deploy-router.sh full` path described in 20-CONTEXT.md §D-07 — the lack of an actual deploy script is what Phase 20 Wave 5 (OPS-01) is supposed to add.
- **Files modified:** None (operational only — no source change).
- **Verification:** `docker image inspect local-llms-router --format '{{.Created}}'` returned `2026-06-03T03:57:38Z` (newer than the post-19-09 baseline `2026-06-03T02:00:37Z`); `docker compose exec router sh -c 'grep -c "toolCallState" /app/dist/index.js'` returned `5` (Plan 19-08 fix still present).
- **Committed in:** N/A (deployment-only; no source change). This deviation is exactly why OPS-01 / OPS-02 are in scope for Phase 20.

## Live Verification Transcript

### Pre-deployment (source + tests)
- `npx tsc --noEmit` → exit 0
- `npx vitest run src/config/__tests__/registry-disabled.test.ts` → 6 passed
- `npx vitest run src/config/__tests__/ tests/config/` → 76 passed (no regression on Phase 14/17/18 config tests)
- `npx vitest run tests/integration/models.test.ts tests/integration/list-models-policy-filter.integration.test.ts tests/unit/mcp/host/tools/list-models.test.ts tests/unit/registry.test.ts tests/unit/factory.test.ts tests/unit/mcp/host/tools/create-embedding.test.ts tests/unit/mcp/host/tools/rerank.test.ts` → 66 passed (no regression on /v1/models route or any touched fixture)
- Full vitest sweep → 1297 passed / 1 failed / 39 skipped / 2 todo (the 1 failure is the pre-existing hotreload.vram.test.ts parallel-load flake — passes 3/3 in isolation, documented in STATE.md; unrelated to this plan)
- YAML pre-flight: `node -e "..." router/models.yaml` → `disabled: bge-m3-vllm,qwen2.5-7b-instruct-awq,qwen2.5-7b-instruct-q4km`; `enabled_count: 10`; exit 0

### Post-deployment (live router)
```
$ docker image inspect local-llms-router --format '{{.Created}}'
2026-06-03T03:57:38.052913183Z          # > 2026-06-03T02:00:37Z post-19-09 baseline ✓

$ curl http://127.0.0.1:3210/healthz
{"status":"ok","service":"router","phase":2,"registry_models":13}    # 13 total in registry (incl. disabled) ✓

$ curl -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" http://127.0.0.1:3210/v1/models | jq '.data | length'
10                                                                    # 10 enabled — was 13 ✓

$ curl ... /v1/models | jq '.data | map(.id) | sort'
[ "bge-m3-ollama", "bge-reranker-local", "big-cloud", "chat-local",
  "embed-local", "gpt-oss:120b-cloud", "gpt-oss:20b-cloud",
  "llama3.2-vision:11b-instruct-q4_K_M", "llama3.2:3b-instruct-q4_K_M",
  "vision-local" ]                                                     # 3 disabled aliases absent ✓

$ curl ... /v1/models/qwen2.5-7b-instruct-q4km
{"error":{"message":"The model 'qwen2.5-7b-instruct-q4km' does not exist",
 "type":"invalid_request_error","param":null,"code":"model_not_found"}}    # 404 envelope ✓

$ curl ... /v1/models/qwen2.5-7b-instruct-awq
{"error":{"message":"The model 'qwen2.5-7b-instruct-awq' does not exist", ...}}    # 404 envelope ✓

$ curl ... /v1/models/bge-m3-vllm
{"error":{"message":"The model 'bge-m3-vllm' does not exist", ...}}    # 404 envelope ✓

$ curl ... /v1/models/chat-local | jq '.id, .capabilities'
"chat-local"
["chat","tools","json_mode"]                                          # workhorse alias unaffected ✓

$ docker compose exec router sh -c 'grep -c "toolCallState" /app/dist/index.js'
5                                                                     # Plan 19-08 tool-calls fix preserved ✓

# RESS-WITH-TOOLS smoke gate (5-retry harness)
Attempt 1: DELTA_OK=1 COMPLETED_OK=1 (output_text deltas=0, fcad=1)
PASS on attempt 1                                                     # Phase 19 surface unaffected ✓
```

## CAT-01 Status

**CLOSED.**

REQUIREMENTS.md line 37 condition satisfied: "The 3 known dead backends (`llamacpp`, `vllm`, `vllm-embed`) are either removed or flagged `disabled: true` with explanatory comment." All 3 flagged; each comment cites Phase 20 / CAT-01 / D-01 + project_vram_budget. The `audit-by-grep against compose.yml services + a startup probe` portion of CAT-01 covers the broader catalog-vs-compose audit which Wave 1 (CAT-02 health-probe) will provide; Wave 0 closes the immediate failure class.

## Reversibility Note

Wave 0 is fully reversible by design:

```bash
git revert cf49ef4
docker compose build router
docker compose up -d --force-recreate router
```

Restores the prior 13-entry `/v1/models` surface. The 3 disabled entries' physical YAML rows would also be restored verbatim (the revert reverses both the source schema field and the 3 YAML annotations).

## Known Deferred / Out-of-Scope

- `tests/integration/hotreload.vram.test.ts` flakes under full-suite parallel load (passes 3/3 in isolation; documented in STATE.md and `.planning/phases/18-.../deferred-items.md`). Pre-existing — NOT caused by Plan 20-01.
- Wave 0 makes ZERO source changes that affect the streaming translator or cloud dispatch (RESS-WITH-TOOLS verified PASS post-deployment).
- The RESS-WITH-TOOLS smoke gate's `gpt-oss:20b-cloud` model has ~40-60% non-determinism on the tool-call path — documented in `.planning/debug/resolved/phase-19-ress-with-tools-delta.md`. The 5-retry harness used here mirrors the operator-side flake mitigation.

## Self-Check: PASSED

- File `router/src/config/__tests__/registry-disabled.test.ts` exists ✓
- File `router/models.yaml` modified ✓
- File `router/src/config/registry.ts` modified ✓
- File `router/src/routes/v1/models.ts` modified ✓
- Commit `cf49ef4` present in `git log` ✓
- 6/6 new disabled tests pass ✓
- /v1/models live count = 10 ✓
- 3 disabled aliases return 404 model_not_found on /v1/models/:id ✓
- Phase 19 RESS-WITH-TOOLS smoke gate PASS post-deployment ✓
