---
phase: 20-model-catalog-hygiene-external-consumer-dx
phase_number: 20
phase_name: Model Catalog Hygiene + External Consumer DX + Deploy Hygiene
version: v0.12.0
generated_at: 2026-06-03T03:35:00Z
generated_by: overnight-autonomous-run (orchestrator-inlined discuss-phase with conservative defaults)
mode: autonomous-conservative
source_of_truth: .planning/seeds/SEED-001-model-catalog-hygiene-consumer-dx.md
requires_user_review: true
override_path: "Run /gsd:discuss-phase 20 --replan to revisit any decision; specific OVERRIDE flags listed per decision below"
---

# Phase 20: CONTEXT (overnight autonomous draft)

> **Reading order:** This is the context document downstream agents (`gsd-phase-researcher`, `gsd-planner`) will consume. It was produced overnight by orchestrator-inlined discuss-phase with **conservative defaults** for every gray area. The user reviews on wake-up and either approves all decisions (run `/gsd:plan-phase 20`) or overrides specific ones (re-run `/gsd:discuss-phase 20 --replan` after editing the OVERRIDE flags below).

## 1. Scope Summary

Close three categories of consumer friction that artiscrapper exposed on 2026-06-03 and formalize deploy hygiene to prevent the next 19-09-class skew bug. 9 REQs across 3 buckets:

- **CAT-01..04** — Catalog hygiene + health-aware `/v1/models`
- **CDX-01..03** — Capability metadata + "which model when" docs + migration guide
- **OPS-01..02** — Deploy script + boot-time SHA skew check

Source of truth: [SEED-001](../../seeds/SEED-001-model-catalog-hygiene-consumer-dx.md).

The phase is sized as **one phase with multiple waves**. Whether it splits into Phase 20/21/22 during planning is a `gsd-planner` decision — the REQ-IDs stay stable across any split.

## 2. Constraints Honored (locked — derived from project memories, not negotiable)

| # | Constraint | Memory source | Implication for Phase 20 |
|---|------------|---------------|--------------------------|
| C1 | VRAM 16 GB WSL2, one 7B hot at a time; vllm/llamacpp redundantes | [project_vram_budget] | The 3 dead-backend aliases (`qwen2.5-7b-instruct-q4km` → llamacpp, `qwen2.5-7b-instruct-awq` → vllm, `bge-m3-vllm` → vllm-embed) need cleanup; cannot reintroduce those backends |
| C2 | qwen2.5:7b es el workhorse local fijo | [project_local_llm_choice] | Taxonomy MUST keep qwen2.5:7b accessible; `chat-local` alias must continue resolving to it |
| C3 | models.yaml hot-edit requires Valkey DEL + `up -d --force-recreate` | [project_models_yaml_hot_edit] | OPS-01 deploy script MUST document the Valkey-DEL sub-command for models.yaml-only changes |
| C4 | n8n LangChain nodes reference alias strings in stored workflows | [project_n8n_integration] | Any rename needs backward-compat alias (CAT-04, ≥30-day grace) |
| C5 | Unsloth Studio + n8n consume `localhost:3210/v1` | [project_unsloth_integration] | Same as C4 — no breaking changes to live consumers |
| C6 | Cloudflare tunnel to `objetiva.com.ar` n8n in production | [project_cloudflare_tunnel] | Live consumer; rename = downtime; backward-compat is mandatory |
| C7 | Router exposes seams, never implements logic | [project_retrieval_agnostic_principle] | `/v1/models` metadata is *information for consumers*, not *router-side filtering decision* — health field doesn't auto-filter unless explicitly opt-out via query param |
| C8 | P7-01: `/v1/embeddings` byte-identical SHA preserved | v0.11.0 Phase 19 | Cannot touch `router/src/routes/v1/embeddings.ts` |
| C9 | POL-06: no `_id$` labels in any /metrics series | v0.11.0 Phase 14 | New `router_deprecated_alias_used_total` MUST use `old_name`/`new_name`, not `*_id` suffixes |
| C10 | MCPS-06: no `StdioServerTransport` imports anywhere | v0.11.0 Phase 15 | N/A — Phase 20 doesn't touch MCP transport |

## 3. Gray Areas — Conservative Decisions

For each gray area surfaced by SEED-001, I record: (a) the decision I'm making for you, (b) why, (c) what would change my mind, (d) the explicit OVERRIDE flag if you want a different answer.

### D-01: Dead-entry handling — `disabled: true` flag, NOT removal

