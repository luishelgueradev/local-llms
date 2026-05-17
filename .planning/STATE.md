---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 8 Plan 04 (CLOUD-03 — per-backend circuit breaker) COMPLETE — router/src/resilience/circuitBreaker.ts implements makeCircuitBreaker + isBreakerTrip with Valkey-backed state (closed/open/half-open) per backend (D-B4). 5 failures in 30s → opens for 60s; half-open probe success closes / failure re-opens (D-B3). BreakerOpenError → 503 + structured envelope (OpenAI: api_error/backend_circuit_open; Anthropic: overloaded_error) + Retry-After header. 3 routes (chat-completions, messages, embeddings) call breaker.check after capability gate, before semaphore acquire; recordSuccess/Failure fire-and-forget around adapter calls. Per-backend isolation verified end-to-end: cloud breaker open leaves local Ollama serving. 6 commits: d2154d6+4365116+bf3185e+6bd6f08+48d4747+0f142b2 across 3 atomic TDD task pairs. 598/600 tests pass (+25 new). Build clean. 1 auto-fixed deviation (Rule 1 — state/probe_at TTL was cooldown*1 in spec, must be cooldown*2 to survive probe transition; fix landed during Task 2 GREEN with module-header documentation). CLOUD-03 closes."
last_updated: "2026-05-17T16:24:00Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 50
  completed_plans: 45
  percent: 90
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Executing Phase 08

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 08 — Ollama Cloud Fallback + Resilience Hardening

## Current Position

Phase: 08 (Ollama Cloud Fallback + Resilience Hardening) — EXECUTING
Plan: 6 of 11

- **Milestone:** v1
- **Phase:** 8
- **Plan:** 08-04 (Wave 2, CLOUD-03 — per-backend circuit breaker) — COMPLETE. router/src/resilience/circuitBreaker.ts implements makeCircuitBreaker + isBreakerTrip classifier with Valkey-backed state (closed/open/half-open) per backend (D-B4). 5 failures in 30s opens breaker for 60s (D-B2); half-open probe success closes / failure re-opens (D-B3). BreakerOpenError → 503 + structured envelope + Retry-After header. 3 routes (chat-completions, messages, embeddings) call breaker.check after capability gate, before semaphore acquire; recordSuccess/Failure fire-and-forget around adapter calls. Per-backend isolation verified: cloud breaker open leaves local Ollama serving. Commits: d2154d6+4365116+bf3185e+6bd6f08+48d4747+0f142b2 (6 commits, 3 atomic TDD task pairs). 598/600 tests pass (+25 new). Build clean. 1 auto-fixed deviation (Rule 1 — TTL doubling for state/probe_at keys; documented in module header). CLOUD-03 closes.
- **Next plan:** 08-05 (Wave 2 or later — max_tokens guardrails, independent feature). Per-backend rate limit (08-06) and idempotency mux (08-07) will reuse Plan 08-04's patterns (no-op fallback, fire-and-forget signal, Valkey decorator).
- **Phase 7 carry-over:** Plan 07-06 task 3 still PENDING-HUMAN (operator approval on RTX 5060 Ti host). Recipe in 07-06-SUMMARY.md §User Setup Required.

### Progress

```
Phase 1: ██████████ 100% (6/6 requirements) — Complete 2026-05-10
Phase 2: ██████████ 100% (9/9 requirements) — Complete 2026-05-12
Phase 3: ██████████ 100% (6/6 requirements) — Complete 2026-05-13
Phase 4: ░░░░░░░░░░ 0% (0/16 requirements)
Phase 5: ░░░░░░░░░░ 0% (0/8 requirements)
Phase 6: ░░░░░░░░░░ 0% (0/11 requirements)
Phase 7: █████████░ 86% (6/7 requirements coded; smoke scripts in tree; OBS-05 already complete from Phase 5; awaiting operator human-verify on 07-06 task 3)
Phase 8: ███████░░░ 67% (7/9 requirements — CLOUD-01 precondition closed via Plan 08-00; DATA-06 foundation closed via Plan 08-01; CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice closed via Plan 08-02; ROUTE-10 closed via Plan 08-03; CLOUD-03 closed via Plan 08-04)
Phase 9: ░░░░░░░░░░ 0% (0/4 requirements)

Overall: ███░░░░░░░ 30% (23/76 v1 requirements)
```

## Performance Metrics

