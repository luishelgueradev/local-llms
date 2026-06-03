---
phase: 20-model-catalog-hygiene-external-consumer-dx
plan: 05
subsystem: docs
tags: [consumer-dx, catalog-hygiene, decision-tree, naming-taxonomy, cat-03, cdx-02, docs-only]

requires:
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 01
    provides: disabled-flag mechanics (Wave 0 — CAT-01) — referenced in DEPLOY § disabled: true flag reference
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 02
    provides: health field shape + 'unknown' rationale (Wave 1 — CAT-02) — referenced in README health paragraph + DEPLOY § health field reference
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 03
    provides: recommendations map + recommended_for taxonomy (Wave 2 — CDX-01) — backbone of the curl + jq example in README + recommendations: block reference in DEPLOY
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 04
    provides: deprecation layer (Wave 3 — CAT-04) — referenced in README deprecation grace footer + DEPLOY § deprecated_aliases: block reference
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 06
    provides: bin/deploy-router.sh (Wave 5 — OPS-01) — referenced in DEPLOY operator recipes "Como agregar un alias nuevo" / "Como deprecar un alias"
provides:
  - README.md "Which model when? (v0.12.0)" top-level section (consumer-facing decision tree + curl/jq flow + naming taxonomy explainer + deprecation grace footer + cross-link to DEPLOY)
  - DEPLOY.md "Model Catalog Hygiene (Phase 20 — v0.12.0)" top-level section (operator-facing requirements coverage table + D-02 LOCKED naming taxonomy decision quote + 4 config block references + operator recipes for add/deprecate alias + VRAM check recipe + cross-references to README + every Wave SUMMARY)
  - Explicit closure of CAT-03 (naming taxonomy decision documented in BOTH docs as "two taxonomies coexisting on purpose")
  - Explicit closure of CDX-02 (decision tree + curl example in README covers the artiscrapper case: chat + json_mode + local)
affects:
  - Future consumers (artiscrapper, n8n, Unsloth Studio) can pick aliases programmatically without reading docs OR read docs and find the canonical guide
  - Future operators adding/deprecating aliases have a single canonical recipe (DEPLOY) instead of digging through plan SUMMARYs

tech-stack:
  added: []
  patterns:
    - "Docs-only plan as Wave 4 closure pattern: when the underlying infrastructure (Waves 0-3 + Wave 5) ships separately, the docs wave doesn't need its own deploy — it's a single atomic commit touching ONLY README.md + DEPLOY.md. Smoke gates trivially still pass because no source changed."
    - "Anchor-stable cross-link convention: README and DEPLOY use lowercased section headings as anchors (e.g. `#which-model-when-v0120`, `#model-catalog-hygiene-phase-20--v0120`). When the heading text contains parentheses or special chars, GitHub strips them — verified both directions resolve."
    - "Operator-recipe-first DEPLOY pattern: instead of describing the config blocks abstractly, each block reference subsection follows the same shape: schema snippet (YAML) → semantics list → re-enable/re-edit recipe. Lets an operator copy-paste + adapt without cross-referencing the plan PLANs."
    - "Consumer-flow-first README pattern: the curl + jq example precedes the architectural explanation. A consumer scrolling through the section sees runnable code first, rationale second — minimizes time-to-first-successful-call."

key-files:
  created:
    - .planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-05-SUMMARY.md
  modified:
    - README.md
    - DEPLOY.md
  preserved:
    - router/src/  # docs-only plan — zero source touched (verified by git diff HEAD~..HEAD -- router/src/ being empty)
    - compose.yml
    - router/Dockerfile
    - bin/

