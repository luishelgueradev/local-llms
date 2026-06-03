---
id: SEED-001
status: dormant
planted: 2026-06-03
planted_during: v0.11.0 / post-Phase 19 (49/49 plans shipped)
trigger_when: next milestone scope = router consumer surface, model catalog UX, or external project integration
scope: medium
---

# SEED-001: Model Catalog Hygiene + External Consumer DX

Remove dead llamacpp/vllm catalog entries, design a coherent semantic naming taxonomy, and add a health-aware metadata surface to `/v1/models` so external consumer projects (artiscrapper, n8n, Unsloth Studio) can programmatically pick a working alias.

## Why This Matters

External consumer project (`artiscrapper`) hit deterministic failures trying to use local-llms for data processing on 2026-06-03. The diagnosis surfaced **three distinct problems**:

1. **Hard bug (catalog drift):** 3 of 13 catalog entries point to backends (`llamacpp`, `vllm`, `vllm-embed`) that don't exist as containers. Per memory `project_vram_budget`, those backends were dropped as "redundantes" when the VRAM budget was set to "one 7B hot at a time" — but `router/models.yaml` was never cleaned up. Result: every consumer that picks `qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`, or `bge-m3-vllm` hits silent ENOTFOUND that surfaces as a 30 s timeout.

2. **Naming chaos:** the registry mixes two unrelated schemes:
   - Quant-encoded: `qwen2.5-7b-instruct-q4km`, `bge-m3-vllm` — leaks backend choice into the alias
   - Semantic: `chat-local`, `embed-local`, `bge-reranker-local`, `vision-local`, `big-cloud`
   - Plus cloud-only `:`-separated `gpt-oss:20b-cloud` / `gpt-oss:120b-cloud`
   - `/v1/models` returns all 13 entries with `cloud_allowed=true` on every single one — no real signal to consumers.

3. **No external-consumer contract:** A consumer has no programmatic way to ask "which alias is recommended for chat + json_mode + local + working right now?". The README's "Integración n8n" guidance references aliases that may be alive or dead.

The previous decision in this project was to **not rename aliases because it touched sensitive parts** (smoke gates that grep literal model names, Open WebUI connections, n8n stored configs, Unsloth Studio picker). That decision was rational at the time but it created compounding tech debt: every new consumer pays the discovery cost, and the surface is degrading silently.

User explicitly reopened this on 2026-06-03 wanting to revisit the deferral.

## When to Surface

**Trigger:** next milestone (v0.12.0) — surface as a Phase 1 candidate the moment `/gsd:new-milestone` runs.

**Strong fit if the new milestone has any of:**
- External consumer DX / SDK / model picker work
- Router catalog / model registry refactor
- Open WebUI or n8n integration polish
- "Make local-llms usable from another project" framing
- Any retrieval / agent / pipeline phase that consumes models internally (would also benefit from the cleanup)

**Weak fit if** the new milestone is purely about a new model runtime (e.g., SGLang adoption) — in that case this seed is adjacent but not on-path.

## Scope Estimate

**Medium — likely a single phase with 4-5 plans, ~1 week.**

Tentative shape, subject to `/gsd:discuss-phase` decisions:

- **Wave 0 (hard bug)** — Remove or `disabled: true`-flag the 3 dead entries in `models.yaml`; Valkey `DEL` the registry cache; `docker compose up -d --force-recreate router`; verify via Phase 19 smoke gate + a new `/v1/models` health probe. Closes the ENOTFOUND class for external consumers immediately.
- **Wave 1 (contract design)** — Define the target taxonomy (`chat-local`, `chat-cloud-small`, `chat-cloud-large`, `embed-local`, `embed-cloud`, `vision-local`, `rerank-local`?), add per-model `recommended_for: [...]` + `health: ok|degraded|down` metadata to `/v1/models`. Possibly add startup health-probing so unreachable backends auto-filter.
- **Wave 2 (backward-compat alias layer)** — Keep `qwen2.5-7b-instruct-q4km` / `bge-m3-ollama` / `bge-m3-vllm` aliases for N weeks pointing to the new canonical names with deprecation warnings in logs. Gives n8n / artiscrapper / Unsloth a migration window.
- **Wave 3 (docs)** — Rewrite README's "Integración n8n" + DEPLOY's model section to "what models, when to pick which" decision tree. Migration guide for downstream projects.

Touches sensitive areas (`models.yaml`, smoke gates, cardinality CI guard, Open WebUI connection settings) but each wave is independently shippable and reversible.

## Gray Areas to Surface in `/gsd:discuss-phase`

- Remove dead `models.yaml` entries vs flag them `disabled: true`?
- Deprecate `qwen2.5-7b-instruct-q4km` immediately or with grace period?
- Naming taxonomy: purely semantic, semantic + dynamic resolution ("local-chat" always picks the current best), or status quo + dead entries removed?
- Add `recommended_for` / `health` metadata to `/v1/models` (router code change) or solve at docs level only (config change)?
- Startup health-probe + auto-filter unreachable aliases on `/v1/models`?
- The `chat-local` 15 s timeout reproduced on 2026-06-03 — likely cold-load of qwen2.5:7b's 4.7 GB on Ollama's first request, but worth confirming under controlled conditions before deciding if it's a second bug.

