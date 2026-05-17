---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: executing
stopped_at: "Phase 8 Plan 07 (ROUTE-12 — Idempotency-Key multiplexer) COMPLETE — router/src/resilience/idempotency.ts (makeIdempotencyMultiplexer factory: acquire SETNX EX 1800 → leader/follower; publishNonStream SET EX 900 result + PUBLISH done; publishStreamEvent RPUSH chunks + PUBLISH; finalizeStream SET EX 900 + EXPIRE 900 chunks + PUBLISH terminal; awaitNonStreamResult SUBSCRIBE-first + GET result race-free; awaitStreamResult async iterable yielding cached + future events with terminal yield). InvalidIdempotencyKeyError class (400 + invalid_request_error + invalid_idempotency_key + param Idempotency-Key on OpenAI; invalid_request_error on Anthropic). extractIdempotencyKey middleware helper (regex /^[A-Za-z0-9._:-]{1,256}$/, duplicate-header rejection). Routes: chat-completions + messages stream+non-stream wired (leader publishes events fire-and-forget BEFORE yielding to SSE translator; follower subscribes + pipes mux iterator through SAME canonicalToOpenAISse/canonicalToAnthropicSse with same displayModel for byte-identical wire output); embeddings non-stream wired. Followers NEVER acquire semaphore (the cost-saving). upstream_message_id captured from message_start and threaded into both leader + follower request_log rows for Plan 08-08 GROUP BY cost-attribution. 3 atomic commits: 4ac2908+7e5b06c+ac31b36 (15 unit + 9 integration tests). 662/664 tests pass (+24 new; 2 skipped pre-existing). Build clean. 2 auto-fixes: Rule 3 — timeoutMs test seam on multiplexer (parallels breakerNow/rateLimitNow); Rule 1 — fake adapter must read pauseBetweenEvents flag LIVE inside generator. ROUTE-12 closes. PITFALLS Pitfall 14 (SDK retry-storms DoS GPU) closes for SDK-driven retries supplying the header. Cloud-cost-protection layer 4/4 complete: rate-limit (08-06) → breaker (08-04) → max_tokens cap (08-05) → idempotency mux (08-07)."
last_updated: "2026-05-17T17:23:33Z"
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 50
  completed_plans: 48
  percent: 96
---

# Project State: local-llms

**Last Updated:** 2026-05-17
**Status:** Executing Phase 08

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** Phase 08 — Ollama Cloud Fallback + Resilience Hardening

## Current Position

Phase: 08 (Ollama Cloud Fallback + Resilience Hardening) — EXECUTING
Plan: 9 of 11