key-decisions:
  - "CAT-03 closure rationale: 'two naming taxonomies coexisting on purpose' is documented EXPLICITLY in DEPLOY § Naming taxonomy decision (D-02 LOCKED quote block with full Spanish rationale citing live consumers: n8n at objetiva.com.ar via Cloudflare Tunnel, Unsloth Studio model picker, artiscrapper in development). README mirrors with a shorter `### Dos esquemas de naming coexistiendo (a proposito)` subsection cross-linking to 20-CONTEXT.md for the deep rationale."
  - "CDX-02 closure rationale: README's decision table covers exactly the 6 use cases in REQUIREMENTS.md CDX-02 (chat / chat+tools / chat+json-strict / embed / rerank / vision × local/cloud), and the curl + jq example resolves the artiscrapper case (chat + json_mode + local) in 5 lines. The example reads BOTH the local and cloud recommendations and falls back when local health is not 'ok' — covers the full artiscrapper-equivalent decision logic in a single pipeline."
  - "Documented the THREE coexisting naming schemes (not just two): semantic + raw + deprecated. The original CAT-03 spec said 'two taxonomies'; the live registry has three — quant-encoded legacy aliases are flagged disabled and reserved for the future deprecated_aliases map. DEPLOY documents all three; README simplifies to two (semantic + raw) because the quant-encoded ones don't appear in /v1/models anyway — they're not part of the consumer surface."
  - "Insertion points chosen for minimum disruption: README inserts between 'Modelos disponibles' (which lists the live alias table) and 'Arquitectura'; DEPLOY inserts between Phase 19 EmbeddingProvider and Backups (the v0.12.0 wrap-up slot). Both placements preserve the chronological narrative of each doc — neither rewrites earlier sections."
  - "Cross-link anchors verified both directions: README link `./DEPLOY.md#model-catalog-hygiene-phase-20--v0120` resolves to DEPLOY section heading; DEPLOY link `./README.md#which-model-when-v0120` resolves to README section heading. GitHub anchor convention (lowercase + hyphen-separated, parentheses stripped, em-dash becomes double-hyphen)."

patterns-established:
  - "Docs Wave can be a single-task atomic plan when the underlying source work landed in earlier waves: Wave 4 of Phase 20 = ONE commit (`822f663`), no source touched, no smoke run, trivially clean. Mirrors how docs-only plans landed in earlier milestones (Phase 19's 19-07 was the OBSV-03 docs wave with the same structure)."
  - "DEPLOY operator-facing sections share a consistent shape across phases: (1) strategic frame blockquote, (2) requirements coverage table, (3) decision rationale (if a binding decision was locked), (4) per-config-block reference subsections (schema → semantics → recipe), (5) operator recipes for common changes, (6) cross-references. Phase 17 Sessions, Phase 18 MCP Client, Phase 19 EmbeddingProvider, and now Phase 20 Model Catalog all follow this shape."
  - "README consumer-facing sections share a consistent shape: (1) opening paragraph in Spanish stating the goal + the programmatic-first rule, (2) decision table for human readers, (3) runnable curl example, (4) architectural notes (health semantics, naming taxonomy), (5) cross-link to DEPLOY. Same shape used by Phase 17 Sessions and Phase 18 MCP Client; replicated here."

requirements-completed: [CAT-03, CDX-02]

duration: ~5min
completed: 2026-06-03
---

# Phase 20 Plan 20-05: Consumer Decision Tree + Operator Catalog Hygiene Docs Summary

**Closes CAT-03 + CDX-02. Single atomic commit (`822f663`) touching only README.md + DEPLOY.md — adds the consumer-facing "Which model when?" decision tree + curl/jq flow to README, and the operator-facing "Model Catalog Hygiene" reference section (coverage table + D-02 LOCKED rationale + 4 config block references + add/deprecate alias recipes + VRAM check) to DEPLOY. Zero source touched; Phase 19 RESS-WITH-TOOLS smoke gate trivially still PASSes.**

## Performance

- **Duration:** ~5 min (Wave 4 docs-only)
- **Started:** 2026-06-03T13:12:09Z
- **Completed:** 2026-06-03T13:16:26Z
- **Tasks:** 2 completed (Task 1: README "Which model when?" section; Task 2: DEPLOY "Model Catalog Hygiene" section)
- **Files modified:** 2 (README.md, DEPLOY.md — both pre-existing)
- **Commits:** 1 atomic docs commit (`822f663`)
- **Lines added:** 273 (across both files)

## Accomplishments