**Decision:** The 3 entries (`qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`, `bge-m3-vllm`) get a new `disabled: true` field in their `models.yaml` block. The registry parser filters them out of `/v1/models` and dispatch, but the entries remain in the file with an explanatory comment for documentation and quick re-enable.

**Why conservative:**
- Removal would change the `backends:` schema (those backends no longer have any consumer, so could be removed too)
- Keeping the comment preserves the historical rationale (per [project_vram_budget])
- Re-enabling vllm/llamacpp in a future milestone would be a 1-line flip vs. re-deriving the YAML structure

**What would change my mind:** If you tell me "I will never run vllm/llamacpp again, delete it all". Then removal is cleaner.

**OVERRIDE flag:** `D-01: remove-entirely-instead-of-disable`

### D-02: Naming taxonomy — keep BOTH coexisting + document explicitly (option (b) from SEED-001 gray areas)

**Decision:** Both naming schemes (semantic `chat-local`/`embed-local`/`big-cloud`/`vision-local` AND quant-encoded `qwen2.5-7b-instruct-q4km`) continue to coexist in `models.yaml`. The semantic aliases are documented as the **recommended consumer-facing surface**; the quant-encoded ones are documented as **deprecated-but-still-resolving** (per D-03 below). No mass rename in this milestone.

**Why conservative:**
- A mass rename is a breaking change to n8n stored workflows + Unsloth Studio picker (C4, C5, C6)
- The semantic aliases already exist and work — they're the right v0.12.0 surface; we don't need to remove the quant-encoded ones, just deprecate them
- Option (a) from SEED-001 ("all semantic") would be cleaner long-term but risks n8n downtime
- Option (c) ("status quo + dead entries removed") leaves naming chaos unaddressed — partial fix

**What would change my mind:** If you tell me "all n8n consumers can be updated in one push; downtime is fine; I want the clean break". Then option (a) wins.

**OVERRIDE flag:** `D-02: pick-option-a-rename-aggressively` or `D-02: pick-option-c-status-quo-no-deprecation`

### D-03: Backward-compat alias layer — log warning, NO model registry shim

**Decision:** Aliases that are deprecated (the quant-encoded ones from D-02) keep resolving to the canonical semantic target. On each resolution, the registry emits:
1. A warn-level log line: `{alias: "qwen2.5-7b-instruct-q4km", redirected_to: "chat-local", deprecated_since: "v0.12.0", removal_target: "v0.13.0"}`
2. Increment to `router_deprecated_alias_used_total{old_name, new_name}` counter
3. The response includes a custom header `X-Deprecated-Alias: chat-local` so consumers can detect programmatically

**No schema change** — the registry parser just maps deprecated alias to the canonical entry's backend/model/capabilities. No new YAML field needed.

**Why conservative:**
- Counter + header give consumers BOTH log-monitoring AND programmatic detection paths
- Removal target `v0.13.0` is documented but not enforced — operator decides when to actually break
- Schema change would compound risk

**What would change my mind:** If you want a structured `aliases:` block on each model entry (e.g., `chat-local: { aliases: ['qwen2.5-7b-instruct-q4km'] }`). That's more elegant but is a schema change.

**OVERRIDE flag:** `D-03: use-aliases-array-schema` or `D-03: remove-deprecated-aliases-immediately`

### D-04: `/v1/models` health field — boot-time probe, lazy refresh

**Decision:** Adds an additive optional `health` field to each `/v1/models` entry: `{ status: "ok"|"degraded"|"down"|"unknown", checked_at: ISO8601 }`. Computed at router boot by probing each declared backend's `/healthz` (or equivalent: Ollama `/`, vLLM `/health`, llama.cpp `/health`). Cached for 60 seconds via Valkey; refreshed lazily on next `/v1/models` request after expiry.

**Field is additive.** Old consumers that don't read `health` continue to work.

