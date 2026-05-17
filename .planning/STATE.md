---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 7 Plan 06 (live smoke scripts) tasks 1-2 auto-complete (commits c9a3369 + 61ded93): bin/smoke-test-observability.sh covers OBS-02/03/04 (Prometheus targets, nvidia_smi_memory_used_bytes sample, Grafana datasource uid=prometheus-default + dashboard uid=local-llms with ≥6 panels); bin/smoke-test-router.sh extended with `=== Phase 7 — /v1/embeddings + request_log ===` section covering bge-m3-ollama 1024-dim, capability gate (qwen on /v1/embeddings → 400), zod empty-input gate (→ 400), bge-m3-vllm 1024-dim (gated on --profile vllm), request_log distinct backend rows. Task 3 PENDING-HUMAN — operator must bring up stack with `--profile vllm`, run both smoke scripts, visually verify Grafana dashboard, then approve. Recipe in 07-06-SUMMARY.md §User Setup Required."
last_updated: "2026-05-17T04:07:56.283Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 39
  completed_plans: 39
  percent: 100
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Phase 7 plans all coded; Plan 07-06 task 3 awaits operator human-verify

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 07 — Embeddings + vLLM + GPU Telemetry

## Current Position

Phase: 07 (Embeddings + vLLM + GPU Telemetry) — EXECUTING (final plan in human-verify)
Plan: 7 of 7 — 07-00..07-05 complete; 07-06 tasks 1-2 auto-complete, task 3 PENDING-HUMAN

- **Milestone:** v1
- **Phase:** 7
- **Plan:** 07-06 (final smoke + human-verify) — awaiting operator approval
- **Status:** All Phase 7 code is in tree. Operator must bring up `docker compose --profile vllm up -d` on the RTX 5060 Ti host, run `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh`, visually verify Grafana dashboard renders live data, then approve. Recipe in 07-06-SUMMARY.md §User Setup Required.

### Progress

```
Phase 1: ██████████ 100% (6/6 requirements) — Complete 2026-05-10
Phase 2: ██████████ 100% (9/9 requirements) — Complete 2026-05-12
Phase 3: ██████████ 100% (6/6 requirements) — Complete 2026-05-13
Phase 4: ░░░░░░░░░░ 0% (0/16 requirements)
Phase 5: ░░░░░░░░░░ 0% (0/8 requirements)
Phase 6: ░░░░░░░░░░ 0% (0/11 requirements)
Phase 7: █████████░ 86% (6/7 requirements coded; smoke scripts in tree; OBS-05 already complete from Phase 5; awaiting operator human-verify on 07-06 task 3)
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

Last session: 2026-05-17T04:06:22Z
Stopped at: Phase 7 Plan 06 (live smoke scripts) tasks 1-2 auto-complete. Commits c9a3369 (feat: bin/smoke-test-observability.sh — OBS-02/03/04 smoke with Prometheus targets, nvidia_smi_memory_used_bytes sample, Grafana datasource + dashboard provisioning checks) + 61ded93 (feat: extend bin/smoke-test-router.sh with `=== Phase 7 — /v1/embeddings + request_log ===` section covering bge-m3-ollama 1024-dim, capability gate, zod empty-input gate, bge-m3-vllm 1024-dim, request_log distinct backend rows). Task 3 PENDING-HUMAN — operator must approve on the RTX 5060 Ti host. No deviations: tasks 1-2 executed exactly as planned.

**Next action:** Operator runs the recipe in 07-06-SUMMARY.md §User Setup Required: `docker compose --profile vllm up -d` → wait for vllm healthy → `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` → visual Grafana check → reply `approved` (or list failing assertions for re-execution).

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
