# Roadmap: local-llms

**Coverage:** 76/76 v1 requirements shipped in v0.9.0 · 26/26 v0.10.0 requirements shipped · 48/48 v0.11.0 requirements shipped · 13/13 v0.12.0 requirements shipped
**Status:** Between milestones — v0.12.0 "External Consumer DX + Catalog Hygiene" archived 2026-06-03. Run `/gsd:new-milestone` to scope the next milestone.

## Milestones

- ✅ **v0.9.0 MVP** — Router multi-backend con cloud fallback + observability + ops · Phases 1-9 · shipped 2026-05-28 · 9 phases, 55 plans, 112 tasks · [archive](./milestones/v0.9.0-ROADMAP.md) · [requirements](./milestones/v0.9.0-REQUIREMENTS.md) · [audit](./milestones/v0.9.0-MILESTONE-AUDIT.md)
- ✅ **v0.10.0 Cognitive Primitives** — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API · Phases 10-13 · shipped 2026-05-29 · 4 phases (freeform single-shot pattern), 26 requirements · [archive](./milestones/v0.10.0-ROADMAP.md) · [requirements](./milestones/v0.10.0-REQUIREMENTS.md) · [audit](./milestones/v0.10.0-MILESTONE-AUDIT.md)
- ✅ **v0.11.0 Retrieval-Ready Infrastructure** — MCP-as-server/client · `/v1/responses` streaming + tools · SessionStore/ContextProvider/SummaryProvider · RetrieverProvider + pre-completion hook · EmbeddingProvider interface · Policy primitives · Phases 14-19 · shipped 2026-06-03 · 6 phases, 49 plans, 48 requirements · [archive](./milestones/v0.11.0-ROADMAP.md) · [requirements](./milestones/v0.11.0-REQUIREMENTS.md) · [audit](./milestones/v0.11.0-MILESTONE-AUDIT.md)
- ✅ **v0.12.0 External Consumer DX + Catalog Hygiene** — Dead-catalog cleanup · Health-aware `/v1/models` · Naming taxonomy decision · Backward-compat alias layer · "Which model when?" docs · Deploy hygiene + source/binary skew check · Post-ship hygiene closure (cold-load timeout + SSE retry-preamble fix) · Phases 20-21 · shipped 2026-06-03 · 2 phases, 9 plans, 13 requirements · scope from [SEED-001](./seeds/SEED-001-model-catalog-hygiene-consumer-dx.md) · [archive](./milestones/v0.12.0-ROADMAP.md) · [requirements](./milestones/v0.12.0-REQUIREMENTS.md) · [audit](./milestones/v0.12.0-MILESTONE-AUDIT.md)

## Phases

<details>
<summary>✅ v0.12.0 External Consumer DX + Catalog Hygiene (Phases 20-21) — SHIPPED 2026-06-03</summary>

- [x] **Phase 20: Model Catalog Hygiene + External Consumer DX + Deploy Hygiene** ✅ 2026-06-03 — 7/7 plans, 9/9 reqs (CAT-01..04 + CDX-01..03 + OPS-01..02). Closed the three categories of consumer fricion that `artiscrapper` exposed on 2026-06-03 (catalog drift to dead backends, naming chaos, no programmatic capability contract) AND formalized deploy hygiene so the next 19-09-class skew bug doesn't recur. Verifier PASS 12/12 success criteria.
- [x] **Phase 21: v0.12.0 Post-ship Hygiene** ✅ 2026-06-03 — 2/2 plans, 4/4 reqs (HYG-01..04). Gap-closure phase that closed the 4 findings from the post-Phase-20 unattended audit before v0.12.0 archive. 4/4 verification gates GREEN; all 4 v0.11.0-era invariants byte-for-byte intact. Companion SSE-retry-preamble hot-fix (commit `e113192`, HYG-05 candidate) lands on the same chain — unblocked every strict-JSON streaming SDK consumer (openai-python, Hermes Agent, n8n LangChain).

</details>

<details>
<summary>✅ v0.11.0 Retrieval-Ready Infrastructure (Phases 14-19) — SHIPPED 2026-06-03</summary>

- [x] **Phase 14: Policy Primitives + Tenant/Project ID Foundation** ✅ 2026-05-30
- [x] **Phase 15: MCP Host (Router as MCP Server)** ✅ 2026-05-31
- [x] **Phase 16: `/v1/responses` Streaming + Tool Calls** ✅ 2026-05-31
- [x] **Phase 17: SessionStore + ContextProvider + SummaryProvider** ✅ 2026-06-01
- [x] **Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook** ✅ 2026-06-01
- [x] **Phase 19: EmbeddingProvider Formalization + Observability Hardening** ✅ 2026-06-02 (post-ship Plan 19-09 ✅ 2026-06-03)

