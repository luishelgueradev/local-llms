---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 8 Plan 05 (CLOUD-04 — cloud max_tokens hard-cap) COMPLETE — CLOUD_MAX_TOKENS_CAP=16384 constant + CloudMaxTokensExceededError class (D-C1 never silently clip; D-C2 single source of truth). Pre-adapter guard on /v1/chat/completions + /v1/messages fires AFTER req.resolvedBackend stamp (X-Model-Backend still ships on 400) and BEFORE breaker.check (no half-open probe consumption). OpenAI envelope: code='cloud_max_tokens_exceeded' / param='max_tokens'; Anthropic envelope: invalid_request_error. Embeddings route NOT gated (no max_tokens param). 4 commits: 645bffe+5921672+0b87d2b+eb9291f across 2 atomic TDD task pairs. 610/612 tests pass (+12 new). Build clean. Zero deviations. CLOUD-04 closes. Cloud-cost-protection layer 2/4 complete (breaker + cap); plans 08-06 (rate limit) + 08-07 (idempotency mux) remain."
last_updated: "2026-05-17T16:37:39Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 50
  completed_plans: 46
  percent: 92
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Executing Phase 08

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 08 — Ollama Cloud Fallback + Resilience Hardening

## Current Position

Phase: 08 (Ollama Cloud Fallback + Resilience Hardening) — EXECUTING
Plan: 7 of 11

- **Milestone:** v1
- **Phase:** 8
- **Plan:** 08-05 (Wave 2, CLOUD-04 — cloud max_tokens hard-cap) — COMPLETE. router/src/config/constants.ts exports `CLOUD_MAX_TOKENS_CAP = 16_384` (D-C2). router/src/errors/envelope.ts adds CloudMaxTokensExceededError class with 3 envelope mappings (status 400; OpenAI envelope code='cloud_max_tokens_exceeded' / param='max_tokens'; Anthropic envelope invalid_request_error). recordOutcome.ts mapErrorToCode → 'invalid_request' D-D2 bucket. Pre-adapter guard on chat-completions.ts + messages.ts fires AFTER req.resolvedBackend stamp (Plan 08-03 X-Model-Backend still ships on 400) and BEFORE breaker.check (Plan 08-04 — oversized requests never consume half-open probe slots). Embeddings route NOT gated (no max_tokens param). 4 commits: 645bffe+5921672+0b87d2b+eb9291f across 2 atomic TDD task pairs (RED unit/GREEN core + RED integration/GREEN routes). 610/612 tests pass (+12 new). Build clean. Zero deviations. CLOUD-04 closes.
- **Next plan:** 08-06 (Wave 2, per-backend rate limit — reuses Plan 08-04 patterns: no-op fallback, fire-and-forget signal, Valkey decorator). Then 08-07 (idempotency mux), 08-08, 08-09, 08-10.
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
Phase 8: ████████░░ 78% (8/9 requirements — CLOUD-01 precondition closed via Plan 08-00; DATA-06 foundation closed via Plan 08-01; CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice closed via Plan 08-02; ROUTE-10 closed via Plan 08-03; CLOUD-03 closed via Plan 08-04; CLOUD-04 closed via Plan 08-05)
Phase 9: ░░░░░░░░░░ 0% (0/4 requirements)

Overall: ███░░░░░░░ 32% (24/76 v1 requirements)
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

Last session: 2026-05-17T16:37:39Z
Stopped at: Phase 8 Plan 05 (CLOUD-04 — cloud max_tokens hard-cap) COMPLETE — CLOUD_MAX_TOKENS_CAP=16384 constant (D-C2 single source of truth, not env-configurable in v1) + CloudMaxTokensExceededError class with 3 envelope mappings (400 + cloud_max_tokens_exceeded on OpenAI / invalid_request_error on Anthropic). Pre-adapter guard on chat-completions + messages routes fires AFTER req.resolvedBackend stamp (X-Model-Backend still ships on 400 — Plan 08-03 onSend) and BEFORE breaker.check (Plan 08-04 — oversized requests don't consume probe slots). Embeddings route NOT gated. 4 commits: 645bffe+5921672+0b87d2b+eb9291f across 2 atomic TDD task pairs. 610/612 tests pass (+12 new). Build clean. Zero deviations. CLOUD-04 closes. Cloud-cost-protection layer 2/4 complete (breaker + cap); 08-06 (rate limit) + 08-07 (idempotency mux) remain.

**Next action:** Operator runs the recipe in 07-06-SUMMARY.md §User Setup Required: `docker compose --profile vllm up -d` → wait for vllm healthy → `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` → visual Grafana check → reply `approved` (or list failing assertions for re-execution).

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
