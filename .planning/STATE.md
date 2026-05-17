---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 8 Plan 06 (ROUTE-11 — per-bearer rate limit) COMPLETE — RateLimitExceededError class + ROUTER_RATE_LIMIT_RPM env (default 600, min 1) + bearerHash (SHA-256 truncated 8 hex, D-D2 mitigation) + makeRateLimitPreHandler factory with Valkey INCR+EXPIRE 65s on `ratelimit:{hash}:{minute}` + 429 wire envelope (rate_limit_error / rate_limit_exceeded / Retry-After: 60) + fail-open on Valkey errors + public-path bypass + onRequest hook AFTER bearer + BEFORE agentId. rateLimitNow injection seam added to BuildAppOpts (parallel to breakerNow) — Rule 3 fix because vi.useFakeTimers hangs Fastify's app.inject. 6 commits: 91faa8b+f1a2b84+1c1c5d3+ea55b46+f19c21e+775ae55 across 3 atomic TDD task pairs (5 envelope + 12 unit + 7 integration tests). 638/640 tests pass (+24 new). Build clean. 1 auto-fix (rateLimitNow injection seam). ROUTE-11 closes. Cloud-cost-protection layer 3/4 complete (breaker + cap + rate-limit); 08-07 (idempotency mux) remains."
last_updated: "2026-05-17T16:55:26Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 50
  completed_plans: 47
  percent: 94
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Executing Phase 08

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 08 — Ollama Cloud Fallback + Resilience Hardening

## Current Position

Phase: 08 (Ollama Cloud Fallback + Resilience Hardening) — EXECUTING
Plan: 8 of 11

- **Milestone:** v1
- **Phase:** 8
- **Plan:** 08-06 (Wave 2, ROUTE-11 — per-bearer-token rate limit) — COMPLETE. router/src/middleware/rateLimit.ts exports `bearerHash(raw)` (SHA-256 truncated to 8 hex chars — D-D2 mitigation of token leakage via Valkey MONITOR) + `makeRateLimitPreHandler({ valkey, log, rpmLimit, now? })` factory returning a Fastify onRequest hook. Key shape `ratelimit:{hash}:{epoch_minute}`; INCR on every request; EXPIRE 65s on count===1 only; throws RateLimitExceededError when count > rpmLimit; fail-open on Valkey errors (log warn + proceed — semaphore + breaker are hard caps; rate-limit is soft cap). RateLimitExceededError class added to envelope.ts with HTTP 429 + OpenAI envelope (rate_limit_error / rate_limit_exceeded / param: null) + Anthropic envelope (rate_limit_error) + recordOutcome.ts mapErrorToCode → 'rate_limit_exceeded' bucket (distinct from 'backend_saturated'). app.ts registers the hook AFTER bearer onRequest + BEFORE agentId preHandler, gated on `opts.valkey && opts.env`; stamps Retry-After: 60 in setErrorHandler BEFORE envelope serialization. BuildAppOpts.env widened to include ROUTER_RATE_LIMIT_RPM; new `rateLimitNow?` injection seam parallels breakerNow (replaces vi.useFakeTimers which hangs Fastify's app.inject). index.ts passes env.ROUTER_RATE_LIMIT_RPM through. Public-path bypass (/healthz, /readyz, /metrics) reuses PUBLIC_PATHS from auth/bearer.ts. 6 commits: 91faa8b+f1a2b84+1c1c5d3+ea55b46+f19c21e+775ae55 across 3 atomic TDD task pairs (4 env + 5 envelope + 12 unit + 7 integration tests). 638/640 tests pass (+24 new; 2 skipped pre-existing). Build clean. 1 auto-fix deviation (Rule 3 — rateLimitNow injection seam was missing from plan interfaces; required to make Test 6 verifiable without freezing Fastify timers). ROUTE-11 closes. Cloud-cost-protection layer 3/4 complete (BREAKER + CAP + RATE-LIMIT); 08-07 (DEDUPE idempotency mux) is the last guard in the layer.
- **Next plan:** 08-07 (Wave 2, idempotency mux — reuses Valkey INCR + bearer-hash pattern from 08-06; SETNX + pub/sub for in-flight de-dupe). Then 08-08, 08-09, 08-10.
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
Phase 8: █████████░ 89% (9/9 requirements coded — CLOUD-01 precondition closed via Plan 08-00; DATA-06 foundation closed via Plan 08-01; CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice closed via Plan 08-02; ROUTE-10 closed via Plan 08-03; CLOUD-03 closed via Plan 08-04; CLOUD-04 closed via Plan 08-05; ROUTE-11 closed via Plan 08-06)
Phase 9: ░░░░░░░░░░ 0% (0/4 requirements)

Overall: ███░░░░░░░ 33% (25/76 v1 requirements)
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

Last session: 2026-05-17T16:55:26Z
Stopped at: Phase 8 Plan 06 (ROUTE-11 — per-bearer-token rate limit) COMPLETE — middleware/rateLimit.ts with bearerHash (SHA-256[:8]) + makeRateLimitPreHandler (Valkey INCR+EXPIRE 65s on `ratelimit:{hash}:{minute}`, fail-open on Valkey errors, public-path bypass) + RateLimitExceededError class (429 + Retry-After: 60 + OpenAI rate_limit_error/rate_limit_exceeded + Anthropic rate_limit_error) + ROUTER_RATE_LIMIT_RPM env (default 600, min 1) + Retry-After in setErrorHandler + rateLimitNow injection seam (parallels breakerNow). 6 commits: 91faa8b+f1a2b84+1c1c5d3+ea55b46+f19c21e+775ae55 across 3 TDD pairs. 638/640 tests pass (+24 new). Build clean. 1 auto-fix (Rule 3 — rateLimitNow seam was missing from plan interfaces; required because vi.useFakeTimers hangs Fastify app.inject). ROUTE-11 closes. Cloud-cost-protection layer 3/4 complete (BREAKER+CAP+RATE-LIMIT); 08-07 (DEDUPE) is the last guard.

**Next action:** Operator runs the recipe in 07-06-SUMMARY.md §User Setup Required: `docker compose --profile vllm up -d` → wait for vllm healthy → `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` → visual Grafana check → reply `approved` (or list failing assertions for re-execution).

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