</details>

<details>
<summary>✅ v0.10.0 Cognitive Primitives (Phases 10-13) — SHIPPED 2026-05-29</summary>

- [x] **Phase 10: Structured Outputs / JSON Mode** ✅ 2026-05-29
- [x] **Phase 11: Reranker (`POST /v1/rerank`)** ✅ 2026-05-29
- [x] **Phase 12: Embeddings Hardening** ✅ 2026-05-29
- [x] **Phase 13: Cost Observability + `/v1/responses`** ✅ 2026-05-29

</details>

<details>
<summary>✅ v0.9.0 MVP (Phases 1-9) — SHIPPED 2026-05-28</summary>

- [x] **Phase 1: GPU + Compose Foundation** ✅ 2026-05-10
- [x] **Phase 2: MVP Vertical Slice — Router + Ollama + SSE** ✅ 2026-05-12
- [x] **Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening** ✅ 2026-05-13
- [x] **Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision** ✅ 2026-05-14
- [x] **Phase 5: Postgres + Observability Seam** ✅ 2026-05-15
- [x] **Phase 6: Open WebUI + Traefik Edge** ✅ 2026-05-15
- [x] **Phase 7: Embeddings + vLLM + GPU Telemetry** ✅ 2026-05-17
- [x] **Phase 8: Ollama Cloud Fallback + Resilience Hardening** ✅ 2026-05-27
- [x] **Phase 9: Operations Hardening** ✅ 2026-05-17

</details>

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-9. v0.9.0 MVP | v0.9.0 | 55/55 | Complete | 2026-05-28 |
| 10-13. Cognitive Primitives | v0.10.0 | freeform | Complete | 2026-05-29 |
| 14. Policy Primitives + Tenant ID Foundation | v0.11.0 | 9/9 | Complete | 2026-05-30 |
| 15. MCP Host (Router as MCP Server) | v0.11.0 | 12/12 | Complete | 2026-05-31 |
| 16. /v1/responses Streaming + Tool Calls | v0.11.0 | 4/4 | Complete | 2026-05-31 |
| 17. SessionStore + ContextProvider + SummaryProvider | v0.11.0 | 7/7 | Complete | 2026-06-01 |
| 18. MCP Client + RetrieverProvider + Pre-Completion Hook | v0.11.0 | 8/8 | Complete | 2026-06-01 |
| 19. EmbeddingProvider Formalization + Observability Hardening | v0.11.0 | 9/9 | Complete | 2026-06-03 |
| 20. Model Catalog Hygiene + External Consumer DX + Deploy Hygiene | v0.12.0 | 7/7 | Complete | 2026-06-03 |
| 21. v0.12.0 Post-ship Hygiene | v0.12.0 | 2/2 | Complete | 2026-06-03 |

---

*Phase-level details (success criteria, requirements, plan breakdowns) preserved per milestone:*

- v0.9.0 — [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md)
- v0.10.0 — [`milestones/v0.10.0-ROADMAP.md`](./milestones/v0.10.0-ROADMAP.md)
- v0.11.0 — [`milestones/v0.11.0-ROADMAP.md`](./milestones/v0.11.0-ROADMAP.md)
- v0.12.0 — [`milestones/v0.12.0-ROADMAP.md`](./milestones/v0.12.0-ROADMAP.md)

*Requirements traceability per milestone:*

- v0.9.0 — [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md)
- v0.10.0 — [`milestones/v0.10.0-REQUIREMENTS.md`](./milestones/v0.10.0-REQUIREMENTS.md)
- v0.11.0 — [`milestones/v0.11.0-REQUIREMENTS.md`](./milestones/v0.11.0-REQUIREMENTS.md)
- v0.12.0 — [`milestones/v0.12.0-REQUIREMENTS.md`](./milestones/v0.12.0-REQUIREMENTS.md)

*Milestone audit reports:*

- v0.9.0 — [`milestones/v0.9.0-MILESTONE-AUDIT.md`](./milestones/v0.9.0-MILESTONE-AUDIT.md)
- v0.10.0 — [`milestones/v0.10.0-MILESTONE-AUDIT.md`](./milestones/v0.10.0-MILESTONE-AUDIT.md)
- v0.11.0 — [`milestones/v0.11.0-MILESTONE-AUDIT.md`](./milestones/v0.11.0-MILESTONE-AUDIT.md)
- v0.12.0 — [`milestones/v0.12.0-MILESTONE-AUDIT.md`](./milestones/v0.12.0-MILESTONE-AUDIT.md)
