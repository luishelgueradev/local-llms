---
gsd_state_version: 1.0
milestone: v0.11.0
milestone_name: Retrieval-Ready Infrastructure
status: roadmap_ready
last_updated: "2026-05-29"
last_activity: 2026-05-29
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State: local-llms

**Last Updated:** 2026-05-29 — v0.11.0 roadmap created. 6 phases (14–19) / 48 requirements mapped. Ready for `/gsd:plan-phase 14`.
**Status:** v0.11.0 roadmap finalized · Phase 14 next

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Strategic frame (binding):** "Retrieval Interfaces, not Retrieval Logic" · "Memory Abstraction Layer, not Memory implementation" · local-llms = infraestructura; RAG/KB = consumidor downstream.

**Current Focus:** v0.11.0 Retrieval-Ready Infrastructure — roadmap complete, planning Phase 14.

## Current Position

Phase: 14 (next to plan)
Plan: —
Status: Roadmap finalized, awaiting phase planning
Last activity: 2026-05-29 — Roadmap created

### Progress

```
Milestone v0.11.0: ░░░░░░░░░░  0% — in planning
  Phase 14: ░░░░░░░░░░ Policy Primitives + Tenant/Project ID Foundation (POL-01..06)
  Phase 15: ░░░░░░░░░░ MCP Host (MCPS-01..06)
  Phase 16: ░░░░░░░░░░ /v1/responses Streaming + Tool Calls (RESS-01..05)
  Phase 17: ░░░░░░░░░░ SessionStore + ContextProvider + SummaryProvider (SESS-01..06 + CTXP-01..04 + SUMP-01..03)
  Phase 18: ░░░░░░░░░░ MCP Client + RetrieverProvider + Pre-Completion Hook (MCPC-01..06 + RETR-01..06)
  Phase 19: ░░░░░░░░░░ EmbeddingProvider Formalization + Observability Hardening (EMBP-01..02 + OBSV-01..04)

Overall v0.11.0:  ░░░░░░░░░░  0/48 requirements

Milestone v0.10.0: ██████████ 100% — SHIPPED 2026-05-29 (archived)
Milestone v0.9.0:  ██████████ 100% — SHIPPED 2026-05-28 (archived)
```

## Key Design Decisions (v0.11.0)

| Decision | Rationale |
|----------|-----------|
| Phase 14 first (policy/tenant IDs before MCP) | Zero-dep additive; tenant_id/project_id must be in request_log before any new surface generates rows — no retrofit pass needed |
| Phase 15 before Phase 18 (MCP host before MCP client) | Shared `@modelcontextprotocol/sdk` package; host establishes raw `req.raw`/`reply.raw` integration pattern before client uses a different SDK surface |
| Phase 16 before Phase 17 (responses streaming before sessions) | Responses route must be in final form before session injection is wired into it |
| Phase 17 before Phase 18 (sessions before retriever hook) | Pre-completion hook operates on post-context-window canonical; without ContextProvider, injection may push messages over model budget |
| Phase 17 kept whole (not split 17a/17b) | SESS→CTXP→SUMP all wire into the same route integration point simultaneously; splitting leaves routes half-integrated and doubles integration overhead |
| MCP transport: Streamable HTTP only, no stdio | n8n production compatibility (n8n issue #24967: 95M retry storm from transport mismatch) |
| Raw `req.raw`/`reply.raw` MCP integration | No `@modelcontextprotocol/fastify` community alpha plugin; 3 lines, HIGH confidence, zero unverified dependency |
| `{server_alias}__{tool_name}` namespace prefix | MCP spec does not define collision semantics; explicit prefix is the only safe approach across multiple servers |
| `on_timeout` required field on hook interface | No default fail mode; implicit fail-open for authorization hooks is a security risk that cannot be deferred |
| Prometheus labels: NEVER include `_id` suffix | Cardinality math: 50 agents × 10 tenants × 5 projects × existing 800 base series = 2M+ series, hitting Prometheus defaults |

## Architectural Frame Violations (reject immediately)

- Frame-01: No retrieval logic in the router (default RetrieverProvider = noop, test-only)
- Frame-02: No in-process retriever even in tests (use msw fixture server)
- Frame-03: No model-based default SummaryProvider (noop returns empty string)
- Frame-04: No content classifier for sensitive routing (explicit X-Workload-Class header only)
- Frame-05: No pgvector or vectors table in router's Postgres migrations
- Frame-06: No tenant ID derived from bearer token hash (explicit X-Tenant-ID header)

## Accumulated Context

### Active Decisions
- Migration numbering: Phase 14 gets next sequential number after 0004 (existing) — must read `_journal.json` as first task of Phase 14 plan
- MCP session GC: 30-min interval + SIGTERM handler 5s timeout + Fastify `onClose` hook
- SessionStore writes: SYNC + 1s timeout + fail-open (different from async-buffered request_log)
- Token counting: `chars / 3` conservative heuristic + 20% ctx_size safety margin (no model-specific tokenizer)
- MCP tools/list cache key: `mcp:tools:{server_alias}` consistent with existing `model-registry:*` pattern

### Deferred (carries forward from v0.10.0)
- Phase 7 Plan 07-06 Task 3 — vLLM cold-start UAT on RTX 5060 Ti (user decision: Ollama-only profile)
- RERANK-06 dedicated live smoke — deferred (model needs to be pulled first)

### Active Todos
- `/gsd:plan-phase 14` — Phase 14 planning next