**No auto-filtering** — even if `status: "down"`, the alias still appears in `/v1/models` (consumer decides whether to use it). This honors C7 (router exposes information, doesn't decide for consumer).

**Why conservative:**
- Boot-time probe is the simplest correctness check
- Lazy 60s refresh is cheap (Valkey GET + maybe a backend HTTP probe)
- Active filtering would be opinionated and might hide aliases the consumer explicitly wants for testing
- Additive field = zero breaking change

**What would change my mind:** If you want active filtering (`?available=true` query param to hide down ones). I'd add that as an opt-in query param.

**OVERRIDE flag:** `D-04: add-available-filter-query-param` or `D-04: skip-health-probe-entirely`

### D-05: `recommended_for` metadata — capability tags, not free-form

**Decision:** Adds an additive optional `recommended_for: string[]` field to each `/v1/models` entry. Values drawn from a fixed taxonomy: `["chat", "chat-tools", "chat-json-strict", "embeddings", "rerank", "vision", "function-calling"]`. Each alias gets the subset that applies. The recommended canonical alias for each use case is **also** documented as a sibling field `tags: { use_case: alias_name }` at the top-level `/v1/models` response (NOT per entry).

Example response shape:
```json
{
  "data": [
    {
      "id": "chat-local",
      "capabilities": ["chat", "tools", "json_mode"],
      "recommended_for": ["chat", "chat-tools", "chat-json-strict"],
      "health": {"status": "ok", "checked_at": "..."},
      ...
    },
    ...
  ],
  "recommendations": {
    "chat-local-default": "chat-local",
    "chat-cloud-default": "big-cloud",
    "chat-json-strict-default": "chat-local",
    "embed-default": "embed-local",
    "rerank-default": "bge-reranker-local",
    "vision-default": "vision-local"
  }
}
```

**Why conservative:**
- Fixed taxonomy avoids consumer confusion ("what does `recommended_for: 'data_processing'` mean?")
- Top-level `recommendations` map gives consumers a one-shot answer to "which alias for X?"
- All additive

**What would change my mind:** If you want free-form `recommended_for` (operator-authored strings). More flexible but harder for consumers.

**OVERRIDE flag:** `D-05: free-form-recommended-for-strings` or `D-05: skip-recommendations-map-only-per-entry-tags`

### D-06: `chat-local` 15s timeout investigation — diagnose first, fix only if real bug

**Decision:** Treat the 15s timeout observed on 2026-06-03 as a **probable cold-load symptom**, not a discrete bug. Plan a diagnostic task (read first request latency for qwen2.5:7b after a router restart vs. second request after warm) and only escalate to a fix wave if the data shows real wrong behavior. Document the expected first-request latency in DEPLOY.md / README.md as part of the "Which model when?" section so consumers know to set client timeouts ≥30s for first hit.

**Why conservative:**
- The Ollama 4.7GB model COLD-LOADS into VRAM on first hit; that's known behavior, not a bug
- Past memory `project_local_llm_choice` notes this trade-off (workhorse model = larger cold-load)
- Spending plan time on a "fix" that's actually expected behavior wastes the milestone

**What would change my mind:** If the diagnostic shows that even warm second requests are slow (>5s for `max_tokens=5` prompt). Then there's a real router-side issue.

**OVERRIDE flag:** `D-06: treat-as-discrete-bug-and-plan-debug-session`

### D-07: Deploy script — bash, not just; mirror compose.yml conventions

**Decision:** `bin/deploy-router.sh` (bash) — matches the existing project convention (`bin/smoke-test-router.sh`, `bin/preflight-gpu.sh`, `bin/bootstrap-host.sh`, etc.). Subcommands:
- `bin/deploy-router.sh full` — `docker compose build router && docker compose up -d --force-recreate router && wait-for-healthz && bash bin/smoke-test-router.sh --phase 19`
- `bin/deploy-router.sh config-only` — `redis-cli/valkey-cli DEL model-registry:cached && docker compose up -d --force-recreate router && wait-for-healthz`
- `bin/deploy-router.sh check` — just runs Phase 19 smoke gate (no build, no restart)

**Why conservative:**
- No new tooling dependency (`just` would require apt install on the host)
- Mirrors the existing bin/ convention
- 3 subcommands cover the 3 actual deploy paths: source change, models.yaml change, just verify

**What would change my mind:** If you prefer `just` (you already have it installed). Or if you want the script in `Makefile` instead.

**OVERRIDE flag:** `D-07: use-just-instead-of-bash` or `D-07: makefile-target-instead`

### D-08: Source/binary skew check — BUILD_SHA env at image build, exposed via /healthz extension

**Decision:** During `docker compose build router`, the Dockerfile bakes `ENV BUILD_SHA=<git rev-parse HEAD>` and `ENV BUILD_TIME=<ISO8601>`. The router reads these on boot and exposes them at:
- `GET /healthz` returns `{"status": "ok", "build_sha": "abc1234", "build_time": "..."}` (additive — old consumers ignore the new fields)
- `GET /version` (new endpoint) returns `{"build_sha", "build_time", "git_dirty": boolean}`

Deploy script's `check` subcommand compares `git rev-parse HEAD` against `/healthz` build_sha and warns if mismatch.

**Why conservative:**
- Bake-at-build-time is the simplest correctness mechanism (no runtime git call, no path drift)
- Additive endpoint changes
- Operator-side comparison happens in the deploy script (no router-side enforcement; honors C7)

**What would change my mind:** If you want active enforcement (router refuses to serve if BUILD_SHA != HEAD at boot). That's more aggressive but possibly desired.

**OVERRIDE flag:** `D-08: active-enforcement-refuse-stale-image` or `D-08: simpler-just-add-build-sha-to-healthz`

### D-09: Migration guide — empty file is OK; only populate if D-02 chooses option (a)

**Decision:** Create `docs/CONSUMER-MIGRATION-v0.12.0.md` (note: in `docs/`, not `.planning/`, so it's user-facing). Per D-02's choice (keep both naming schemes), the only migration step for consumers is "you can now use `health` field and `recommendations` map in `/v1/models` for programmatic alias selection — optional, your existing fixed-alias code continues to work". If you flip D-02 to option (a) on review, this file gets populated with the per-alias old→new mapping.

**Why conservative:** Empty is a feature here — it means we made zero breaking changes.

**OVERRIDE flag:** `D-09: populate-with-aggressive-rename-table` (auto-triggered if D-02 overridden)

## 4. Wave Structure (conservative — gsd-planner can refine)

Tentative wave shape based on the conservative defaults above. The planner will produce concrete PLANs; this is just the shape so the user can sanity-check the size:

- **Wave 0 (hard bug, fast, reversible):** `disabled: true` on 3 dead entries + commit + Valkey DEL + `docker compose up -d --force-recreate router` + smoke verify (RESS-WITH-TOOLS gate + new `/v1/models` returns 10 entries instead of 13). Closes CAT-01.
- **Wave 1 (health probe):** Boot-time backend reachability probe + Valkey cache + `health` field on `/v1/models` + 60s lazy refresh + unit tests + integration test. Closes CAT-02.
- **Wave 2 (capability metadata):** Per-entry `recommended_for: string[]` + top-level `recommendations` map + integration tests. Closes CDX-01.
- **Wave 3 (deprecation surface):** Backward-compat alias layer + `router_deprecated_alias_used_total` counter + `X-Deprecated-Alias` response header + log line + unit + integration tests. Closes CAT-04.
- **Wave 4 (docs):** README + DEPLOY "Which model when?" decision tree + cross-link from `/v1/models` response docs + naming taxonomy decision documentation (CAT-03 + CDX-02).
- **Wave 5 (deploy hygiene):** `bin/deploy-router.sh` 3-subcommand script + Dockerfile BUILD_SHA env + `/healthz` extension + new `/version` endpoint + smoke gate added to Phase 20 section of `bin/smoke-test-router.sh`. Closes OPS-01 + OPS-02.
- **Wave 6 (migration guide):** Empty `docs/CONSUMER-MIGRATION-v0.12.0.md` populated with optional new-features doc (just `health` + `recommendations` — no breaking migration steps). Closes CDX-03.

Total: ~7 waves of work. If split across multiple phases (20/21/22), the natural break points are Wave 0+1+5 (Phase 20: hygiene + deploy) → Wave 2+3+4+6 (Phase 21: consumer DX surface).

## 5. Anti-patterns to Watch (for planner)

- **Touching `router/src/routes/v1/embeddings.ts`** — P7-01 BLOCK invariant from v0.11.0. SHA must stay byte-identical.
- **Adding `_id$`-suffixed labels** to any new metric — POL-06 invariant. New counter MUST be `router_deprecated_alias_used_total{old_name, new_name}` (not `old_alias_id`).
- **Renaming `chat-local` / `embed-local` / `big-cloud` / `vision-local` / `bge-reranker-local`** — those are the semantic aliases that should STAY canonical; only the quant-encoded ones get deprecation flags.
- **Hard-removing entries from `models.yaml`** — per D-01, use `disabled: true`. Removal would change the `backends:` schema.
- **Active filtering on `/v1/models` based on health** — per C7 and D-04, the consumer decides whether to use a down alias; the router only reports.
- **Breaking the n8n LangChain OpenAI-Chat-Model surface** — n8n stores alias strings in workflow JSON. Any change must keep old strings resolving (backward-compat alias layer).
- **Updating the smoke gate literal `gpt-oss:20b-cloud`** — Phase 19 RESS-WITH-TOOLS greps this exact string. Don't rename cloud aliases unless you also update the smoke (and you shouldn't rename them).
- **Splitting Wave 0 across multiple commits** — `models.yaml` edit + Valkey DEL + force-recreate must be ONE atomic operation per [project_models_yaml_hot_edit]; the deploy script enforces this in `config-only` mode.

## 6. Downstream Consumers (must continue to work without user-side update)

| Consumer | Aliases referenced | Test for "still works" |
|----------|--------------------|------------------------|
| n8n workflows at `objetiva.com.ar` (Cloudflare tunnel) | `chat-local`, `big-cloud`, `embed-local` | All three still resolve to the same backend after Phase 20 ships |
| Unsloth Studio (host :8888) | model picker reads `/v1/models` | Old picker UI continues to show models (additive fields don't break) |
| artiscrapper (this session's complainant) | currently using `gpt-oss:20b-cloud` after fallback | Cloud aliases unchanged; will benefit from new `recommendations.chat-json-strict-default` |
| Open WebUI (`webui-app` network) | server-to-server `/v1/models` polling | Old polling continues to work; new `health` field is ignored |

## 7. Out of Scope (explicit non-goals)

- New model runtimes (no SGLang, no TensorRT-LLM)
- Retrieval/RAG features (router never implements retrieval — C7)
- Multi-tenant policy changes (POL-01..06 from v0.11.0 cover this)
- Wire shape changes to `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`, `/v1/rerank` (additive `/v1/models` and new `/version` only)
- Immediate alias removal — every rename gets ≥30-day grace period (CAT-04)
- Updating downstream consumer projects (artiscrapper, n8n, Unsloth) — they remain unchanged; the migration guide just documents new optional features

## 8. Open Questions for Planner

These are NOT decisions I'm making for the user — they're notes for `gsd-planner` to resolve during plan creation:

1. **Should Wave 1's health probe run in-process or via a Fastify plugin?** Plugin is cleaner but adds wire complexity. Suggest plugin.
2. **Should Wave 3's deprecation log be JSON-structured (pino-style) or pretty-printed?** Probably pino-style to match `router/src/logger.ts` conventions.
3. **Should `bin/deploy-router.sh` support `--profile prod` arg to use the live tunnel?** Yes, mirroring `bin/smoke-test-router.sh` convention. Default to `--profile dev`.
4. **Should the `recommendations` map be operator-configurable in `models.yaml`?** Probably yes — `recommendations: { chat-local-default: chat-local }` block alongside `models:`. Default to first matching alias if not set.
5. **Should `BUILD_SHA` mismatch be a hard-fail or warn-only in Wave 5?** Conservative: warn-only. Easy to flip to hard-fail later.

## 9. References

- Source seed: [SEED-001](../../seeds/SEED-001-model-catalog-hygiene-consumer-dx.md)
- Predecessor diagnosis: `.planning/debug/resolved/phase-19-ress-with-tools-delta.md` (the 19-09 deploy gap)
- v0.11.0 ship state: [v0.11.0-MILESTONE-AUDIT.md](../../milestones/v0.11.0-MILESTONE-AUDIT.md)
- artiscrapper failure session: documented inline in the user's 2026-06-03 conversation (preserved in this conversation transcript)
- Current `models.yaml` state (commit 5f0ddb4): `router/models.yaml` — 13 entries, 3 pointing to non-running backends

## 10. Notes for the Morning User Review

When you wake up, read this CONTEXT.md top to bottom and check:

1. **Decisions D-01 through D-09** — any you want to flip? Note the OVERRIDE flag and either edit this file in place OR run `/gsd:discuss-phase 20 --replan` to redo from scratch.
2. **Wave structure (§4)** — does this match how you want to ship? If you want a different split (e.g., do Wave 5 deploy hygiene FIRST so the rest of the milestone has the new tooling), flag that here and the planner will pick it up.
3. **Open questions (§8)** — answer the 5 if you have strong preferences, otherwise the planner picks defaults.
4. **Consumer impact (§6)** — sanity check: did I miss a consumer? Any consumer I named that DOES break under these decisions?

If all of (1-4) look fine, run `/gsd:plan-phase 20` to advance. If you want bigger surgery, run `/gsd:discuss-phase 20 --power` for the full interactive flow.

Wave 0 (the hard bug — `disabled: true` flag on 3 dead entries) is **safe to execute right now** with `/gsd:execute-phase 20 --wave 0`. The orchestrator may have already done this overnight as the "bonus step" per the overnight plan — check `OVERNIGHT-REPORT.md` for what shipped vs what's pending.