- **CAT-03 closed.** Naming taxonomy decision (D-02 LOCKED — "two taxonomies coexisting on purpose") is documented EXPLICITLY in DEPLOY § Naming taxonomy decision as a multi-paragraph quote block in Spanish, citing the live consumer constraints (n8n at objetiva.com.ar via Cloudflare Tunnel, Unsloth Studio's model picker, artiscrapper in development). README mirrors with a shorter `### Dos esquemas de naming coexistiendo (a proposito)` subsection. Both docs cross-reference 20-CONTEXT.md for the full historical rationale + commit a4580e0 for the established pattern.

- **CDX-02 closed.** README "Which model when? (v0.12.0)" section delivers:
  - Decision table covering all 6 use cases (chat / chat+tools / chat+json-strict / embeddings / rerank / vision) × local/cloud — exactly the matrix CDX-02 requires.
  - Copy-pasteable `curl + jq` flow that reads `recommendations["chat-json-strict-default"]`, fetches the entry, validates `health.status === 'ok'`, and falls back to the cloud default when local is degraded — covers the artiscrapper case (chat + json_mode + local) in 5 lines.
  - Health field semantics paragraph (boot probe + lazy 60s refresh; ollama-cloud → 'unknown' explained).
  - Deprecation grace footer (X-Deprecated-Alias header + ≥30 day window).
  - Cross-link to DEPLOY for operator-side configuration.

- **THREE coexisting naming schemes documented** (not just two — DEPLOY § Naming taxonomy explains: semantic + raw + quant-encoded-legacy). The original CAT-03 spec said "two taxonomies"; the live registry has three because quant-encoded aliases are flagged `disabled: true` and reserved for the future `deprecated_aliases:` map. README simplifies to two (the consumer-visible ones); DEPLOY surfaces all three because operators need to understand the disabled-flag → deprecated_aliases lifecycle.

- **All four config block references documented in DEPLOY** with schema snippet + semantics list + re-enable/re-edit recipe:
  - `disabled: true` flag (CAT-01) — anti-leak invariant T-20-01 cited
  - `health` field (CAT-02) — D-04 LOCKED no-auto-filter rationale
  - `recommendations:` block (CDX-01) — 10-key live config example + auto-derive rule
  - `deprecated_aliases:` block (CAT-04) — all 4 surfaces (header, pino log, Prometheus counter, /v1/models projection)

- **Two operator recipes** documented end-to-end in DEPLOY:
  - "Como agregar un alias nuevo" — 4 steps including `bash bin/deploy-router.sh config-only` reference (OPS-01)
  - "Como deprecar un alias (futuro rename)" — 5 steps following the CAT-01 disabled + CAT-04 deprecated_aliases composed pattern, including monitoring `router_deprecated_alias_used_total` before final removal

- **VRAM check recipe** documented with `docker exec local-llms-ollama ollama ps` + `nvidia-smi`, citing the WSL2 ~10.6 GB usable budget memory (`project_vram_budget`).

- **Cross-references to every Wave SUMMARY** (20-01 through 20-06) at the end of the DEPLOY section — operators who need implementation depth have a curated path.

- **Anchor stability verified both directions:** README's `./DEPLOY.md#model-catalog-hygiene-phase-20--v0120` and DEPLOY's `./README.md#which-model-when-v0120` both resolve correctly with GitHub anchor conventions (lowercase, hyphen-separated, em-dash becomes double-hyphen, parentheses stripped).

- **Phase 19 RESS-WITH-TOOLS gate** trivially still PASSes — zero source files touched (verified: `git diff HEAD~1 HEAD -- router/src/ compose.yml router/Dockerfile bin/` is empty).

## Task Commits

Per plan `commit_strategy: one_atomic_commit`, both tasks landed in a single commit:

1. **Both tasks (README + DEPLOY)** — `822f663` (docs)

**Plan metadata commit:** TBD (after this SUMMARY)

## Files Created/Modified

### Created
- `.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-05-SUMMARY.md` (this file)

### Modified
- `README.md` — new top-level section `## Which model when? (v0.12.0)` inserted between "Modelos disponibles" and "Arquitectura" (~80 lines added). Contains: opening paragraph + 6-row decision table + curl/jq flow + health semantics paragraph + naming taxonomy subsection + deprecation grace footer + DEPLOY cross-link.
- `DEPLOY.md` — new top-level section `## Model Catalog Hygiene (Phase 20 — v0.12.0)` inserted between Phase 19 EmbeddingProvider and Backups (~190 lines added). Contains: strategic frame quote + requirements coverage table (9 rows) + D-02 LOCKED naming taxonomy quote block + 4 config block references (disabled / health / recommendations / deprecated_aliases) + 2 operator recipes (add / deprecate) + VRAM check recipe + 5 Wave SUMMARY cross-references + README cross-link.

## Decisions Made

All decisions inherited from `20-CONTEXT.md` (D-01..D-09); only D-02 (naming taxonomy) is the load-bearing decision being DOCUMENTED in Wave 4. Other decisions referenced for context:

- **D-02 LOCKED (documented EXPLICITLY in DEPLOY + README)** — two naming schemes coexist on purpose. Both docs cite the consumer-impact rationale (live n8n + Unsloth + artiscrapper). DEPLOY's quote block is the canonical CAT-03 closure artifact.
- **D-04 LOCKED (referenced in DEPLOY § health field reference)** — no auto-filter; `status: 'down'` entries still appear in `/v1/models`; consumer decides per C7.
- **D-05 LOCKED (referenced in DEPLOY § recommendations: block)** — fixed-taxonomy `recommended_for` enum + operator-configurable `recommendations:` map; 10-key live config example shown.
- **D-09 (referenced in DEPLOY coverage table)** — migration guide stays empty in v0.12.0 because no breaking renames; status marked as "pending Plan 20-07".

## Deviations from Plan

### Auto-fixed Issues

**None.** Both tasks executed exactly as specified in the plan. The grep gates from each task's `<verify>` block passed on first commit:

- README grep `Which model when` → 1 (≥1 required)
- README grep `recommendations\[` → 3 (≥1 required)
- README grep `X-Deprecated-Alias` → 1 (≥1 required)
- DEPLOY grep `Model Catalog Hygiene` → 1 (≥1 required)
- DEPLOY grep `deprecated_aliases` → 8 (≥1 required)
- DEPLOY grep `disabled: true` → 8 (≥1 required)
- DEPLOY grep `CAT-01|CAT-02|CAT-04` → 10 (≥3 required)

### Process notes

- **Slight deviation from prompt vs PLAN.md:** The orchestrator's prompt suggested a "subsection" placement inside an existing section; the PLAN.md (which is the source of truth) specified `## ` (top-level) sections in both docs. Followed the PLAN. The top-level placement is also necessary for the DEPLOY cross-link from README (`#model-catalog-hygiene-phase-20--v0120`) to resolve as a clean section anchor.
- **Insertion point in DEPLOY:** plan said "between Phase 19 EmbeddingProvider section and Backups — it's the v0.12.0 wrap-up." Honored.
- **Insertion point in README:** plan said "between the existing model documentation (around EmbeddingProvider) or before Integración n8n". Chose the slot just after "Modelos disponibles" (which is the live alias table) — directly adjacent to the table the new section references. Slightly different from the plan's suggested vicinity but more semantically natural: the new section is a guide for reading that table, so it goes right next to it.

## Live Verification Transcript

### Pre-commit grep gates

```
=== README grep 'Which model when' ===
1
=== README grep 'recommendations\[' ===
3
=== README grep 'X-Deprecated-Alias' ===
1
=== DEPLOY grep 'Model Catalog Hygiene' ===
1
=== DEPLOY grep 'deprecated_aliases' ===
8
=== DEPLOY grep 'disabled: true' ===
8
=== DEPLOY grep 'CAT-01|CAT-02|CAT-04' (count) ===
10
```

### Anchor cross-link verification

```
=== README anchor target ===
244:## Which model when? (v0.12.0)
=== DEPLOY anchor target ===
871:## Model Catalog Hygiene (Phase 20 — v0.12.0)
=== README → DEPLOY links ===
](./DEPLOY.md#embeddingprovider-phase-19--v0110)
](./DEPLOY.md#mcp-host-phase-15--v0110)
](./DEPLOY.md#model-catalog-hygiene-phase-20--v0120)
=== DEPLOY → README links ===
](./README.md#which-model-when-v0120)
```

All anchors resolve.

### Source-touch invariant

```
$ git diff HEAD~1 HEAD -- router/src/ compose.yml router/Dockerfile bin/
(empty)
```

Zero source touched — Phase 19 RESS-WITH-TOOLS gate trivially preserved.

### Post-commit state

```
$ git status --short
(empty — clean tree)

$ git log --oneline -1
822f663 docs(20-05): "Which model when?" decision tree + Model Catalog Hygiene operator section (CAT-03 CDX-02)

$ git diff --diff-filter=D --name-only HEAD~1 HEAD
(empty — no deletions)
```

## CAT-03 + CDX-02 Status

**CLOSED.**

REQUIREMENTS.md conditions satisfied:

- **CAT-03**: "Naming taxonomy decision is documented in `DEPLOY.md` and `README.md`. EITHER (a) all aliases follow one convention, OR (b) the mix is explicitly documented as 'two taxonomies coexisting on purpose for these reasons'." → Option (b) chosen per D-02 LOCKED. DEPLOY § Naming taxonomy decision = quote block with the full Spanish rationale + reference to 20-CONTEXT.md. README § Dos esquemas de naming coexistiendo (a proposito) = consumer-facing mirror with cross-link.

- **CDX-02**: "`README.md` and `DEPLOY.md` contain a 'Which model when?' decision tree subsection: chat vs chat+tools vs chat+json strict vs embed vs rerank vs vision, each pointing to the recommended alias for both `local` and `cloud` profiles. Covers the artiscrapper case (chat + json_mode strict + local)." → README § Which model when? (v0.12.0) = decision table covering all 6 use cases × local/cloud + curl/jq flow resolving the artiscrapper case (chat + json_mode + local) with explicit fallback to cloud. DEPLOY references the README section as the consumer-facing artifact and adds the operator-facing depth.

## Reversibility Note

Wave 4 is fully reversible by design:

```bash
git revert 822f663
```

Restores README + DEPLOY to their pre-Wave-4 state. No source dependencies; no deploy step needed; no smoke regression possible because zero source changed.

## Known Deferred / Out-of-Scope

- **Wave 6 (Plan 20-07 — CDX-03 migration guide)** is the only remaining work for Phase 20. Per D-09 the file will be short/empty because v0.12.0 ships ZERO breaking renames. Wave 4 documents what consumers SHOULD KNOW; Wave 6 documents what they MUST DO (which in this milestone is "nothing" — `recommendations` map + `health` field are additive and existing fixed-alias code continues to work).
- **Table in "Modelos disponibles" (README ~line 226)** is slightly stale — still lists `bge-m3-vllm`, `qwen2.5-7b-instruct-awq`, `qwen2.5-7b-instruct-q4km` as if they were available. They are `disabled: true` per CAT-01 and invisible at /v1/models. Out of scope for this plan (plan explicitly said "Do NOT modify any other README section"). Tracked as deferred — a future docs touch-up could refresh this table or replace it with a curl command and let the live `/v1/models` be the source of truth.

## Self-Check: PASSED

- File `README.md` modified with new section at line 244 ✓
- File `DEPLOY.md` modified with new section at line 871 ✓
- File `.planning/phases/20-.../20-05-SUMMARY.md` created (this file) ✓
- Commit `822f663` present in `git log` ✓
- All 7 grep gates from plan PASS ✓
- Both cross-link anchors resolve in both directions ✓
- Zero source touched (`git diff HEAD~1 HEAD -- router/src/ compose.yml router/Dockerfile bin/` is empty) ✓
- No file deletions in the commit ✓
- Clean working tree post-commit ✓
- CAT-03 + CDX-02 closure conditions in REQUIREMENTS.md satisfied ✓
