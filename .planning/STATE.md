---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 8 Plan 02 (CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice) COMPLETE — OllamaCloudAdapter targets https://ollama.com/v1 with bearer OLLAMA_API_KEY; LocalBackendEnum widened with 'ollama-cloud'; vram_budget_gb relaxed to .nonnegative(); env.ts adds optional OLLAMA_API_KEY field cross-checked at boot via assertCloudEnvIfConfigured; factory split into LOCAL_ADAPTERS + CLOUD_ADAPTERS with MakeAdapterDeps.cloudApiKey thread; app.ts pre-binds a makeAdapterWithCloudKey closure at all 4 call sites; models.yaml gains gpt-oss:120b-cloud + gpt-oss:20b-cloud entries. Commits: 720fff7 (Task 1 — registry/env/boot helper) + ab42b5c (Task 2 — adapter + factory) + 3cf3c27 (Task 3 — app.ts closure + models.yaml). 556/558 tests pass (2 skipped, +24 new tests). Build clean. 2 deviations auto-fixed (Rule 3: stale Phase-3 test asserting cloud rejection + Rule 3: isMainModule gate so vitest can import index.ts without triggering process.exit). CLOUD-01 + CLOUD-02 + EMBED-02 closed; resilience layers (08-03..08-10) layer on top."
last_updated: "2026-05-17T15:56:10Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 50
  completed_plans: 42
  percent: 84
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Executing Phase 08

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 08 — Ollama Cloud Fallback + Resilience Hardening

## Current Position

Phase: 08 (Ollama Cloud Fallback + Resilience Hardening) — EXECUTING
Plan: 4 of 11

- **Milestone:** v1
- **Phase:** 8
- **Plan:** 08-02 (Wave 1, CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice) — COMPLETE. OllamaCloudAdapter (bearer OLLAMA_API_KEY targeting https://ollama.com/v1) implements all 4 BackendAdapter methods including embeddings (closes EMBED-02 deferred from Phase 7); registry widened to accept `backend: ollama-cloud` with vram_budget_gb=0; env.ts adds optional OLLAMA_API_KEY field cross-checked at boot; factory split into LOCAL_ADAPTERS + CLOUD_ADAPTERS with MakeAdapterDeps.cloudApiKey thread; app.ts pre-binds the key in a makeAdapterWithCloudKey closure; models.yaml gains gpt-oss:120b-cloud + gpt-oss:20b-cloud. Commits: 720fff7 + ab42b5c + 3cf3c27. 556/558 tests pass; build clean.
- **Next plan:** 08-03 (Wave 2 — X-Model-Backend onSend hook; reads `entry.backend === 'ollama-cloud'` to set the response header). 08-04 follows with the circuit breaker around adapter calls. The "killer feature" curl is structurally complete after 08-02 — Waves 2+ add resilience.
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
Phase 8: ████░░░░░░ 44% (5/9 requirements — CLOUD-01 precondition closed via Plan 08-00; DATA-06 foundation closed via Plan 08-01; CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice closed via Plan 08-02)
Phase 9: ░░░░░░░░░░ 0% (0/4 requirements)

Overall: ███░░░░░░░ 29% (22/76 v1 requirements)
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

Last session: 2026-05-17T15:56:10Z
Stopped at: Phase 8 Plan 02 (CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice) COMPLETE — OllamaCloudAdapter targets https://ollama.com/v1 with bearer OLLAMA_API_KEY; registry widened (LocalBackendEnum + .nonnegative()); env.ts adds optional OLLAMA_API_KEY cross-checked at boot via assertCloudEnvIfConfigured; factory split into LOCAL_ADAPTERS + CLOUD_ADAPTERS with MakeAdapterDeps.cloudApiKey; app.ts pre-binds the key in makeAdapterWithCloudKey closure; models.yaml gains gpt-oss:120b-cloud + gpt-oss:20b-cloud. Commits: 720fff7 + ab42b5c + 3cf3c27. 556/558 tests pass (2 skipped, +24 new). Build clean. 2 deviations auto-fixed (Rule 3: stale Phase-3 ollama-cloud rejection test flipped; Rule 3: isMainModule gate around index.ts main() so vitest can import the assertCloudEnvIfConfigured helper without triggering process.exit). CLOUD-01 + CLOUD-02 + EMBED-02 closed.

**Next action:** Operator runs the recipe in 07-06-SUMMARY.md §User Setup Required: `docker compose --profile vllm up -d` → wait for vllm healthy → `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` → visual Grafana check → reply `approved` (or list failing assertions for re-execution).

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
