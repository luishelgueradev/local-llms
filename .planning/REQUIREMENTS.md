# Requirements: local-llms v0.12.0 — External Consumer DX + Catalog Hygiene

**Defined:** 2026-06-03
**Source:** [SEED-001](./seeds/SEED-001-model-catalog-hygiene-consumer-dx.md) (planted 2026-06-03 after artiscrapper integration session exposed three distinct consumer-DX failures)

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Milestone goal:** Hacer que un proyecto externo que consume `local-llms` pueda — sin trial-and-error, sin saber qué backends están vivos, sin chocar con aliases muertos — descubrir programáticamente qué modelo pedirle al router para su use case y confiar en que esa elección funciona. Cerrar tres categorías de fricción que `artiscrapper` (2026-06-03) expuso: (1) catalog drift hacia backends que ya no corren, (2) naming chaos sin guía, (3) sin contrato programático de capacidades. Y formalizar la higiene de deploy para que el próximo bug "imagen stale vs source nuevo" (categoría 19-09) no recurra.

**Strategic frame (binding constraint on every REQ below):**
- *"Catalog says X, router serves X — siempre"* (no drift entre declaración y realidad)
- *"Consumer picks programmatically, not by reading docs"* (los metadatos del router son la fuente de verdad para el chooser)
- *"No breaking changes to live consumers without grace period"* (n8n en objetiva.com.ar, Unsloth Studio, artiscrapper son consumers reales — los renames van con backward-compat aliases y warnings de deprecación)
- *"Deploy hygiene = no source/binary skew"* (cada edit de models.yaml o router/src/ tiene un path documentado y atomic para llegar al container corriendo)

---

## Constraints (locked — derived from existing project memories)

- [project_vram_budget]: GPU 16GB WSL2, piso Windows ~5.7GB → usable ~10.6GB; un backend 7B caliente a la vez; vllm/llamacpp confirmados redundantes
- [project_local_llm_choice]: qwen2.5:7b es el workhorse local fijo — toda taxonomía debe mantenerlo accesible
- [project_models_yaml_hot_edit]: editar models.yaml requiere DEL de Valkey cache + `docker compose up -d --force-recreate router` (NO `restart`)
- [project_n8n_integration]: n8n LangChain nodes referencian alias strings en workflows persistidos — renames sin backward-compat rompen automation
- [project_unsloth_integration]: Unsloth Studio (host :8888) y n8n consumen `localhost:3210/v1` — mismo concern
- [project_cloudflare_tunnel]: producción remote en `https://local-llms.luishelguera.dev` → localhost:3210; consumer en `objetiva.com.ar` no puede tener downtime
- [project_retrieval_agnostic_principle]: router expone capability metadata; nunca decide por el consumer qué pickear (consumer es el que elige, router solo lo informa)
- [v0.11.0 invariants]: P7-01 (/v1/embeddings byte-identical), POL-06 (no `_id$` labels en /metrics), MCPS-06 (no StdioServerTransport) — se preservan

---

## Requirements

### Catalog Hygiene (CAT) — 4 requirements

| ID | Description | Status |
|----|-------------|--------|
| CAT-01 | `router/models.yaml` declared `backends:` map contains zero entries that don't correspond to a running compose service OR a documented `disabled: true` (audit-by-grep against `compose.yml` services + a startup probe). The 3 known dead backends (`llamacpp`, `vllm`, `vllm-embed`) are either removed or flagged `disabled: true` with explanatory comment. | ✅ Complete (Phase 20 / Plan 20-01 — 2026-06-03) |
| CAT-02 | `GET /v1/models` exposes a per-entry `health` or `available` boolean computed from a startup-time backend reachability probe. Consumers can filter unreachable aliases without trial-and-error. Field is additive — existing consumers that ignore it continue to work. | ✅ Complete (Phase 20 / Plan 20-02 — 2026-06-03) |
| CAT-03 | Naming taxonomy decision is documented in `DEPLOY.md` and `README.md`. EITHER (a) all aliases follow one convention (semantic only, e.g. `chat-local`/`chat-cloud-small`/`embed-local`), OR (b) the mix is explicitly documented as "two taxonomies coexisting on purpose for these reasons". Decision deferred to `/gsd:discuss-phase 20`. | Planned (Phase 20) |
| CAT-04 | Backward-compat alias layer: for every alias rename/removal, the old alias remains in `models.yaml` for ≥30 days pointing to the new canonical entry, emitting a deprecation log line (`router_deprecated_alias_used_total` counter) on each use. No breaking change to n8n / Unsloth / artiscrapper without this grace period. | ✅ Complete (Phase 20 / Plan 20-04 — 2026-06-03) |

