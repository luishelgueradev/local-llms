---
phase: 20-model-catalog-hygiene-external-consumer-dx
plan: 03
subsystem: routes
tags: [consumer-dx, recommendations, models-yaml, registry, additive-field, taxonomy, cdx-01]

requires:
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 01
    provides: enabledModels(reg) canonical filter + ModelEntrySchema.disabled flag (Wave 0)
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 02
    provides: additive-field pattern + BackendHealthDecoration baseline (Wave 1)
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 04
    provides: top-level operator-configurable map pattern (deprecated_aliases — Wave 3)
provides:
  - ModelEntrySchema.recommended_for?: optional fixed-taxonomy enum array (chat | chat-tools | chat-json-strict | embeddings | rerank | vision | function-calling)
  - RegistrySchema.recommendations?: optional top-level Record<string,string> operator-configurable map
  - deriveRecommendedFor(entry) → RecommendedForTag[] exported helper (operator-declared WINS over capability derivation)
  - RecommendedForTag exported type union
  - Cross-field superRefine validation rejecting recommendations targets that are nonexistent OR disabled
  - GET /v1/models response top-level `recommendations` field (computed via computeRecommendations(reg))
  - GET /v1/models + /v1/models/:id per-entry `recommended_for` array (always present; never omitted)
  - models.yaml top-level recommendations: block with 10 keys (semantic alias targets per D-02 LOCKED)
  - per-entry recommended_for tags on 11 enabled entries in live models.yaml
affects: [20-05, 20-06, 20-07, future-consumers (artiscrapper, n8n, Unsloth)]

tech-stack:
  added: []
  patterns:
    - "Fixed-taxonomy capability tag pattern: 7-value enum (chat | chat-tools | chat-json-strict | embeddings | rerank | vision | function-calling) bounded by Zod schema — every value is documented; no 'what does this tag mean?' ambiguity. Compose 'chat-tools' AND 'function-calling' as synonyms so OpenAI/Anthropic SDK vocabularies both find a match."
    - "Operator-declared WINS over derivation: deriveRecommendedFor() respects operator-authored entry.recommended_for when present AND non-empty; falls through to capability derivation when absent. Lets operators HIDE a capability the model technically supports but produces flaky output for (e.g. json_mode adherence inconsistent)."
    - "Auto-derived recommendations map by (tag, profile) walk: when registry.recommendations is absent or empty, first matching enabled entry wins per (tag, profile) pair where profile ∈ {local, cloud} (local = backend !== 'ollama-cloud'). Deterministic — first match by YAML order; operators who want a specific entry default either reorder models.yaml OR declare the recommendations block explicitly (latter is recommended path)."
    - "Top-level operator-configurable map composing with Wave 0 disabled invariant: cross-field superRefine rejects recommendation targets that are disabled OR nonexistent. Reuses Wave 0's enabledNames set so the disabled-flag contract carries through structurally — a future re-enable (flip disabled: false) automatically makes that name a valid recommendation target."
    - "ALWAYS-present per-entry projection (not OMIT-when-empty): unlike Wave 3's deprecated_aliases (omitted when no entries target a canonical), recommended_for is ALWAYS present in the projection — even an empty array signals 'this entry maps to no fixed-taxonomy use case' (e.g. future hypothetical 'audio' capability the taxonomy doesn't cover). Consumers can rely on the field shape without conditional access."
    - "D-02 LOCKED convention enforced in live models.yaml (not in schema): recommendation targets point at SEMANTIC role aliases (chat-local, big-cloud, embed-local, vision-local, bge-reranker-local) NOT raw model names (qwen2.5:7b-instruct-q4_K_M, gpt-oss:20b-cloud) — the semantic alias is the consumer-facing canonical per CONTEXT.md §D-02 downstream impact bullets. Schema does NOT enforce this (both work) but the shipping config follows the convention."

key-files:
  created:
    - router/src/routes/v1/__tests__/models-recommendations.test.ts
    - router/tests/integration/v1-models-recommendations.integration.test.ts
  modified:
    - router/models.yaml
    - router/src/config/registry.ts
    - router/src/routes/v1/models.ts
    - router/tests/integration/models.test.ts
  preserved:
    - router/src/routes/v1/embeddings.ts  # P7-01 BLOCK — SHA 598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404 byte-identical to baseline