- **Phases planned:** 9
- **Phases completed:** 0
- **Requirements mapped:** 76/76 (100% coverage)
- **Research artifacts:** PROJECT.md, REQUIREMENTS.md, research/SUMMARY.md, research/STACK.md, research/FEATURES.md, research/ARCHITECTURE.md, research/PITFALLS.md
- **Research-flagged phases:** 4 (Anthropic translation), 6 (Traefik + Open WebUI), 7 (vLLM + embeddings), 8 (Ollama Cloud + resilience)

## Accumulated Context

### Key Decisions (carried from PROJECT.md)

- **Router stack:** Node 22 LTS + Fastify v5 + TypeScript + pino + zod + `fastify-sse-v2` + `@bram-dc/fastify-type-provider-zod`. `node:22-bookworm-slim` (not alpine).
- **Backends:** `ollama/ollama:0.5.7` (catalog), `ghcr.io/ggml-org/llama.cpp:server-cuda` pinned to a build tag (GGUF), `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` (HF AWQ); Ollama Cloud as a declared `backend: ollama-cloud` entry, not a magic spillover.
- **GPU reservation:** `deploy.resources.reservations.devices` (modern form), via `x-gpu` YAML anchor reused by every backend service. Never `runtime: nvidia`.
- **Storage:** two volumes — `models-gguf/` (Ollama + llama.cpp can read the same `.gguf` via symlink for dedup) and `models-hf/` (HuggingFace snapshot dir for vLLM). Never one shared `/models` tree.
- **Networks:** four — `edge`, `app`, `backend: internal: true`, `data: internal: true`. Router is the only service on all four.
- **Auth:** single bearer token from `.env`, constant-time compare. No multi-key, no OAuth, no spend caps.
- **Streaming:** SSE obligatorio; pino redaction, abort propagation, and 15s heartbeat baked in from Phase 2.
- **Anthropic translation:** normalize internally to canonical Anthropic-shape (strict superset of OpenAI). Translate inbound + outbound separately. Round-trip golden tests.
- **VRAM partitioning:** static, encoded in `models.yaml`. Default policy: one backend hot at a time via Compose `profiles:`. vLLM always with explicit `--max-model-len` and `--gpu-memory-utilization 0.45`.

### Standing Anti-Patterns to Reject (carried from research)

- `:latest` Docker tags on any inference runtime.
- `node:22-alpine` for the router.
- `runtime: nvidia` (legacy form) anywhere in Compose.
- Linux NVIDIA driver installed inside the WSL distro.
- `compress` middleware on `/v1/chat/completions` or `/v1/messages`.
- `redis:latest`; use `valkey/valkey:8-alpine` instead.
- `traefik:v2.x`.
- Single shared `/models` volume across all three runtimes.
- Open WebUI bypass connections (OWUI → backend directly).
- `WEBUI_AUTH=True` "just for testing first" — first boot is permanent.
- Public-internet exposure of the router (Tailscale recommended for remote).

### Active Todos

(empty — no plans exist yet)

### Blockers

(none)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260510-v8z | Phase 01 script cleanup — non-blocking warnings + info items from 01-REVIEW.md | 2026-05-10 | 20d57d2 | [260510-v8z-phase-01-script-cleanup-non-blocking-war](./quick/260510-v8z-phase-01-script-cleanup-non-blocking-war/) |

## Session Continuity

Last session: 2026-05-17T16:24:00Z
Stopped at: Phase 8 Plan 04 (CLOUD-03 — per-backend circuit breaker) COMPLETE — Valkey-backed state machine + isBreakerTrip classifier (5xx + APIConnectionError/Timeout + Node DNS/conn errors trip; 4xx + Zod + abort + generic don't). 3 routes wired with breaker.check pre-adapter + recordSuccess/Failure fire-and-forget around adapter calls. Per-backend isolation (D-B4) verified end-to-end. Commits: d2154d6+4365116+bf3185e+6bd6f08+48d4747+0f142b2 (6 commits, 3 atomic TDD task pairs). 598/600 tests pass (+25 new). Build clean. 1 auto-fixed deviation (Rule 1 — TTL doubling for state/probe_at keys). CLOUD-03 closes; resilience layer ready for Plans 08-06 (rate limit) + 08-07 (idempotency mux).

**Next action:** Operator runs the recipe in 07-06-SUMMARY.md §User Setup Required: `docker compose --profile vllm up -d` → wait for vllm healthy → `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` → visual Grafana check → reply `approved` (or list failing assertions for re-execution).

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