- **Milestone:** v1
- **Phase:** 8
- **Plan:** 08-07 (Wave 3, ROUTE-12 — Idempotency-Key multiplexer) — COMPLETE. router/src/resilience/idempotency.ts exports `makeIdempotencyMultiplexer({ valkey, log, subscriberFactory, timeoutMs? })` factory with full surface: `acquire(key, requestId)` SETNX EX 1800 → leader|follower role; `publishNonStream(key, body, msgId)` SET EX 900 result + PUBLISH 'done' marker; `publishStreamEvent(key, event)` RPUSH chunks list + PUBLISH event JSON; `finalizeStream(key, terminal, msgId)` SET EX 900 result + EXPIRE 900 chunks + PUBLISH terminal; `awaitNonStreamResult(key, requestId)` SUBSCRIBE-first + GET result race-free + 30s timeout → IdempotencyTimeoutError; `awaitStreamResult(key, requestId)` async iterable yielding cached LRANGE chunks then future PUBLISH events until terminal marker. Key namespace `idempotency:${key}:{lock|result|chunks|channel}`. Terminal-discriminant via `$terminal` field on payloads (canonical events never use this field). InvalidIdempotencyKeyError class added to envelope.ts with HTTP 400 + OpenAI envelope (invalid_request_error / invalid_idempotency_key / param 'Idempotency-Key') + Anthropic envelope (invalid_request_error). extractIdempotencyKey middleware helper validates regex /^[A-Za-z0-9._:-]{1,256}$/, rejects array-form (duplicate-header) per RFC 9110 single-value convention. app.ts constructs the multiplexer after Plan 08-01's Valkey decoration (gated on opts.valkey, subscriberFactory = () => opts.valkey.duplicate()) and threads idempotency? into chat/messages/embeddings route registration. Chat-completions + messages routes wire both branches: NON-STREAM follower returns awaitNonStreamResult body verbatim; STREAM follower pipes awaitStreamResult iterator through the SAME canonicalToOpenAISse/canonicalToAnthropicSse translator with the SAME displayModel (byte-identical wire output guaranteed by translator-determinism over canonical events); leader's stream-branch wraps the upstream iterable in an async generator that fire-and-forget publishStreamEvent(ev) BEFORE yielding to the SSE translator + captures upstream_message_id from message_start + finalizeStream('done'|'error'|'aborted') in sseCleanup. Embeddings route wires non-stream only (no stream branch). Followers NEVER acquire the per-backend semaphore — the explicit cost-saving the multiplexer provides. upstream_message_id captured from message_start AND threaded into both leader + follower request_log rows for Plan 08-08 GROUP BY upstream_message_id cost-attribution. 3 atomic commits: 4ac2908+7e5b06c+ac31b36 across 3 tasks (15 unit + 9 integration tests). 662/664 tests pass (+24 new; 2 skipped pre-existing). Build clean. 2 auto-fix deviations: Rule 3 — timeoutMs test seam on multiplexer factory parallels breakerNow/rateLimitNow from Plans 08-04/08-06 (vi.useFakeTimers freezes Fastify internals); Rule 1 — fake adapter must read pauseBetweenEvents flag LIVE inside the async generator (initial capture-at-start approach left followers deadlocked). ROUTE-12 closes. PITFALLS Pitfall 14 (agent retry-storms DoS the local GPU) closes for SDK-driven retries supplying the header; storms without the header are still bounded by Plans 08-04 (breaker) + 08-06 (rate-limit) + Phase 3 (semaphore). Cloud-cost-protection layer 4/4 COMPLETE: rate-limit (08-06) → breaker (08-04) → max_tokens cap (08-05) → idempotency mux (08-07).
- **Next plan:** 08-08 (DATA-07 + OBS-06 — cloud_spend_daily aggregation; depends on 08-07's shared upstream_message_id). Then 08-09 (registry cache), 08-10 (smoke tests).
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
Phase 8: ██████████ 100% (10/10 requirements coded — CLOUD-01 precondition closed via Plan 08-00; DATA-06 foundation closed via Plan 08-01; CLOUD-01 + CLOUD-02 + EMBED-02 vertical slice closed via Plan 08-02; ROUTE-10 closed via Plan 08-03; CLOUD-03 closed via Plan 08-04; CLOUD-04 closed via Plan 08-05; ROUTE-11 closed via Plan 08-06; ROUTE-12 closed via Plan 08-07. Plans 08-08/09/10 remain — observability + cache + smoke)
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

Last session: 2026-05-17T17:23:33Z
Stopped at: Phase 8 Plan 07 (ROUTE-12 — Idempotency-Key multiplexer) COMPLETE — router/src/resilience/idempotency.ts (makeIdempotencyMultiplexer factory: acquire SETNX EX 1800 → leader/follower; publishNonStream SET EX 900 + PUBLISH 'done'; publishStreamEvent RPUSH + PUBLISH; finalizeStream SET EX 900 + EXPIRE 900 + PUBLISH terminal; awaitNonStreamResult SUBSCRIBE-first + GET; awaitStreamResult async iterable with cached LRANGE + future PUBLISH events + terminal yield). InvalidIdempotencyKeyError class (400 + envelope mappings) + extractIdempotencyKey middleware helper (regex /^[A-Za-z0-9._:-]{1,256}$/). app.ts wires multiplexer (gated on opts.valkey, subscriberFactory = () => opts.valkey.duplicate()). Chat-completions + messages routes: leader fire-and-forget publishStreamEvent inside upstream wrapper + finalizeStream in sseCleanup; follower stream branch pipes mux iterator through same SSE translator with same displayModel for byte-identical wire output. Embeddings: non-stream only. Followers NEVER acquire semaphore (cost-saving). upstream_message_id captured from message_start → both leader + follower request_log rows (Plan 08-08 GROUP BY). 3 atomic commits: 4ac2908+7e5b06c+ac31b36 (15 unit + 9 integration tests). 662/664 tests pass (+24 new; 2 skipped pre-existing). Build clean. 2 auto-fixes (Rule 3 — timeoutMs test seam; Rule 1 — fake adapter reads pauseBetweenEvents LIVE). ROUTE-12 closes. PITFALLS Pitfall 14 closes for SDK-driven retries. Cloud-cost-protection layer 4/4 COMPLETE.

**Next action:** Plan 08-08 (DATA-07 + OBS-06 — cloud_spend_daily aggregation, reuses 08-07's shared upstream_message_id). Then 08-09 (registry cache), 08-10 (smoke tests). Phase 7 carry-over: operator still owes human-verify on 07-06 task 3.

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