key-decisions:
  - "D-05 LOCKED honored: fixed-taxonomy `recommended_for` enum + top-level `recommendations` map; both additive on top of Wave 0+1+3 surface. Pre-existing /v1/models consumers (Open WebUI, n8n model picker) continue to work because unknown fields are ignored per OpenAI-compat client semantics."
  - "Open Q4 resolved YES (planner-locked, executor-confirmed): recommendations IS operator-configurable in models.yaml via top-level `recommendations:` block; auto-derived from per-entry recommended_for tags when the block is absent. v0.12.0 ships with the block PRESENT — 10 keys pointing at semantic aliases."
  - "D-02 LOCKED enforced (executor-verified): live models.yaml `recommendations` block points at SEMANTIC role aliases (chat-local, big-cloud, embed-local, vision-local, bge-reranker-local), NOT raw model names. Per CONTEXT.md §D-02 downstream impact bullets, the semantic alias is the consumer-facing canonical; raw names are escape-hatches. Schema does NOT enforce the convention (both work as targets) but the shipping config follows it. This signals to NEW consumers that the role alias is the recommended path."
  - "Auto-derive uses `<tag>-default` and `<tag>-cloud-default` literal naming (NOT operator-friendly shortcuts like `embed-default`): per the deterministic rule 'tag name verbatim'. Operators who want shortcuts (e.g. `embed-default` instead of the literal `embeddings-default`) declare them explicitly via the operator-configurable block. v0.12.0 live config does both — explicit `embed-default: embed-local` plus auto-derive would have produced `embeddings-default: embed-local`. Operator config wins (passthrough), so `embeddings-default` is NOT present in the live response."
  - "Operator-declared empty array does NOT win — deriveRecommendedFor falls through to capability derivation. Defensive design: empty operator array is treated as 'forgot to populate' not 'explicitly cleared every tag' (the latter would silently hide all recommendations for an entry — operationally surprising). To deliberately hide all tags, operators omit the field entirely (still falls through to derivation) — true 'hide everything' requires either no capabilities or a hypothetical future explicit no-recommendations flag (out of scope for v0.12.0)."

patterns-established:
  - "Co-located unit tests under src/routes/v1/__tests__/: first router unit test under this layout (Phase 17/20 prior co-located tests used src/config/__tests__/ + src/plugins/__tests__/ + src/health/__tests__/). Routes layer now follows the same convention."
  - "Strict-shape integration test fixtures get updated alongside additive-field additions: Phase 17 ctx_size + Phase 20 Wave 0 disabled + Phase 20 Wave 1 health + Phase 20 Wave 3 deprecated_aliases (when present) + Phase 20 Wave 2 recommended_for all follow the same convention — when a new ALWAYS-PRESENT field lands, the 2 strict-shape Object.keys assertions in router/tests/integration/models.test.ts get the new field added to the expected list. Pattern preserved by the Plan 17 / 20-01 / 20-02 / 20-03 precedent chain."
  - "Cross-field superRefine reuse of enabledNames set: when a new top-level operator-configurable map needs to validate targets against enabled-only entries (Wave 3 deprecated_aliases.target + Wave 2 recommendations.value), reuse the SAME enabledNames set built in the earlier check in the same superRefine block. Avoids duplicate set construction; ensures both checks see the identical truth source."

requirements-completed: [CDX-01]

duration: ~13min
completed: 2026-06-03
---

# Phase 20 Plan 20-03: recommended_for + recommendations map on /v1/models Summary

**Additive `recommended_for: string[]` field on every `/v1/models` entry (fixed 7-value taxonomy) + top-level operator-configurable `recommendations` map (auto-derived when absent) — closes CDX-01 by giving external consumers a programmatic answer to "which alias should I use for X?" without reading docs or hardcoding alias strings. v0.12.0 ships with 10 operator-declared recommendation entries pointing at SEMANTIC role aliases per D-02 LOCKED.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-06-03T11:56:54Z
- **Completed:** 2026-06-03T12:10:18Z (post-deployment verification + STATE/ROADMAP/REQUIREMENTS flip)
- **Tasks:** 3 completed (Task 1: schema + helper + cross-field validation; Task 2: models.yaml population; Task 3: route wiring + 13 new tests)
- **Files modified:** 6 (2 new + 4 modified)

## Accomplishments

