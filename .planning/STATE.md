---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: Phase 6 context gathered
last_updated: "2026-05-16T02:42:51.185Z"
progress:
  total_phases: 9
  completed_phases: 5
  total_plans: 31
  completed_plans: 27
  percent: 87
---

# Project State: local-llms

**Last Updated:** 2026-05-13
**Status:** Ready to execute

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 05 — postgres-observability-seam

## Current Position

Phase: 05 (postgres-observability-seam) — EXECUTING
Plan: 1 of 5

- **Milestone:** v1
- **Phase:** 6
- **Plan:** Not started
- **Status:** Awaiting `/gsd-discuss-phase 4` (recommended — Anthropic translation is the single hardest item in the project; research-flagged) or `/gsd-plan-phase --research-phase 4` to investigate canonical-shape translation, tool-call mapping, and vision routing before planning.

### Progress

```
Phase 1: ██████████ 100% (6/6 requirements) — Complete 2026-05-10
Phase 2: ██████████ 100% (9/9 requirements) — Complete 2026-05-12
Phase 3: ██████████ 100% (6/6 requirements) — Complete 2026-05-13
Phase 4: ░░░░░░░░░░ 0% (0/16 requirements)
Phase 5: ░░░░░░░░░░ 0% (0/8 requirements)
Phase 6: ░░░░░░░░░░ 0% (0/11 requirements)
Phase 7: ░░░░░░░░░░ 0% (0/7 requirements)
Phase 8: ░░░░░░░░░░ 0% (0/9 requirements)
Phase 9: ░░░░░░░░░░ 0% (0/4 requirements)

Overall: ███░░░░░░░ 28% (21/76 v1 requirements)
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

Last session: 2026-05-16T01:50:11.439Z
Stopped at: Phase 6 context gathered

**Next action:** Run `/gsd-discuss-phase 4` (recommended) to surface Anthropic-translation tradeoffs (canonical shape, tool-call round-trip, vision routing), or `/gsd-plan-phase --research-phase 4` to research-then-plan in one shot.

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-13 — Phase 3 complete (multi-backend dispatch + registry hardening; verification 6/6; REVIEW fixes WR-01/WR-03/CR-01)*