### Consumer DX (CDX) — 3 requirements

| ID | Description | Status |
|----|-------------|--------|
| CDX-01 | `GET /v1/models` per-entry includes a `recommended_for: ["chat","json_mode","tools","tool_use","embeddings","rerank","vision"]` or equivalent capability/role metadata so external consumers can programmatically ask "which alias is the canonical local chat that supports json_mode strict?" without reading docs. Field is additive (existing consumers unaffected). | Planned (Phase 20) |
| CDX-02 | `README.md` and `DEPLOY.md` contain a "Which model when?" decision tree subsection: chat vs chat+tools vs chat+json strict vs embed vs rerank vs vision, each pointing to the recommended alias for both `local` and `cloud` profiles. Covers the artiscrapper case (chat + json_mode strict + local). | Planned (Phase 20) |
| CDX-03 | Migration guide for downstream consumers (`docs/CONSUMER-MIGRATION-v0.12.0.md` or similar) when any v0.11.0 alias changes: lists every alias rename, the old→new mapping, and the recommended n8n / Unsloth / Open WebUI / generic OpenAI-client update steps. Empty file is acceptable if no renames happened. | Planned (Phase 20) |

### Deploy Hygiene (OPS) — 2 requirements

| ID | Description | Status |
|----|-------------|--------|
| OPS-01 | A `just` (or `make`, or `bin/`) script wraps the canonical deploy path `docker compose build router && docker compose up -d --force-recreate router && bash bin/smoke-test-router.sh --phase 19` as a single atomic command. Documents Valkey `DEL` of registry cache as a sibling sub-command when only `models.yaml` changed. Eliminates the "edit but never rebuild" failure class that Plan 19-09 fixed once. | Planned (Phase 20) |
| OPS-02 | Pre-deploy or boot-time check compares `git rev-parse HEAD:router/src/translation/openai-out.ts` (or a `BUILD_SHA` env baked at image build) against a value the running container exposes via `/healthz` or `/version`. Surfaces source/image skew before traffic hits the stale binary. Catches the next class of "fix on disk, not in container" silently. | Planned (Phase 20) |

---

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| CAT-01 | Phase 20 / Plan 20-01 | ✅ Complete (2026-06-03) |
| CAT-02 | Phase 20 / Plan 20-02 | ✅ Complete (2026-06-03) |
| CAT-03 | Phase 20 | Planned |
| CAT-04 | Phase 20 / Plan 20-04 | ✅ Complete (2026-06-03) |
| CDX-01 | Phase 20 | Planned |
| CDX-02 | Phase 20 | Planned |
| CDX-03 | Phase 20 | Planned |
| OPS-01 | Phase 20 | Planned |
| OPS-02 | Phase 20 | Planned |

**Total:** 9 requirements across 1 phase (Phase 20). The phase may split into 20/21/22 during `/gsd:discuss-phase 20` if scope warrants — the requirement IDs stay stable across any phase split.

---

## Out of Scope (explicit non-goals)

- **No new model runtimes** (no SGLang, no TensorRT-LLM adoption). VRAM budget locked, Ollama-only profile per `project_vram_budget`.
- **No retrieval/RAG features** — per `project_retrieval_agnostic_principle`, router never implements retrieval logic. Catalog metadata is *information for consumers*, not *router-side decision-making*.
- **No multi-tenant policy changes** — POL-01..06 from v0.11.0 already cover the policy primitives needed; this milestone is consumer-facing UX, not policy redesign.
- **No protocol surface changes** — `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`, `/v1/rerank`, `/v1/models` wire shapes remain backward-compatible. Only additive fields.
- **No removal of `qwen2.5-7b-instruct-q4km` / `qwen2.5-7b-instruct-awq` / `bge-m3-vllm` aliases in the same release** that flips them to working — they get the `disabled: true` flag AND a backward-compat alias to a working ollama target IF the discuss-phase chooses option B (semantic rename), so consumers don't break.

---

## Dependencies

- ✅ All v0.11.0 milestone artifacts (49 plans, 48 reqs, 6 phases — see [milestones/v0.11.0-ROADMAP.md](./milestones/v0.11.0-ROADMAP.md))
- ✅ Live Phase 19 verification (smoke gates green, image rebuilt 2026-06-03 via Plan 19-09)
- ✅ SEED-001 captured with full diagnosis trail
- ✅ Deferred quick-task 260525-0hr (`Perfil "solo Ollama" optimizado + nombres de modelo por rol`, commit `c7b0e82`) — its work IS the substrate for Phase 20; that quick task established the precedent of semantic role aliases (`chat-local`, `embed-local`, `vision-local`, `big-cloud`) but never finished cleaning up the quant-encoded ones