- **CDX-01 closed.** GET /v1/models now carries (a) a top-level `recommendations` map answering "which alias should I use for chat-json-strict on local?" with a single key lookup, AND (b) per-entry `recommended_for: string[]` from the fixed 7-value taxonomy `[chat, chat-tools, chat-json-strict, embeddings, rerank, vision, function-calling]`. The artiscrapper failure mode (consumer guessing alias names by trial-and-error) is structurally gone — `body.recommendations['chat-json-strict-default']` returns `'chat-local'` programmatically.

- **D-05 LOCKED honored.** Fixed taxonomy bounded by Zod enum; both `recommended_for` and `recommendations` additive — pre-existing /v1/models consumers (Open WebUI, n8n model picker) unaffected because unknown fields are ignored per OpenAI-compat client semantics.

- **Open Q4 resolved YES.** Recommendations IS operator-configurable in models.yaml via top-level `recommendations:` block. v0.12.0 ships with the block PRESENT (10 keys). When absent, the route auto-derives from per-entry tags using the (tag, profile) rule.

- **D-02 LOCKED enforced in live config.** All 10 recommendation targets in live models.yaml point at SEMANTIC role aliases (chat-local, big-cloud, embed-local, vision-local, bge-reranker-local) NOT raw model names. The semantic alias is the consumer-facing canonical per CONTEXT.md §D-02 downstream impact bullets — even though `qwen2.5:7b-instruct-q4_K_M` exists as a raw-name alias for chat-local, the recommendations point at `chat-local` so NEW consumers learn the recommended path.

- **Wave 0 + Wave 1 + Wave 3 invariants composed cleanly.** Cross-field superRefine rejects recommendation targets that are disabled OR nonexistent — Wave 0 disabled-flag invariant carries through structurally. The new per-entry `recommended_for` projection sits alongside Wave 1's `health` field + Wave 3's optional `deprecated_aliases` field without conflict.

- **POL-06 preserved.** ZERO new metrics added by this plan. Static cardinality CI guard PASS; live cardinality CI guard PASS.

- **P7-01 BLOCK preserved.** `router/src/routes/v1/embeddings.ts` SHA `598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404` byte-identical to baseline. No modifications to the embeddings route file or any of its imports.

- **Phase 19 RESS-WITH-TOOLS smoke gate PASS** on attempt 1 of 3 retries post-deployment (gpt-oss:20b-cloud documented ~40-60% tool-path non-determinism — `.planning/debug/resolved/phase-19-ress-with-tools-delta.md`).

## Task Commits

Per orchestrator's explicit directive (`ONE atomic commit. Message: feat(20-03): recommended_for + recommendations map on /v1/models (CDX-01)`), all 3 tasks landed in a single commit (matches the small-plan precedent set by 20-01, 20-02, 20-04 — all 3 tasks touch tightly-coupled seam points: schema + helper + route + tests):

1. **All 3 tasks (schema + helper + cross-field validation + models.yaml population + route wiring + 13 new tests + 2 fixture updates)** — `fb7ec53` (feat)

**Plan metadata commit:** TBD (after this SUMMARY)

## Files Created/Modified

### Created (2)

- `router/src/routes/v1/__tests__/models-recommendations.test.ts` (~110 LOC) — 7 vitest cases for `deriveRecommendedFor()`:
  1. capabilities `[chat, tools, json_mode]` → set-equal `[chat, chat-tools, function-calling, chat-json-strict]`
  2. capabilities `[embeddings]` → `[embeddings]`
  3. capabilities `[rerank]` → `[rerank]`
  4. capabilities `[chat, vision]` → set-equal `[chat, vision]`
  5. operator-declared `recommended_for: [chat]` WINS over capability derivation (caps suggest more)
  6. (Rule-2 edge case) operator-declared empty array does NOT win — falls through to derivation
  7. (Rule-2 edge case) operator-declared subset wins (operator hides a tag the model technically supports)
  - First test file under co-located `src/routes/v1/__tests__/` (new directory).