## Reproduced Facts (snapshot 2026-06-03, post-Phase 19-09)

**Backends declared in `models.yaml` vs running containers:**

| Backend | Container running? | Models pointing to it |
|---------|---|---|
| `ollama` | ✅ healthy | 7 (llama3.2:3b, llama3.2-vision, bge-m3-ollama, chat-local, vision-local, bge-reranker-local, embed-local) |
| `llamacpp` | ❌ does not exist | 1 (`qwen2.5-7b-instruct-q4km`) |
| `vllm` | ❌ does not exist | 1 (`qwen2.5-7b-instruct-awq`) |
| `vllm-embed` | ❌ does not exist | 1 (`bge-m3-vllm`) |
| `ollama-cloud` | ✅ | 3 (gpt-oss:120b-cloud, gpt-oss:20b-cloud, big-cloud) |

**Ollama disk inventory** (`docker exec local-llms-ollama ollama list`):
- `qwen2.5:7b-instruct-q4_K_M` (4.7 GB) — canonical local workhorse per `project_local_llm_choice`
- `llama3.2:3b-instruct-q4_K_M` (2.0 GB) — currently the only alias that responds in ms
- `llama3.2-vision:11b-instruct-q4_K_M` (7.8 GB)
- `bge-m3:latest` (1.2 GB)

**Live probe against http://127.0.0.1:3210, bearer from `.env`, `max_tokens=5`, 15 s budget:**

| Alias | Result | Cause |
|-------|--------|-------|
| `llama3.2:3b-instruct-q4_K_M` | ✅ ms response `"How can I assist you"` | Ollama hot |
| `chat-local` (→ qwen2.5:7b) | ⏱ timeout 15 s | likely cold-load of 4.7 GB; needs confirmation |
| `qwen2.5-7b-instruct-q4km` (→ llamacpp) | ⏱ timeout 15 s | ENOTFOUND llamacpp |
| `gpt-oss:20b-cloud` | ✅ responds (already verified by Plan 19-09) | cloud OK |

## Prior Decisions to Honor

- `project_local_llm_choice`: qwen2.5:7b is the local workhorse — alias surface must keep that available
- `project_vram_budget`: one 7B hot at a time; vllm/llamacpp dropped
- `project_models_yaml_hot_edit`: editing `models.yaml` requires Valkey `DEL` of registry cache + `up -d --force-recreate` of router (NOT `restart`)
- `project_n8n_integration`: n8n LangChain nodes consume the OpenAI Chat Model surface — renaming aliases breaks user-stored workflow nodes
- `project_unsloth_integration`: Unsloth Studio + n8n consume `localhost:3210/v1` — same renaming concern
- `project_cloudflare_tunnel`: `local-llms.luishelguera.dev` → localhost:3210 — n8n at objetiva.com.ar is a live consumer; rename = downtime
- `project_retrieval_agnostic_principle`: router exposes seams, never implements logic — applies here as "router exposes capability metadata, never decides what consumer should pick"

## Consumer Scope (Who Breaks If Names Change)

- Open WebUI (server-to-server, configurable)
- n8n workflows at `local-llms.luishelguera.dev` (objetiva.com.ar deployment) — stored configs reference specific alias strings
- artiscrapper (this session's complainant) — currently going through workaround Option B (parse JSON from text instead of strict `response_format`)
- Unsloth Studio — references `localhost:3210/v1` model picker
- Any future agent the user spins up

## Breadcrumbs

- `router/models.yaml` (353 lines; 13 models, 5 backends declared, 2 backends actually exist) — config of record
- `compose.yml` — services section: only `ollama`, `postgres`, `valkey`, `traefik`, `grafana`, `prometheus`, `openwebui`, `router`, `pg-backup`, `gpu-exporter` actually run; `llamacpp`, `vllm`, `vllm-embed` declared but never started
- `router/src/adapters/llamacpp/` — `LlamacppOpenAIAdapter.chatCompletionsCanonical` is the symbol surfaced in artiscrapper's err.stack
- `router/scripts/check-prometheus-cardinality.ts` — POL-06 guard (no `_id$` labels) — alias renames must preserve this
- `bin/smoke-test-router.sh` — Phase 19 RESS-WITH-TOOLS gate greps literal `gpt-oss:20b-cloud`; any rename of cloud aliases must update the smoke literal in lockstep (Plan 19-09 verified this is a "must hold" invariant)
- `.planning/phases/19-embeddingprovider-formalization-observability-hardening/19-09-PLAN.md` + SUMMARY — referenced for the Valkey-DEL + force-recreate pattern that any models.yaml edit needs
- Commit `aa4a9c6` (Plan 19-08 translator fix) and `7afbd96` (19-09 deploy) — current production state of the router

## Notes

- This seed was planted right after `/gsd:execute-phase 19 --gaps-only` shipped (commits `7afbd96`/`72b5154`/`20f9833`) and `/gsd:progress` recommended `/gsd:complete-milestone`.
- The user's flow choice: complete v0.11.0 → start v0.12.0 → this seed becomes Phase 1 candidate.
- Recommended entry point when surfaced: `/gsd:discuss-phase 1` (design conversation needed; not a single-shot fix).
- This seed deliberately does NOT prescribe the taxonomy — that's the discuss-phase's job.