- `router/tests/integration/v1-models-recommendations.integration.test.ts` (~280 LOC) — 6 integration cases via real buildApp + fake Valkey + app.inject (VRAM hygiene preserved — NO live /v1/chat probes):
  1. **Operator-declared map passthrough** — fixture with `recommendations: {chat-local-default: chat-local, ...}` → response.recommendations exactly mirrors operator declaration; no auto-derived keys polluting the map
  2. **Auto-derive when block absent** — fixture WITHOUT recommendations block → non-empty map computed from per-entry recommended_for + (tag, profile) rules; verified keys: `chat-default`, `chat-cloud-default`, `chat-tools-default`, `chat-tools-cloud-default`, `chat-json-strict-default`, `chat-json-strict-cloud-default`, `function-calling-default`, `embeddings-default` (literal tag name, NOT operator's `embed-default` shortcut); `vision-default` and `rerank-default` correctly absent (no matching entries in fixture)
  3. **Per-entry recommended_for present in response.data** — every entry has the field; all values drawn from the 7-value taxonomy; spot-check chat-local has all 4 declared tags; spot-check embed-local has just `[embeddings]`
  4. **Backward-compat fields preserved** — first entry has `id`, `object`, `owned_by`, `capabilities`, `policy.cloud_allowed`, AND `recommended_for`; T-3-A2 anti-leak still holds (backend / backend_url / backend_model / vram_budget_gb all undefined in the projection)
  5. **Schema rejects nonexistent target** — `recommendations: {chat-local-default: nonexistent-model}` → `loadRegistryFromString` throws ZodError mentioning the offending key
  6. **Schema rejects disabled target (Wave 0 ↔ Wave 2 boundary)** — `recommendations: {chat-local-default: disabled-target}` where `disabled-target` exists but has `disabled: true` → ZodError thrown at parse time

### Modified (4)

- `router/src/config/registry.ts` — adds optional `recommended_for: z.array(z.enum([...7 tags])).optional()` to ModelEntrySchema with JSDoc citing Phase 20 / CDX-01 / D-05 LOCKED + operator-WINS-over-derivation rationale + fixed-taxonomy bounded-consumer-contract rationale. Adds optional top-level `recommendations: z.record(z.string(), z.string()).optional()` to RegistrySchema with JSDoc citing operator-configurable + auto-derive behavior + D-02 LOCKED semantic-alias-target convention + Wave 0 composition. New cross-field superRefine block after the deprecated_aliases check: every `recommendations` value MUST be in `enabledNames` set (reused from the deprecated_aliases check above — single set construction; ensures both checks see identical truth source). Exports new `RecommendedForTag` type union + `deriveRecommendedFor(entry)` pure helper.

- `router/models.yaml` — adds `recommended_for:` field to all 11 enabled entries (10 from the plan + the raw-name `qwen2.5:7b-instruct-q4_K_M` alias added in commit a4580e0 which the plan literal didn't account for). 3 disabled entries left untouched (Wave 0 contract preserved). Appends new top-level `recommendations:` block at EOF with 10 operator-declared keys, all targets pointing at SEMANTIC role aliases per D-02 LOCKED. Inline block comment cites Phase 20 / CDX-01 / D-05 LOCKED, hot-reload recipe (config change → no `docker compose build` needed; force-recreate is enough after Valkey DEL), and the auto-derive fallback behavior.

- `router/src/routes/v1/models.ts` — imports `deriveRecommendedFor` + `RecommendedForTag` from registry. New module-scope const `ALL_TAGS` (readonly array of all 7 taxonomy tags). New non-exported `computeRecommendations(reg) → Record<string, string>` helper: operator-declared passthrough when registry.recommendations is non-empty; auto-derives a map from per-entry tags when absent (first matching enabled entry wins per (tag, profile) pair). `filterAndProject` emits `recommended_for: deriveRecommendedFor(m)` in the base projection (always present). GET /v1/models response gains top-level `recommendations: computeRecommendations(reg)` field alongside `data`. GET /v1/models/:id entry also gains per-entry `recommended_for` (top-level recommendations map NOT included on single-entry route).

- `router/tests/integration/models.test.ts` — 2 strict-shape `Object.keys` assertions (lines ~95-97 and ~240-241) updated to include `'recommended_for'` in the expected key list. Phase 17 `ctx_size` + Phase 20 Wave 0 `disabled` + Phase 20 Wave 1 `health` set the precedent for fixture updates when a new ALWAYS-PRESENT field lands. Comment annotations cite Phase 20 Plan 20-03 (CDX-01 / D-05).

### Preserved (1 — P7-01 BLOCK invariant)

- `router/src/routes/v1/embeddings.ts` — SHA `598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404` byte-identical to baseline. Verified via `sha256sum` before commit. The grep-gate test `router/tests/unit/grep-gates/embeddings-untouched.test.ts` continues to pass; the SHA baseline at `router/tests/unit/grep-gates/embeddings-untouched-baseline.json` was NOT rotated.

## Decisions Made

All inherited from `20-CONTEXT.md` (D-05 LOCKED via overnight autonomous discuss; D-02 LOCKED via 2026-06-03 user confirmation; Open Q4 planner-resolved YES).

- **D-05 LOCKED (honored):** Fixed-taxonomy enum + top-level recommendations map; both additive. Pre-Phase-20 consumers unaffected.
- **Open Q4 resolved YES (planner-locked, executor-confirmed):** Operator-configurable map in models.yaml; auto-derived when absent. v0.12.0 ships with the block PRESENT.
- **D-02 LOCKED enforced in live config (executor-verified):** All 10 recommendation targets in live models.yaml point at semantic role aliases, NOT raw model names. Schema does NOT enforce this (both work) but the shipping config follows the convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Test fixture update] Pre-existing /v1/models tests had strict-shape assertions**
- **Found during:** Task 3 — verification (re-running adjacent `models.test.ts` after Task 3 changes).
- **Issue:** `router/tests/integration/models.test.ts` (lines 94-97 and 238-242) use `expect(Object.keys(...).sort()).toEqual([...])` to assert the EXACT projected entry shape. Adding the new ALWAYS-PRESENT `recommended_for` field would break those assertions even though the contract is strictly additive.
- **Fix:** Updated both assertions to include `'recommended_for'` in the expected key list. Same pattern Plan 17 used for `ctx_size`, Plan 20-01 used for `disabled`, and Plan 20-02 used for `health`.
- **Files modified:** `router/tests/integration/models.test.ts` (2 lines changed in 2 different `it()` blocks; comment annotations updated to cite Phase 20 Plan 20-03 / CDX-01 / D-05).
- **Verification:** All 4 strict-shape assertions pass after the update.
- **Committed in:** `fb7ec53` (part of the atomic Plan 20-03 commit).

**2. [Rule 1 — Bug] Test 2 expected wrong auto-derive key for embeddings**
- **Found during:** Task 3 — first vitest run of `tests/integration/v1-models-recommendations.integration.test.ts` returned 1 failure on Test 2.
- **Issue:** Initial test draft asserted `body.recommendations['embed-default']` would be `'embed-local'` under auto-derive. But the auto-derive rule uses `<tag>-default` where `tag` is the TAG NAME VERBATIM (`embeddings`, not `embed`). The actual auto-derive key is `embeddings-default`. The operator-friendly shortcut `embed-default` only exists when operators declare it explicitly via the operator-configurable block (Test 1 covers that path).
- **Fix:** Updated Test 2 assertion to `body.recommendations['embeddings-default']` (literal tag name). Added explanatory comment documenting the literal-tag-name convention + how operators get the shortcut (via explicit declaration).
- **Files modified:** `router/tests/integration/v1-models-recommendations.integration.test.ts` (one assertion + one explanatory comment).
- **Verification:** All 13 new tests pass after the fix.
- **Committed in:** `fb7ec53` (part of the atomic Plan 20-03 commit).

### Plan-vs-Reality Discrepancy (acceptance criterion relaxation)

**3. [Process — non-deviation from invariants] Plan's `enabled.length === 10` literal was stale**
- **Plan literal (Task 2 verify):** `(enabled.length === 10 && tagged.length === 10 && recKeys.length >= 6)`
- **Reality:** `enabled.length === 11` — the plan was authored against the post-Wave-0 count (10 enabled), but commit a4580e0 (predates Phase 20) added a raw-name alias `qwen2.5:7b-instruct-q4_K_M` as an 11th enabled entry. Plan 20-02's SUMMARY confirms 11 entries. Plan 20-04's SUMMARY confirms 11 entries.
- **Adjustment:** Per the substantive contract (`every enabled entry has recommended_for; recommendations block has ≥6 keys; every recommendation value resolves to an enabled model name`), the actual state satisfies the requirement: `enabled === tagged === 11` AND `recKeys === 10` AND every target is in the enabled-names set. The plan literal `10` was a stale snapshot, not a contract.
- **Documented because:** Worth noting for future plan authors that the catalog has 11 enabled entries (not 10) as of Phase 20.

## Live Verification Transcript

### Pre-deployment (source + tests)

- `npx tsc --noEmit` → exit 0
- `npx vitest run src/routes/v1/__tests__/models-recommendations.test.ts tests/integration/v1-models-recommendations.integration.test.ts` → **13 passed** (7 unit + 6 integration)
- Adjacent regression suite (`models.test.ts` + `list-models-policy-filter` + `v1-models-health-field` + `registry-disabled` + `deprecation` + `deprecated-alias-resolution` + `registry.test.ts` + `list-models tools` + new unit + new integration) → **74 passed across 10 files** (no existing-test breakage)
- Full vitest sweep: **1341 pass / 1 known flake (hotreload.vram.test.ts WSL2 parallel-load timing — passes 3/3 in isolation, documented in 20-01 + 20-02 + 20-04 SUMMARYs) / 39 skipped / 2 todo / 0 unexpected fail** (was 1328 pre-Plan-20-03; +13 net from new tests)
- `npx tsx scripts/check-prometheus-cardinality.ts` (static) → `cardinality-check: OK — no /_id$/ labels found (mode=source)`
- `sha256sum router/src/routes/v1/embeddings.ts` → `598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404` (matches baseline; P7-01 PASS)

### Post-deployment (live router)

```
$ docker image inspect local-llms-router --format '{{.Created}}'
2026-06-03T12:07:57.032995265Z          # > 2026-06-03T11:45:24Z Plan 20-04 baseline ✓

$ curl http://127.0.0.1:3210/healthz
{"status":"ok","service":"router","phase":2,"registry_models":14}    # unchanged ✓

$ curl ... /v1/models | jq '.data | length'
11                                                                    # unchanged ✓

$ curl ... /v1/models | jq '.recommendations'
{
  "chat-local-default": "chat-local",
  "chat-cloud-default": "big-cloud",
  "chat-json-strict-default": "chat-local",
  "chat-json-strict-cloud-default": "big-cloud",
  "chat-tools-default": "chat-local",
  "chat-tools-cloud-default": "big-cloud",
  "embed-default": "embed-local",
  "rerank-default": "bge-reranker-local",
  "vision-default": "vision-local",
  "function-calling-default": "chat-local"
}                                                                     # 10 keys; all targets = semantic aliases (D-02 LOCKED) ✓

$ curl ... /v1/models | jq '.data[] | {id, recommended_for}'
# 11 entries, all with non-empty recommended_for arrays drawn from the 7-tag taxonomy
# - llama3.2:3b-instruct-q4_K_M  → [chat]
# - llama3.2-vision:11b-...      → [chat, vision]
# - bge-m3-ollama                → [embeddings]
# - gpt-oss:120b-cloud           → [chat, chat-tools, chat-json-strict, function-calling]
# - gpt-oss:20b-cloud            → [chat, chat-tools, chat-json-strict, function-calling]
# - chat-local                   → [chat, chat-tools, chat-json-strict, function-calling]
# - qwen2.5:7b-instruct-q4_K_M   → [chat, chat-tools, chat-json-strict, function-calling]
# - vision-local                 → [chat, vision]
# - bge-reranker-local           → [rerank]
# - embed-local                  → [embeddings]
# - big-cloud                    → [chat, chat-tools, chat-json-strict, function-calling]
                                                                       # all 11 entries tagged correctly ✓

$ curl ... /v1/models/chat-local | jq
{
  "id": "chat-local",
  "object": "model",
  "created": 1780488530,
  "owned_by": "local-llms",
  "capabilities": ["chat","tools","json_mode"],
  "policy": {"cloud_allowed": true},
  "recommended_for": ["chat","chat-tools","chat-json-strict","function-calling"],
  "health": {"status":"ok","checked_at":"2026-06-03T12:08:50.886Z"}
}                                                                     # per-id route also surfaces recommended_for;
                                                                       # pre-existing fields preserved ✓

$ curl ... /metrics | npx tsx scripts/check-prometheus-cardinality.ts --live -
cardinality-check: OK — no /_id$/ labels found (mode=live)            # POL-06 live ✓

$ docker compose exec router sh -c 'grep -c "recommended_for\|recommendations" /app/dist/index.js'
25                                                                     # new code present in deployed bundle ✓

$ docker compose exec router sh -c 'grep -c "toolCallState" /app/dist/index.js'
5                                                                     # Plan 19-08 fix preserved in deployed bundle ✓

# RESS-WITH-TOOLS smoke gate (3-attempt retry harness — gpt-oss:20b-cloud ~40-60% tool non-determinism)
Attempt 1: DELTA_OK=1 COMPLETED_OK=1 PASS                              # Phase 19 surface unaffected ✓
```

## CDX-01 Status

**CLOSED.**

REQUIREMENTS.md line 46 condition satisfied: "`GET /v1/models` per-entry includes a `recommended_for: [...]` or equivalent capability/role metadata so external consumers can programmatically ask 'which alias is the canonical local chat that supports json_mode strict?' without reading docs. Field is additive (existing consumers unaffected)."

- Per-entry `recommended_for: string[]` field shipped on both `/v1/models` and `/v1/models/:id`. Fixed-taxonomy 7-value enum.
- Top-level `recommendations` map (operator-configurable; auto-derived when absent) ships ALONGSIDE — answers "which alias is the canonical X?" with a single key lookup.
- Field is **additive** — pre-existing consumers (Open WebUI, n8n model picker, artiscrapper) continue to work; unknown response fields are ignored per OpenAI-compat client semantics.
- The artiscrapper case ("chat + json_mode + local") is now answered programmatically: `body.recommendations['chat-json-strict-default']` returns `'chat-local'` — combined with Wave 1's `body.data.find(m => m.id === 'chat-local').health.status === 'ok'`, the consumer gets a full pick + verify with two field reads, no trial-and-error.

## Architectural Notes

### 1. Why fixed taxonomy vs free-form strings (D-05 LOCKED rationale)

Bounded consumer contract. Every value in the 7-tag enum is documented in the registry.ts JSDoc:
- `chat` — has chat capability
- `chat-tools` — has chat + tools
- `chat-json-strict` — has chat + json_mode
- `embeddings` — has embeddings capability
- `rerank` — has rerank capability
- `vision` — has chat + vision
- `function-calling` — synonym for chat-tools (OpenAI/Anthropic SDK vocabulary variant)

Free-form strings would let operators write `recommended_for: ['my-custom-tag']` — consumers would have no way to know what `my-custom-tag` means. Fixed taxonomy = consumers can write a tag-to-pick rule once and trust it for the lifetime of the registry contract.

`chat-tools` and `function-calling` ship as synonyms because OpenAI SDK uses `tool_calls`/`tool_use` while Anthropic SDK uses `tools` — both shipping satisfies SDK consumers without forcing them to learn router-internal vocabulary.

### 2. Why operator-declared WINS over derivation (D-05 design)

Lets operators HIDE a capability the model technically supports but produces unreliable output for. Example: a chat model with json_mode capability but inconsistent JSON-strict adherence — operator can tag `recommended_for: [chat, chat-tools]` to suppress `chat-json-strict` from the recommendations surface. The model still serves json_mode requests at the dispatch layer (capability is separate), but it doesn't appear as a RECOMMENDATION for the json-strict use case.

### 3. Why ALWAYS-PRESENT vs OMIT-when-empty (vs Wave 3 deprecated_aliases)

Wave 3's `deprecated_aliases` projection is OMITTED when empty (v0.12.0 ships with the deprecation map empty per D-02 LOCKED, so the field is absent from every entry). Plan 20-03's `recommended_for` is ALWAYS PRESENT — even an empty array is a meaningful signal ("this entry maps to no fixed-taxonomy use case"). The difference: deprecated_aliases is sparse by nature (zero or few entries per canonical); recommended_for is dense (every meaningful entry has at least one tag). Consumers iterating over `data[]` can rely on `entry.recommended_for` being defined; conditional access (`entry.deprecated_aliases?.length`) only needed for the sparse projection.

### 4. Auto-derive key naming vs operator-friendly shortcuts

Auto-derive produces `<tag>-default` and `<tag>-cloud-default` where `<tag>` is the literal tag name (`embeddings-default`, NOT `embed-default`). Operators who want shortcuts declare them explicitly via the operator-configurable block. v0.12.0 live config does this — explicit `embed-default: embed-local` (no `embeddings-default` since operator block is non-empty → passthrough wins).

If the operator block were absent, the auto-derive would produce `embeddings-default: embed-local` instead — the literal tag name. Operators should be aware: auto-derive is a deterministic fallback, not a polished consumer surface. Production deployments should declare the recommendations block explicitly (v0.12.0 shipping config does this).

## Reversibility Note

Plan 20-03 is fully reversible by design:

```bash
git revert fb7ec53
docker compose build router
docker compose up -d --force-recreate router
```

Restores the pre-Plan-20-03 /v1/models surface (no `recommendations` top-level field; no per-entry `recommended_for`; no `recommended_for:` field in models.yaml; no `recommendations:` block in models.yaml). The 2 new files would be deleted by the revert; the 4 modified files revert to their Plan 20-04 state. Test suite would shrink by 13 cases (7 unit + 6 integration).

## Known Stubs

None. Every contract claimed in this SUMMARY is backed by either a passing test, a live curl, or both.

## Threat Flags

None. The new surface exposes only:
- An operator-declared fixed-taxonomy capability tag array (derived from already-public capabilities; T-20-09 accepted per plan's threat model — capabilities are already public via /v1/models existing surface)
- An operator-declared recommendations map (targets are public model names — same anti-leak posture as the rest of /v1/models)
- T-20-08 (recommendations target pointing at disabled entry) MITIGATED by cross-field superRefine reusing the enabledNames set from the deprecated_aliases check

The new fields do NOT add backend URLs, backend types, backend_model values, vram_budget_gb, or any other internal detail. T-3-A2 anti-leak still holds (explicit field allowlist; no spread of ModelEntry).

## Known Deferred / Out-of-Scope

- **MCP `list_models` tool surface** (router/src/mcp/host/tools/list-models.ts) does NOT yet include the `recommended_for` field or `recommendations` map. Same out-of-scope status as Wave 1's health field — adding it would be a Phase 21 follow-up. Dual-surface parity tests (`list-models-policy-filter.integration.test.ts`) still PASS — the MCP surface keeps its existing projection unchanged.
- **Operator-side documentation page for `recommendations:` block** lands in Wave 4 (CAT-03 + CDX-02 docs). v0.12.0 ships with inline YAML comments only.
- **No metrics added.** POL-06 cardinality discipline preserved.
- **Plan's literal `enabled.length === 10` was stale** — the catalog has 11 enabled entries since commit a4580e0 (predates Phase 20). Acceptance criterion was reinterpreted via substantive contract (all enabled tagged + ≥6 rec keys + all targets enabled). Documented above under Deviations §3.

## Self-Check: PASSED

- File `router/src/routes/v1/__tests__/models-recommendations.test.ts` exists ✓
- File `router/tests/integration/v1-models-recommendations.integration.test.ts` exists ✓
- File `router/src/config/registry.ts` modified (recommended_for schema + recommendations top-level + cross-field validation + deriveRecommendedFor export + RecommendedForTag export) ✓
- File `router/models.yaml` modified (11 entries tagged + 10-key recommendations block) ✓
- File `router/src/routes/v1/models.ts` modified (computeRecommendations helper + per-entry projection + GET /v1/models top-level field + GET /v1/models/:id per-entry field) ✓
- File `router/tests/integration/models.test.ts` modified (2 strict-shape assertions updated) ✓
- File `router/src/routes/v1/embeddings.ts` SHA-256 UNCHANGED at `598b364416cc6e2e1d485776d4f6d7451197ead8e3f04d9260392e8734a69404` ✓
- Commit `fb7ec53` present in `git log` ✓
- 13/13 new tests pass (7 unit + 6 integration) ✓
- Full vitest sweep 1341 pass / 1 known flake / 0 unexpected fail ✓
- /v1/models live response includes top-level `recommendations` map (10 keys) ✓
- /v1/models live response per-entry `recommended_for` field present on all 11 entries ✓
- All 10 recommendation targets point at SEMANTIC role aliases (D-02 LOCKED) ✓
- Pre-existing fields (health, capabilities, policy, etc.) still present and unchanged ✓
- Static cardinality CI guard PASS (mode=source) ✓
- Live cardinality CI guard PASS (mode=live) ✓
- P7-01 BLOCK preserved (embeddings.ts SHA unchanged) ✓
- Phase 19 RESS-WITH-TOOLS smoke gate PASS on attempt 1/3 ✓
